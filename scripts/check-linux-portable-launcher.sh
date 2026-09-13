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

# macOS and Windows have always compiled these two beside the launcher test; Linux did not, which
# is why a header with no Linux branch reached a release tag unnoticed. The known-answer vectors
# now run on every platform that ships an artifact.
cc \
  -std=c11 \
  -Wall \
  -Wextra \
  -Werror \
  -D_GNU_SOURCE \
  "$root/native/portable-launcher/keiko-portable-sha256.test.c" \
  -o "$scratch/keiko-portable-sha256-test"
"$scratch/keiko-portable-sha256-test"

cc \
  -std=c11 \
  -Wall \
  -Wextra \
  -Werror \
  -D_GNU_SOURCE \
  "$root/native/portable-launcher/keiko-portable-tree-hash.test.c" \
  -o "$scratch/keiko-portable-tree-hash-test"
"$scratch/keiko-portable-tree-hash-test"

echo "linux-portable-launcher-quality: PASS"
