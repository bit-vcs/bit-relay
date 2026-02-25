# Hosting bit-relay on Cloudflare Workers

This guide explains how to deploy your own bit-relay instance on Cloudflare Workers.

The public instance (`bit-relay.mizchi.workers.dev`) runs without API authentication so that anyone
can participate in the P2P network. If you need a private relay for your team, deploy your own and
configure `BIT_RELAY_AUTH_TOKEN`.

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up)
- Node.js 18+ and pnpm
- Git

## Clone and Install

```bash
git clone https://github.com/bit-vcs/bit-relay.git
cd bit-relay
pnpm install
```

## Local Development

You can run the relay locally in two ways:

### Deno (in-memory, no Durable Objects)

```bash
deno task dev
# => http://127.0.0.1:8788
```

### Wrangler (Cloudflare Workers emulation)

```bash
pnpm run dev:cf
# => http://127.0.0.1:8787
```

Verify with:

```bash
curl http://127.0.0.1:8788/health
# => {"status":"ok","service":"bit-relay"}
```

## Deploy to Cloudflare

```bash
pnpm run deploy
```

This runs `wrangler deploy`, which deploys `src/cloudflare_worker.ts` as a Cloudflare Worker with
two Durable Objects:

- **RelayRoom** — handles relay messaging, pub/sub, and key verification per room
- **GitServeSession** — manages git serve sessions for relay-based cloning

After deployment, your relay will be available at `https://<your-worker>.workers.dev`.

## Configuration

All configuration is done via environment variables (set in the Cloudflare dashboard or via
`wrangler secret`).

### Authentication

| Variable                | Description                                                                                                                           | Default      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `BIT_RELAY_AUTH_TOKEN`  | Bearer token for API authentication. When set, all `/api/v1/*` and `/ws` requests require this token. Leave unset for a public relay. | (none, open) |
| `RELAY_PEER_AUTH_TOKEN` | Shared bearer token for relay-to-relay cache endpoints (`/api/v1/cache/exchange/*`, `/api/v1/cache/issues/*`).                        | (none)       |

### Signature Verification

| Variable                      | Description                              | Default |
| ----------------------------- | ---------------------------------------- | ------- |
| `RELAY_REQUIRE_SIGNATURE`     | Require Ed25519 signatures on publish    | `true`  |
| `RELAY_MAX_CLOCK_SKEW_SEC`    | Max allowed clock skew for signatures    | `300`   |
| `RELAY_NONCE_TTL_SEC`         | Nonce time-to-live for replay protection | `600`   |
| `RELAY_MAX_NONCES_PER_SENDER` | Max stored nonces per sender             | `2048`  |

### Rate Limiting

| Variable                              | Description                         | Default            |
| ------------------------------------- | ----------------------------------- | ------------------ |
| `RELAY_PUBLISH_LIMIT_PER_WINDOW`      | Max publishes per sender per window | (built-in default) |
| `RELAY_PUBLISH_WINDOW_MS`             | Rate limit window duration (ms)     | (built-in default) |
| `RELAY_IP_PUBLISH_LIMIT_PER_WINDOW`   | Max publishes per IP per window     | (built-in default) |
| `RELAY_ROOM_PUBLISH_LIMIT_PER_WINDOW` | Max publishes per room per window   | (built-in default) |
| `PUBLISH_PAYLOAD_MAX_BYTES`           | Max payload size per publish        | (built-in default) |

### Rooms and Sessions

| Variable                      | Description                                                    | Default            |
| ----------------------------- | -------------------------------------------------------------- | ------------------ |
| `RELAY_MAX_MESSAGES_PER_ROOM` | Max stored messages per room                                   | (built-in default) |
| `RELAY_ROOM_TOKENS`           | JSON object mapping room names to tokens                       | `{}`               |
| `RELAY_PRESENCE_TTL_SEC`      | Presence heartbeat TTL                                         | (built-in default) |
| `GIT_SERVE_SESSION_TTL_SEC`   | Git serve session TTL (0 = no expiry)                          | `0`                |
| `RELAY_ISSUE_SOURCE_OF_TRUTH` | Issue snapshot conflict policy (`last_write`, `github`, `bit`) | `last_write`       |

### WebSocket

| Variable               | Description                          | Default            |
| ---------------------- | ------------------------------------ | ------------------ |
| `MAX_WS_SESSIONS`      | Max concurrent WebSocket connections | (built-in default) |
| `WS_PING_INTERVAL_SEC` | WebSocket ping interval              | (built-in default) |
| `WS_IDLE_TIMEOUT_SEC`  | WebSocket idle timeout               | (built-in default) |

## Example: Setting Secrets

```bash
# Require API authentication (for private relays)
wrangler secret put BIT_RELAY_AUTH_TOKEN

# Disable signature requirement (for testing)
wrangler secret put RELAY_REQUIRE_SIGNATURE
# Enter: false

# Set a room token
wrangler secret put RELAY_ROOM_TOKENS
# Enter: {"my-room":"secret-token"}

# Set relay-to-relay shared token for cache exchange
wrangler secret put RELAY_PEER_AUTH_TOKEN
# Enter: <shared-token>
```

## Verify Deployment

```bash
curl https://<your-worker>.workers.dev/health
# => {"status":"ok","service":"bit-relay"}
```

Then use it with bit:

```bash
bit relay serve relay+https://<your-worker>.workers.dev
bit relay sync push relay+https://<your-worker>.workers.dev
```

## Runbook: Rotate `RELAY_PEER_AUTH_TOKEN`

Use this when peer cache APIs must be re-keyed without breaking relay operations.

### 1) Generate a new token

```bash
NEW_TOKEN="$(openssl rand -hex 32)"
echo "$NEW_TOKEN"
```

### 2) Update Cloudflare secret

```bash
printf '%s' "$NEW_TOKEN" | wrangler secret put RELAY_PEER_AUTH_TOKEN
```

### 3) Roll out to every peer relay

Every peer process must run with the same token value:

```bash
RELAY_PEER_AUTH_TOKEN="$NEW_TOKEN"
```

For this repository's helper scripts, include it in the relay start env (for example on
sprites/exe).

### 4) Verify auth boundary (must pass)

```bash
BASE="https://<relay>.workers.dev"

# no auth -> 401
curl -i "$BASE/api/v1/cache/exchange/discovery"

# with auth -> 200
curl -i -H "authorization: Bearer $NEW_TOKEN" \
  "$BASE/api/v1/cache/exchange/discovery"
```

Also verify issue cache API:

```bash
curl -i "$BASE/api/v1/cache/issues/pull?room=main&after=0&limit=1"
curl -i -H "authorization: Bearer $NEW_TOKEN" \
  "$BASE/api/v1/cache/issues/pull?room=main&after=0&limit=1"
```

### 5) Invalidate old token

After all peers are updated, old token requests must return `401`. Run a final check against known
peers and remove any leftover old-token env values.

## Architecture

```
Client (bit CLI)
  │
  ├── /api/v1/publish, /api/v1/subscribe, /ws
  │     └── Worker → RelayRoom (Durable Object, per room)
  │
  ├── /api/v1/serve/register, /poll, /respond
  │     └── Worker → GitServeSession (Durable Object, per session)
  │
  └── /git/<session_id>/...
        └── Worker → GitServeSession (Durable Object)
```

Each room and git serve session runs in its own Durable Object, providing strong consistency and
automatic scaling.
