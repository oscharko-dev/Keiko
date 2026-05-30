#!/usr/bin/env bash
#
# keiko.sh — manage the local Keiko UI/BFF server (the only long-running local
# Keiko process). It binds 127.0.0.1 only, serves the packaged UI assets, and is
# the loopback control plane for the Wave 1 workflows and evidence browser.
#
# Usage:
#   scripts/keiko.sh start      Start the UI and wait until it is healthy.
#   scripts/keiko.sh stop       Gracefully stop the UI (SIGTERM, then SIGKILL).
#   scripts/keiko.sh restart    Stop (if running) and start again.
#   scripts/keiko.sh status     Report whether the UI is running.
#   scripts/keiko.sh help       Show this help.
#
# Configuration (all optional, read from the environment):
#   KEIKO_UI_PORT   Loopback port to bind          (default: 4319)
#   KEIKO_UI_HOST   127.0.0.1 | localhost          (default: 127.0.0.1)
#
# Runtime state (pid + log) lives under the gitignored .keiko/ directory.
#
# Exit codes: 0 success, 1 runtime error (build/startup/stop failure), 2 usage error.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PORT="${KEIKO_UI_PORT:-4319}"
HOST="${KEIKO_UI_HOST:-127.0.0.1}"
ENTRY="$ROOT/dist/cli/index.js"
STATIC_DIR="$ROOT/dist/ui/static"
STATE_DIR="$ROOT/.keiko"
PID_FILE="$STATE_DIR/ui.pid"
LOG_FILE="$STATE_DIR/ui.log"
HEALTH_URL="http://${HOST}:${PORT}/api/health"

# True if PID is alive AND is actually a Keiko UI process. Guards against a stale
# pid file whose number has been recycled by an unrelated process.
is_keiko_ui() {
  pid="$1"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  ps -p "$pid" -o command= 2>/dev/null | grep -q "dist/cli/index.js"
}

# Echoes the live Keiko UI pid (and returns 0), or returns 1 if not running.
# Clears a stale pid file as a side effect.
running_pid() {
  [ -f "$PID_FILE" ] || return 1
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if is_keiko_ui "$pid"; then
    echo "$pid"
    return 0
  fi
  rm -f "$PID_FILE"
  return 1
}

usage() {
  sed -n '3,27p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

cmd_start() {
  mkdir -p "$STATE_DIR"

  if pid="$(running_pid)"; then
    echo "Keiko UI already running on http://${HOST}:${PORT} (pid ${pid})."
    return 0
  fi

  # The built assets must be present: `npm run build` compiles the CLI/BFF and
  # `npm run build:ui` produces the static export the server serves.
  if [ ! -f "$ENTRY" ] || [ ! -d "$STATIC_DIR" ]; then
    echo "Keiko UI: build assets missing." >&2
    echo "Run: npm run build && npm run build:ui" >&2
    return 1
  fi

  echo "Starting Keiko UI on http://${HOST}:${PORT} ..."
  nohup node "$ENTRY" ui --port "$PORT" --host "$HOST" >>"$LOG_FILE" 2>&1 &
  pid=$!
  echo "$pid" >"$PID_FILE"

  # Poll the health endpoint until the server answers, it dies, or we time out.
  i=0
  while [ "$i" -lt 40 ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "Keiko UI failed to start. Last log lines:" >&2
      tail -n 20 "$LOG_FILE" >&2 2>/dev/null || true
      rm -f "$PID_FILE"
      return 1
    fi
    if curl -fsS "$HEALTH_URL" 2>/dev/null | grep -q '"status":"ok"'; then
      echo "Keiko UI running on http://${HOST}:${PORT} (pid ${pid})."
      echo "Logs: ${LOG_FILE}"
      return 0
    fi
    i=$((i + 1))
    sleep 0.5
  done

  echo "Keiko UI did not become healthy within the timeout. Last log lines:" >&2
  tail -n 20 "$LOG_FILE" >&2 2>/dev/null || true
  kill "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  return 1
}

cmd_stop() {
  if ! pid="$(running_pid)"; then
    echo "Keiko UI is not running."
    return 0
  fi

  echo "Stopping Keiko UI (pid ${pid}) ..."
  kill -TERM "$pid" 2>/dev/null || true

  # Wait up to ~10s for a graceful exit (the server closes its socket on SIGTERM).
  i=0
  while [ "$i" -lt 20 ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      echo "Keiko UI stopped."
      return 0
    fi
    i=$((i + 1))
    sleep 0.5
  done

  echo "Keiko UI did not exit gracefully; sending SIGKILL." >&2
  kill -KILL "$pid" 2>/dev/null || true
  sleep 0.5
  if kill -0 "$pid" 2>/dev/null; then
    echo "Keiko UI: failed to stop pid ${pid}." >&2
    return 1
  fi
  rm -f "$PID_FILE"
  echo "Keiko UI stopped (forced)."
  return 0
}

cmd_status() {
  if pid="$(running_pid)"; then
    echo "Keiko UI is running on http://${HOST}:${PORT} (pid ${pid})."
    return 0
  fi
  echo "Keiko UI is not running."
  return 0
}

cmd_restart() {
  cmd_stop
  cmd_start
}

main() {
  command="${1:-}"
  case "$command" in
    start) cmd_start ;;
    stop) cmd_stop ;;
    restart) cmd_restart ;;
    status) cmd_status ;;
    help | -h | --help) usage ;;
    "")
      usage >&2
      return 2
      ;;
    *)
      echo "keiko.sh: unknown command: ${command}" >&2
      usage >&2
      return 2
      ;;
  esac
}

main "$@"
