import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createApp } from '../src/app.js';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

test('health, no-store, and Chrome extension CORS headers are present', async (t) => {
  const { client, close } = await startApp(t);
  t.after(close);

  const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  const health = await client.get('/health', { origin });
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { ok: true, telegramReady: false });
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.equal(health.headers.get('access-control-allow-origin'), origin);
  assert.match(health.headers.get('access-control-allow-methods'), /POST/);

  const options = await client.raw('OPTIONS', '/v1/sync', undefined, { Origin: origin });
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('access-control-allow-origin'), origin);
});

test('health reports Telegram readiness only when bot token and webhook secret are configured', async (t) => {
  const missingToken = await startApp(t, { telegramWebhookSecret: 'test-webhook-secret' });
  t.after(missingToken.close);
  assert.deepEqual((await missingToken.client.get('/health')).body, { ok: true, telegramReady: false });

  const missingSecret = await startApp(t, { telegramBotToken: 'test-bot-token' });
  t.after(missingSecret.close);
  assert.deepEqual((await missingSecret.client.get('/health')).body, { ok: true, telegramReady: false });

  const ready = await startApp(t, {
    telegramBotToken: 'test-bot-token',
    telegramWebhookSecret: 'test-webhook-secret'
  });
  t.after(ready.close);
  assert.deepEqual((await ready.client.get('/health')).body, { ok: true, telegramReady: true });
});

test('POST /v1/link returns a safe unavailable error without creating a deep link when Telegram is not ready', async (t) => {
  const missingBoth = await startApp(t);
  t.after(missingBoth.close);
  const missingBothResponse = await missingBoth.client.post('/v1/link', { uuid: UUID_A });
  assert.equal(missingBothResponse.status, 503);
  assert.equal(missingBothResponse.body.error.code, 'telegram_unavailable');
  assert.equal(JSON.stringify(missingBothResponse.body).includes('telegramLink'), false);
  assertNoSecretFields(missingBothResponse.body);
  await assert.rejects(readFile(join(missingBoth.dataDir, `${UUID_A}.json`), 'utf8'), { code: 'ENOENT' });

  const missingToken = await startApp(t, { telegramWebhookSecret: 'test-webhook-secret' });
  t.after(missingToken.close);
  const missingTokenResponse = await missingToken.client.post('/v1/link', { uuid: UUID_A });
  assert.equal(missingTokenResponse.status, 503);
  assert.equal(missingTokenResponse.body.error.code, 'telegram_unavailable');
  assert.equal(JSON.stringify(missingTokenResponse.body).includes('telegramLink'), false);
  assertNoSecretFields(missingTokenResponse.body, ['test-webhook-secret']);
  await assert.rejects(readFile(join(missingToken.dataDir, `${UUID_A}.json`), 'utf8'), { code: 'ENOENT' });

  const missingSecret = await startApp(t, { telegramBotToken: 'test-bot-token' });
  t.after(missingSecret.close);
  const missingSecretResponse = await missingSecret.client.post('/v1/link', { uuid: UUID_B });
  assert.equal(missingSecretResponse.status, 503);
  assert.equal(missingSecretResponse.body.error.code, 'telegram_unavailable');
  assert.equal(JSON.stringify(missingSecretResponse.body).includes('telegramLink'), false);
  assertNoSecretFields(missingSecretResponse.body, ['test-bot-token']);
  await assert.rejects(readFile(join(missingSecret.dataDir, `${UUID_B}.json`), 'utf8'), { code: 'ENOENT' });
});

