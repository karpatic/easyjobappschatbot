# easyjobappschatbot

`easyjobappschatbot` is a narrow Node.js relay between the Easy Job Apps Chrome extension and Telegram. It does not call OpenAI APIs, load OpenAI SDKs, or store OpenAI keys. Runtime secrets are read only from environment variables, optionally loaded from `CHATBOT_ENV_FILE`.

## Architecture

- **HTTP only, no framework dependency:** the service uses Node's built-in `http` module and `node:test`.
- **Durable per-UUID state:** each UUID v4 gets one JSON file at `${CHATBOT_DATA_DIR}/${uuid}.json`.
- **Atomic persistence:** state writes go to a temporary file in the data directory, fsync the file, then rename over the UUID JSON file.
- **Per-UUID serialization:** all mutations for a UUID run through a Node-held Linux abstract Unix-domain socket lock, plus an in-process promise queue, to avoid lost updates across relay instances sharing a data directory on one host.
- **Private Telegram binding:** `/v1/link` returns a deep link for `EasyJobAppsBot` only when Telegram is fully configured; the Telegram chat ID is stored only in the UUID state file and is never returned by the public API.
- **Safe relinking:** `/v1/unlink` detaches the current Telegram chat, keeps conversation history, invalidates the old deep-link token, creates a fresh one-time token, and prevents older unsent assistant messages from being replayed to a future chat.
- **No-store responses:** all responses include `Cache-Control: no-store`.
- **Bounded JSON bodies:** request bodies default to `65536` bytes and can be lowered or raised with `CHATBOT_BODY_LIMIT_BYTES`.

## API

All POST endpoints require `Content-Type: application/json`.
The extension-facing POST endpoints use the validated UUID v4 in the JSON body as the existing bearer value. Treat UUIDs as private capability tokens.

### `GET /health`

Returns:

```json
{ "ok": true, "telegramReady": true }
```

