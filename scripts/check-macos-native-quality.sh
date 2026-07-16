#!/usr/bin/env bash
set -euo pipefail

target="${1:-macos-arm64}"
case "$target" in
  macos-arm64 | macos-x64) ;;
  *)
    echo "macos-native-quality: FAIL - unsupported target"
    exit 1
    ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/keiko-native-quality.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

common=(-std=c17 -Wall -Wextra -Wpedantic -Werror)
launcher_define="-DKEIKO_PORTABLE_TARGET=\"${target}\""
launcher="$root/native/portable-launcher/keiko-portable-launcher.c"
helper="$root/native/portable-launcher/macos-keychain-helper.c"
launcher_test="$root/native/portable-launcher/keiko-portable-launcher.test.c"

clang "${common[@]}" "$launcher_define" "$launcher" -o "$scratch/keiko-launcher"
clang --analyze "${common[@]}" "$launcher_define" "$launcher" -o /dev/null
clang "${common[@]}" -Wno-deprecated-declarations -framework Security -framework CoreFoundation \
  "$helper" -o "$scratch/keychain-helper"
clang --analyze "${common[@]}" -Wno-deprecated-declarations "$helper" -o /dev/null
clang "${common[@]}" "$launcher_define" "$launcher_test" -o "$scratch/launcher-test"
"$scratch/launcher-test"

set +e
"$scratch/keychain-helper" >/dev/null 2>&1
invalid_status=$?
set -e
if [[ "$invalid_status" -ne 1 ]]; then
  echo "macos-native-quality: FAIL - invalid invocation did not fail closed"
  exit 1
fi

# Secure workspace read helper: warnings-as-errors compile with its release flag set,
# Clang static analyzer, and the executable protocol/boundary harness.
secure_read="$root/native/secure-workspace-read/secure_workspace_read.c"
secure_read_flags=(-std=c11 -Wall -Wextra -Werror -O2 -D_DARWIN_C_SOURCE)
clang "${secure_read_flags[@]}" "$secure_read" -o "$scratch/secure-workspace-read"
clang --analyze "${secure_read_flags[@]}" "$secure_read" -o /dev/null
node "$root/native/secure-workspace-read/test-protocol.mjs"

echo "macos-native-quality: PASS - compiler, analyzer, and boundary checks completed."
