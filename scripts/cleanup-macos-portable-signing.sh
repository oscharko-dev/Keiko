#!/bin/bash
set -uo pipefail

target="${1:-}"
native_result="${2:-}"
root="${KEIKO_SIGNING_TEMP_ROOT:-}"
status=0

if [[ -n "$root" ]]; then
  safe_root=false
  case "$root" in "$RUNNER_TEMP"/keiko-macos-signing-*) safe_root=true ;; *) status=1 ;; esac
  if [[ "$safe_root" == true && -x "$root/keychain-helper" ]]; then
    "$root/keychain-helper" cleanup >/dev/null 2>&1 || status=1
  fi
  if [[ "$safe_root" == true ]]; then
    rm -rf "$root" >/dev/null 2>&1 || status=1
    [[ ! -e "$root" ]] || status=1
  fi
fi

{
  printf 'KEIKO_SIGNING_TEMP_ROOT=\n'
  printf 'KEIKO_KEYCHAIN_PATH=\n'
  printf 'KEIKO_KEYCHAIN_PASSWORD=\n'
  printf 'KEIKO_P12_PATH=\n'
  printf 'KEIKO_NOTARY_KEY_PATH=\n'
} >> "$GITHUB_ENV" || status=1

if [[ "$status" == 0 && -n "$target" && -f "$native_result" ]]; then
  node scripts/macos-native-policy.mjs cleanup-success --target "$target" \
    --input "$native_result" --output "$native_result" >/dev/null 2>&1 || status=1
fi
exit "$status"
