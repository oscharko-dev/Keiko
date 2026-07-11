#!/bin/bash
set -euo pipefail

architectures="$(lipo -archs "$1" 2>/dev/null)" || exit 1
printf '%s\n' "$architectures" | tr ' ' '\n' | grep -Fxq "$2"
