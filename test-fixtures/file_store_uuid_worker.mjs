import { FileStore } from '../src/storage.js';

const [dataDir, uuid, eventId] = process.argv.slice(2);
const store = new FileStore({
  dataDir,
  lockTimeoutMs: 2_000,
  lockStaleMs: 10_000,
  lockRetryMs: 5
});

try {
  await store.withUuid(uuid, async (state, save) => {
    process.send?.({ type: 'entered', eventId });
    await waitForRelease();
    state.events.push({
      seq: state.nextSeq,
      id: eventId,
      origin: 'extension',
      role: 'user',
      type: 'text',
      text: eventId,
      createdAt: new Date().toISOString()
    });
    state.nextSeq += 1;
    await save();
    process.send?.({ type: 'saved', eventId });
  });
  await store.close();
  process.exit(0);
} catch (error) {
  process.send?.({ type: 'error', message: error?.message || 'worker failed' });
  process.exit(1);
}

function waitForRelease() {
  return new Promise((resolve) => {
    process.on('message', function onMessage(message) {
      if (message?.type !== 'release') {
        return;
      }
      process.off('message', onMessage);
      resolve();
    });
  });
}
