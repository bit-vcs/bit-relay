#!/usr/bin/env bash
set -euo pipefail

SPRITE_NAME="${1:-${SPRITE_NAME:-myapp}}"
REMOTE_DIR="${REMOTE_DIR:-/home/sprite/bit-relay}"
PORT="${PORT:-8080}"
URL_AUTH="${URL_AUTH:-public}" # public | default
RELAY_REQUIRE_SIGNATURE="${RELAY_REQUIRE_SIGNATURE:-true}"

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "required command not found: $1" >&2
    exit 1
  fi
}

ensure_sprite_exists() {
  if sprite list | awk "NF {print \$1}" | grep -Fxq "$SPRITE_NAME"; then
    return 0
  fi
  echo "[deploy-sprites] creating sprite: $SPRITE_NAME"
  sprite create -skip-console "$SPRITE_NAME"
}

sync_sources() {
  echo "[deploy-sprites] syncing sources -> $SPRITE_NAME:$REMOTE_DIR"
  (
    cd "$ROOT_DIR"
    export COPYFILE_DISABLE=1
    export COPY_EXTENDED_ATTRIBUTES_DISABLE=1
    tar \
      --no-xattrs \
      --exclude='.git' \
      --exclude='node_modules' \
      --exclude='.wrangler' \
      -czf - . \
      | sprite -s "$SPRITE_NAME" exec sh -lc "rm -rf '$REMOTE_DIR' && mkdir -p '$REMOTE_DIR' && tar -xzf - -C '$REMOTE_DIR'"
  )
}

stop_relay_process() {
  sprite -s "$SPRITE_NAME" exec sh -lc "set -eu; pids=\$(ps -eo pid,args | awk '/deno run --allow-net --allow-env src\\/deno_main.ts/ && \$0 !~ /awk/ {print \$1}'); if [ -n \"\$pids\" ]; then kill \$pids; fi"
}

start_relay_process() {
  echo "[deploy-sprites] starting relay on 0.0.0.0:$PORT"
  sprite -s "$SPRITE_NAME" exec sh -lc "cd '$REMOTE_DIR' && nohup env HOST=0.0.0.0 PORT=$PORT RELAY_REQUIRE_SIGNATURE=$RELAY_REQUIRE_SIGNATURE deno run --allow-net --allow-env src/deno_main.ts >/home/sprite/bit-relay.log 2>&1 &"
}

set_url_auth() {
  case "$URL_AUTH" in
    public|default)
      sprite -s "$SPRITE_NAME" url update --auth "$URL_AUTH" >/dev/null
      ;;
    *)
      echo "invalid URL_AUTH: $URL_AUTH (expected: public or default)" >&2
      exit 1
      ;;
  esac
}

health_check() {
  local sprite_url
  sprite_url="$(sprite -s "$SPRITE_NAME" url | awk '/^URL:/ {print $2}')"
  if [ -z "$sprite_url" ]; then
    echo "failed to resolve sprite URL" >&2
    exit 1
  fi

  local health_url="${sprite_url%/}/health"
  local body=""
  local ok=0
  for _ in $(seq 1 20); do
    if body="$(curl -fsS "$health_url" 2>/dev/null)"; then
      ok=1
      break
    fi
    sleep 1
  done

  if [ "$ok" -ne 1 ]; then
    echo "[deploy-sprites] health check failed: $health_url" >&2
    sprite -s "$SPRITE_NAME" exec sh -lc "tail -n 80 /home/sprite/bit-relay.log || true" >&2
    exit 1
  fi

  echo "[deploy-sprites] URL: $sprite_url"
  echo "[deploy-sprites] health: $body"
}

main() {
  require_cmd sprite
  require_cmd tar
  require_cmd curl

  ensure_sprite_exists
  sync_sources
  stop_relay_process || true
  start_relay_process
  set_url_auth
  health_check
}

main "$@"
