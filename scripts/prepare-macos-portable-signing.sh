#!/bin/bash
set -euo pipefail
umask 077

root="$RUNNER_TEMP/keiko-macos-signing-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${RANDOM}"
keychain="$root/signing.keychain-db"
p12="$root/developer-id.p12"
p8="$root/notary-key.p8"
helper="$root/keychain-helper"
password="$(openssl rand -hex 32)"
mkdir -m 700 "$root"
printf '::add-mask::%s\n' "$root" "$password"
{
  printf 'KEIKO_SIGNING_TEMP_ROOT=%s\n' "$root"
  printf 'KEIKO_KEYCHAIN_PATH=%s\n' "$keychain"
  printf 'KEIKO_KEYCHAIN_PASSWORD=%s\n' "$password"
  printf 'KEIKO_P12_PATH=%s\n' "$p12"
  printf 'KEIKO_NOTARY_KEY_PATH=%s\n' "$p8"
} >> "$GITHUB_ENV"

printf '%s' "$APPLE_DEVELOPER_ID_CERT_P12_BASE64" | base64 -D > "$p12"
printf '%s' "$APPLE_NOTARY_KEY_P8_BASE64" | base64 -D > "$p8"
chmod 600 "$p12" "$p8"
clang -Wall -Wextra -Werror -Wno-deprecated-declarations -framework Security -framework CoreFoundation \
  native/portable-launcher/macos-keychain-helper.c -o "$helper" >/dev/null 2>&1
KEIKO_KEYCHAIN_PATH="$keychain" KEIKO_KEYCHAIN_PASSWORD="$password" KEIKO_P12_PATH="$p12" \
  APPLE_DEVELOPER_ID_CERT_PASSWORD="$APPLE_DEVELOPER_ID_CERT_PASSWORD" \
  "$helper" setup >/dev/null 2>&1
identity="$root/identity.txt"
security find-identity -v -p codesigning "$keychain" > "$identity" 2>/dev/null
[[ "$(grep -Ec '^[[:space:]]*[0-9]+\)' "$identity")" == "1" ]]
[[ "$(grep -Fc "\"$APPLE_DEVELOPER_ID_IDENTITY\"" "$identity")" == "1" ]]
rm -f "$identity" "$p12"
