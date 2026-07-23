import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { FileStore } from '../src/storage.js';

const UUID_A = '11111111-1111-4111-8111-111111111111';

test('FileStore derives bounded abstract socket addresses from canonical data directory and lock name', async (t) => {
  const dataDir = await tempDataDir(t);
  const linkPath = `${dataDir}-alias`;
  await symlink(dataDir, linkPath);
  t.after(() => rm(linkPath, { force: true }));

  const store = new FileStore({ dataDir });
  const aliasStore = new FileStore({ dataDir: linkPath });
  const address = await store.socketAddressFor('global-address-check');

  assert.equal(address[0], '\0');
  assert.ok(Buffer.byteLength(address, 'utf8') < 108);
  assert.equal(address, await aliasStore.socketAddressFor('global-address-check'));
  assert.notEqual(address, await store.socketAddressFor('global-other-name'));
  assert.equal(address.includes(dataDir), false);
  assert.equal(address.includes('global-address-check'), false);
  await assertNoLockArtifacts(dataDir);
});

test('FileStore serializes per-UUID mutations across separate Node processes with abstract socket locks', async (t) => {
  const dataDir = await tempDataDir(t);
  const first = forkUuidWorker(t, dataDir, UUID_A, 'process-one');
  await waitForWorkerMessage(first, 'entered');

  const second = forkUuidWorker(t, dataDir, UUID_A, 'process-two');
  let secondEntered = false;
  const secondEnteredPromise = waitForWorkerMessage(second, 'entered').then((message) => {
    secondEntered = true;
    return message;
  });

  await delay(100);
  assert.equal(secondEntered, false);

  const firstSavedPromise = waitForWorkerMessage(first, 'saved');
  first.send({ type: 'release' });
  await firstSavedPromise;

  await secondEnteredPromise;
  const secondSavedPromise = waitForWorkerMessage(second, 'saved');
  second.send({ type: 'release' });
  await secondSavedPromise;
  await Promise.all([waitForWorkerExit(first), waitForWorkerExit(second)]);

  const state = JSON.parse(await readFile(join(dataDir, `${UUID_A}.json`), 'utf8'));
  assert.deepEqual(state.events.map((event) => event.id), ['process-one', 'process-two']);
  assert.deepEqual(state.events.map((event) => event.seq), [1, 2]);
  await assertNoLockArtifacts(dataDir);
});

test('FileStore releases an abstract socket lock when the owning process is SIGKILLed', async (t) => {
  const dataDir = await tempDataDir(t);
  const holder = forkUuidWorker(t, dataDir, UUID_A, 'killed-holder');
  await waitForWorkerMessage(holder, 'entered');

  const waiter = forkUuidWorker(t, dataDir, UUID_A, 'after-sigkill', { lockTimeoutMs: 2_000 });
  const waiterEntered = waitForWorkerMessage(waiter, 'entered');
  await delay(100);

  holder.kill('SIGKILL');
  await waitForWorkerKilled(holder, 'SIGKILL');
  await waiterEntered;

  const waiterSaved = waitForWorkerMessage(waiter, 'saved');
  waiter.send({ type: 'release' });
  await waiterSaved;
  await waitForWorkerExit(waiter);

  const state = JSON.parse(await readFile(join(dataDir, `${UUID_A}.json`), 'utf8'));
  assert.deepEqual(state.events.map((event) => event.id), ['after-sigkill']);
  await assertNoLockArtifacts(dataDir);
});

test('FileStore prevents lost updates without stale lease recovery options', async (t) => {
  const dataDir = await tempDataDir(t);
  const slow = forkUuidWorker(t, dataDir, UUID_A, 'slow-holder', {
    lockTimeoutMs: 2_000,
    lockRetryMs: 5
  });
  await waitForWorkerMessage(slow, 'entered');

  const impatient = forkUuidWorker(t, dataDir, UUID_A, 'impatient-waiter', {
    lockTimeoutMs: 2_000,
    lockRetryMs: 5
  });
  let impatientEntered = false;
  const impatientEnteredPromise = waitForWorkerMessage(impatient, 'entered').then((message) => {
    impatientEntered = true;
    return message;
  });

  await delay(150);
  assert.equal(impatientEntered, false);

  const slowSaved = waitForWorkerMessage(slow, 'saved');
  slow.send({ type: 'release' });
  await slowSaved;

  await impatientEnteredPromise;
  const impatientSaved = waitForWorkerMessage(impatient, 'saved');
  impatient.send({ type: 'release' });
  await impatientSaved;
  await Promise.all([waitForWorkerExit(slow), waitForWorkerExit(impatient)]);

  const state = JSON.parse(await readFile(join(dataDir, `${UUID_A}.json`), 'utf8'));
  assert.deepEqual(state.events.map((event) => event.id), ['slow-holder', 'impatient-waiter']);
  assert.deepEqual(state.events.map((event) => event.seq), [1, 2]);
  await assertNoLockArtifacts(dataDir);
});

