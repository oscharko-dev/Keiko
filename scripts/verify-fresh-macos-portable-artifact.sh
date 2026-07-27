#!/bin/bash
set -euo pipefail
umask 077

[[ $# -eq 3 ]] || exit 1
target="$1"
disposable="$2"
scratch="$3"
payload="$disposable/Keiko"
app="$payload/Keiko.app"
mkdir -m 700 "$scratch"
trap 'rm -rf "$scratch"' EXIT

case "$target" in macos-arm64) required_arch="arm64" ;; macos-x64) required_arch="x86_64" ;; *) exit 1 ;; esac
[[ "$(uname -m)" == "$required_arch" ]]
[[ -n "${APPLE_DEVELOPER_ID_IDENTITY:-}" && -n "${APPLE_TEAM_ID:-}" ]]

inventory="$scratch/inventory.json"
node scripts/macos-portable-signing.mjs inventory-root --payload-root "$payload" --target "$target" --inventory "$inventory"

verify_path() {
  local path="$1"
  local role="$2"
  local details="$scratch/codesign-details.txt"
  local entitlements="$scratch/entitlements.plist"
  if [[ -f "$path" ]]; then scripts/check-macos-macho-architecture.sh "$path" "$required_arch"; fi
  codesign --verify --strict --verbose=2 "$path" >/dev/null 2>&1
  codesign -d --verbose=4 "$path" 2> "$details"
  grep -Fq "Authority=$APPLE_DEVELOPER_ID_IDENTITY" "$details"
  grep -Fq "TeamIdentifier=$APPLE_TEAM_ID" "$details"
  grep -Eq 'flags=.*\(runtime\)' "$details"
  grep -Fq 'Timestamp=' "$details"
  codesign -d --entitlements :- "$path" > "$entitlements" 2>/dev/null
  node -e 'const fs=require("fs"),cp=require("child_process");const p=process.argv[1],role=process.argv[2],j=`${p}.json`;cp.execFileSync("plutil",["-convert","json","-o",j,p]);const x=JSON.parse(fs.readFileSync(j));let expected={};if(role==="node-runtime")expected={"com.apple.security.cs.allow-jit":true};if(role==="system-extension-manager"||role==="host-app")expected={"com.apple.developer.system-extension.install":true};if(role==="endpoint-security-extension")expected={"com.apple.developer.endpoint-security.client":true};if(JSON.stringify(x)!==JSON.stringify(expected))process.exit(1)' "$entitlements" "$role"
  rm -f "$details" "$entitlements" "$entitlements.json"
}

while IFS=$'\t' read -r relative role; do verify_path "$payload/$relative" "$role"; done < <(
  node -e 'const x=require(process.argv[1]);for(const e of x.codeObjects)console.log(`${e.relativePath}\t${e.role}`)' "$inventory"
)
while IFS= read -r relative; do
  [[ -z "$relative" ]] && continue
  role="default"
  [[ "$relative" == *.systemextension ]] && role="endpoint-security-extension"
  verify_path "$payload/$relative" "$role"
done < <(
  node -e 'const x=require(process.argv[1]);for(const e of x.nestedBundles)console.log(e)' "$inventory"
)
verify_path "$app" host-app
codesign --verify --deep --strict --verbose=2 "$app" >/dev/null 2>&1
xcrun stapler validate "$app" >/dev/null 2>&1
spctl -a -t exec -vvv "$app" >/dev/null 2>&1
echo "fresh macOS qualification passed for $target"
