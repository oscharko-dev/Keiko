#!/usr/bin/env bash
# Runs a narrow vitest selection inside a gates container, installing and building first when the
# container's own volumes are still empty. It is a targeted check in the governed Node 26 lane:
#
#   docker compose -f docker/gates/docker-compose.yml run --rm gates \
#     ./docker/gates/run-vitest.sh packages/keiko-activity-log/src/some.test.ts
#
# Suites never run on the host (a macOS tree and a Linux container cannot share node_modules, and
# the real login keychain stays out of reach); this is where a Linux CI failure is reproduced.
set -euo pipefail

if [[ $# -eq 0 ]]; then
  printf 'usage: run-vitest.sh <vitest file or filter>...\n' >&2
  exit 64
fi

printf 'node %s, npm %s\n' "$(node --version)" "$(npm --version)"
if [[ ! -x node_modules/.bin/vitest ]]; then
  printf '▶ installing workspaces (first run in this container volume)\n'
  npm ci --ignore-scripts
fi
npm run build:packages
exec npx vitest run "$@"
