import { randomBytes } from 'node:crypto';
import { URL } from 'node:url';

import { HttpError, isHttpError } from './errors.js';
import { FileStore } from './storage.js';
import { TelegramClient } from './telegram.js';
import {
  requireObject,
  validateAfter,
  validateChatId,
  validateExtensionEvents,
  validateStartToken,
  validateTelegramText,
  validateUuid
} from './validation.js';

const DEFAULT_BODY_LIMIT_BYTES = 64 * 1024;

export function createApp(options = {}) {
  const logger = safeLogger(options.logger ?? console);
  const store = options.store ?? new FileStore({ dataDir: options.dataDir });
  const telegram = options.telegram ?? new TelegramClient({
    botToken: options.telegramBotToken,
    transport: options.telegramTransport
  });
  const botUsername = options.botUsername || 'EasyJobAppsBot';
  const bodyLimitBytes = options.bodyLimitBytes || DEFAULT_BODY_LIMIT_BYTES;
  const telegramWebhookSecret = options.telegramWebhookSecret || null;
  const allowedOrigins = options.allowedOrigins || [];
  let telegramBindingQueue = Promise.resolve();

  async function handler(request, response) {
    applyCommonHeaders(request, response, allowedOrigins);

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    try {
      const url = new URL(request.url, 'http://localhost');
      const path = url.pathname;

      if (request.method === 'GET' && path === '/health') {
        sendJson(response, 200, { ok: true, telegramReady: isTelegramReady() });
        return;
      }

      if (request.method === 'POST' && path === '/v1/link') {
        const body = requireObject(await readJsonBody(request, bodyLimitBytes));
        const uuid = validateUuid(body.uuid);
        const result = await linkUuid(uuid);
        sendJson(response, 200, result);
        return;
      }

      if (request.method === 'POST' && path === '/v1/unlink') {
        const body = requireObject(await readJsonBody(request, bodyLimitBytes));
        const uuid = validateUuid(body.uuid);
        const result = await unlinkUuid(uuid);
        sendJson(response, 200, result);
        return;
      }

      if (request.method === 'POST' && path === '/v1/sync') {
        const body = requireObject(await readJsonBody(request, bodyLimitBytes));
        const uuid = validateUuid(body.uuid);
        const after = validateAfter(body.after);
        const events = validateExtensionEvents(body.events);
        const result = await syncUuid(uuid, after, events);
        sendJson(response, 200, result);
        return;
      }

      if (request.method === 'POST' && path === '/v1/reset') {
        const body = requireObject(await readJsonBody(request, bodyLimitBytes));
        const uuid = validateUuid(body.uuid);
        const result = await resetUuid(uuid);
        sendJson(response, 200, result);
        return;
      }

      if (request.method === 'POST' && path === '/telegram/webhook') {
        validateTelegramSecret(request, telegramWebhookSecret);
        const body = requireObject(await readJsonBody(request, bodyLimitBytes));
        await handleTelegramUpdate(body);
        sendJson(response, 200, { ok: true });
        return;
      }

      throw new HttpError(404, 'not_found', 'route not found');
    } catch (error) {
      const httpError = isHttpError(error);
      const status = error?.status === 413 ? 413 : httpError ? error.status : 500;
      if (status >= 500 && !httpError) {
        logger.error('request failed', { code: 'internal_error' });
      }
      sendJson(response, status, {
        error: {
          code: httpError ? error.code : status === 413 ? 'payload_too_large' : 'internal_error',
          message: httpError ? error.message : status === 413 ? 'request body is too large' : 'internal server error'
        }
      });
    }
  }

  async function linkUuid(uuid) {
    if (!isTelegramReady()) {
      throw new HttpError(503, 'telegram_unavailable', 'Telegram linking is unavailable');
    }

    return store.withUuid(uuid, async (state, save) => {
      if (!state.linkToken) {
        state.linkToken = await createUnusedLinkToken();
        await save();
      }
      return publicLinkResponse(uuid, state);
    });
  }

  async function unlinkUuid(uuid) {
    return store.withUuid(uuid, async (state, save) => {
      const previousLinkToken = state.linkToken;
      state.telegramChatId = null;
      state.tokenConsumedAt = null;
      state.linkToken = await createUnusedLinkToken(previousLinkToken);
      markExistingAssistantEventsDelivered(state);
      await save();
      return publicLinkResponse(uuid, state);
    });
  }

  async function resetUuid(uuid) {
    return store.withUuid(uuid, async (state, save) => {
      if (!state.linkToken) {
        state.linkToken = await createUnusedLinkToken();
      }
      state.events = [];
      state.nextSeq = 1;
      state.outboundSentEventIds = [];
      await save();
      return {
        ok: true,
        uuid,
        telegramLink: makeTelegramLink(botUsername, state.linkToken)
      };
    });
  }

  async function syncUuid(uuid, after, incomingEvents) {
    return store.withUuid(uuid, async (state, save) => {
      const existingIds = new Set(state.events.map((event) => event.id));
      let changed = false;

      for (const event of incomingEvents) {
        if (existingIds.has(event.id)) {
          continue;
        }
        const storedEvent = {
          seq: state.nextSeq,
          id: event.id,
          origin: 'extension',
          role: event.role,
          type: event.type,
          text: event.text,
          createdAt: new Date().toISOString()
        };
        if (event.replyTo !== undefined) {
          storedEvent.replyTo = event.replyTo;
        }
        state.events.push(storedEvent);
        state.nextSeq += 1;
        existingIds.add(event.id);
        changed = true;
      }

      if (changed) {
        await save();
      }

      await deliverPendingAssistantEvents(state, save);

      return {
        uuid,
        telegramReady: isTelegramReady(),
        telegramLinked: isTelegramLinked(state),
        cursor: Math.max(0, state.nextSeq - 1),
        events: state.events
          .filter((event) => event.seq > after)
          .map(toPublicEvent)
      };
    });
  }

  async function handleTelegramUpdate(update) {
    const message = update.message ?? update.edited_message;
    const text = validateTelegramText(message?.text);
    const chatId = validateChatId(message?.chat?.id);
    if (!text || chatId === null) {
      return;
    }

    const startToken = parseStartToken(text);
    if (startToken) {
      await bindStartToken(startToken, chatId);
      return;
    }

    await appendTelegramText(update, message, chatId, text);
  }

  async function bindStartToken(token, chatId) {
    const safeToken = validateStartToken(token);
    if (!safeToken) {
      return;
    }

    await withTelegramBindingLock(async () => {
      const uuid = await store.findUuidByToken(safeToken);
      if (!uuid) {
        return;
      }

      const chatOwnerUuid = await store.findUuidByChatId(chatId);
      if (chatOwnerUuid && chatOwnerUuid !== uuid) {
        return;
      }

      await store.withUuid(uuid, async (state, save) => {
        if (state.linkToken !== safeToken || state.tokenConsumedAt || state.telegramChatId !== null) {
          return;
        }

        const currentChatOwnerUuid = await store.findUuidByChatId(chatId);
        if (currentChatOwnerUuid && currentChatOwnerUuid !== uuid) {
          return;
        }

        state.telegramChatId = chatId;
        state.tokenConsumedAt = new Date().toISOString();
        await save();
      });
    });
  }

  async function appendTelegramText(update, message, chatId, text) {
    const uuid = await store.findUuidByChatId(chatId);
    if (!uuid) {
      return;
    }

    await store.withUuid(uuid, async (state, save) => {
      if (state.telegramChatId !== chatId) {
        return;
      }
      const eventId = `tg:${update.update_id ?? 'no-update'}:${message.message_id ?? 'no-message'}`;
      if (state.events.some((event) => event.id === eventId)) {
        return;
      }
      state.events.push({
        seq: state.nextSeq,
        id: eventId,
        origin: 'telegram',
        role: 'user',
        type: 'text',
        text,
        createdAt: new Date().toISOString()
      });
      state.nextSeq += 1;
      await save();
    });
  }

  async function deliverPendingAssistantEvents(state, save) {
    if (!telegram.configured || state.telegramChatId === null) {
      return false;
    }
    const sent = new Set(state.outboundSentEventIds);
    let changed = false;
    for (const event of state.events) {
      if (
        event.origin !== 'extension' ||
        event.role !== 'assistant' ||
        event.type !== 'text' ||
        sent.has(event.id)
      ) {
        continue;
      }
      try {
        await telegram.sendText(state.telegramChatId, event.text);
        sent.add(event.id);
        state.outboundSentEventIds = [...sent];
        changed = true;
      } catch {
        logger.warn('telegram outbound delivery failed', { code: 'telegram_delivery_failed' });
      }
    }
    if (changed) {
      await save();
    }
    return changed;
  }

  function markExistingAssistantEventsDelivered(state) {
    const sent = new Set(state.outboundSentEventIds);
    for (const event of state.events) {
      if (event.origin === 'extension' && event.role === 'assistant') {
        sent.add(event.id);
      }
    }
    state.outboundSentEventIds = [...sent];
  }

  function withTelegramBindingLock(callback) {
    const current = telegramBindingQueue
      .catch(() => undefined)
      .then(callback);
    telegramBindingQueue = current.catch(() => undefined);
    return current;
  }

  async function createUnusedLinkToken(previousToken = null) {
    for (;;) {
      const token = createLinkToken();
      if (token === previousToken) {
        continue;
      }
      if (!await store.findUuidByToken(token)) {
        return token;
      }
    }
  }

  function publicLinkResponse(uuid, state) {
    return {
      uuid,
      telegramReady: isTelegramReady(),
      telegramLinked: isTelegramLinked(state),
      telegramLink: makeTelegramLink(botUsername, state.linkToken)
    };
  }

  function isTelegramReady() {
    return Boolean(telegram.configured && telegramWebhookSecret);
  }

  function isTelegramLinked(state) {
    return Boolean(state.tokenConsumedAt && state.telegramChatId !== null);
  }

  return {
    handler,
    close: () => store.close?.()
  };
}

