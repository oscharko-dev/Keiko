#!/bin/bash
set -euo pipefail
umask 077

stage="$1"
target="$2"
inventory="$3"
verified_inventory="$4"
static_result="$5"
payload="$stage/payload/Keiko"
app="$payload/Keiko.app"
scratch="$KEIKO_SIGNING_TEMP_ROOT/native"
mkdir -m 700 "$scratch"

case "$target" in macos-arm64) required_arch="arm64" ;; macos-x64) required_arch="x86_64" ;; *) exit 1 ;; esac
[[ "$(uname -m)" == "$required_arch" ]]

sign_file() {
  local relative="$1" role="$2" path="$payload/$relative" entitlements
  entitlements="native/portable-launcher/macos-entitlements.plist"
  if [[ "$role" == "node-runtime" ]]; then entitlements="native/portable-launcher/macos-node-entitlements.plist"; fi
  if [[ -f "$path" ]]; then scripts/check-macos-macho-architecture.sh "$path" "$required_arch"; fi
  codesign --force --options runtime --timestamp --keychain "$KEIKO_KEYCHAIN_PATH" \
    --entitlements "$entitlements" --sign "$APPLE_DEVELOPER_ID_IDENTITY" "$path" >/dev/null 2>&1
}

while IFS=$'\t' read -r relative role; do sign_file "$relative" "$role"; done < <(
  node -e 'const x=require(process.argv[1]); for(const e of [...x.codeObjects].sort((a,b)=>b.relativePath.split("/").length-a.relativePath.split("/").length||a.relativePath.localeCompare(b.relativePath))) console.log(`${e.relativePath}\t${e.role}`)' "$inventory"
)
while IFS= read -r relative; do
  [[ -z "$relative" ]] && continue
  codesign --force --options runtime --timestamp --keychain "$KEIKO_KEYCHAIN_PATH" \
    --entitlements native/portable-launcher/macos-entitlements.plist \
    --sign "$APPLE_DEVELOPER_ID_IDENTITY" "$payload/$relative" >/dev/null 2>&1
done < <(node -e 'const x=require(process.argv[1]); for(const e of x.nestedBundles) console.log(e)' "$inventory")
node scripts/macos-portable-signing.mjs rebind-payload --stage-root "$stage" --target "$target"
codesign --force --options runtime --timestamp --keychain "$KEIKO_KEYCHAIN_PATH" \
  --entitlements native/portable-launcher/macos-entitlements.plist \
  --sign "$APPLE_DEVELOPER_ID_IDENTITY" "$app" >/dev/null 2>&1

submission="$scratch/notarization.zip"
result="$scratch/notary-result.json"
ditto -c -k --keepParent "$app" "$submission" >/dev/null 2>&1
xcrun notarytool submit "$submission" --key "$KEIKO_NOTARY_KEY_PATH" \
  --key-id "$APPLE_NOTARY_KEY_ID" --issuer "$APPLE_NOTARY_ISSUER_ID" \
  --wait --timeout 30m --output-format json > "$result" 2>/dev/null
node scripts/macos-portable-signing.mjs notary-result --result "$result"
rm -f "$submission" "$result"
xcrun stapler staple "$app" >/dev/null 2>&1

verify_signed_path() {
  local path="$1" role="$2" details entitlements
  codesign --verify --strict --verbose=2 "$path" >/dev/null 2>&1
  details="$scratch/codesign-details.txt"
  codesign -d --verbose=4 "$path" 2> "$details"
  grep -Fq "Authority=$APPLE_DEVELOPER_ID_IDENTITY" "$details"
  grep -Fq "TeamIdentifier=$APPLE_TEAM_ID" "$details"
  grep -Eq 'flags=.*\(runtime\)' "$details"
  grep -Fq 'Timestamp=' "$details"
  entitlements="$scratch/entitlements.plist"
  codesign -d --entitlements :- "$path" > "$entitlements" 2>/dev/null
  if [[ "$role" == "node-runtime" ]]; then
    node -e 'const fs=require("fs"),cp=require("child_process"); const p=process.argv[1],j=`${p}.json`; cp.execFileSync("plutil",["-convert","json","-o",j,p]); const x=JSON.parse(fs.readFileSync(j)); if(JSON.stringify(x)!==JSON.stringify({"com.apple.security.cs.allow-jit":true})) process.exit(1)' "$entitlements"
  else
    node -e 'const fs=require("fs"),cp=require("child_process"); const p=process.argv[1],j=`${p}.json`; cp.execFileSync("plutil",["-convert","json","-o",j,p]); const x=JSON.parse(fs.readFileSync(j)); if(Object.keys(x).length!==0) process.exit(1)' "$entitlements"
  fi
  rm -f "$entitlements" "$entitlements.json"
  rm -f "$details"
}

while IFS=$'\t' read -r relative role; do
  verify_signed_path "$payload/$relative" "$role"
done < <(node -e 'const x=require(process.argv[1]); for(const e of x.codeObjects) console.log(`${e.relativePath}\t${e.role}`)' "$inventory")
while IFS= read -r relative; do
  [[ -z "$relative" ]] && continue
  verify_signed_path "$payload/$relative" default
done < <(node -e 'const x=require(process.argv[1]); for(const e of x.nestedBundles) console.log(e)' "$inventory")
verify_signed_path "$app" default
codesign --verify --deep --strict --verbose=2 "$app" >/dev/null 2>&1
xcrun stapler validate "$app" >/dev/null 2>&1
spctl -a -t exec -vvv "$app" >/dev/null 2>&1

node scripts/macos-portable-signing.mjs inventory --stage-root "$stage" --target "$target" --inventory "$verified_inventory"
node scripts/macos-portable-signing.mjs compare-paths --expected-inventory "$inventory" --actual-inventory "$verified_inventory"

asset="$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).artifact.assetName)' "$stage/manifest/portable-manifest.json")"
rm -f "$stage/$asset"
ditto -c -k --sequesterRsrc --keepParent "$payload" "$stage/$asset" >/dev/null 2>&1
extract="$scratch/extracted"
mkdir "$extract"
ditto -x -k "$stage/$asset" "$extract" >/dev/null 2>&1
codesign --verify --deep --strict --verbose=2 "$extract/Keiko/Keiko.app" >/dev/null 2>&1
xcrun stapler validate "$extract/Keiko/Keiko.app" >/dev/null 2>&1
spctl -a -t exec -vvv "$extract/Keiko/Keiko.app" >/dev/null 2>&1
node scripts/macos-portable-signing.mjs inventory-root --payload-root "$extract/Keiko" --target "$target" --inventory "$scratch/extracted-inventory.json"
node scripts/macos-portable-signing.mjs compare-bytes --expected-inventory "$verified_inventory" --actual-inventory "$scratch/extracted-inventory.json"
rm -rf "$extract"
node scripts/macos-native-policy.mjs static-success --target "$target" --input "$static_result" \
  --output "$static_result"
