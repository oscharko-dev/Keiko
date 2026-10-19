#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "linux-native-quality: FAIL - compiler and protocol qualification require Linux"
  exit 1
fi
mode="${1:---protocol-only}"
case "$mode" in
  --protocol-only | --kernel) ;;
  *) echo "linux-native-quality: FAIL - supply --protocol-only or --kernel"; exit 1 ;;
esac
if [[ "$#" -gt 1 ]]; then exit 1; fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/keiko-linux-native-quality.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
common=(-std=c17 -Wall -Wextra -Wpedantic -Werror -O2 '-DKEIKO_PORTABLE_TARGET="linux-x64"')
for source in keiko_runtime_supervisor qualification_fixture qualification_observer coordinator_encoder_fixture deadline_fixture owner_channel_fixture owner_receiver_fixture process_scope_root_fixture process_scope_receiver_fixture; do
  input="$root/native/runtime-supervisor/linux/${source}.c"
  cc "${common[@]}" "$input" -o "$scratch/$source"
  cc "${common[@]}" -fanalyzer -c "$input" -o "$scratch/${source}.analysis.o"
done
launcher="$root/native/portable-launcher/keiko-portable-launcher.c"
cc "${common[@]}" -D_GNU_SOURCE "$launcher" -o "$scratch/launcher"
cc "${common[@]}" -D_GNU_SOURCE -fanalyzer -c "$launcher" -o "$scratch/launcher.analysis.o"
cc "${common[@]}" -D_GNU_SOURCE \
  "$root/native/portable-launcher/keiko-portable-launcher.test.c" -o "$scratch/launcher-test"
"$scratch/launcher-test"
if [[ "$mode" == "--kernel" ]]; then
  node "$root/native/runtime-supervisor/linux/protocol.test.mjs" --helper "$scratch/keiko_runtime_supervisor"
  node "$root/native/runtime-supervisor/linux/owner-channel.test.mjs"
  node "$root/native/runtime-supervisor/linux/outer-owner.test.mjs"
  node "$root/native/runtime-supervisor/linux/process-scope.test.mjs"
  helper_digest="$(sha256sum "$scratch/keiko_runtime_supervisor")"
  helper_digest="${helper_digest%% *}"
  node "$root/native/runtime-supervisor/linux/protocol.test.mjs" --outer-owner \
    "$scratch/launcher" "$scratch/keiko_runtime_supervisor" "$helper_digest"
else
  node "$root/native/runtime-supervisor/linux/protocol.test.mjs" --protocol-only
fi
echo "linux-native-quality: PASS - compiler, analyzer and requested protocol/kernel scope"
