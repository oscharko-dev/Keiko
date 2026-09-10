#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/keiko-linux-launcher-quality.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

cc \
  -std=c11 \
  -Wall \
  -Wextra \
  -Werror \
  -D_GNU_SOURCE \
  -DKEIKO_PORTABLE_TARGET=\"linux-x64\" \
  "$root/native/portable-launcher/keiko-portable-launcher.test.c" \
  -o "$scratch/keiko-portable-launcher-test"
"$scratch/keiko-portable-launcher-test"

echo "linux-portable-launcher-quality: PASS"
