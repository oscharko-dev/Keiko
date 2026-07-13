#!/usr/bin/env bash
#
# keiko.sh — manage the local Keiko UI/BFF server (the only long-running local
# Keiko process). It binds 127.0.0.1 only, serves the packaged UI assets, and is
# the loopback control plane for the Wave 1 workflows and evidence browser.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PORT="${KEIKO_UI_PORT:-1983}"
HOST="${KEIKO_UI_HOST:-127.0.0.1}"
ENTRY="$ROOT/dist/cli/index.js"
STATIC_DIR="$ROOT/dist/ui/static"
# The server resolves CSP hashes from this file at request time (src/cli/ui.ts ->
# createLiveCspHeaderProvider), so a rebuilt UI can recover without a lucky restart order.
CSP_HASHES="$ROOT/dist/ui/csp-hashes.json"
# Runtime state (pid + log). Defaults to the gitignored .keiko/ under the repo;
# overridable (mainly for tests) so a run never clobbers another instance's state.
STATE_DIR="${KEIKO_STATE_DIR:-$ROOT/.keiko}"
PID_FILE="$STATE_DIR/ui.pid"
LOG_FILE="$STATE_DIR/ui.log"
HEALTH_URL="http://${HOST}:${PORT}/api/health"
# Health-poll and graceful-stop budgets in whole seconds, overridable for slow
# environments. The poll/stop loops tick twice a second, so iterations = seconds x 2.
START_TIMEOUT_SECS="${KEIKO_START_TIMEOUT_SECS:-20}"
STOP_TIMEOUT_SECS="${KEIKO_STOP_TIMEOUT_SECS:-10}"

usage() {
  cat <<'EOF'
keiko.sh — manage the local Keiko UI/BFF server (loopback only).

Usage:
  scripts/keiko.sh start      Start the UI and wait until it is healthy.
  scripts/keiko.sh stop       Gracefully stop the UI (SIGTERM, then SIGKILL).
  scripts/keiko.sh restart    Stop (if running) and start again.
  scripts/keiko.sh status     Report whether the UI is running.
  scripts/keiko.sh help       Show this help.

Configuration (all optional, read from the environment):
  KEIKO_UI_PORT             Loopback port to bind        (default: 1983)
  KEIKO_UI_HOST             127.0.0.1 | localhost         (default: 127.0.0.1)
  KEIKO_STATE_DIR           Runtime pid/log directory     (default: <repo>/.keiko)
  KEIKO_START_TIMEOUT_SECS  Seconds to wait for health    (default: 20)
  KEIKO_STOP_TIMEOUT_SECS   Seconds to wait for shutdown  (default: 10)

Exit codes: 0 success, 1 runtime error (build/startup/stop failure), 2 usage error.
EOF
}

# Whole positive integer (>= 1), else a usage error. Validates the timeout knobs so a
# typo fails fast with a clear message rather than producing a zero-iteration loop.
require_positive_int() {
  name="$1"
  value="$2"
  if ! printf '%s' "$value" | grep -qE '^[1-9][0-9]*$'; then
    echo "keiko.sh: ${name} must be a positive integer (got: '${value}')." >&2
    return 2
  fi
}

# True if PID is alive AND is actually a Keiko UI process. Guards against a stale
# pid file whose number has been recycled by an unrelated process.
is_keiko_ui() {
  pid="$1"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  ps -p "$pid" -o command= 2>/dev/null | grep -q "dist/cli/index.js"
}

# Echoes the live Keiko UI pid (and returns 0), or returns 1 if not running.
# Clears a stale/invalid pid file as a side effect.
running_pid() {
  [[ -f "$PID_FILE" ]] || return 1
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if is_keiko_ui "$pid"; then
    echo "$pid"
    return 0
  fi
  rm -f "$PID_FILE"
  return 1
}

wait_until_not_keiko_ui() {
  pid="$1"
  iterations="$2"
  i=0
  while [[ "$i" -lt "$iterations" ]]; do
    if ! is_keiko_ui "$pid"; then
      return 0
    fi
    i=$((i + 1))
    sleep 0.5
  done
  ! is_keiko_ui "$pid"
}

cmd_start() {
  require_positive_int KEIKO_START_TIMEOUT_SECS "$START_TIMEOUT_SECS" || return 2
  mkdir -p "$STATE_DIR"

  if pid="$(running_pid)"; then
    echo "Keiko UI already running on http://${HOST}:${PORT} (pid ${pid})."
    return 0
  fi

  # The built assets must all be present: `npm run build` compiles the CLI/BFF and
  # `npm run build:ui` produces the static export AND the CSP hashes the server resolves
  # at request time. Missing any one of them is a build problem, not a runtime one.
  if [[ ! -f "$ENTRY" ]] || [[ ! -d "$STATIC_DIR" ]] || [[ ! -f "$CSP_HASHES" ]]; then
    echo "Keiko UI: build assets missing." >&2
    echo "Run: npm run build && npm run build:ui" >&2
    return 1
  fi

  echo "Starting Keiko UI on http://${HOST}:${PORT} ..."
  nohup node "$ENTRY" ui --port "$PORT" --host "$HOST" >>"$LOG_FILE" 2>&1 &
  pid=$!
  echo "$pid" >"$PID_FILE"

  # Poll the health endpoint until the server answers, it dies, or we time out.
  start_iters=$((START_TIMEOUT_SECS * 2))
  i=0
  while [[ "$i" -lt "$start_iters" ]]; do
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
  require_positive_int KEIKO_STOP_TIMEOUT_SECS "$STOP_TIMEOUT_SECS" || return 2
  if ! pid="$(running_pid)"; then
    echo "Keiko UI is not running."
    return 0
  fi

  echo "Stopping Keiko UI (pid ${pid}) ..."
  kill -TERM "$pid" 2>/dev/null || true

  # Wait for a graceful exit (the server closes its socket on SIGTERM) before SIGKILL.
  stop_iters=$((STOP_TIMEOUT_SECS * 2))
  if wait_until_not_keiko_ui "$pid" "$stop_iters"; then
    rm -f "$PID_FILE"
    echo "Keiko UI stopped."
    return 0
  fi

  echo "Keiko UI did not exit gracefully; sending SIGKILL." >&2
  kill -KILL "$pid" 2>/dev/null || true
  if ! wait_until_not_keiko_ui "$pid" 1; then
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