`telegramReady` is `true` only when both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` are configured.

### `POST /v1/link`

Creates or returns the stable one-time Telegram deep link for a UUID v4. The relay returns a deep link only when Telegram is ready.

Request:

```json
{ "uuid": "11111111-1111-4111-8111-111111111111" }
```

Response:

```json
{
  "uuid": "11111111-1111-4111-8111-111111111111",
  "telegramReady": true,
  "telegramLinked": false,
  "telegramLink": "https://t.me/EasyJobAppsBot?start=<one-time-token>"
}
```

The token binds on the first Telegram `/start <token>` received by the webhook. Later attempts to reuse the same token do not rebind it.
`telegramLinked` is `true` only after that token has been consumed and the relay has stored the Telegram chat binding. It is never based on link creation alone.

If either `TELEGRAM_BOT_TOKEN` or `TELEGRAM_WEBHOOK_SECRET` is missing, the relay does not create or return a deep link:

```json
{
  "error": {
    "code": "telegram_unavailable",
    "message": "Telegram linking is unavailable"
  }
}
```

The unavailable response uses HTTP `503`.

### `POST /v1/unlink`

Detaches any currently bound Telegram chat for a UUID v4 and returns a fresh relink URL when Telegram is ready. Conversation events are preserved, but `telegramChatId` and `tokenConsumedAt` are cleared in storage. The previous deep-link token becomes invalid immediately.

Request:

```json
{ "uuid": "11111111-1111-4111-8111-111111111111" }
```

Response:

```json
{
  "uuid": "11111111-1111-4111-8111-111111111111",
  "telegramReady": true,
  "telegramLinked": false,
  "telegramLink": "https://t.me/EasyJobAppsBot?start=<fresh-one-time-token>"
}
```

After unlinking, messages from the old Telegram chat are ignored. A fresh `/start <fresh-one-time-token>` from another Telegram chat can bind the UUID again. Existing extension-origin assistant event IDs are marked delivered during unlink, so unsent assistant messages from before unlink are not replayed to the newly linked chat.
If Telegram is unavailable during unlink, the relay still detaches and rotates the token, but returns `"telegramLink": null` instead of an unusable deep link.

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
  "telegramReady": true,
  "telegramLinked": true,
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

Duplicate event IDs are ignored, so retrying the same batch is safe. A linked UUID with Telegram ready sends new extension-origin `assistant` text events to the bound Telegram chat. `/v1/sync` exposes only `telegramReady` and `telegramLinked`; it never returns the Telegram chat ID, bot token, or webhook secret.

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

Receives Telegram updates. The relay fails closed unless `TELEGRAM_WEBHOOK_SECRET` is configured, and every webhook request must include:

```http
X-Telegram-Bot-Api-Secret-Token: <configured-secret>
```

Supported update behavior:

- Only Telegram private chat updates are processed; group, supergroup, and channel updates are acknowledged but ignored.
- `/start <token>` binds the one-time token to that Telegram private chat if it has not already been consumed.
- A Telegram chat ID that is already bound to one UUID cannot bind to a second UUID; the second `/start` is acknowledged but ignored, and that token can still be used from another unbound chat.
- Later Telegram text from a bound chat is appended as an `origin: "telegram"`, `role: "user"` event.
- Unknown chats, invalid tokens, non-text messages, and duplicate Telegram message IDs are acknowledged but ignored.

## Security Notes

- Do not log, return, or expose `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, Telegram chat IDs, or deep-link tokens outside the link URL returned to the caller.
- Treat the UUID in extension API requests as a bearer value; send it only over HTTPS from trusted extension contexts.
- `/v1/unlink` rotates the deep-link token on every call, including already-unlinked UUIDs. Use the latest returned `telegramLink`; older links must be considered revoked.
- Telegram binding uses a cross-process global abstract socket lock so two relay instances sharing a data directory on the same host cannot bind the same private Telegram chat to different UUIDs.
- Storage locks use Node 22's `node:net` server handles on Linux abstract Unix-domain socket addresses derived from SHA-256 of the canonical `CHATBOT_DATA_DIR` and validated lock name. They do not create filesystem sockets, `.locks` entries, lock inodes, helper processes, heartbeats, or stale-lease recovery state. Lock ownership is released when the server handle closes or when the owning relay process exits, including `SIGKILL`.
- Lock coordination is single-host only. Relay processes on different hosts do not coordinate through shared storage, even if they point at the same network-mounted `CHATBOT_DATA_DIR`.
- `/v1/reset` intentionally keeps its existing semantics: it clears conversation events while preserving the current Telegram link and binding.

## Configuration

Create an untracked env file from `.env.example`, then either export its values or start the process with `CHATBOT_ENV_FILE=/path/to/file`.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `CHATBOT_DATA_DIR` | Yes | none | Directory for per-UUID JSON state files. |
| `TELEGRAM_BOT_USERNAME` | No | `EasyJobAppsBot` | Bot username used in generated deep links. |
| `TELEGRAM_BOT_TOKEN` | Required for Telegram linking | none | Bot API token used only for outbound Telegram delivery. Deep links are unavailable without it. |
| `TELEGRAM_WEBHOOK_SECRET` | Required for Telegram linking | none | Secret expected in Telegram webhook requests. Deep links are unavailable without it. |
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

Runtime prerequisites:

- Node.js 22 or newer on Linux with abstract Unix-domain socket support.

## Deployment

1. Run Node.js 22 or newer on Linux. Keep all relay instances that share one `CHATBOT_DATA_DIR` on the same host.
2. Create a persistent, private `CHATBOT_DATA_DIR`.
3. Set `TELEGRAM_BOT_TOKEN` only in the runtime environment or an untracked env file.
4. Set `TELEGRAM_WEBHOOK_SECRET` to a random value and configure Telegram's webhook with the same secret token.
5. Put the service behind HTTPS before registering the Telegram webhook.
6. Run `npm test` in CI before deployment.

Migration note: deploy this as a stop-the-world migration from versions that used legacy `.locks/*.lock` directory leases or `.locks/*.flock` files. Stop every old relay process before starting this version because the lock formats do not coordinate while mixed versions run. After the old processes are stopped, leftover `.locks` artifacts are inert and may be removed out of band.

The service handles `SIGINT` and `SIGTERM` by closing the HTTP server and storage hooks before exiting.