test('POST /v1/link creates a stable one-time Telegram deep link without exposing internals', async (t) => {
  const { client, close } = await startApp(t, {
    telegramBotToken: 'test-bot-token',
    telegramWebhookSecret: 'test-webhook-secret'
  });
  t.after(close);

  const first = await client.post('/v1/link', { uuid: UUID_A });
  assert.equal(first.status, 200);
  assert.equal(first.body.uuid, UUID_A);
  assert.equal(first.body.telegramReady, true);
  assert.equal(first.body.telegramLinked, false);
  assert.match(first.body.telegramLink, /^https:\/\/t\.me\/EasyJobAppsBot\?start=[A-Za-z0-9_-]{32,}$/);
  assertNoSecretFields(first.body, ['test-bot-token', 'test-webhook-secret']);

  const second = await client.post('/v1/link', { uuid: UUID_A });
  assert.equal(second.status, 200);
  assert.equal(second.body.telegramLink, first.body.telegramLink);
  assert.equal(second.body.telegramReady, true);
  assert.equal(second.body.telegramLinked, false);
  assertNoSecretFields(second.body, ['test-bot-token', 'test-webhook-secret']);
});

test('Telegram webhook secret is enforced and /start tokens bind only once', async (t) => {
  const sends = [];
  const logs = collectLogs();
  const { client, close } = await startApp(t, {
    telegramBotToken: 'test-token',
    telegramWebhookSecret: 'test-webhook-secret',
    telegramTransport: captureTelegram(sends),
    logger: logs.logger
  });
  t.after(close);

  const link = await client.post('/v1/link', { uuid: UUID_A });
  const token = startToken(link.body.telegramLink);

  const missingSecret = await client.post('/telegram/webhook', startUpdate(token, 123));
  assert.equal(missingSecret.status, 401);
  assertNoSecretFields(missingSecret.body);

  const wrongSecret = await client.post('/telegram/webhook', startUpdate(token, 123), {
    'X-Telegram-Bot-Api-Secret-Token': 'wrong'
  });
  assert.equal(wrongSecret.status, 401);
  assertNoSecretFields(wrongSecret.body);

  const bound = await client.post('/telegram/webhook', startUpdate(token, 123), {
    'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret'
  });
  assert.equal(bound.status, 200);
  assert.deepEqual(bound.body, { ok: true });

  const linked = await client.post('/v1/link', { uuid: UUID_A });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.telegramLinked, true);
  assertNoSecretFields(linked.body, ['test-webhook-secret', 'test-token']);

  const rebound = await client.post('/telegram/webhook', startUpdate(token, 999), {
    'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret'
  });
  assert.equal(rebound.status, 200);

  await client.post('/v1/sync', {
    uuid: UUID_A,
    after: 0,
    events: [{ id: 'assistant-1', role: 'assistant', type: 'text', text: 'Ready from extension' }]
  });

  assert.equal(sends.length, 1);
  assert.equal(sends[0].body.chat_id, 123);
  assert.equal(sends[0].body.text, 'Ready from extension');
  assert.doesNotMatch(JSON.stringify(logs.messages), /test-webhook-secret|test-token|123|999/);
});

test('Telegram text after binding is appended as user events and survives reload', async (t) => {
  const dataDir = await tempDataDir(t);
  const first = await startApp(t, {
    dataDir,
    telegramBotToken: 'test-bot-token',
    telegramWebhookSecret: 'test-webhook-secret'
  });
  const link = await first.client.post('/v1/link', { uuid: UUID_A });
  const token = startToken(link.body.telegramLink);

  assert.equal((await first.client.post('/telegram/webhook', startUpdate(token, 456), {
    'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret'
  })).status, 200);
  assert.equal((await first.client.post('/telegram/webhook', textUpdate('hello from telegram', 456, 11, 2), {
    'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret'
  })).status, 200);

  const beforeReload = await first.client.post('/v1/sync', { uuid: UUID_A, after: 0, events: [] });
  assert.equal(beforeReload.status, 200);
  assert.equal(beforeReload.body.cursor, 1);
  assert.equal(beforeReload.body.telegramReady, true);
  assert.equal(beforeReload.body.telegramLinked, true);
  assert.equal(beforeReload.body.events.length, 1);
  assert.equal(beforeReload.body.events[0].origin, 'telegram');
  assert.equal(beforeReload.body.events[0].role, 'user');
  assert.equal(beforeReload.body.events[0].text, 'hello from telegram');
  assert.equal(Object.hasOwn(beforeReload.body.events[0], 'replyTo'), false);
  assertNoSecretFields(beforeReload.body);
  await first.close();

  const second = await startApp(t, {
    dataDir,
    telegramBotToken: 'test-bot-token',
    telegramWebhookSecret: 'test-webhook-secret'
  });
  t.after(second.close);
  const afterReload = await second.client.post('/v1/sync', { uuid: UUID_A, after: 0, events: [] });
  assert.equal(afterReload.status, 200);
  assert.equal(afterReload.body.telegramReady, true);
  assert.equal(afterReload.body.telegramLinked, true);
  assert.deepEqual(afterReload.body.events, beforeReload.body.events);
});

