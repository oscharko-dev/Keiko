#!/bin/bash
set -euo pipefail

root="${KEIKO_SIGNING_TEMP_ROOT:-}"
if [[ -z "$root" ]]; then exit 0; fi
case "$root" in "$RUNNER_TEMP"/keiko-macos-signing-*) ;; *) exit 1 ;; esac
helper="$root/keychain-helper"
if [[ -x "$helper" ]]; then
  "$helper" cleanup >/dev/null 2>&1
fi
rm -rf "$root"
[[ ! -e "$root" ]]
{
  printf 'KEIKO_SIGNING_TEMP_ROOT=\n'
  printf 'KEIKO_KEYCHAIN_PATH=\n'
  printf 'KEIKO_KEYCHAIN_PASSWORD=\n'
  printf 'KEIKO_P12_PATH=\n'
  printf 'KEIKO_NOTARY_KEY_PATH=\n'
} >> "$GITHUB_ENV"
