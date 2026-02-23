# Hosting bit-relay on Cloudflare Workers

This guide explains how to deploy your own bit-relay instance on Cloudflare Workers.

The public instance (`bit-relay.mizchi.workers.dev`) runs without API authentication so that anyone can participate in the P2P network. If you need a private relay for your team, deploy your own and configure `BIT_RELAY_AUTH_TOKEN`.

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

This runs `wrangler deploy`, which deploys `src/cloudflare_worker.ts` as a Cloudflare Worker with two Durable Objects:

- **RelayRoom** — handles relay messaging, pub/sub, and key verification per room
- **GitServeSession** — manages git serve sessions for relay-based cloning

After deployment, your relay will be available at `https://<your-worker>.workers.dev`.

## Configuration

All configuration is done via environment variables (set in the Cloudflare dashboard or via `wrangler secret`).

### Authentication

| Variable | Description | Default |
|----------|-------------|---------|
| `BIT_RELAY_AUTH_TOKEN` | Bearer token for API authentication. When set, all `/api/v1/*` and `/ws` requests require this token. Leave unset for a public relay. | (none, open) |

### Signature Verification

| Variable | Description | Default |
|----------|-------------|---------|
| `RELAY_REQUIRE_SIGNATURE` | Require Ed25519 signatures on publish | `true` |
| `RELAY_MAX_CLOCK_SKEW_SEC` | Max allowed clock skew for signatures | `300` |
| `RELAY_NONCE_TTL_SEC` | Nonce time-to-live for replay protection | `600` |
| `RELAY_MAX_NONCES_PER_SENDER` | Max stored nonces per sender | `2048` |

### Rate Limiting

| Variable | Description | Default |
|----------|-------------|---------|
| `RELAY_PUBLISH_LIMIT_PER_WINDOW` | Max publishes per sender per window | (built-in default) |
| `RELAY_PUBLISH_WINDOW_MS` | Rate limit window duration (ms) | (built-in default) |
| `RELAY_IP_PUBLISH_LIMIT_PER_WINDOW` | Max publishes per IP per window | (built-in default) |
| `RELAY_ROOM_PUBLISH_LIMIT_PER_WINDOW` | Max publishes per room per window | (built-in default) |
| `PUBLISH_PAYLOAD_MAX_BYTES` | Max payload size per publish | (built-in default) |

### Rooms and Sessions

| Variable | Description | Default |
|----------|-------------|---------|
| `RELAY_MAX_MESSAGES_PER_ROOM` | Max stored messages per room | (built-in default) |
| `RELAY_ROOM_TOKENS` | JSON object mapping room names to tokens | `{}` |
| `RELAY_PRESENCE_TTL_SEC` | Presence heartbeat TTL | (built-in default) |
| `GIT_SERVE_SESSION_TTL_SEC` | Git serve session TTL (0 = no expiry) | `0` |

### WebSocket

| Variable | Description | Default |
|----------|-------------|---------|
| `MAX_WS_SESSIONS` | Max concurrent WebSocket connections | (built-in default) |
| `WS_PING_INTERVAL_SEC` | WebSocket ping interval | (built-in default) |
| `WS_IDLE_TIMEOUT_SEC` | WebSocket idle timeout | (built-in default) |

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

Each room and git serve session runs in its own Durable Object, providing strong consistency and automatic scaling.