function createLinkToken() {
  return randomBytes(24).toString('base64url');
}

export function makeTelegramLink(botUsername, token) {
  return `https://t.me/${encodeURIComponent(botUsername)}?start=${encodeURIComponent(token)}`;
}

function parseStartToken(text) {
  const match = /^\/start(?:@\w+)?(?:\s+(.+))?$/u.exec(text.trim());
  if (!match?.[1]) {
    return null;
  }
  return match[1].trim();
}

function validateTelegramSecret(request, expectedSecret) {
  if (!expectedSecret) {
    return;
  }
  const received = request.headers['x-telegram-bot-api-secret-token'];
  if (received !== expectedSecret) {
    throw new HttpError(401, 'unauthorized', 'telegram webhook token is invalid');
  }
}

function toPublicEvent(event) {
  const publicEvent = {
    seq: event.seq,
    id: event.id,
    origin: event.origin,
    role: event.role,
    type: event.type,
    text: event.text,
    createdAt: event.createdAt
  };
  if (event.origin === 'extension' && event.replyTo !== undefined) {
    publicEvent.replyTo = event.replyTo;
  }
  return publicEvent;
}

function applyCommonHeaders(request, response, allowedOrigins) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Pragma', 'no-cache');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Telegram-Bot-Api-Secret-Token');

  const origin = request.headers.origin;
  if (isAllowedOrigin(origin, allowedOrigins)) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
  }
}

