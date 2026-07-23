import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { isSafeEventId, validateUuid } from './validation.js';

const STATE_VERSION = 1;

export class FileStore {
  constructor({ dataDir }) {
    if (!dataDir || typeof dataDir !== 'string') {
      throw new Error('dataDir is required');
    }
    this.dataDir = resolve(dataDir);
    this.queues = new Map();
  }

  async close() {}

  async withUuid(uuidInput, callback) {
    const uuid = validateUuid(uuidInput);
    const previous = this.queues.get(uuid) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        const state = await this.readState(uuid);
        const save = async () => {
          await this.writeState(uuid, state);
        };
        return callback(state, save);
      });

    const queued = current.catch(() => undefined).finally(() => {
      if (this.queues.get(uuid) === queued) {
        this.queues.delete(uuid);
      }
    });
    this.queues.set(uuid, queued);

    return current;
  }

  async findUuidByToken(token) {
    await this.ensureDir();
    const files = await readdir(this.dataDir);
    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }
      const uuid = basename(file, '.json');
      try {
        validateUuid(uuid);
        const state = await this.readState(uuid);
        if (state.linkToken === token) {
          return uuid;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  async findUuidByChatId(chatId) {
    await this.ensureDir();
    const files = await readdir(this.dataDir);
    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }
      const uuid = basename(file, '.json');
      try {
        validateUuid(uuid);
        const state = await this.readState(uuid);
        if (state.telegramChatId === chatId) {
          return uuid;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  fileForUuid(uuidInput) {
    const uuid = validateUuid(uuidInput);
    const file = resolve(this.dataDir, `${uuid}.json`);
    if (dirname(file) !== this.dataDir || basename(file) !== `${uuid}.json`) {
      throw new Error('unsafe state path');
    }
    return file;
  }

  async readState(uuidInput) {
    const uuid = validateUuid(uuidInput);
    await this.ensureDir();
    const file = this.fileForUuid(uuid);
    try {
      const raw = await readFile(file, 'utf8');
      return normalizeState(uuid, JSON.parse(raw));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return newState(uuid);
      }
      throw error;
    }
  }

  async writeState(uuidInput, state) {
    const uuid = validateUuid(uuidInput);
    await this.ensureDir();
    const file = this.fileForUuid(uuid);
    const tempFile = join(this.dataDir, `.${uuid}.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}.tmp`);
    const data = `${JSON.stringify(normalizeState(uuid, state), null, 2)}\n`;

    let handle;
    try {
      handle = await open(tempFile, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY, 0o600);
      await handle.writeFile(data, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(tempFile, file);
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => undefined);
      }
      await rm(tempFile, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async ensureDir() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await access(this.dataDir, constants.R_OK | constants.W_OK);
  }
}

export function newState(uuidInput) {
  const uuid = validateUuid(uuidInput);
  return {
    version: STATE_VERSION,
    uuid,
    linkToken: null,
    tokenConsumedAt: null,
    telegramChatId: null,
    nextSeq: 1,
    events: [],
    outboundSentEventIds: []
  };
}

export function normalizeState(uuidInput, state) {
  const uuid = validateUuid(uuidInput);
  const events = Array.isArray(state?.events) ? state.events.map(normalizeStoredEvent).filter(Boolean) : [];
  const maxSeq = events.reduce((max, event) => Math.max(max, event.seq), 0);
  const nextSeq = Number.isSafeInteger(state?.nextSeq) && state.nextSeq > maxSeq
    ? state.nextSeq
    : maxSeq + 1;

  return {
    version: STATE_VERSION,
    uuid,
    linkToken: typeof state?.linkToken === 'string' ? state.linkToken : null,
    tokenConsumedAt: typeof state?.tokenConsumedAt === 'string' ? state.tokenConsumedAt : null,
    telegramChatId: state?.telegramChatId ?? null,
    nextSeq,
    events,
    outboundSentEventIds: Array.isArray(state?.outboundSentEventIds)
      ? state.outboundSentEventIds.filter((id) => typeof id === 'string')
      : []
  };
}

function normalizeStoredEvent(event) {
  if (
    !event ||
    !Number.isSafeInteger(event.seq) ||
    event.seq <= 0 ||
    !isSafeEventId(event.id) ||
    !['extension', 'telegram'].includes(event.origin) ||
    !['user', 'assistant', 'system'].includes(event.role) ||
    event.type !== 'text' ||
    typeof event.text !== 'string' ||
    typeof event.createdAt !== 'string'
  ) {
    return null;
  }

  const normalized = {
    seq: event.seq,
    id: event.id,
    origin: event.origin,
    role: event.role,
    type: 'text',
    text: event.text,
    createdAt: event.createdAt
  };
  if (event.origin === 'extension' && isSafeEventId(event.replyTo)) {
    normalized.replyTo = event.replyTo;
  }
  return normalized;
}