test('POST /v1/sync reports Telegram readiness and link state without exposing internals', async (t) => {
  const unavailable = await startApp(t);
  t.after(unavailable.close);
  const notReady = await unavailable.client.post('/v1/sync', { uuid: UUID_A, after: 0, events: [] });
  assert.equal(notReady.status, 200);
  assert.equal(notReady.body.telegramReady, false);
  assert.equal(notReady.body.telegramLinked, false);
  assertNoSecretFields(notReady.body);

  const ready = await startApp(t, {
    telegramBotToken: 'test-bot-token',
    telegramWebhookSecret: 'test-webhook-secret'
  });
  t.after(ready.close);
  const unlinked = await ready.client.post('/v1/sync', { uuid: UUID_A, after: 0, events: [] });
  assert.equal(unlinked.status, 200);
  assert.equal(unlinked.body.telegramReady, true);
  assert.equal(unlinked.body.telegramLinked, false);
  assertNoSecretFields(unlinked.body, ['test-bot-token', 'test-webhook-secret']);

  const link = await ready.client.post('/v1/link', { uuid: UUID_A });
  await ready.client.post('/telegram/webhook', startUpdate(startToken(link.body.telegramLink), 234), {
    'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret'
  });

  const linked = await ready.client.post('/v1/sync', { uuid: UUID_A, after: 0, events: [] });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.telegramReady, true);
  assert.equal(linked.body.telegramLinked, true);
  assertNoSecretFields(linked.body, ['test-bot-token', 'test-webhook-secret', '234']);
});

