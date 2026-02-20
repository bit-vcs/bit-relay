# bit-relay

`bit` / `bithub` 向けの独立 relay サーバー実装です。 MoonBit 生成物に依存せず、TypeScript
だけで動作します。

- local: Deno (`deno serve`)
- edge: Cloudflare Workers + Durable Object

## Endpoints

- `GET /health`
- `POST /api/v1/publish?room=<room>&sender=<sender>&topic=notify&id=<id>&sig=<sig?>`
- `GET /api/v1/poll?room=<room>&after=<cursor>&limit=<n>`
- `GET /api/v1/inbox/pending?room=<room>&consumer=<consumer>&limit=<n>`
- `POST /api/v1/inbox/ack?room=<room>&consumer=<consumer>`
- `GET /ws?room=<room>`
- `GET /api/v1/key/info?sender=<sender>`
- `POST /api/v1/key/rotate`

## Compatibility

- `bit hub sync` 向けに `payload.kind=hub.record` をそのまま保持
- `bithub` 互換として `{"payload": {...}}` のラップ形式も受理して展開
- room validation: `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`
- dedupe: room 内の同一 `id` は `accepted=false`

## Auth

`CLUSTER_API_TOKEN` を設定すると `/api/v1/*` と `/ws` で Bearer 認証を要求します。

```bash
export CLUSTER_API_TOKEN='secret-token'
```

## Signing / TOFU

`publish` はデフォルトで署名必須です（`RELAY_REQUIRE_SIGNATURE=true`）。

必要ヘッダ:

- `x-relay-public-key`: ed25519 公開鍵（base64url）
- `x-relay-signature`: 署名（base64url）
- `x-relay-timestamp`: Unix epoch seconds
- `x-relay-nonce`: nonce（再利用不可）

署名対象文字列 (`v1`):

```text
v1
sender=<sender>
room=<room>
id=<id>
topic=<topic>
ts=<timestamp>
nonce=<nonce>
payload_sha256=<sha256(canonical_json(payload))>
```

- `sender` ごとに公開鍵を TOFU で自動登録
- 以後、同じ `sender` で別公開鍵は `409 sender key mismatch`
- 同じ nonce 再利用は `409 replayed nonce`

### Key rotation

`POST /api/v1/key/rotate` body:

```json
{
  "sender": "alice",
  "new_public_key": "...base64url...",
  "ts": 1771599000,
  "nonce": "nonce-rotate-1",
  "old_signature": "...",
  "new_signature": "..."
}
```

署名対象文字列 (`v1`):

```text
v1
op=rotate
sender=<sender>
new_public_key=<new_public_key>
ts=<timestamp>
nonce=<nonce>
```

- `old_signature`: 現在の鍵で署名
- `new_signature`: 新しい鍵で署名

## Run Locally (Deno)

```bash
deno task dev
# default: http://127.0.0.1:8788
```

optional env:

- `HOST` (default: `127.0.0.1`)
- `PORT` (default: `8788`)
- `CLUSTER_API_TOKEN`
- `RELAY_MAX_MESSAGES_PER_ROOM` (default: `1000`)
- `PUBLISH_PAYLOAD_MAX_BYTES` (default: `65536`)
- `RELAY_PUBLISH_LIMIT_PER_WINDOW` (default: `30`)
- `RELAY_PUBLISH_WINDOW_MS` (default: `60000`)
- `RELAY_ROOM_TOKENS` (JSON, e.g. `{"secure":"token"}`)
- `MAX_WS_SESSIONS` (default: `100`)
- `RELAY_REQUIRE_SIGNATURE` (default: `true`)
- `RELAY_MAX_CLOCK_SKEW_SEC` (default: `300`)
- `RELAY_NONCE_TTL_SEC` (default: `600`)
- `RELAY_MAX_NONCES_PER_SENDER` (default: `2048`)

互換モード（従来の unsigned publish 許可）:

```bash
export RELAY_REQUIRE_SIGNATURE=false
```

## Run on Cloudflare

```bash
pnpm install
pnpm run dev:cf
pnpm run deploy
```

`wrangler.jsonc` は Durable Object `RelayRoom` を使用します。

## Basic checks

```bash
just test
```
