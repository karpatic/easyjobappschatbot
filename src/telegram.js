const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export class TelegramClient {
  constructor({ botToken = null, transport = defaultTransport, requestTimeoutMs } = {}) {
    this.botToken = botToken || null;
    this.transport = transport;
    this.requestTimeoutMs = positiveIntegerOrDefault(requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  }

  get configured() {
    return Boolean(this.botToken);
  }

  async sendText(chatId, text, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (!this.configured) {
      return { sent: false, skipped: true };
    }

    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const controller = new AbortController();
    await withTimeout(() => this.transport({
      method: 'POST',
      url,
      signal: controller.signal,
      body: {
        chat_id: chatId,
        text,
        disable_web_page_preview: true
      }
    }), positiveIntegerOrDefault(timeoutMs, this.requestTimeoutMs), () => controller.abort(), 'telegram_request_timeout');
    return { sent: true };
  }
}

async function defaultTransport(request) {
  const response = await fetch(request.url, {
    method: request.method,
    signal: request.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request.body)
  });
  if (!response.ok) {
    throw new Error(`telegram_request_failed:${response.status}`);
  }
  const body = await response.json();
  if (!body?.ok) {
    throw new Error('telegram_response_not_ok');
  }
  return body;
}

async function withTimeout(operation, timeoutMs, onTimeout, message) {
  let timedOut = false;
  let timer;
  try {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        onTimeout?.();
      } catch {
        // The transport promise still owns the final outcome after timeout.
      }
    }, timeoutMs);
    const result = await operation();
    if (timedOut) {
      throw new Error(message);
    }
    return result;
  } catch (error) {
    if (timedOut) {
      throw new Error(message, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function positiveIntegerOrDefault(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