test('sync appends extension events once, deduplicates IDs, and honors cursors', async (t) => {
  const { client, close } = await startApp(t);
  t.after(close);

  const first = await client.post('/v1/sync', {
    uuid: UUID_A,
    after: 0,
    events: [
      { id: 'event-1', role: 'user', type: 'text', text: 'one' },
      { id: 'event-2', role: 'assistant', type: 'text', text: 'two' }
    ]
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.cursor, 2);
  assert.deepEqual(first.body.events.map((event) => [event.seq, event.id, event.origin]), [
    [1, 'event-1', 'extension'],
    [2, 'event-2', 'extension']
  ]);

  const duplicate = await client.post('/v1/sync', {
    uuid: UUID_A,
    after: 0,
    events: [
      { id: 'event-1', role: 'user', type: 'text', text: 'changed text is ignored' },
      { id: 'event-2', role: 'assistant', type: 'text', text: 'changed text is ignored' }
    ]
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.cursor, 2);
  assert.equal(duplicate.body.events.length, 2);
  assert.equal(duplicate.body.events[0].text, 'one');
  assert.equal(duplicate.body.events[1].text, 'two');

  const afterOne = await client.post('/v1/sync', { uuid: UUID_A, after: 1, events: [] });
  assert.equal(afterOne.status, 200);
  assert.deepEqual(afterOne.body.events.map((event) => event.id), ['event-2']);
});

test('extension replyTo events round-trip through public sync responses and storage reloads', async (t) => {
  const dataDir = await tempDataDir(t);
  const first = await startApp(t, { dataDir });

  const response = await first.client.post('/v1/sync', {
    uuid: UUID_A,
    after: 0,
    events: [
      { id: 'thread-root', role: 'user', type: 'text', text: 'root' },
      { id: 'thread-reply', replyTo: 'thread-root', role: 'assistant', type: 'text', text: 'reply' }
    ]
  });
  assert.equal(response.status, 200);
  assert.equal(Object.hasOwn(response.body.events[0], 'replyTo'), false);
  assert.equal(response.body.events[1].replyTo, 'thread-root');

  const state = JSON.parse(await readFile(join(dataDir, `${UUID_A}.json`), 'utf8'));
  assert.equal(Object.hasOwn(state.events[0], 'replyTo'), false);
  assert.equal(state.events[1].replyTo, 'thread-root');
  await first.close();

  const second = await startApp(t, { dataDir });
  t.after(second.close);
  const afterReload = await second.client.post('/v1/sync', { uuid: UUID_A, after: 0, events: [] });
  assert.equal(afterReload.status, 200);
  assert.equal(afterReload.body.events[1].replyTo, 'thread-root');
});

test('extension replyTo must use the safe event ID format', async (t) => {
  const { client, close } = await startApp(t);
  t.after(close);

  const response = await client.post('/v1/sync', {
    uuid: UUID_A,
    after: 0,
    events: [{ id: 'reply-with-bad-parent', replyTo: '../not-safe', role: 'user', type: 'text', text: 'bad parent' }]
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'invalid_reply_to');
});

test('concurrent sync writes for the same UUID are serialized without losing events', async (t) => {
  const { client, close } = await startApp(t);
  t.after(close);

  await Promise.all(Array.from({ length: 20 }, (_, index) => client.post('/v1/sync', {
    uuid: UUID_A,
    after: 0,
    events: [{ id: `parallel-${index}`, role: 'user', type: 'text', text: `message ${index}` }]
  })));

  const synced = await client.post('/v1/sync', { uuid: UUID_A, after: 0, events: [] });
  assert.equal(synced.status, 200);
  assert.equal(synced.body.events.length, 20);
  assert.deepEqual(synced.body.events.map((event) => event.seq), Array.from({ length: 20 }, (_, index) => index + 1));
  assert.equal(new Set(synced.body.events.map((event) => event.id)).size, 20);
});

test('reset clears events and preserves the UUID Telegram link', async (t) => {
  const { client, close } = await startApp(t, {
    telegramBotToken: 'test-bot-token',
    telegramWebhookSecret: 'test-webhook-secret'
  });
  t.after(close);

  const link = await client.post('/v1/link', { uuid: UUID_A });
  await client.post('/v1/sync', {
    uuid: UUID_A,
    after: 0,
    events: [{ id: 'event-before-reset', role: 'assistant', type: 'text', text: 'clear me' }]
  });

  const reset = await client.post('/v1/reset', { uuid: UUID_A });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.telegramLink, link.body.telegramLink);
  assertNoSecretFields(reset.body);

  const empty = await client.post('/v1/sync', { uuid: UUID_A, after: 0, events: [] });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.events, []);
  assert.equal(empty.body.cursor, 0);
});

test('assistant events are delivered to Telegram via injected transport exactly once', async (t) => {
  const sends = [];
  const { client, close } = await startApp(t, {
    telegramBotToken: 'fake-bot-token',
    telegramWebhookSecret: 'fake-webhook-secret',
    telegramTransport: captureTelegram(sends)
  });
  t.after(close);

  const link = await client.post('/v1/link', { uuid: UUID_A });
  assert.equal((await client.post('/telegram/webhook', startUpdate(startToken(link.body.telegramLink), 789), {
    'X-Telegram-Bot-Api-Secret-Token': 'fake-webhook-secret'
  })).status, 200);

  const first = await client.post('/v1/sync', {
    uuid: UUID_A,
    after: 0,
    events: [{ id: 'assistant-once', role: 'assistant', type: 'text', text: 'sent once' }]
  });
  assert.equal(first.status, 200);
  assert.equal(sends.length, 1);
  assert.match(sends[0].url, /\/botfake-bot-token\/sendMessage$/);
  assert.deepEqual(sends[0].body, {
    chat_id: 789,
    text: 'sent once',
    disable_web_page_preview: true
  });
  assertNoSecretFields(first.body);

  const duplicate = await client.post('/v1/sync', {
    uuid: UUID_A,
    after: 0,
    events: [{ id: 'assistant-once', role: 'assistant', type: 'text', text: 'sent twice?' }]
  });
  assert.equal(duplicate.status, 200);
  assert.equal(sends.length, 1);
});

test('validation rejects invalid UUIDs, cursors, event sizes, traversal, and oversized JSON bodies', async (t) => {
  const { client, close } = await startApp(t, { bodyLimitBytes: 16 * 1024 });
  t.after(close);

  assert.equal((await client.post('/v1/link', { uuid: 'not-a-uuid' })).status, 400);
  assert.equal((await client.post('/v1/link', { uuid: '../' + UUID_A })).status, 400);
  assert.equal((await client.post('/v1/sync', { uuid: UUID_A, after: -1, events: [] })).status, 400);
  assert.equal((await client.post('/v1/sync', { uuid: UUID_A, after: 0, events: [{ id: 'x', role: 'assistant', type: 'text', text: 'a'.repeat(4097) }] })).status, 400);
  assert.equal((await client.post('/v1/sync', { uuid: UUID_A, after: 0, events: Array.from({ length: 51 }, (_, index) => ({ id: `event-${index}`, role: 'user', type: 'text', text: 'x' })) })).status, 400);

  const smallBodyApp = await startApp(t, { bodyLimitBytes: 1024 });
  t.after(smallBodyApp.close);
  const oversized = await smallBodyApp.client.raw('POST', '/v1/link', JSON.stringify({ uuid: UUID_B, filler: 'x'.repeat(2048) }), {
    'Content-Type': 'application/json'
  });
  assert.equal(oversized.status, 413);
});

test('secret and chat identifiers are not disclosed in responses or logs on delivery failures', async (t) => {
  const logs = collectLogs();
  const { client, close } = await startApp(t, {
    telegramBotToken: 'sensitive-token',
    telegramWebhookSecret: 'sensitive-webhook-secret',
    telegramTransport: async () => {
      throw new Error('transport leaked sensitive-token for chat 321');
    },
    logger: logs.logger
  });
  t.after(close);

  const link = await client.post('/v1/link', { uuid: UUID_A });
  await client.post('/telegram/webhook', startUpdate(startToken(link.body.telegramLink), 321), {
    'X-Telegram-Bot-Api-Secret-Token': 'sensitive-webhook-secret'
  });

  const response = await client.post('/v1/sync', {
    uuid: UUID_A,
    after: 0,
    events: [{ id: 'assistant-failure', role: 'assistant', type: 'text', text: 'will be stored even if delivery fails' }]
  });
  assert.equal(response.status, 200);
  assertNoSecretFields(response.body);

  const responseText = JSON.stringify(response.body);
  const logText = JSON.stringify(logs.messages);
  assert.doesNotMatch(responseText, /sensitive-token|sensitive-webhook-secret|321/);
  assert.doesNotMatch(logText, /sensitive-token|sensitive-webhook-secret|321/);
});

test('state is stored in one JSON file per UUID with atomic-write cleanup', async (t) => {
  const dataDir = await tempDataDir(t);
  const { client, close } = await startApp(t, {
    dataDir,
    telegramBotToken: 'test-bot-token',
    telegramWebhookSecret: 'test-webhook-secret'
  });
  t.after(close);

  await client.post('/v1/link', { uuid: UUID_A });
  await client.post('/v1/link', { uuid: UUID_B });
  await client.post('/v1/sync', {
    uuid: UUID_A,
    after: 0,
    events: [{ id: 'stored-event', role: 'assistant', type: 'text', text: 'persisted' }]
  });

  assert.equal((await stat(join(dataDir, `${UUID_A}.json`))).isFile(), true);
  assert.equal((await stat(join(dataDir, `${UUID_B}.json`))).isFile(), true);

  const files = await import('node:fs/promises').then(({ readdir }) => readdir(dataDir));
  assert.equal(files.filter((file) => file.endsWith('.json')).length, 2);
  assert.deepEqual(files.filter((file) => file.endsWith('.tmp')), []);
});

async function startApp(t, overrides = {}) {
  const dataDir = overrides.dataDir ?? await tempDataDir(t);
  const app = createApp({
    dataDir,
    botUsername: 'EasyJobAppsBot',
    ...overrides
  });
  return {
    client: makeClient(app.handler),
    dataDir,
    async close() {
      await app.close?.();
    }
  };
}

async function tempDataDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'easyjobappschatbot-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function makeClient(handler) {
  return {
    get(path, options = {}) {
      return this.raw('GET', path, undefined, headerOptions(options));
    },
    post(path, body, headers = {}) {
      return this.raw('POST', path, JSON.stringify(body), {
        'Content-Type': 'application/json',
        ...headers
      });
    },
    async raw(method, path, body, headers = {}) {
      const response = await invokeHandler(handler, { method, path, body, headers });
      const text = response.text;
      let parsed = null;
      if (text) {
        parsed = JSON.parse(text);
      }
      return { status: response.status, headers: response.headers, body: parsed };
    }
  };
}

