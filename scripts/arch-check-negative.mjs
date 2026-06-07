// Negative architecture-gate test (ADR-0020 D5).
//
// Runs dependency-cruiser and the AST import-policy checker against the
// intentional-violation fixtures under tests/architecture/fixtures and ASSERTS:
//   (a) a non-zero exit code (the gate fired); and
//   (b) every expected rule name appears in stdout, exactly once per fixture, so each
//       physically-extracted package boundary or import-specifier policy is proven live by name
//       (not just by exit code).
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

import {
  checkArchitectureImportPolicy,
  countImportPolicyViolationsByRule,
} from "./check-import-policy.mjs";

const RULES_FILE = ".dependency-cruiser.cjs";
const FIXTURE_PATH = "tests/architecture/fixtures";
const INCLUDE_ONLY_OVERRIDE = "^(tests/architecture/fixtures|\\.\\./|src|packages/[^/]+/src)";

// One expected rule per physically-extracted package boundary. Most rules should fire exactly once
// against their dedicated fixture subdir; workflows intentionally fires twice because it pins both
// the non-allow-listed sibling violation and the allow-listed sibling package-source bypass. The
// import-policy expectations below cover literal import specifiers dependency-cruiser does not
// expose as source graph edges in this repository configuration.
const EXPECTED_DEPCRUISER_RULE_COUNTS = {
  "adr-0019-direction-1-contracts-leaf": 1,
  "adr-0019-direction-2-security-only-contracts": 1,
  "adr-0019-direction-3a-model-gateway-only-contracts-security": 1,
  "adr-0019-direction-3b-workspace-only-contracts-security": 1,
  "adr-0019-direction-3c-tools-only-contracts-security-workspace": 1,
  "adr-0019-direction-3d-evidence-only-contracts-security-workspace": 1,
  "adr-0019-direction-3e-local-knowledge-only-contracts": 1,
  "adr-0019-direction-3k-verification-only-contracts-security-workspace-tools": 1,
  "adr-0019-direction-3l-evaluations-only-contracts-security-model-gateway-workspace-tools-harness-workflows-verification-evidence": 1,
  "adr-0019-direction-3f-memory-vault-only-contracts-security": 1,
  "adr-0019-direction-3g-memory-capture-only-contracts-security": 1,
  "adr-0019-direction-3h-memory-consolidation-only-contracts-security": 1,
  "adr-0019-direction-3i-memory-governance-only-contracts-security": 1,
  "adr-0019-direction-3j-memory-retrieval-only-contracts-security": 1,
  "adr-0019-direction-10a-quality-intelligence-only-contracts-security": 1,
  "adr-0019-direction-4a-harness-only-contracts-security-model-gateway-workspace-tools-evidence": 1,
  "adr-0019-direction-5a-workflows-only-contracts-security-model-gateway-workspace-tools-harness-evidence": 2,
  "adr-0019-direction-6a-server-only-contracts-security-model-gateway-workspace-tools-harness-workflows-evidence": 1,
  "adr-0019-direction-7a-cli-only-contracts-security-model-gateway-workspace-tools-harness-workflows-evaluations-evidence-server-verification": 1,
  "adr-0019-direction-6-domain-not-server": 1,
  "adr-0019-direction-7-domain-not-cli": 1,
  "adr-0019-direction-8-ui-not-node-domain-values": 1,
  "adr-0019-direction-9-root-product-composition-only": 1,
  "adr-0019-trust-2-ui-no-provider-config": 1,
  "adr-0019-trust-3-ui-no-gateway-internals": 1,
  "adr-0019-trust-6-evidence-allowed-callers": 1,
  "adr-0019-trust-7-cli-server-no-port-bypass": 1,
  "adr-0019-trust-8-no-do-not-follow-in-prod": 1,
};

const EXPECTED_IMPORT_POLICY_RULE_COUNTS = {
  "adr-0019-trust-1-provider-sdk-isolation": 1,
  "adr-0019-trust-4-no-direct-fs-outside-workspace": 1,
  "adr-0019-trust-5-patch-routes-through-tools": 1,
};

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

const wrongDepcruiserCounts = Object.entries(EXPECTED_DEPCRUISER_RULE_COUNTS)
  .map(([rule, expected]) => ({
    rule,
    expected,
    count: countOccurrences(stdout, rule),
  }))
  .filter((entry) => entry.count !== entry.expected);
if (wrongDepcruiserCounts.length > 0) {
  for (const { rule, count, expected } of wrongDepcruiserCounts) {
    console.error(
      `arch-check-negative: FAIL — rule \`${rule}\` fired ${String(count)} times (expected ${String(expected)}).`,
    );
  }
  console.error("  Stdout:");
  console.error(stdout);
  console.error("  Stderr:");
  console.error(result.stderr);
  process.exit(1);
}

const importPolicyViolations = await checkArchitectureImportPolicy(process.cwd(), {
  mode: "fixtures",
});
const importPolicyCounts = countImportPolicyViolationsByRule(importPolicyViolations);
const expectedImportPolicyRules = new Set(Object.keys(EXPECTED_IMPORT_POLICY_RULE_COUNTS));
const wrongImportPolicyCounts = Object.entries(EXPECTED_IMPORT_POLICY_RULE_COUNTS)
  .map(([rule, expected]) => ({
    rule,
    expected,
    count: importPolicyCounts.get(rule) ?? 0,
  }))
  .filter((entry) => entry.count !== entry.expected);
const unexpectedImportPolicyViolations = importPolicyViolations.filter(
  (violation) => !expectedImportPolicyRules.has(violation.rule),
);
if (wrongImportPolicyCounts.length > 0 || unexpectedImportPolicyViolations.length > 0) {
  for (const { rule, count, expected } of wrongImportPolicyCounts) {
    console.error(
      `arch-check-negative: FAIL — import-policy rule \`${rule}\` fired ${String(count)} times (expected ${String(expected)}).`,
    );
  }
  for (const violation of unexpectedImportPolicyViolations) {
    console.error(
      `arch-check-negative: FAIL — unexpected import-policy rule \`${violation.rule}\` fired at ${violation.file}:${String(violation.line)}.`,
    );
  }
  process.exit(1);
}

const expectedDepcruiserFixtureCount = Object.values(EXPECTED_DEPCRUISER_RULE_COUNTS).reduce(
  (sum, count) => sum + count,
  0,
);
const expectedImportPolicyFixtureCount = Object.values(EXPECTED_IMPORT_POLICY_RULE_COUNTS).reduce(
  (sum, count) => sum + count,
  0,
);

console.log(
  `arch-check-negative: PASS — gate fired on ${String(expectedDepcruiserFixtureCount + expectedImportPolicyFixtureCount)} fixture(s) as expected.`,
);
console.log(stdout.trim());
for (const violation of importPolicyViolations) {
  console.log(
    `${violation.rule}: ${violation.file}:${String(violation.line)} imports ${JSON.stringify(violation.specifier)}`,
  );
}
process.exit(0);
