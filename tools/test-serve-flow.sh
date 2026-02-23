#!/usr/bin/env bash
set -euo pipefail

# Manual test: git serve session flow (register → poll → respond)
#
# Usage:
#   tools/test-serve-flow.sh <relay-url>
#
# Examples:
#   tools/test-serve-flow.sh http://localhost:8788
#   tools/test-serve-flow.sh https://myapp.exe.dev
#
# This script simulates both the "serve side" (file owner) and the
# "clone side" (external reader), verifying the relay correctly
# proxies requests between them.

BASE_URL="${1:-http://localhost:8788}"
BASE_URL="${BASE_URL%/}"

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
    ng "$1 (expected=$3, got=$2)"
  fi
}

# ------------------------------------------------------------------
# 1. Health check
# ------------------------------------------------------------------
echo "--- 1. health check ---"
health=$(curl -fsS "$BASE_URL/health" 2>/dev/null || echo "FAIL")
if echo "$health" | grep -q '"status":"ok"'; then
  ok "relay is healthy"
else
  ng "relay is not healthy: $health"
  echo "Abort." >&2
  exit 1
fi

# ------------------------------------------------------------------
# 2. Register a serve session
# ------------------------------------------------------------------
echo "--- 2. register session ---"
register_res=$(curl -fsS -X POST "$BASE_URL/api/v1/serve/register")
session_id=$(echo "$register_res" | python3 -c "import sys,json; print(json.load(sys.stdin)['session_id'])" 2>/dev/null || echo "")
session_token=$(echo "$register_res" | python3 -c "import sys,json; print(json.load(sys.stdin)['session_token'])" 2>/dev/null || echo "")

if [ -n "$session_id" ] && [ -n "$session_token" ]; then
  ok "session registered: id=$session_id"
else
  ng "failed to register session: $register_res"
  exit 1
fi

# ------------------------------------------------------------------
# 3. Session info
# ------------------------------------------------------------------
echo "--- 3. session info ---"
info_res=$(curl -fsS "$BASE_URL/api/v1/serve/info?session=$session_id&session_token=$session_token")
info_active=$(echo "$info_res" | python3 -c "import sys,json; print(json.load(sys.stdin)['active'])" 2>/dev/null || echo "")
check "session is active" "$info_active" "True"

# ------------------------------------------------------------------
# 4. Clone side: send a git request (background)
# ------------------------------------------------------------------
echo "--- 4. clone-side request + serve-side poll/respond ---"

# File content to serve
FILE_CONTENT="hello from bit relay serve test"
FILE_B64=$(echo -n "$FILE_CONTENT" | base64)

# Clone side sends a GET request (runs in background, blocks until responded)
clone_out=$(mktemp)
curl -sS "$BASE_URL/git/$session_id/test-file.txt" -o "$clone_out" &
clone_pid=$!

# Give the request a moment to reach the relay
sleep 1

# ------------------------------------------------------------------
# 5. Serve side: poll for pending requests
# ------------------------------------------------------------------
poll_res=$(curl -fsS "$BASE_URL/api/v1/serve/poll?session=$session_id&session_token=$session_token&timeout=5")
request_id=$(echo "$poll_res" | python3 -c "import sys,json; r=json.load(sys.stdin)['requests']; print(r[0]['request_id'] if r else '')" 2>/dev/null || echo "")
request_path=$(echo "$poll_res" | python3 -c "import sys,json; r=json.load(sys.stdin)['requests']; print(r[0]['path'] if r else '')" 2>/dev/null || echo "")

if [ -n "$request_id" ]; then
  ok "polled request: id=$request_id, path=$request_path"
else
  ng "no pending requests found"
  kill $clone_pid 2>/dev/null || true
  rm -f "$clone_out"
  exit 1
fi

# ------------------------------------------------------------------
# 6. Serve side: respond with file content
# ------------------------------------------------------------------
respond_body=$(python3 -c "
import json, base64
print(json.dumps({
  'request_id': '$request_id',
  'status': 200,
  'headers': {'content-type': 'text/plain'},
  'body_base64': base64.b64encode(b'$FILE_CONTENT').decode()
}))
")

respond_res=$(curl -fsS -X POST \
  "$BASE_URL/api/v1/serve/respond?session=$session_id&session_token=$session_token" \
  -H "content-type: application/json" \
  -d "$respond_body")

respond_ok=$(echo "$respond_res" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok',''))" 2>/dev/null || echo "")
check "respond accepted" "$respond_ok" "True"

# ------------------------------------------------------------------
# 7. Clone side: verify received content
# ------------------------------------------------------------------
wait $clone_pid 2>/dev/null || true
clone_content=$(cat "$clone_out")
rm -f "$clone_out"

check "clone received file content" "$clone_content" "$FILE_CONTENT"

# ------------------------------------------------------------------
# 8. POST request (write/upload) flow
# ------------------------------------------------------------------
echo "--- 5. write (POST) flow ---"

UPLOAD_CONTENT="uploaded data from clone side"

# Clone side sends a POST request (background)
post_out=$(mktemp)
curl -sS -X POST "$BASE_URL/git/$session_id/upload" \
  -H "content-type: application/octet-stream" \
  -d "$UPLOAD_CONTENT" \
  -o "$post_out" &
post_pid=$!

sleep 1

# Serve side polls
poll_res2=$(curl -fsS "$BASE_URL/api/v1/serve/poll?session=$session_id&session_token=$session_token&timeout=5")
request_id2=$(echo "$poll_res2" | python3 -c "import sys,json; r=json.load(sys.stdin)['requests']; print(r[0]['request_id'] if r else '')" 2>/dev/null || echo "")
request_method2=$(echo "$poll_res2" | python3 -c "import sys,json; r=json.load(sys.stdin)['requests']; print(r[0]['method'] if r else '')" 2>/dev/null || echo "")
body_b64=$(echo "$poll_res2" | python3 -c "import sys,json; r=json.load(sys.stdin)['requests']; print(r[0].get('body_base64','') if r else '')" 2>/dev/null || echo "")

check "POST request received" "$request_method2" "POST"

# Decode body and verify
if [ -n "$body_b64" ]; then
  decoded=$(echo "$body_b64" | base64 -d 2>/dev/null || echo "DECODE_FAIL")
  check "POST body matches upload" "$decoded" "$UPLOAD_CONTENT"
else
  ng "POST body is empty"
fi

# Serve side responds with 200 OK
respond_body2=$(python3 -c "
import json, base64
print(json.dumps({
  'request_id': '$request_id2',
  'status': 200,
  'headers': {'content-type': 'application/json'},
  'body_base64': base64.b64encode(b'{\"ok\":true}').decode()
}))
")
curl -fsS -X POST \
  "$BASE_URL/api/v1/serve/respond?session=$session_id&session_token=$session_token" \
  -H "content-type: application/json" \
  -d "$respond_body2" >/dev/null

wait $post_pid 2>/dev/null || true
post_content=$(cat "$post_out")
rm -f "$post_out"

check "clone received upload response" "$post_content" '{"ok":true}'

# ------------------------------------------------------------------
# Summary
# ------------------------------------------------------------------
echo ""
echo "=== Results: $pass passed, $fail failed ==="
if [ "$fail" -gt 0 ]; then
  exit 1
fi
