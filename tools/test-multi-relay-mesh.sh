#!/usr/bin/env bash
set -euo pipefail

# E2E integration check: multi-relay mesh propagation
#
# This script starts 3 local relay nodes with peer settings, attaches
# multiple users to each node, and verifies:
#   1) notify topic propagation across all nodes
#   2) issue topic propagation via cache/issues/sync across all nodes
#
# Usage:
#   tools/test-multi-relay-mesh.sh [base_port]
#
# Examples:
#   tools/test-multi-relay-mesh.sh
#   tools/test-multi-relay-mesh.sh 19081
#
# Environment variables:
#   RELAY_SYNC_INTERVAL_SEC   Sync interval sec for peer worker (default: 1)
#   RELAY_REQUIRE_SIGNATURE   Pass-through for node startup (default: false)
#   KEEP_NODES                Keep node processes after test (1 to keep)

BASE_PORT="${1:-19081}"
SYNC_INTERVAL_SEC="${RELAY_SYNC_INTERVAL_SEC:-1}"
REQUIRE_SIGNATURE="${RELAY_REQUIRE_SIGNATURE:-false}"
KEEP_NODES="${KEEP_NODES:-0}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TMP_DIR="$(mktemp -d "/tmp/bit-relay-mesh.XXXXXX")"

NODES=("relay-a" "relay-b" "relay-c")
PORTS=("${BASE_PORT}" "$((BASE_PORT + 1))" "$((BASE_PORT + 2))")
URLS=(
  "http://127.0.0.1:${PORTS[0]}"
  "http://127.0.0.1:${PORTS[1]}"
  "http://127.0.0.1:${PORTS[2]}"
)
PIDS=()

pass=0
fail=0

ok() {
  pass=$((pass + 1))
  echo "  [OK] $1"
}

