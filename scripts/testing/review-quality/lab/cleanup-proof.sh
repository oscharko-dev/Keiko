#!/usr/bin/env bash
# Cleanup proof for lab.sh (R4130-041, R4130-042), without models or network:
#
#   scripts/testing/review-quality/lab/cleanup-proof.sh [path/to/lab.sh]
#
# It copies lab.sh into a scratch checkout whose gate entry is a stub, and serves the "models" and
# the gateway with python3's http.server on spare loopback ports. Each case checks that `lab.sh run`
# keeps the gate's exit status and that no server it started is still listening afterwards.
# Prints one line per case and exits 1 if any case fails.
set -u

LAB_SH=${1:-$(cd "$(dirname "$0")" && pwd)/lab.sh}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/keiko-lab-proof.XXXXXX")
TREE=$WORK/tree
export KEIKO_REVIEW_LAB=$WORK/lab
export KEIKO_REVIEW_LAB_REVIEWER_PORT=18080
export KEIKO_REVIEW_LAB_COUNTER_PORT=18081
export KEIKO_REVIEW_LAB_GATEWAY_PORT=14000
export KEIKO_REVIEW_LAB_MIN_FREE_GB=0
PORTS="18080 18081 14000"
# A background job of a non-interactive shell ignores SIGINT. The wrapper restores it and gives the
# run its own process group, so the interrupt case can signal the group as a terminal's Ctrl-C does.
WRAP='import os,signal,sys; signal.signal(signal.SIGINT, signal.SIG_DFL); os.setsid(); os.execv(sys.argv[1], sys.argv[1:])'
FAILED=0

listening_count() {
  local n=0 port
  for port in $PORTS; do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then n=$((n + 1)); fi
  done
  echo "$n"
}

prepare() { # gate behaviour: exit7 | hang
  rm -rf "$TREE" "$KEIKO_REVIEW_LAB"
  mkdir -p "$TREE/scripts/testing/review-quality/lab" "$KEIKO_REVIEW_LAB/venv/bin" \
    "$KEIKO_REVIEW_LAB/logs" "$KEIKO_REVIEW_LAB/keiko"
  cp "$LAB_SH" "$TREE/scripts/testing/review-quality/lab/lab.sh"
  chmod +x "$TREE/scripts/testing/review-quality/lab/lab.sh"
  if [ "$1" = exit7 ]; then
    echo 'process.exit(7);' > "$TREE/scripts/testing/review-quality/run.mjs"
  else
    echo 'setInterval(() => {}, 1000);' > "$TREE/scripts/testing/review-quality/run.mjs"
  fi
  local stub
  for stub in mlx_lm.server litellm; do
    cat > "$KEIKO_REVIEW_LAB/venv/bin/$stub" <<'EOF'
#!/usr/bin/env bash
port=
while [ $# -gt 0 ]; do
  if [ "$1" = --port ]; then port=$2; fi
  shift
done
exec python3 -m http.server --bind 127.0.0.1 "$port"
EOF
  done
  printf '#!/usr/bin/env bash\necho /nonexistent/stub-model\n' > "$KEIKO_REVIEW_LAB/venv/bin/hf"
  chmod +x "$KEIKO_REVIEW_LAB/venv/bin/"*
  printf 'LITELLM_MASTER_KEY=sk-stub\n' > "$KEIKO_REVIEW_LAB/.env"
  : > "$KEIKO_REVIEW_LAB/litellm-4bit.yaml"
}

start_run() { # in the background, in its own process group; sets RUN_PID
  python3 -c "$WRAP" "$TREE/scripts/testing/review-quality/lab/lab.sh" run 4bit seeds \
    >> "$WORK/run.log" 2>&1 &
  RUN_PID=$!
  local _
  for _ in $(seq 1 30); do
    if [ "$(listening_count)" = 3 ]; then break; fi
    sleep 1
  done
  sleep 2
}

expect() { # case expected-status actual-status
  sleep 1
  local left
  left=$(listening_count)
  if [ "$3" = "$2" ] && [ "$left" = 0 ]; then
    echo "PASS $1: status $3, no server left"
  else
    echo "FAIL $1: status $3 (expected $2), $left server(s) still listening"
    FAILED=1
  fi
}

if [ "$(listening_count)" != 0 ]; then
  echo "cleanup-proof: ports $PORTS must be free" >&2
  exit 2
fi

prepare exit7
python3 -c "$WRAP" "$TREE/scripts/testing/review-quality/lab/lab.sh" run 4bit seeds >> "$WORK/run.log" 2>&1
expect "the gate fails" 7 "$?"

prepare hang
start_run
kill -INT -- "-$RUN_PID"
wait "$RUN_PID"
expect "Ctrl-C during the gate" 130 "$?"

prepare hang
start_run
kill -TERM "$RUN_PID"
wait "$RUN_PID"
expect "SIGTERM during the gate" 143 "$?"

prepare exit7
python3 -m http.server --bind 127.0.0.1 "$KEIKO_REVIEW_LAB_GATEWAY_PORT" >/dev/null 2>&1 &
blocker=$!
sleep 1
python3 -c "$WRAP" "$TREE/scripts/testing/review-quality/lab/lab.sh" run 4bit seeds >> "$WORK/run.log" 2>&1
status=$?
kill "$blocker" 2>/dev/null
wait "$blocker" 2>/dev/null
expect "the gateway port is taken" 1 "$status"

rm -rf "$WORK"
exit "$FAILED"
