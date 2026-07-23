# easyjobappschatbot

`easyjobappschatbot` is a narrow Node.js relay between the Easy Job Apps Chrome extension and Telegram. It does not call OpenAI APIs, load OpenAI SDKs, or store OpenAI keys. Runtime secrets are read only from environment variables, optionally loaded from `CHATBOT_ENV_FILE`.

## Architecture

- **HTTP only, no framework dependency:** the service uses Node's built-in `http` module and `node:test`.
- **Durable per-UUID state:** each UUID v4 gets one JSON file at `${CHATBOT_DATA_DIR}/${uuid}.json`.
- **Atomic persistence:** state writes go to a temporary file in the data directory, fsync the file, then rename over the UUID JSON file.
- **Per-UUID serialization:** all mutations for a UUID run through an in-process promise queue to avoid lost updates under concurrent syncs.
- **Private Telegram binding:** `/v1/link` returns a deep link for `EasyJobAppsBot`; the Telegram chat ID is stored only in the UUID state file and is never returned by the public API.
- **No-store responses:** all responses include `Cache-Control: no-store`.
- **Bounded JSON bodies:** request bodies default to `65536` bytes and can be lowered or raised with `CHATBOT_BODY_LIMIT_BYTES`.

## API

All POST endpoints require `Content-Type: application/json`.

### `GET /health`

Returns:

```json
{ "ok": true }
```

### `POST /v1/link`

Creates or returns the stable one-time Telegram deep link for a UUID v4.

Request:

```json
{ "uuid": "11111111-1111-4111-8111-111111111111" }
```

Response:

```json
{
  "uuid": "11111111-1111-4111-8111-111111111111",
  "telegramLink": "https://t.me/EasyJobAppsBot?start=<one-time-token>"
}
```

The token binds on the first Telegram `/start <token>` received by the webhook. Later attempts to reuse the same token do not rebind it.

### `POST /v1/sync`

Accepts an idempotent batch of extension-origin events and returns all events after the supplied sequence cursor.

Request:

```json
{
  "uuid": "11111111-1111-4111-8111-111111111111",
  "after": 0,
  "events": [
    {
      "id": "extension-event-1",
      "replyTo": "previous-extension-event",
      "role": "assistant",
      "type": "text",
      "text": "Message for Telegram"
    }
  ]
}
```

Response:

```json
{
  "uuid": "11111111-1111-4111-8111-111111111111",
  "cursor": 1,
  "events": [
    {
      "seq": 1,
      "id": "extension-event-1",
      "origin": "extension",
      "replyTo": "previous-extension-event",
      "role": "assistant",
      "type": "text",
      "text": "Message for Telegram",
      "createdAt": "2026-07-23T00:00:00.000Z"
    }
  ]
}
```

Duplicate event IDs are ignored, so retrying the same batch is safe. A linked UUID with `TELEGRAM_BOT_TOKEN` configured sends new extension-origin `assistant` text events to the bound Telegram chat.

Limits:

- Maximum events per batch: `50`
- Maximum event text length: `4096` characters
- Event IDs and optional extension `replyTo` IDs: `1-128` characters using letters, numbers, `.`, `_`, `:`, or `-`

### `POST /v1/reset`

Clears the UUID's events while preserving the Telegram link and binding.

Request:

```json
{ "uuid": "11111111-1111-4111-8111-111111111111" }
```

Response:

```json
{
  "ok": true,
  "uuid": "11111111-1111-4111-8111-111111111111",
  "telegramLink": "https://t.me/EasyJobAppsBot?start=<same-one-time-token>"
}
```

### `POST /telegram/webhook`

Receives Telegram updates. If `TELEGRAM_WEBHOOK_SECRET` is configured, the request must include:

```http
X-Telegram-Bot-Api-Secret-Token: <configured-secret>
```

Supported update behavior:

- `/start <token>` binds the one-time token to that Telegram chat if it has not already been consumed.
- Later Telegram text from a bound chat is appended as an `origin: "telegram"`, `role: "user"` event.
- Unknown chats, invalid tokens, non-text messages, and duplicate Telegram message IDs are acknowledged but ignored.

## Configuration

Create an untracked env file from `.env.example`, then either export its values or start the process with `CHATBOT_ENV_FILE=/path/to/file`.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `CHATBOT_DATA_DIR` | Yes | none | Directory for per-UUID JSON state files. |
| `TELEGRAM_BOT_USERNAME` | No | `EasyJobAppsBot` | Bot username used in generated deep links. |
| `TELEGRAM_BOT_TOKEN` | No | none | Bot API token used only for outbound Telegram delivery. |
| `TELEGRAM_WEBHOOK_SECRET` | No | none | Secret expected in Telegram webhook requests. |
| `CHATBOT_ALLOWED_ORIGINS` | No | none | Comma-separated exact CORS origins. Chrome extension origins are allowed by pattern. |
| `CHATBOT_BODY_LIMIT_BYTES` | No | `65536` | Maximum JSON request body size in bytes. |
| `HOST` | No | `0.0.0.0` | Listen host. |
| `PORT` | No | `3000` | Listen port. |

## Local Development

```sh
npm test
CHATBOT_ENV_FILE=.env node src/index.js
```

This repository intentionally has no runtime npm dependencies.

## Deployment

1. Run Node.js 18 or newer.
2. Create a persistent, private `CHATBOT_DATA_DIR`.
3. Set `TELEGRAM_BOT_TOKEN` only in the runtime environment or an untracked env file.
4. Set `TELEGRAM_WEBHOOK_SECRET` to a random value and configure Telegram's webhook with the same secret token.
5. Put the service behind HTTPS before registering the Telegram webhook.
6. Run `npm test` in CI before deployment.

The service handles `SIGINT` and `SIGTERM` by closing the HTTP server and storage hooks before exiting.
