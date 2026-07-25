#!/usr/bin/env bash
# Runs the gates that most often turn our required CI red, in CI's own Linux userland.
#
# Selection is evidence-based, not a guess: over the twelve most recent failing CI runs the causes
# were SonarCloud findings (5), D12 evidence (4), dependency audits (4), release smoke E2E (2),
# coverage gates (2) and UI typecheck (1). Everything reproducible without CI secrets or a second
# operating system is below. See docs/qa/local-gates.md for what deliberately stays CI-owned.
#
# Usage:  ./docker/gates/run-gates.sh [suite]
#   fast   lint, typecheck, format, arch — the cheap majority (default)
#   tests  fast + unit and UI suites with coverage
#   e2e    tests + release smoke E2E (needs the browser download)
#   full   everything above plus the package/surface gates
set -euo pipefail

suite="${1:-fast}"
failed=()

step() {
  local label="$1"
  shift
  printf '\n\033[1m▶ %s\033[0m\n' "$label"
  if "$@"; then
    printf '\033[32m✔ %s\033[0m\n' "$label"
  else
    printf '\033[31m✘ %s\033[0m\n' "$label"
    failed+=("$label")
  fi
}

if [ ! -d node_modules ] || [ ! -x node_modules/.bin/vitest ]; then
  printf '\033[1m▶ installing workspaces (first run in this container)\033[0m\n'
  npm ci --ignore-scripts
fi

step "typecheck (package graph)" npm run typecheck
step "typecheck (keiko-ui)" npm run typecheck --workspace @oscharko-dev/keiko-ui
step "lint" npm run lint
step "lint (keiko-ui)" npm run lint --workspace @oscharko-dev/keiko-ui
step "format:check" npm run format:check
step "arch:check" npm run arch:check
step "adr-index" npm run check:adr-index
step "dependency-hygiene" npm run check:dependency-hygiene
step "osv-waiver-scope" npm run check:osv-waiver-scope
step "audit (shipped graph)" npm audit --audit-level=high --omit=dev

if [ "$suite" != "fast" ]; then
  step "unit tests" npm test
  step "ui tests with coverage" npm run test:coverage:ui
  step "ui coverage ratchet" npm run check:coverage:ui
fi

if [ "$suite" = "e2e" ] || [ "$suite" = "full" ]; then
  browsers="${PLAYWRIGHT_BROWSERS_PATH:-/opt/playwright}"
  if ! compgen -G "${browsers}/chromium-*" > /dev/null; then
    step "install chromium" npx --ignore-scripts playwright@1.61.1 install --with-deps chromium
  fi
  step "release smoke E2E" npm run test:e2e:smoke
fi

if [ "$suite" = "full" ]; then
  step "build" npm run build
  step "build:ui" npm run build:ui
  step "package surface" npm run check:package-surface
fi

printf '\n'
if [ ${#failed[@]} -gt 0 ]; then
  printf '\033[31m%d gate(s) failed:\033[0m\n' "${#failed[@]}"
  printf '  - %s\n' "${failed[@]}"
  printf '\nFix these before pushing — each one would have cost a full CI cycle.\n'
  exit 1
fi
printf '\033[32mAll local gates passed.\033[0m\n'
printf 'Still CI-owned: SonarCloud, D12 wall-clock evidence, Windows/macOS smoke, attestations.\n'
