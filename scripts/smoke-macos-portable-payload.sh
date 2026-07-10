#!/bin/bash
set -euo pipefail
umask 077

stage="$1"
target="$2"
static_result="$3"
verification_input="$4"
app="$stage/payload/Keiko/Keiko.app"

for name in APPLE_DEVELOPER_ID_CERT_P12_BASE64 APPLE_DEVELOPER_ID_CERT_PASSWORD \
  APPLE_DEVELOPER_ID_IDENTITY APPLE_NOTARY_ISSUER_ID APPLE_NOTARY_KEY_ID \
  APPLE_NOTARY_KEY_P8_BASE64 APPLE_TEAM_ID KEIKO_KEYCHAIN_PASSWORD KEIKO_KEYCHAIN_PATH \
  KEIKO_NOTARY_KEY_PATH KEIKO_P12_PATH KEIKO_SIGNING_TEMP_ROOT; do
  [[ -z "${!name:-}" ]]
done

"$app/Contents/Resources/runtime/node/bin/node" \
  -e 'const f=new Function("x","return x+1"); for(let i=0;i<10000;i++) if(f(i)!==i+1) process.exit(1)' \
  >/dev/null 2>&1
while IFS= read -r executable; do
  "$app/Contents/Resources/$executable" --version >/dev/null 2>&1
done < <(
  node -e 'const fs=require("fs"),m=JSON.parse(fs.readFileSync(process.argv[1])); for(const s of m.sidecarRuntimes||[]) console.log(s.executablePath)' \
    "$stage/manifest/portable-manifest.json"
)
node scripts/macos-native-policy.mjs complete --stage-root "$stage" --target "$target" \
  --input "$static_result" --output "$verification_input"
