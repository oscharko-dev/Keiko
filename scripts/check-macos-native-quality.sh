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
architecture="arm64"
if [[ "$target" == "macos-x64" ]]; then architecture="x86_64"; fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/keiko-native-quality.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

common=(-std=c17 -Wall -Wextra -Wpedantic -Werror -arch "$architecture")
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
secure_read_flags=(-std=c11 -Wall -Wextra -Werror -O2 -D_DARWIN_C_SOURCE -arch "$architecture")
clang "${secure_read_flags[@]}" "$secure_read" -o "$scratch/secure-workspace-read"
clang --analyze "${secure_read_flags[@]}" "$secure_read" -o /dev/null
node "$root/native/secure-workspace-read/test-protocol.mjs"

runtime_root="$root/native/runtime-supervisor/macos"
runtime_flags=(-std=c11 -Wall -Wextra -Werror -O2 -D_DARWIN_C_SOURCE -arch "$architecture")
supervisor="$runtime_root/keiko_runtime_supervisor.c"
fixture="$runtime_root/qualification_fixture.c"
clang "${runtime_flags[@]}" "$supervisor" -o "$scratch/keiko-runtime-supervisor"
clang --analyze "${runtime_flags[@]}" "$supervisor" -o /dev/null
clang "${runtime_flags[@]}" "$fixture" -o "$scratch/runtime-qualification-fixture"
clang --analyze "${runtime_flags[@]}" "$fixture" -o /dev/null

set +e
"$scratch/keiko-runtime-supervisor" >/dev/null 2>&1
invalid_supervisor_status=$?
set -e
if [[ "$invalid_supervisor_status" -eq 0 ]]; then
  echo "macos-native-quality: FAIL - supervisor accepted an unbound invocation"
  exit 1
fi

# KEIKO-0277: run the darwin protocol harness. Without arguments it runs the platform-independent
# source contract only (fd-3/fd-4 close pins, non-PATH spawn, no shell exec) — that alone catches
# a silent deletion of the trust boundary and is worth running on every PR. Behavioural
# qualification needs the installed Endpoint Security system extension to be ACTIVE (no hosted
# runner has that), so it is opt-in: `--helper` in the release pipeline, `--compile` on a
# workstation with the extension installed. Neither is set here; the release path in
# scripts/qualify-macos-runtime-release.mjs continues to pass `--helper <exact staged binary>`.
node "$runtime_root/test-protocol.mjs"

extension_root="$runtime_root/system-extension"
objective_c_flags=(-fobjc-arc -fblocks -Wall -Wextra -Werror -O2 -arch "$architecture")
extension="$extension_root/keiko_runtime_monitor.m"
manager="$extension_root/keiko_system_extension_manager.m"
extension_frameworks=(-lEndpointSecurity -lbsm -framework Security -framework CoreFoundation)
manager_frameworks=(-framework Foundation -framework SystemExtensions)
clang "${objective_c_flags[@]}" "${extension_frameworks[@]}" \
  "$extension" -o "$scratch/keiko-runtime-monitor"
clang --analyze "${objective_c_flags[@]}" "$extension" -o /dev/null
clang "${objective_c_flags[@]}" "${manager_frameworks[@]}" \
  "$manager" -o "$scratch/keiko-system-extension-manager"
clang --analyze "${objective_c_flags[@]}" "$manager" -o /dev/null

set +e
"$scratch/keiko-system-extension-manager" >/dev/null 2>&1
invalid_manager_status=$?
set -e
if [[ "$invalid_manager_status" -ne 1 ]]; then
  echo "macos-native-quality: FAIL - manager accepted an invalid invocation"
  exit 1
fi

echo "macos-native-quality: PASS - compiler, analyzer, and boundary checks completed."
