# bit-relay

`bit` / `bithub` 向けの独立 relay サーバー実装です。\
MoonBit 生成物に依存せず、TypeScript だけで動作します。

- local: Deno (`deno serve`)
- edge: Cloudflare Workers + Durable Object

## Endpoints

- `GET /health`
- `POST /api/v1/publish?room=<room>&sender=<sender>&topic=notify&id=<id>&sig=<sig?>`
- `GET /api/v1/poll?room=<room>&after=<cursor>&limit=<n>`
- `GET /api/v1/inbox/pending?room=<room>&consumer=<consumer>&limit=<n>`
- `POST /api/v1/inbox/ack?room=<room>&consumer=<consumer>`
- `GET /ws?room=<room>`

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

## bit / bithub examples

```bash
# bit
bit hub sync push relay+http://127.0.0.1:8788
bit hub sync fetch relay+http://127.0.0.1:8788

# bithub
./bithub . --relay relay+http://127.0.0.1:8788
```
