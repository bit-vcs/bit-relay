#!/usr/bin/env bash
set -euo pipefail

# Supervisor script for bit-relay on exe.dev
# Automatically restarts the relay process on crash with exponential backoff.
# Process exit is detected instantly via `wait`.
# Health check runs in a background loop and kills unhealthy processes.
#
# Usage: relay-supervisor.sh [relay-dir]
#   relay-dir: directory containing src/deno_main.ts (default: ~/bit-relay)

RELAY_DIR="${1:-${RELAY_DIR:-$HOME/bit-relay}}"
LOG_FILE="$HOME/bit-relay.log"
PID_FILE="$HOME/bit-relay.pid"

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8080}"
RELAY_REQUIRE_SIGNATURE="${RELAY_REQUIRE_SIGNATURE:-true}"

MAX_BACKOFF=60
HEALTH_INTERVAL=30

backoff=1
health_pid=""

log() {
  echo "[supervisor $(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
}

cleanup() {
  log "supervisor shutting down"
  [ -n "$health_pid" ] && kill "$health_pid" 2>/dev/null || true
  if [ -f "$PID_FILE" ]; then
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi
  exit 0
}

trap cleanup INT TERM

health_ok() {
  curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1
}

wait_for_healthy() {
  for _ in $(seq 1 10); do
    if health_ok; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# Background health checker: periodically pings /health
# and kills the relay process if it becomes unresponsive.
start_health_monitor() {
  local target_pid=$1
  (
    while true; do
      sleep "$HEALTH_INTERVAL"
      if ! kill -0 "$target_pid" 2>/dev/null; then
        break
      fi
      if ! health_ok; then
        log "health check failed, killing relay (pid=$target_pid)"
        kill "$target_pid" 2>/dev/null || true
        break
      fi
    done
  ) &
  health_pid=$!
}

stop_health_monitor() {
  if [ -n "$health_pid" ]; then
    kill "$health_pid" 2>/dev/null || true
    wait "$health_pid" 2>/dev/null || true
    health_pid=""
  fi
}

while true; do
  log "starting relay on $HOST:$PORT (dir=$RELAY_DIR)"
  cd "$RELAY_DIR"
  env HOST="$HOST" PORT="$PORT" \
      RELAY_REQUIRE_SIGNATURE="$RELAY_REQUIRE_SIGNATURE" \
      deno run --allow-net --allow-env src/deno_main.ts >> "$LOG_FILE" 2>&1 &
  relay_pid=$!
  echo "$relay_pid" > "$PID_FILE"
  log "relay started: pid=$relay_pid"

  if wait_for_healthy; then
    log "relay is healthy"
    backoff=1
  else
    log "relay failed health check after start"
  fi

  start_health_monitor "$relay_pid"

  # Block until relay process exits (instant detection)
  wait "$relay_pid" 2>/dev/null || true

  stop_health_monitor
  rm -f "$PID_FILE"
  log "relay exited, restarting in ${backoff}s..."
  sleep "$backoff"
  backoff=$((backoff * 2))
  if [ "$backoff" -gt "$MAX_BACKOFF" ]; then
    backoff=$MAX_BACKOFF
  fi
done
