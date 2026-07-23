export class TelegramClient {
  constructor({ botToken = null, transport = defaultTransport } = {}) {
    this.botToken = botToken || null;
    this.transport = transport;
  }

  get configured() {
    return Boolean(this.botToken);
  }

  async sendText(chatId, text) {
    if (!this.configured) {
      return { sent: false, skipped: true };
    }

    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    await this.transport({
      method: 'POST',
      url,
      body: {
        chat_id: chatId,
        text,
        disable_web_page_preview: true
      }
    });
    return { sent: true };
  }
}

async function defaultTransport(request) {
  const response = await fetch(request.url, {
    method: request.method,
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
