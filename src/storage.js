import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, open, readdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { isSafeEventId, validateUuid } from './validation.js';

const STATE_VERSION = 1;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_MS = 25;
const LOCK_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,160}$/;
const ABSTRACT_SOCKET_PREFIX = 'easyjobappschatbot:v1:';
const LINUX_SOCKADDR_UN_PATH_BYTES = 108;
const MIN_NODE_MAJOR_FOR_ABSTRACT_LOCKS = 22;

export class FileStore {
  constructor({ dataDir, lockTimeoutMs, lockRetryMs } = {}) {
    if (!dataDir || typeof dataDir !== 'string') {
      throw new Error('dataDir is required');
    }
    this.dataDir = resolve(dataDir);
    this.queues = new Map();
    this.lockTimeoutMs = positiveIntegerOrDefault(lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
    this.lockRetryMs = positiveIntegerOrDefault(lockRetryMs, DEFAULT_LOCK_RETRY_MS);
  }

  async close() {}

  async withUuid(uuidInput, callback) {
    const uuid = validateUuid(uuidInput);
    return this.withQueue(`uuid:${uuid}`, () => this.withSocketLock(`uuid-${uuid}`, async () => {
      const state = await this.readState(uuid);
      const save = async () => {
        await this.writeStateUnlocked(uuid, state);
      };
      return callback(state, save);
    }));
  }

  async withGlobalLock(name, callback) {
    const lockName = validateLockName(`global-${name}`);
    return this.withQueue(lockName, () => this.withSocketLock(lockName, callback));
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
    return this.withQueue(`uuid:${uuid}`, () => this.withSocketLock(`uuid-${uuid}`, () => this.writeStateUnlocked(uuid, state)));
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

  async withSocketLock(lockNameInput, callback) {
    const release = await this.acquireSocketLock(lockNameInput);
    try {
      return await callback();
    } finally {
      await release();
    }
  }

  async acquireSocketLock(lockNameInput) {
    const lockName = validateLockName(lockNameInput);
    const address = await this.socketAddressFor(lockName);
    return acquireAbstractSocketLock(address, this.lockTimeoutMs, this.lockRetryMs);
  }

  async socketAddressFor(lockNameInput) {
    const lockName = validateLockName(lockNameInput);
    await this.ensureDir();
    const canonicalDataDir = await realpath(this.dataDir);
    return makeAbstractSocketAddress(canonicalDataDir, lockName);
  }
}

async function acquireAbstractSocketLock(address, timeoutMs, retryMs) {
  assertAbstractSocketRuntimeSupported();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const server = await listenOnAbstractSocket(address);
      return makeSocketRelease(server);
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') {
        throw safeLockError('abstract socket lock acquisition failed', 'ELOCKFAILED');
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw safeLockError('abstract socket lock acquisition timed out', 'ELOCKTIMEDOUT');
      }
      await delay(Math.min(retryMs, remainingMs));
    }
  }
}

function assertAbstractSocketRuntimeSupported() {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (process.platform !== 'linux' || !Number.isSafeInteger(nodeMajor) || nodeMajor < MIN_NODE_MAJOR_FOR_ABSTRACT_LOCKS) {
    throw safeLockError('abstract socket locks require Node.js 22 or newer on Linux', 'ELOCKUNSUPPORTED');
  }
}

function listenOnAbstractSocket(address) {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      socket.destroy();
    });
    let settled = false;

    const cleanup = () => {
      server.off('error', onError);
      server.off('listening', onListening);
    };
    const onError = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const onListening = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(server);
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(address);
  });
}

function makeSocketRelease(server) {
  let releasePromise = null;
  return () => {
    releasePromise ??= closeSocketServer(server);
    return releasePromise;
  };
}

function closeSocketServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (!error || error.code === 'ERR_SERVER_NOT_RUNNING') {
        resolve();
        return;
      }
      reject(safeLockError('abstract socket lock release failed', 'ELOCKRELEASEFAILED'));
    });
  });
}

function makeAbstractSocketAddress(canonicalDataDir, lockName) {
  const digest = createHash('sha256')
    .update(JSON.stringify([canonicalDataDir, lockName]))
    .digest('hex');
  const address = `\0${ABSTRACT_SOCKET_PREFIX}${digest}`;
  if (Buffer.byteLength(address, 'utf8') >= LINUX_SOCKADDR_UN_PATH_BYTES) {
    throw safeLockError('abstract socket lock address is too long', 'ELOCKNAMETOOLONG');
  }
  return address;
}

function safeLockError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
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
    throw new Error('invalid lock name');
  }
  return value;
}