function isAllowedOrigin(origin, allowedOrigins) {
  if (!origin || typeof origin !== 'string') {
    return false;
  }
  if (allowedOrigins.includes(origin)) {
    return true;
  }
  return /^chrome-extension:\/\/[a-z]{32}$/i.test(origin) || /^moz-extension:\/\/[0-9a-f-]{36}$/i.test(origin);
}

function sendJson(response, status, value) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(value));
}

async function readJsonBody(request, limitBytes) {
  if (!String(request.headers['content-type'] || '').toLowerCase().includes('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', 'content-type must be application/json');
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limitBytes) {
      throw new HttpError(413, 'payload_too_large', 'request body is too large');
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'request body must be valid JSON');
  }
}

function safeLogger(logger) {
  return {
    info: (...args) => logger.info?.(...safeLogArgs(args)),
    warn: (...args) => logger.warn?.(...safeLogArgs(args)),
    error: (...args) => logger.error?.(...safeLogArgs(args))
  };
}

function safeLogArgs(args) {
  return args.map((arg) => {
    if (typeof arg === 'string') {
      return arg;
    }
    if (!arg || typeof arg !== 'object') {
      return arg;
    }
    return JSON.parse(JSON.stringify(arg, (_key, value) => {
      if (typeof value === 'string' && value.length > 120) {
        return '[redacted]';
      }
      return value;
    }));
  });
}
