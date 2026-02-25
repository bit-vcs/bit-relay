# CI Trigger Specification

This document defines the CI trigger flow in bit-relay:

1. Relay receives `refs/relay/incoming/...` through `git-receive-pack`
2. Relay dispatches an external webhook event
3. External CI posts the result back to relay
4. Clients consume CI results from relay APIs

## 1. Trigger Source

Incoming refs are extracted from `POST /git/<session_id>/git-receive-pack` request bodies.

- Matching pattern: `refs/relay/incoming/[A-Za-z0-9._/-]{1,255}`
- Duplicate refs in the same request body are deduplicated
- For each unique incoming ref, relay emits one `incoming_ref` event

## 2. Webhook Dispatch Conditions

Relay dispatches a webhook only when all of the following are true:

- `RELAY_TRIGGER_WEBHOOK_URL` is configured
- Incoming ref matches one of configured prefixes
- Relay responded to `git-receive-pack` with a 2xx status

Configuration:

- `RELAY_TRIGGER_WEBHOOK_URL`: destination URL
- `RELAY_TRIGGER_WEBHOOK_TOKEN`: optional bearer token
- `RELAY_TRIGGER_EVENT_TYPE`: default `relay.incoming_ref`
- `RELAY_TRIGGER_REF_PREFIXES`: CSV list, default `refs/relay/incoming/`

Dispatch result behavior:

- Any 2xx is treated as success
- Non-2xx or network errors are logged as trigger dispatch failures
- If `git-receive-pack` returns non-2xx, relay does not emit incoming-ref webhooks

## 3. Outbound Webhook Payload

Relay sends `POST <RELAY_TRIGGER_WEBHOOK_URL>` with JSON body:

```json
{
  "event_type": "relay.incoming_ref",
  "event_id": "evt-...",
  "occurred_at": 1700000000,
  "room": "main",
  "source": "deno:127.0.0.1:8788",
  "target": "session:<session_id>",
  "ref": "refs/relay/incoming/repo-ci"
}
```

If `RELAY_TRIGGER_WEBHOOK_TOKEN` is set, relay adds:

```text
Authorization: Bearer <token>
```

## 4. CI Callback API

External CI should report results to:

- `POST /api/v1/trigger/callback`

Required fields:

- `ref` (string)
- `status` (string)

Optional fields:

- `room`
- `logs_url`
- `artifact_url`
- `external_id`
- `provider`
- `id`

Room resolution:

- If `room` is provided: use it
- Else if `ref` starts with `refs/relay/incoming/<room>/...`: use that first `<room>` segment
- Else: fallback to `main`

Published envelope:

- `topic`: `ci.result`
- `sender`: `ci:callback`
- payload includes `ref`, `status`, `logs_url`, `artifact_url`, `external_id`, `provider`,
  `received_at`

## 5. Reading CI Results

Two APIs are available:

- `GET /api/v1/trigger/results?room=<room>&after=<cursor>&limit=<n>`
- `GET /api/v1/poll?room=<room>&after=<cursor>&limit=<n>` (includes `ci.result` in room timeline)

## 6. Auth and Room Token Rules

- If `BIT_RELAY_AUTH_TOKEN` is configured, `/api/v1/trigger/*` requires Bearer auth
- If a room token is configured for the room, callback/results access must include `x-room-token`
  header or `room_token` query param

## 7. Verification Commands

Use the existing integration tests:

```bash
deno test --allow-net --allow-env tests/trigger_incoming_ref_integration_test.ts
deno test --allow-net --allow-env tests/trigger_callback_test.ts
```
