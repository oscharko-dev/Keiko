// Negative architecture-gate test (ADR-0020 D5).
//
// Runs dependency-cruiser against the intentional-violation fixtures under
// tests/architecture/fixtures and ASSERTS:
//   (a) a non-zero exit code (the gate fired); and
//   (b) every expected rule name appears in stdout, exactly once per fixture, so each
//       physically-extracted package boundary is proven live by name (not just by exit code).
//
// Exits 0 on assertion success, 1 on assertion failure.
//
// `--include-only` here overrides the production config's includeOnly (which scopes
// the production scan to ^(src|packages/[^/]+/src)). The override is a strict superset:
// it covers the fixture files themselves, their unresolved relative import targets (`../`-form,
// emitted when the target package does not yet exist on disk), AND the production
// includeOnly so that once a future PR creates the target package, dependency-cruiser
// still resolves the import to a `packages/...` path that stays inside the scan.

import { spawnSync } from "node:child_process";

const RULES_FILE = ".dependency-cruiser.cjs";
const FIXTURE_PATH = "tests/architecture/fixtures";
const INCLUDE_ONLY_OVERRIDE = "^(tests/architecture/fixtures|\\.\\./|src|packages/[^/]+/src)";

// One expected rule per physically-extracted package boundary. Each rule should fire EXACTLY ONCE
// against its dedicated fixture subdir, so the assertion is "name appears, exit non-zero". Add a
// new entry whenever a new boundary lands a fixture under tests/architecture/fixtures/<name>/.
const EXPECTED_RULES = [
  "adr-0019-direction-1-contracts-leaf",
  "adr-0019-direction-2-security-only-contracts",
  "adr-0019-direction-3a-model-gateway-only-contracts-security",
  "adr-0019-direction-3b-workspace-only-contracts-security",
  "adr-0019-direction-3c-tools-only-contracts-security-workspace",
  "adr-0019-direction-3d-evidence-only-contracts-security-workspace",
  "adr-0019-direction-3e-local-knowledge-only-contracts",
  "adr-0019-direction-3k-verification-only-contracts-security-workspace-tools",
  "adr-0019-direction-3l-evaluations-only-contracts-security-model-gateway-workspace-tools-harness-workflows-verification-evidence",
  "adr-0019-direction-3f-memory-vault-only-contracts-security",
  "adr-0019-direction-3g-memory-capture-only-contracts-security",
  "adr-0019-direction-3h-memory-consolidation-only-contracts-security",
  "adr-0019-direction-3i-memory-governance-only-contracts-security",
  "adr-0019-direction-3j-memory-retrieval-only-contracts-security",
  "adr-0019-direction-10a-quality-intelligence-only-contracts-security",
  "adr-0019-direction-4a-harness-only-contracts-security-model-gateway-workspace-tools-evidence",
  "adr-0019-direction-5a-workflows-only-contracts-security-model-gateway-workspace-tools-harness-evidence",
  "adr-0019-direction-6a-server-only-contracts-security-model-gateway-workspace-tools-harness-workflows-evidence",
  "adr-0019-direction-7a-cli-only-contracts-security-model-gateway-workspace-tools-harness-workflows-evaluations-evidence-server-verification",
  "adr-0019-direction-8-ui-not-node-domain-values",
  "adr-0019-direction-9-root-product-composition-only",
];

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

// dependency-cruiser exits 0 when no rules fired and a positive integer equal to the error count
// otherwise. Asserting non-zero guards against a silent gate; per-rule string assertions below
// guard against the wrong rule firing or a rule disappearing entirely.
if (result.status === 0) {
  console.error(
    "arch-check-negative: FAIL — expected dep-cruiser to report violations, got exit 0.",
  );
  console.error("  Stdout:", result.stdout);
  console.error("  Stderr:", result.stderr);
  process.exit(1);
}

const stdout = result.stdout;

// Count rule firings per expected name. Each rule must fire EXACTLY ONCE in this run: each
// fixture subdir is tightly scoped to one rule via its `from.path` in .dependency-cruiser.cjs, so
// a second firing would indicate either a fixture leak across subdirs or a duplicate report.
// `includes()` alone would silently accept duplicates and drift the gate over time.
function countOccurrences(haystack, needle) {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

const wrong = EXPECTED_RULES.map((rule) => ({
  rule,
  count: countOccurrences(stdout, rule),
})).filter((entry) => entry.count !== 1);
if (wrong.length > 0) {
  for (const { rule, count } of wrong) {
    console.error(
      `arch-check-negative: FAIL — rule \`${rule}\` fired ${String(count)} times (expected 1).`,
    );
  }
  console.error("  Stdout:");
  console.error(stdout);
  console.error("  Stderr:");
  console.error(result.stderr);
  process.exit(1);
}

console.log(
  `arch-check-negative: PASS — gate fired on ${String(EXPECTED_RULES.length)} fixture(s) as expected.`,
);
console.log(stdout.trim());
process.exit(0);
