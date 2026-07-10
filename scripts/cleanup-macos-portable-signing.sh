#!/bin/bash
set -uo pipefail

target="${1:-}"
native_result="${2:-}"
root="${KEIKO_SIGNING_TEMP_ROOT:-}"
status=0
safe_root=false
helper_executable=false

if [[ -n "$root" ]]; then
  case "$root" in "$RUNNER_TEMP"/keiko-macos-signing-*) safe_root=true ;; *) status=1 ;; esac
  if [[ "$safe_root" == true && -x "$root/keychain-helper" ]]; then
    helper_executable=true
  fi
fi

if [[ -n "$target" && -f "$native_result" ]]; then
  node scripts/macos-native-policy.mjs cleanup-authority --target "$target" \
    --input "$native_result" --safe-root "$safe_root" \
    --helper-executable "$helper_executable" >/dev/null 2>&1 || status=1
fi

if [[ -n "$root" ]]; then
  if [[ "$safe_root" == true && "$helper_executable" == true ]]; then
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
