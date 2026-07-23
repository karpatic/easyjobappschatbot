import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { configFromEnv, loadEnvFile } from '../src/config.js';

test('CHATBOT_ENV_FILE style files load runtime settings without overriding existing env', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'easyjobappschatbot-env-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const envFile = join(dir, '.env');
  await writeFile(envFile, [
    'CHATBOT_DATA_DIR=/tmp/chatbot-data-placeholder',
    'PORT=4567',
    'TELEGRAM_BOT_TOKEN=placeholder-from-file',
    'TELEGRAM_WEBHOOK_SECRET=placeholder-secret'
  ].join('\n'));

  const previous = {
    CHATBOT_DATA_DIR: process.env.CHATBOT_DATA_DIR,
    PORT: process.env.PORT,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET
  };
  t.after(() => {
    restoreEnv(previous);
  });

  delete process.env.CHATBOT_DATA_DIR;
  process.env.PORT = '9999';
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_WEBHOOK_SECRET;

  loadEnvFile(envFile);
  const config = configFromEnv();
  assert.equal(config.dataDir, '/tmp/chatbot-data-placeholder');
  assert.equal(config.port, 9999);
  assert.equal(config.telegramBotToken, 'placeholder-from-file');
  assert.equal(config.telegramWebhookSecret, 'placeholder-secret');
});

function restoreEnv(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
