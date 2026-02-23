#!/usr/bin/env bash
set -euo pipefail

# Integration test: distributed claim watch scenario
#
# Simulates two coding agents (alice, bob) working via a shared relay.
# One agent watches claims; the other publishes claim/unclaim events.
#
# Usage:
#   # Terminal 1: start relay (no signature required for local testing)
#   RELAY_REQUIRE_SIGNATURE=false just dev
#
#   # Terminal 2: run this test
#   tools/test-claim-watch.sh [relay-url]
#
# Requires: curl, websocat (for WS test)

BASE_URL="${1:-http://localhost:8788}"
BASE_URL="${BASE_URL%/}"
ROOM="test-claim-watch"

pass=0
fail=0

ok() {
  pass=$((pass + 1))
  echo "  ✓ $1"
}

ng() {
  fail=$((fail + 1))
  echo "  ✗ $1" >&2
}

check() {
  if [ "$2" = "$3" ]; then
    ok "$1"
  else
    ng "$1 (expected='$3', got='$2')"
  fi
}

check_contains() {
  if echo "$2" | grep -q "$3"; then
    ok "$1"
  else
    ng "$1 (expected to contain '$3', got='$2')"
  fi
}

cleanup_pids=()
cleanup() {
  for pid in "${cleanup_pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

# ------------------------------------------------------------------
# 1. Health check
# ------------------------------------------------------------------
echo "=== 1. Health check ==="
health=$(curl -fsS "$BASE_URL/health" 2>/dev/null || echo "FAIL")
if echo "$health" | grep -q '"status":"ok"'; then
  ok "relay is healthy"
else
  ng "relay is not healthy: $health"
  echo "Is relay running? Start with: RELAY_REQUIRE_SIGNATURE=false just dev" >&2
  exit 1
fi

# ------------------------------------------------------------------
# 2. Agent Alice publishes a claim (via HTTP publish API)
# ------------------------------------------------------------------
echo "=== 2. Alice claims issue-0001 ==="

TIMESTAMP=$(date +%s)
claim_payload=$(python3 -c "
import json
print(json.dumps({
    'type': 'work-item.claim',
    'issue_id': 'issue-0001',
    'action': 'claim',
    'claimer': 'alice',
    'timestamp': $TIMESTAMP
}))
")

publish_res=$(curl -fsS -X POST \
  "$BASE_URL/api/v1/publish?room=$ROOM&sender=alice&topic=work-item.claim&id=claim-alice-001" \
  -H "content-type: application/json" \
  -d "$claim_payload")

accepted=$(echo "$publish_res" | python3 -c "import sys,json; print(json.load(sys.stdin).get('accepted',''))" 2>/dev/null || echo "")
check "alice claim accepted" "$accepted" "True"

# ------------------------------------------------------------------
# 3. Agent Bob publishes another claim
# ------------------------------------------------------------------
echo "=== 3. Bob claims issue-0002 ==="

TIMESTAMP2=$((TIMESTAMP + 10))
claim_payload2=$(python3 -c "
import json
print(json.dumps({
    'type': 'work-item.claim',
    'issue_id': 'issue-0002',
    'action': 'claim',
    'claimer': 'bob',
    'timestamp': $TIMESTAMP2
}))
")

publish_res2=$(curl -fsS -X POST \
  "$BASE_URL/api/v1/publish?room=$ROOM&sender=bob&topic=work-item.claim&id=claim-bob-001" \
  -H "content-type: application/json" \
  -d "$claim_payload2")

accepted2=$(echo "$publish_res2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('accepted',''))" 2>/dev/null || echo "")
check "bob claim accepted" "$accepted2" "True"

# ------------------------------------------------------------------
# 4. Poll: verify both claims are visible
# ------------------------------------------------------------------
echo "=== 4. Poll: verify claims ==="

poll_res=$(curl -fsS "$BASE_URL/api/v1/poll?room=$ROOM&after=0&limit=100")
envelope_count=$(echo "$poll_res" | python3 -c "
import sys, json
data = json.load(sys.stdin)
envelopes = data.get('envelopes', [])
claims = [e for e in envelopes if e.get('topic') == 'work-item.claim']
print(len(claims))
" 2>/dev/null || echo "0")
check "poll returns 2 claim envelopes" "$envelope_count" "2"

next_cursor=$(echo "$poll_res" | python3 -c "import sys,json; print(json.load(sys.stdin).get('next_cursor',0))" 2>/dev/null || echo "0")
ok "cursor after initial poll: $next_cursor"

# ------------------------------------------------------------------
# 5. Alice unclaims issue-0001
# ------------------------------------------------------------------
echo "=== 5. Alice unclaims issue-0001 ==="

TIMESTAMP3=$((TIMESTAMP + 30))
unclaim_payload=$(python3 -c "
import json
print(json.dumps({
    'type': 'work-item.claim',
    'issue_id': 'issue-0001',
    'action': 'unclaim',
    'claimer': 'alice',
    'timestamp': $TIMESTAMP3
}))
")

publish_res3=$(curl -fsS -X POST \
  "$BASE_URL/api/v1/publish?room=$ROOM&sender=alice&topic=work-item.claim&id=unclaim-alice-001" \
  -H "content-type: application/json" \
  -d "$unclaim_payload")

accepted3=$(echo "$publish_res3" | python3 -c "import sys,json; print(json.load(sys.stdin).get('accepted',''))" 2>/dev/null || echo "")
check "alice unclaim accepted" "$accepted3" "True"

# ------------------------------------------------------------------
# 6. Incremental poll: only new messages after cursor
# ------------------------------------------------------------------
echo "=== 6. Incremental poll (cursor=$next_cursor) ==="

poll_res2=$(curl -fsS "$BASE_URL/api/v1/poll?room=$ROOM&after=$next_cursor&limit=100")
inc_count=$(echo "$poll_res2" | python3 -c "
import sys, json
data = json.load(sys.stdin)
envelopes = data.get('envelopes', [])
print(len(envelopes))
" 2>/dev/null || echo "0")
check "incremental poll returns 1 new envelope" "$inc_count" "1"

inc_action=$(echo "$poll_res2" | python3 -c "
import sys, json
data = json.load(sys.stdin)
envelopes = data.get('envelopes', [])
if envelopes:
    payload = envelopes[0].get('payload', {})
    print(payload.get('action', ''))
else:
    print('')
" 2>/dev/null || echo "")
check "incremental poll contains unclaim" "$inc_action" "unclaim"

# ------------------------------------------------------------------
# 7. WebSocket test (if websocat is available)
# ------------------------------------------------------------------
echo "=== 7. WebSocket broadcast test ==="

if command -v websocat &>/dev/null; then
  WS_URL=$(echo "$BASE_URL" | sed 's|^http://|ws://|;s|^https://|wss://|')

  # Connect WS client in background, capture messages
  # Use `sleep | websocat` to keep stdin open (prevents early close)
  ws_out=$(mktemp)
  sleep 30 | websocat "$WS_URL/ws?room=$ROOM" > "$ws_out" 2>/dev/null &
  ws_pid=$!
  cleanup_pids+=("$ws_pid")

  # Wait for ready
  sleep 1

  # Publish a new claim while WS is connected
  TIMESTAMP4=$((TIMESTAMP + 60))
  ws_claim=$(python3 -c "
import json
print(json.dumps({
    'type': 'work-item.claim',
    'issue_id': 'issue-0003',
    'action': 'claim',
    'claimer': 'charlie',
    'timestamp': $TIMESTAMP4
}))
")

  curl -fsS -X POST \
    "$BASE_URL/api/v1/publish?room=$ROOM&sender=charlie&topic=work-item.claim&id=claim-charlie-001" \
    -H "content-type: application/json" \
    -d "$ws_claim" >/dev/null

  # Wait for broadcast
  sleep 2

  kill "$ws_pid" 2>/dev/null || true
  wait "$ws_pid" 2>/dev/null || true

  ws_content=$(cat "$ws_out")
  rm -f "$ws_out"

  if echo "$ws_content" | grep -q "work-item.claim"; then
    ok "WS received claim broadcast"
  else
    ng "WS did not receive claim broadcast (got: $ws_content)"
  fi

  if echo "$ws_content" | grep -q "issue-0003"; then
    ok "WS broadcast contains issue-0003"
  else
    ng "WS broadcast missing issue-0003"
  fi

  if echo "$ws_content" | grep -q "charlie"; then
    ok "WS broadcast contains claimer charlie"
  else
    ng "WS broadcast missing claimer charlie"
  fi
else
  echo "  (skipped: websocat not installed. Install with: brew install websocat)"
fi

# ------------------------------------------------------------------
# 8. Duplicate publish (idempotency)
# ------------------------------------------------------------------
echo "=== 8. Duplicate publish test ==="

dup_res=$(curl -fsS -X POST \
  "$BASE_URL/api/v1/publish?room=$ROOM&sender=alice&topic=work-item.claim&id=claim-alice-001" \
  -H "content-type: application/json" \
  -d "$claim_payload")

dup_accepted=$(echo "$dup_res" | python3 -c "import sys,json; print(json.load(sys.stdin).get('accepted',''))" 2>/dev/null || echo "")
check "duplicate publish returns accepted=False" "$dup_accepted" "False"

# ------------------------------------------------------------------
# Summary
# ------------------------------------------------------------------
echo ""
echo "=== Results: $pass passed, $fail failed ==="
if [ "$fail" -gt 0 ]; then
  exit 1
fi