ng() {
  fail=$((fail + 1))
  echo "  [NG] $1" >&2
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

uri_encode() {
  jq -rn --arg v "$1" '$v | @uri'
}

cleanup() {
  if [ "${KEEP_NODES}" = "1" ]; then
    echo "KEEP_NODES=1: node processes are kept running."
    echo "  logs: ${TMP_DIR}"
    return
  fi
  for pid in "${PIDS[@]}"; do
    kill "${pid}" >/dev/null 2>&1 || true
    wait "${pid}" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

check_port_free() {
  local port="$1"
  if lsof -iTCP:"${port}" -sTCP:LISTEN -n -P >/dev/null 2>&1; then
    echo "port already in use: ${port}" >&2
    exit 1
  fi
}

start_node() {
  local idx="$1"
  local node_id="${NODES[$idx]}"
  local port="${PORTS[$idx]}"
  local peer_urls=()
  local j
  for j in "${!NODES[@]}"; do
    if [ "${j}" -eq "${idx}" ]; then
      continue
    fi
    peer_urls+=("${URLS[$j]}")
  done
  local peers_csv
  peers_csv="$(IFS=,; echo "${peer_urls[*]}")"

  check_port_free "${port}"

  echo "start ${node_id} at ${URLS[$idx]} peers=${peers_csv}"
  (
    cd "${ROOT_DIR}"
    HOST=127.0.0.1 \
      PORT="${port}" \
      RELAY_NODE_ID="${node_id}" \
      RELAY_PEERS="${peers_csv}" \
      RELAY_PEER_SYNC_INTERVAL_SEC="${SYNC_INTERVAL_SEC}" \
      RELAY_REQUIRE_SIGNATURE="${REQUIRE_SIGNATURE}" \
      deno run --allow-net --allow-env src/deno_main.ts \
      >"${TMP_DIR}/${node_id}.log" 2>&1
  ) &
  PIDS+=("$!")
}

wait_for_health() {
  local base_url="$1"
  local label="$2"
  local attempt
  for attempt in $(seq 1 40); do
    local body
    body="$(curl -fsS "${base_url}/health" 2>/dev/null || true)"
    if echo "${body}" | jq -e '.status == "ok"' >/dev/null 2>&1; then
      ok "${label} health is ok"
      return 0
    fi
    sleep 0.25
  done
  ng "${label} failed to become healthy"
  echo "---- ${label} log ----" >&2
  cat "${TMP_DIR}/${label}.log" >&2 || true
  return 1
}

publish_event() {
  local base_url="$1"
  local room="$2"
  local sender="$3"
  local msg_id="$4"
  local topic="$5"
  local payload="$6"

  local url="${base_url}/api/v1/publish?room=$(uri_encode "${room}")&sender=$(uri_encode "${sender}")&id=$(uri_encode "${msg_id}")&topic=$(uri_encode "${topic}")"
  local body
  body="$(curl -fsS -X POST "${url}" -H 'content-type: application/json' -d "${payload}")"
  local accepted
  accepted="$(echo "${body}" | jq -r '.accepted')"
  if [ "${accepted}" != "true" ]; then
    ng "publish rejected sender=${sender} id=${msg_id}: ${body}"
    return 1
  fi
  ok "publish accepted sender=${sender} id=${msg_id}"
}

verify_notify_propagation() {
  local room="$1"
  shift
  local expected_ids=("$@")
  local expected_json
  expected_json="$(printf '%s\n' "${expected_ids[@]}" | jq -R -s -c 'split("\n")[:-1] | sort')"

  local attempt
  for attempt in $(seq 1 20); do
    local all_ok=1
    echo "notify propagation attempt=${attempt}"
    local idx
    for idx in "${!URLS[@]}"; do
      local base_url="${URLS[$idx]}"
      local body
      body="$(curl -fsS "${base_url}/api/v1/poll?room=$(uri_encode "${room}")&after=0&limit=100")"
      local count
      count="$(echo "${body}" | jq '.envelopes | length')"
      local ids_json
      ids_json="$(echo "${body}" | jq -c '[.envelopes[].id] | sort')"
      local ids_match
      ids_match="$(jq -n --argjson a "${ids_json}" --argjson b "${expected_json}" '$a == $b')"
      echo "  ${base_url} count=${count} ids_match=${ids_match}"
      if [ "${ids_match}" != "true" ]; then
        all_ok=0
      fi
    done
    if [ "${all_ok}" -eq 1 ]; then
      ok "notify topic propagated to all nodes"
      return 0
    fi
    sleep 1
  done
  ng "notify propagation did not converge"
  return 1
}

verify_issue_sync_propagation() {
  local room="$1"
  local attempt
  for attempt in $(seq 1 20); do
    local all_ok=1
    echo "issue sync propagation attempt=${attempt}"
    local idx
    for idx in "${!URLS[@]}"; do
      local base_url="${URLS[$idx]}"
      local body
      body="$(curl -fsS "${base_url}/api/v1/cache/issues/sync?room=$(uri_encode "${room}")&after=0&limit=20")"
      local event_count
      event_count="$(echo "${body}" | jq '.events | length')"
      local snapshot_count
      snapshot_count="$(echo "${body}" | jq '.snapshots | length')"
      local has_upsert
      has_upsert="$(echo "${body}" | jq '[.events[].action] | index("upsert") != null')"
      local has_updated
      has_updated="$(echo "${body}" | jq '[.events[].action] | index("updated") != null')"
      echo "  ${base_url} events=${event_count} snapshots=${snapshot_count} upsert=${has_upsert} updated=${has_updated}"
      if [ "${event_count}" -lt 2 ] || [ "${has_upsert}" != "true" ] || [ "${has_updated}" != "true" ]; then
        all_ok=0
      fi
    done
    if [ "${all_ok}" -eq 1 ]; then
      ok "issue sync propagated to all nodes"
      return 0
    fi
    sleep 1
  done
  ng "issue sync propagation did not converge"
  return 1
}

main() {
  require_cmd deno
  require_cmd curl
  require_cmd jq
  require_cmd lsof

  echo "=== multi-relay mesh propagation test ==="
  echo "base_port=${BASE_PORT} sync_interval=${SYNC_INTERVAL_SEC}s require_signature=${REQUIRE_SIGNATURE}"
  echo "tmp_dir=${TMP_DIR}"

  local idx
  for idx in "${!NODES[@]}"; do
    start_node "${idx}"
  done

  for idx in "${!NODES[@]}"; do
    wait_for_health "${URLS[$idx]}" "${NODES[$idx]}"
  done

  local notify_room="mesh-demo-$(date +%s)"
  local expected_ids=()
  local rows=(
    "0 alice-a1 a-msg-1"
    "0 alice-a2 a-msg-2"
    "1 bob-b1 b-msg-1"
    "1 bob-b2 b-msg-2"
    "2 carol-c1 c-msg-1"
    "2 carol-c2 c-msg-2"
  )

  echo "=== publish notify events room=${notify_room} ==="
  local row
  for row in "${rows[@]}"; do
    local node_idx sender id_prefix msg_id
    read -r node_idx sender id_prefix <<<"${row}"
    msg_id="${id_prefix}-${notify_room}"
    publish_event "${URLS[$node_idx]}" "${notify_room}" "${sender}" "${msg_id}" "notify" \
      "{\"from\":\"${sender}\",\"message\":\"hello from ${sender}\"}"
    expected_ids+=("${msg_id}")
  done

  verify_notify_propagation "${notify_room}" "${expected_ids[@]}"

  local issue_room="mesh-issue-$(date +%s)"
  echo "=== publish issue events room=${issue_room} ==="
  publish_event "${URLS[0]}" "${issue_room}" "alice-a1" "issue-create-${issue_room}" "issue" \
    '{"issue_id":"issue-1","title":"initial"}'
  publish_event "${URLS[1]}" "${issue_room}" "bob-b1" "issue-update-${issue_room}" "issue.updated" \
    '{"issue_id":"issue-1","title":"updated"}'

  verify_issue_sync_propagation "${issue_room}"

  echo ""
  echo "=== Results: ${pass} passed, ${fail} failed ==="
  echo "notify_room=${notify_room}"
  echo "issue_room=${issue_room}"
  echo "logs=${TMP_DIR}"
  if [ "${fail}" -gt 0 ]; then
    exit 1
  fi
}

main "$@"
