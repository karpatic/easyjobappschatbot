import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadEnvFile(filePath = process.env.CHATBOT_ENV_FILE) {
  if (!filePath) {
    return;
  }
  const content = readFileSync(resolve(filePath), 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) {
      continue;
    }
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) {
      continue;
    }
    process.env[key] = unquoteEnvValue(rawValue.trim());
  }
}

export function configFromEnv(env = process.env) {
  if (!env.CHATBOT_DATA_DIR) {
    throw new Error('CHATBOT_DATA_DIR is required');
  }

  return {
    host: env.HOST || '0.0.0.0',
    port: parsePort(env.PORT || '3000'),
    dataDir: env.CHATBOT_DATA_DIR,
    botUsername: env.TELEGRAM_BOT_USERNAME || 'EasyJobAppsBot',
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || null,
    telegramWebhookSecret: env.TELEGRAM_WEBHOOK_SECRET || null,
    allowedOrigins: splitList(env.CHATBOT_ALLOWED_ORIGINS),
    bodyLimitBytes: parsePositiveInteger(env.CHATBOT_BODY_LIMIT_BYTES, 64 * 1024)
  };
}

function splitList(value) {
  if (!value) {
    return [];
  }
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function parsePort(value) {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }
  return port;
}

function parsePositiveInteger(value, fallback) {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('CHATBOT_BODY_LIMIT_BYTES must be a positive integer');
  }
  return parsed;
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
