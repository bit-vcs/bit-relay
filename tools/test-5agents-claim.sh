#!/usr/bin/env bash
set -euo pipefail

# Integration test: 5 coding agents in a distributed claim environment
#
# Simulates a team of 5 agents (alice, bob, charlie, dave, eve)
# working on issues via a shared relay. Tests concurrent claim/unclaim,
# WS broadcast ordering, conflict resolution, and stale detection.
#
# Usage:
#   # Terminal 1: start relay
#   RELAY_REQUIRE_SIGNATURE=false just dev
#
#   # Terminal 2: run this test
#   tools/test-5agents-claim.sh [relay-url]
#
# Requires: curl, websocat

BASE_URL="${1:-http://localhost:8788}"
BASE_URL="${BASE_URL%/}"
ROOM="test-5agents-$(date +%s)"
WS_URL=$(echo "$BASE_URL" | sed 's|^http://|ws://|;s|^https://|wss://|')

AGENTS=(alice bob charlie dave eve)

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

cleanup_pids=()
cleanup() {
  for pid in "${cleanup_pids[@]}"; do
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

publish_claim() {
  local sender="$1" issue="$2" action="$3" ts="$4" id="$5"
  local payload
  payload=$(python3 -c "
import json
print(json.dumps({
    'type': 'work-item.claim',
    'issue_id': '$issue',
    'action': '$action',
    'claimer': '$sender',
    'timestamp': $ts
}))
")
  curl -fsS -X POST \
    "$BASE_URL/api/v1/publish?room=$ROOM&sender=$sender&topic=work-item.claim&id=$id" \
    -H "content-type: application/json" \
    -d "$payload" 2>/dev/null
}

# ------------------------------------------------------------------
# 0. Preflight
# ------------------------------------------------------------------
echo "=== 0. Preflight ==="
echo "  room: $ROOM"

health=$(curl -fsS "$BASE_URL/health" 2>/dev/null || echo "FAIL")
if echo "$health" | grep -q '"status":"ok"'; then
  ok "relay is healthy"
else
  ng "relay is not healthy"
  exit 1
fi

if ! command -v websocat &>/dev/null; then
  ng "websocat not found (brew install websocat)"
  exit 1
fi
ok "websocat available"

# ------------------------------------------------------------------
# 1. Each agent claims a unique issue (5 parallel publishes)
# ------------------------------------------------------------------
echo "=== 1. Each agent claims a unique issue ==="

BASE_TS=$(date +%s)
for i in "${!AGENTS[@]}"; do
  agent="${AGENTS[$i]}"
  issue="issue-$(printf '%04d' $((i + 1)))"
  ts=$((BASE_TS + i))
  res=$(publish_claim "$agent" "$issue" "claim" "$ts" "init-$agent")
  accepted=$(echo "$res" | python3 -c "import sys,json; print(json.load(sys.stdin).get('accepted',''))" 2>/dev/null || echo "")
  check "$agent claims $issue" "$accepted" "True"
done

# ------------------------------------------------------------------
# 2. Poll: all 5 claims visible
# ------------------------------------------------------------------
echo "=== 2. Poll: verify 5 claims ==="

poll_res=$(curl -fsS "$BASE_URL/api/v1/poll?room=$ROOM&after=0&limit=100")
claim_count=$(echo "$poll_res" | python3 -c "
import sys, json
data = json.load(sys.stdin)
envelopes = data.get('envelopes', [])
claims = [e for e in envelopes if e.get('topic') == 'work-item.claim']
print(len(claims))
" 2>/dev/null || echo "0")
check "5 claims in room" "$claim_count" "5"

cursor=$(echo "$poll_res" | python3 -c "import sys,json; print(json.load(sys.stdin).get('next_cursor',0))" 2>/dev/null || echo "0")
ok "cursor: $cursor"

# ------------------------------------------------------------------
# 3. Connect 5 WS watchers (one per agent)
# ------------------------------------------------------------------
echo "=== 3. Connect 5 WS watchers ==="

declare -a ws_outs ws_pids
for agent in "${AGENTS[@]}"; do
  ws_out=$(mktemp)
  sleep 60 | websocat "$WS_URL/ws?room=$ROOM" > "$ws_out" 2>/dev/null &
  ws_pid=$!
  cleanup_pids+=("$ws_pid")
  ws_outs+=("$ws_out")
  ws_pids+=("$ws_pid")
done
sleep 1
ok "5 WS watchers connected"

# ------------------------------------------------------------------
# 4. Concurrent claim contest: 3 agents claim the same issue
# ------------------------------------------------------------------
echo "=== 4. Claim contest: alice, bob, charlie claim issue-0010 ==="

CONTEST_TS=$((BASE_TS + 100))

# All three claim at nearly the same time (sequential but fast)
for i in 0 1 2; do
  agent="${AGENTS[$i]}"
  ts=$((CONTEST_TS + i))
  publish_claim "$agent" "issue-0010" "claim" "$ts" "contest-$agent" >/dev/null
done
ok "3 concurrent claims published"

# Poll and resolve: latest timestamp wins
poll_contest=$(curl -fsS "$BASE_URL/api/v1/poll?room=$ROOM&after=0&limit=100")
winner=$(echo "$poll_contest" | python3 -c "
import sys, json
data = json.load(sys.stdin)
envelopes = data.get('envelopes', [])
# Find claims for issue-0010, pick latest timestamp
claims_0010 = []
for e in envelopes:
    p = e.get('payload', {})
    if p.get('issue_id') == 'issue-0010' and p.get('action') == 'claim':
        claims_0010.append(p)
if claims_0010:
    latest = max(claims_0010, key=lambda c: c.get('timestamp', 0))
    print(latest.get('claimer', ''))
else:
    print('')
" 2>/dev/null || echo "")
check "latest claim wins (charlie)" "$winner" "charlie"

# ------------------------------------------------------------------
# 5. Unclaim + re-claim handoff
# ------------------------------------------------------------------
echo "=== 5. Handoff: charlie unclaims, dave claims issue-0010 ==="

HANDOFF_TS=$((CONTEST_TS + 50))
publish_claim "charlie" "issue-0010" "unclaim" "$HANDOFF_TS" "handoff-unclaim" >/dev/null
publish_claim "dave" "issue-0010" "claim" "$((HANDOFF_TS + 1))" "handoff-claim" >/dev/null

# Verify active claims
poll_handoff=$(curl -fsS "$BASE_URL/api/v1/poll?room=$ROOM&after=0&limit=100")
active_0010=$(echo "$poll_handoff" | python3 -c "
import sys, json
data = json.load(sys.stdin)
envelopes = data.get('envelopes', [])
# Build latest state per issue
latest = {}
for e in envelopes:
    p = e.get('payload', {})
    iid = p.get('issue_id', '')
    ts = p.get('timestamp', 0)
    if iid and (iid not in latest or ts > latest[iid].get('timestamp', 0)):
        latest[iid] = p
# Check issue-0010
c = latest.get('issue-0010', {})
print(f\"{c.get('claimer','')}/{c.get('action','')}\")
" 2>/dev/null || echo "")
check "issue-0010 now held by dave" "$active_0010" "dave/claim"

# ------------------------------------------------------------------
# 6. WS broadcast verification
# ------------------------------------------------------------------
echo "=== 6. WS broadcast: verify all watchers received events ==="

# Publish one more event for verification
VERIFY_TS=$((HANDOFF_TS + 100))
publish_claim "eve" "issue-0099" "claim" "$VERIFY_TS" "ws-verify-eve" >/dev/null
sleep 2

# Check all WS watchers
ws_received=0
for i in "${!AGENTS[@]}"; do
  agent="${AGENTS[$i]}"
  ws_content=$(cat "${ws_outs[$i]}")
  if echo "$ws_content" | grep -q "issue-0099"; then
    ws_received=$((ws_received + 1))
  fi
done
check "all 5 watchers received eve's claim" "$ws_received" "5"

# Count total broadcast events per watcher (should all see the same count)
event_counts=()
for i in "${!AGENTS[@]}"; do
  ws_content=$(cat "${ws_outs[$i]}")
  count=$(echo "$ws_content" | grep -c "work-item.claim" || echo "0")
  event_counts+=("$count")
done
# All should have the same count
first_count="${event_counts[0]}"
all_same="true"
for c in "${event_counts[@]}"; do
  if [ "$c" != "$first_count" ]; then
    all_same="false"
    break
  fi
done
if [ "$all_same" = "true" ]; then
  ok "all watchers saw same event count ($first_count)"
else
  ng "event count mismatch: ${event_counts[*]}"
fi

# ------------------------------------------------------------------
# 7. Stale detection: old claim vs recent claim
# ------------------------------------------------------------------
echo "=== 7. Stale detection via poll ==="

# Simulate an old claim (24h+ ago)
OLD_TS=$((BASE_TS - 90000))  # ~25 hours ago
publish_claim "alice" "issue-stale" "claim" "$OLD_TS" "stale-alice" >/dev/null

# And a recent claim
publish_claim "bob" "issue-fresh" "claim" "$BASE_TS" "fresh-bob" >/dev/null

poll_stale=$(curl -fsS "$BASE_URL/api/v1/poll?room=$ROOM&after=0&limit=200")
stale_check=$(echo "$poll_stale" | python3 -c "
import sys, json, time
data = json.load(sys.stdin)
envelopes = data.get('envelopes', [])
now = int(time.time())
threshold = 24 * 3600  # 24h
latest = {}
for e in envelopes:
    p = e.get('payload', {})
    iid = p.get('issue_id', '')
    ts = p.get('timestamp', 0)
    if iid and (iid not in latest or ts > latest[iid].get('timestamp', 0)):
        latest[iid] = p
stale_id = latest.get('issue-stale', {})
fresh_id = latest.get('issue-fresh', {})
stale_ts = stale_id.get('timestamp', 0)
fresh_ts = fresh_id.get('timestamp', 0)
is_stale = (now - stale_ts) > threshold
is_fresh = (now - fresh_ts) <= threshold
print(f'{is_stale}/{is_fresh}')
" 2>/dev/null || echo "")
check "stale/fresh detection correct" "$stale_check" "True/True"

# ------------------------------------------------------------------
# 8. Incremental poll: only events after cursor
# ------------------------------------------------------------------
echo "=== 8. Incremental poll from cursor=$cursor ==="

poll_inc=$(curl -fsS "$BASE_URL/api/v1/poll?room=$ROOM&after=$cursor&limit=200")
inc_count=$(echo "$poll_inc" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(len(data.get('envelopes', [])))
" 2>/dev/null || echo "0")

# We published: 3 contest + 2 handoff + 1 ws-verify + 1 stale + 1 fresh = 8
check "incremental poll returns 8 new events" "$inc_count" "8"

# ------------------------------------------------------------------
# 9. Summary of active claims
# ------------------------------------------------------------------
echo "=== 9. Active claims summary ==="

poll_all=$(curl -fsS "$BASE_URL/api/v1/poll?room=$ROOM&after=0&limit=200")
summary=$(echo "$poll_all" | python3 -c "
import sys, json
data = json.load(sys.stdin)
envelopes = data.get('envelopes', [])
latest = {}
for e in envelopes:
    p = e.get('payload', {})
    iid = p.get('issue_id', '')
    ts = p.get('timestamp', 0)
    action = p.get('action', '')
    claimer = p.get('claimer', '')
    if iid and (iid not in latest or ts > latest[iid][0]):
        latest[iid] = (ts, action, claimer)
active = sorted([(k, v[2], v[1]) for k, v in latest.items() if v[1] == 'claim'])
for iid, claimer, _ in active:
    print(f'  {iid} -> {claimer}')
print(f'total_active={len(active)}')
")
echo "$summary"

active_count=$(echo "$summary" | tail -1 | sed 's/total_active=//')
# 5 initial + issue-0010 (dave) + issue-0099 (eve) + issue-stale (alice) + issue-fresh (bob) = 9
# But issue-0001 (alice) is separate from issue-stale, and issue-0010 was re-claimed by dave
check "9 active claims total" "$active_count" "9"

# ------------------------------------------------------------------
# Cleanup & summary
# ------------------------------------------------------------------
echo ""
echo "=== Results: $pass passed, $fail failed ==="
if [ "$fail" -gt 0 ]; then
  exit 1
fi
