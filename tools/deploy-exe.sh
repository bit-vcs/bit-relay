#!/usr/bin/env bash
set -euo pipefail

# Usage: tools/deploy-exe.sh <ssh-host>
# Example: tools/deploy-exe.sh user@myapp.exe.dev
#
# Environment variables:
#   EXE_HOST              SSH target (or pass as $1)
#   REMOTE_DIR            Remote directory (default: ~/bit-relay)
#   PORT                  Listening port (default: 8080)
#   RELAY_REQUIRE_SIGNATURE  Require Ed25519 signatures (default: true)

EXE_HOST="${1:-${EXE_HOST:-}}"
REMOTE_DIR="${REMOTE_DIR:-~/bit-relay}"
PORT="${PORT:-8080}"
RELAY_REQUIRE_SIGNATURE="${RELAY_REQUIRE_SIGNATURE:-true}"

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ -z "$EXE_HOST" ]; then
  echo "Usage: $0 <ssh-host>" >&2
  echo "  e.g. $0 user@myapp.exe.dev" >&2
  exit 1
fi

sync_sources() {
  echo "[deploy-exe] syncing sources -> $EXE_HOST:$REMOTE_DIR"
  (
    cd "$ROOT_DIR"
    export COPYFILE_DISABLE=1
    export COPY_EXTENDED_ATTRIBUTES_DISABLE=1
    tar \
      --no-xattrs \
      --exclude='.git' \
      --exclude='.jj' \
      --exclude='node_modules' \
      --exclude='.wrangler' \
      --exclude='bench/results' \
      -czf - . \
      | ssh "$EXE_HOST" "rm -rf $REMOTE_DIR && mkdir -p $REMOTE_DIR && tar -xzf - -C $REMOTE_DIR"
  )
}

ensure_deno() {
  echo "[deploy-exe] checking deno installation"
  ssh "$EXE_HOST" "command -v deno >/dev/null 2>&1 || curl -fsSL https://deno.land/install.sh | sh"
}

stop_relay() {
  echo "[deploy-exe] stopping existing relay process"
  ssh "$EXE_HOST" "pkill -f 'relay-supervisor.sh' 2>/dev/null || true; pkill -f 'deno run.*deno_main.ts' 2>/dev/null || true"
  sleep 1
}

start_relay() {
  echo "[deploy-exe] starting relay via supervisor on 0.0.0.0:$PORT"
  ssh "$EXE_HOST" "cd $REMOTE_DIR && nohup env HOST=0.0.0.0 PORT=$PORT RELAY_REQUIRE_SIGNATURE=$RELAY_REQUIRE_SIGNATURE bash tools/relay-supervisor.sh $REMOTE_DIR > /dev/null 2>&1 &"
}

health_check() {
  echo "[deploy-exe] waiting for health check..."
  local ok=0
  for _ in $(seq 1 20); do
    if ssh "$EXE_HOST" "curl -fsS http://127.0.0.1:$PORT/health 2>/dev/null"; then
      ok=1
      echo ""
      break
    fi
    sleep 1
  done

  if [ "$ok" -ne 1 ]; then
    echo "[deploy-exe] health check failed" >&2
    ssh "$EXE_HOST" "tail -n 40 ~/bit-relay.log" >&2
    exit 1
  fi

  echo "[deploy-exe] relay is running on $EXE_HOST:$PORT (supervised)"
}

main() {
  sync_sources
  ensure_deno
  stop_relay
  start_relay
  health_check
}

main