test('FileStore abstract socket acquisition has a bounded timeout and safe error', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'easyjobappschatbot-lock-test-'));
  const holder = new FileStore({ dataDir, lockTimeoutMs: 1_000, lockRetryMs: 5 });
  const contender = new FileStore({ dataDir, lockTimeoutMs: 75, lockRetryMs: 5 });
  const release = await holder.acquireSocketLock('global-timeout-check');
  let callbackRan = false;
  const startedAt = Date.now();

  try {
    await assert.rejects(
      contender.withGlobalLock('timeout-check', async () => {
        callbackRan = true;
      }),
      (error) => {
        assert.match(error.message, /abstract socket lock acquisition timed out/i);
        assert.doesNotMatch(String(error.stack), /sensitive-token|ownerNonce|heartbeat|flock|cat/i);
        return true;
      }
    );
  } finally {
    await release();
    await rm(dataDir, { recursive: true, force: true });
  }

  assert.equal(callbackRan, false);
  assert.ok(Date.now() - startedAt < 1_000);
});

test('FileStore abstract socket release is idempotent and exposes no helper close path', async (t) => {
  const dataDir = await tempDataDir(t);
  const holder = new FileStore({ dataDir, lockTimeoutMs: 1_000, lockRetryMs: 5 });
  const contender = new FileStore({ dataDir, lockTimeoutMs: 75, lockRetryMs: 5 });
  const release = await holder.acquireSocketLock('global-idempotent-release');

  assert.equal(release.helperPid, undefined);
  assert.deepEqual(Object.keys(release), []);
  await assert.rejects(
    contender.acquireSocketLock('global-idempotent-release'),
    /abstract socket lock acquisition timed out/i
  );

  await release();
  await release();

  const reacquired = await contender.acquireSocketLock('global-idempotent-release');
  await reacquired();
  await assertNoLockArtifacts(dataDir);
});

test('FileStore close does not release an in-flight abstract socket lock', async (t) => {
  const dataDir = await tempDataDir(t);
  const holder = new FileStore({ dataDir, lockTimeoutMs: 1_000, lockRetryMs: 5 });
  const contender = new FileStore({ dataDir, lockTimeoutMs: 75, lockRetryMs: 5 });
  const release = await holder.acquireSocketLock('global-no-external-close');

  await holder.close();
  await assert.rejects(
    contender.acquireSocketLock('global-no-external-close'),
    /abstract socket lock acquisition timed out/i
  );

  await release();
  const reacquired = await contender.acquireSocketLock('global-no-external-close');
  await reacquired();
  await assertNoLockArtifacts(dataDir);
});

test('FileStore rejects unsafe abstract socket lock names before creating lock artifacts', async (t) => {
  const dataDir = await tempDataDir(t);
  const store = new FileStore({ dataDir });

  await assert.rejects(
    store.acquireSocketLock('../bad-name'),
    /invalid lock name/
  );
  await assert.rejects(
    store.withGlobalLock('bad/name', async () => {}),
    /invalid lock name/
  );
  await assert.rejects(
    store.acquireSocketLock('x'.repeat(161)),
    /invalid lock name/
  );
  await assertNoLockArtifacts(dataDir);
});

test('FileStore namespaces abstract socket locks by canonical data directory', async (t) => {
  const dataDirA = await tempDataDir(t);
  const dataDirB = await tempDataDir(t);
  const storeA = new FileStore({ dataDir: dataDirA, lockTimeoutMs: 1_000 });
  const storeB = new FileStore({ dataDir: dataDirB, lockTimeoutMs: 1_000 });

  const releaseA = await storeA.acquireSocketLock('global-shared-name');
  const releaseB = await storeB.acquireSocketLock('global-shared-name');

  await releaseB();
  await releaseA();
  await assertNoLockArtifacts(dataDirA);
  await assertNoLockArtifacts(dataDirB);
});

async function tempDataDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'easyjobappschatbot-lock-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function assertNoLockArtifacts(dataDir) {
  await assert.rejects(readdir(join(dataDir, '.locks')), { code: 'ENOENT' });
}

function forkUuidWorker(t, dataDir, uuid, eventId, options = {}) {
  const workerPath = fileURLToPath(new URL('../test-fixtures/file_store_uuid_worker.mjs', import.meta.url));
  const child = fork(workerPath, [
    dataDir,
    uuid,
    eventId,
    String(options.lockTimeoutMs ?? 2_000),
    String(options.lockRetryMs ?? 5)
  ], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  });
  t.after(() => child.kill());
  return child;
}

function waitForWorkerMessage(child, type) {
  return new Promise((resolve, reject) => {
    const stderr = [];
    const onStderr = (chunk) => stderr.push(chunk.toString('utf8'));
    const cleanup = () => {
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.stderr?.off('data', onStderr);
    };
    const onMessage = (message) => {
      if (message?.type === 'error') {
        cleanup();
        reject(new Error(message.message));
        return;
      }
      if (message?.type === type) {
        cleanup();
        resolve(message);
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`worker exited before ${type}: ${code ?? signal}; ${stderr.join('')}`));
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.stderr?.on('data', onStderr);
  });
}

function waitForWorkerExit(child) {
  if (child.exitCode === 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`worker exited with ${code ?? signal}`));
    });
  });
}

function waitForWorkerKilled(child, expectedSignal) {
  if (child.signalCode === expectedSignal) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    child.once('exit', (code, signal) => {
      if (signal === expectedSignal) {
        resolve();
        return;
      }
      reject(new Error(`worker exited with ${code ?? signal}`));
    });
  });
}