async function invokeHandler(handler, { method, path, body, headers }) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  request.method = method;
  request.url = path;
  request.headers = normalizeHeaders(headers);

  let resolveEnd;
  const ended = new Promise((resolve) => {
    resolveEnd = resolve;
  });
  const responseHeaders = new Headers();
  const response = {
    statusCode: 200,
    setHeader(name, value) {
      responseHeaders.set(name, String(value));
    },
    writeHead(status, headersToSet = {}) {
      this.statusCode = status;
      for (const [name, value] of Object.entries(headersToSet)) {
        this.setHeader(name, value);
      }
    },
    end(chunk = '') {
      resolveEnd({
        status: this.statusCode,
        headers: responseHeaders,
        text: Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      });
    }
  };

  await handler(request, response);
  return ended;
}

function normalizeHeaders(headers) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}

function headerOptions(options) {
  return options.origin ? { Origin: options.origin } : {};
}

function startToken(link) {
  return new URL(link).searchParams.get('start');
}

function startUpdate(token, chatId) {
  return {
    update_id: 1000 + Number(chatId),
    message: {
      message_id: 1,
      chat: { id: chatId },
      text: `/start ${token}`
    }
  };
}

function textUpdate(text, chatId, messageId, updateId) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      chat: { id: chatId },
      text
    }
  };
}

function captureTelegram(sends) {
  return async (request) => {
    sends.push(request);
    return { ok: true, result: { message_id: sends.length } };
  };
}

function collectLogs() {
  const messages = [];
  const logger = {
    info: (...args) => messages.push(['info', ...args]),
    warn: (...args) => messages.push(['warn', ...args]),
    error: (...args) => messages.push(['error', ...args])
  };
  return { logger, messages };
}

function assertNoSecretFields(value, secrets = []) {
  const text = JSON.stringify(value);
  assert.doesNotMatch(text, /chat_id|chatId|telegramChatId/i);
  for (const secret of secrets) {
    assert.doesNotMatch(text, new RegExp(escapeRegExp(secret), 'i'));
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
