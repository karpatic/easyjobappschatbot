import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { isSafeEventId, validateUuid } from './validation.js';

const STATE_VERSION = 1;
const LOCK_DIR_NAME = '.locks';
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_RETRY_MS = 20;
const MIN_LOCK_HEARTBEAT_MS = 1_000;
const LOCK_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,160}$/;

export class FileStore {
  constructor({ dataDir, lockTimeoutMs, lockStaleMs, lockRetryMs } = {}) {
    if (!dataDir || typeof dataDir !== 'string') {
      throw new Error('dataDir is required');
    }
    this.dataDir = resolve(dataDir);
    this.queues = new Map();
    this.lockTimeoutMs = positiveIntegerOrDefault(lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
    this.lockStaleMs = positiveIntegerOrDefault(lockStaleMs, DEFAULT_LOCK_STALE_MS);
    this.lockRetryMs = positiveIntegerOrDefault(lockRetryMs, DEFAULT_LOCK_RETRY_MS);
  }

  async close() {}

  async withUuid(uuidInput, callback) {
    const uuid = validateUuid(uuidInput);
    return this.withQueue(`uuid:${uuid}`, () => this.withFilesystemLock(`uuid-${uuid}`, async () => {
      const state = await this.readState(uuid);
      const save = async () => {
        await this.writeStateUnlocked(uuid, state);
      };
      return callback(state, save);
    }));
  }

  async withGlobalLock(name, callback) {
    const lockName = validateLockName(`global-${name}`);
    return this.withQueue(lockName, () => this.withFilesystemLock(lockName, callback));
  }

  withQueue(key, callback) {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(callback);

    const queued = current.catch(() => undefined).finally(() => {
      if (this.queues.get(key) === queued) {
        this.queues.delete(key);
      }
    });
    this.queues.set(key, queued);

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
    return this.withQueue(`uuid:${uuid}`, () => this.withFilesystemLock(`uuid-${uuid}`, () => this.writeStateUnlocked(uuid, state)));
  }

  async writeStateUnlocked(uuidInput, state) {
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

  async ensureLockDir() {
    await this.ensureDir();
    await mkdir(this.lockRoot(), { recursive: true, mode: 0o700 });
  }

  lockRoot() {
    return join(this.dataDir, LOCK_DIR_NAME);
  }

  lockDirFor(lockNameInput) {
    const lockName = validateLockName(lockNameInput);
    return join(this.lockRoot(), `${lockName}.lock`);
  }

  async withFilesystemLock(lockNameInput, callback) {
    const release = await this.acquireFilesystemLock(lockNameInput);
    try {
      return await callback();
    } finally {
      await release();
    }
  }

  async acquireFilesystemLock(lockNameInput) {
    const lockName = validateLockName(lockNameInput);
    await this.ensureLockDir();
    const lockDir = this.lockDirFor(lockName);
    const deadline = Date.now() + this.lockTimeoutMs;

    for (;;) {
      try {
        await mkdir(lockDir, { mode: 0o700 });
        return await this.activateFilesystemLock(lockDir);
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          throw error;
        }
      }

      const recoveredStaleLock = await this.recoverStaleLock(lockDir);
      if (recoveredStaleLock && Date.now() <= deadline) {
        continue;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error('filesystem lock acquisition timed out');
      }
      await delay(Math.min(this.lockRetryMs, remainingMs));
    }
  }

  async activateFilesystemLock(lockDir) {
    const ownerFile = join(lockDir, 'owner.json');
    const acquiredAt = new Date().toISOString();
    const makeOwner = () => `${JSON.stringify({
      pid: process.pid,
      acquiredAt,
      heartbeatAt: new Date().toISOString()
    }, null, 2)}\n`;

    try {
      await writeFile(ownerFile, makeOwner(), { mode: 0o600 });
    } catch (error) {
      await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }

    let released = false;
    const heartbeatMs = Math.max(MIN_LOCK_HEARTBEAT_MS, Math.floor(this.lockStaleMs / 3));
    const heartbeat = setInterval(() => {
      writeFile(ownerFile, makeOwner(), { mode: 0o600 }).catch(() => undefined);
    }, heartbeatMs);
    heartbeat.unref?.();

    return async () => {
      if (released) {
        return;
      }
      released = true;
      clearInterval(heartbeat);
      await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
    };
  }

  async recoverStaleLock(lockDir) {
    let lockStat;
    try {
      lockStat = await stat(join(lockDir, 'owner.json'));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        try {
          lockStat = await stat(lockDir);
        } catch (statError) {
          if (statError?.code === 'ENOENT') {
            return true;
          }
          throw statError;
        }
      } else {
        throw error;
      }
    }

    if (Date.now() - lockStat.mtimeMs < this.lockStaleMs) {
      return false;
    }

    try {
      await rm(lockDir, { recursive: true, force: true });
      return true;
    } catch (error) {
      return error?.code === 'ENOENT';
    }
  }
}

export function newState(uuidInput) {
  const uuid = validateUuid(uuidInput);
  return {
    version: STATE_VERSION,
    uuid,
    linkToken: null,
    tokenConsumedAt: null,
    telegramLinkConfirmedAt: null,
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
    telegramLinkConfirmedAt: typeof state?.telegramLinkConfirmedAt === 'string' ? state.telegramLinkConfirmedAt : null,
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

function positiveIntegerOrDefault(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function validateLockName(value) {
  if (typeof value !== 'string' || !LOCK_NAME_PATTERN.test(value)) {
    throw new Error('invalid filesystem lock name');
  }
  return value;
}
