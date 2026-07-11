#!/bin/bash
set -euo pipefail
umask 077

target="$1"
disposable="$2"
case "$target" in macos-arm64 | macos-x64) ;; *) exit 1 ;; esac
case "$disposable" in "$RUNNER_TEMP"/keiko-isolated-macos-smoke-*) ;; *) exit 1 ;; esac
trap 'rm -rf "$disposable" >/dev/null 2>&1' EXIT

for name in APPLE_DEVELOPER_ID_CERT_P12_BASE64 APPLE_DEVELOPER_ID_CERT_PASSWORD \
  APPLE_DEVELOPER_ID_IDENTITY APPLE_NOTARY_ISSUER_ID APPLE_NOTARY_KEY_ID \
  APPLE_NOTARY_KEY_P8_BASE64 APPLE_TEAM_ID KEIKO_KEYCHAIN_PASSWORD KEIKO_KEYCHAIN_PATH \
  KEIKO_NOTARY_KEY_PATH KEIKO_P12_PATH KEIKO_SIGNING_TEMP_ROOT; do
  [[ -z "${!name:-}" ]]
  unset "$name"
done
unset GITHUB_ENV GITHUB_PATH GITHUB_OUTPUT GITHUB_STEP_SUMMARY BASH_ENV NODE_OPTIONS
unset GITHUB_TOKEN GH_TOKEN ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL
unset ACTIONS_RUNTIME_TOKEN ACTIONS_RUNTIME_URL ACTIONS_CACHE_URL ACTIONS_RESULTS_URL

sidecars=()
while IFS= read -r executable; do sidecars+=("$executable"); done < <(
  node -e 'const fs=require("fs"),p=JSON.parse(fs.readFileSync(process.argv[1])); for(const x of p.sidecarExecutables) console.log(x)' \
    "$disposable/smoke-plan.json"
)
app="$disposable/Keiko/Keiko.app"
"$app/Contents/Resources/runtime/node/bin/node" \
  -e 'const f=new Function("x","return x+1"); for(let i=0;i<10000;i++) if(f(i)!==i+1) process.exit(1)' \
  >/dev/null 2>&1
for executable in "${sidecars[@]}"; do
  "$app/Contents/Resources/$executable" --version >/dev/null 2>&1
done
