// Negative architecture-gate test (ADR-0020 D5).
//
// Runs dependency-cruiser against the intentional-violation fixture under
// tests/architecture/fixtures and ASSERTS A NON-ZERO EXIT CODE. The script exits 0
// on assertion success (the gate fired as expected) and 1 on assertion failure (the
// gate stayed silent — the gate is broken).
//
// `--include-only` here overrides the production config's includeOnly (which scopes
// the production scan to ^(src|packages/[^/]+/src)). The override is a strict superset:
// it covers the fixture file itself, its unresolved relative import target (`../`-form,
// emitted when the target package does not yet exist on disk), AND the production
// includeOnly so that once a future PR creates the target package, dependency-cruiser
// still resolves the import to a `packages/...` path that stays inside the scan.

import { spawnSync } from "node:child_process";

const RULES_FILE = ".dependency-cruiser.cjs";
const FIXTURE_PATH = "tests/architecture/fixtures";
const INCLUDE_ONLY_OVERRIDE = "^(tests/architecture/fixtures|\\.\\./|src|packages/[^/]+/src)";

// `npx --no-install` keeps CI hermetic by refusing to fetch from the registry when the
// local devDependency is missing. dependency-cruiser is a root devDependency, so npm
// resolution must already provide the local binary.
const result = spawnSync(
  "npx",
  [
    "--no-install",
    "depcruise",
    "--validate",
    RULES_FILE,
    "--include-only",
    INCLUDE_ONLY_OVERRIDE,
    FIXTURE_PATH,
  ],
  { encoding: "utf8" },
);

if (result.status === null) {
  console.error("arch-check-negative: failed to spawn depcruise:", result.error);
  process.exit(1);
}

// dependency-cruiser exits 1 specifically when validation rules fire on the input. Exit 2 (and
// other non-zero codes) signal internal errors — bad config, missing files, parse failures —
// which must NOT be accepted as a successful gate-fired result. Asserting exactly 1 keeps the
// negative test honest if dep-cruiser's config loader breaks in a future release.
if (result.status !== 1) {
  console.error(
    `arch-check-negative: FAIL — expected dep-cruiser exit 1 (rule fired), got ${String(result.status)}.`,
  );
  console.error("  Stdout:");
  console.error(result.stdout);
  console.error("  Stderr:");
  console.error(result.stderr);
  process.exit(1);
}

console.log("arch-check-negative: PASS — gate fired on fixture as expected (exit 1).");
if (result.stdout.trim().length > 0) {
  console.log(result.stdout.trim());
}
process.exit(0);
