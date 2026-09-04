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
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import {
  checkArchitectureImportPolicy,
  countImportPolicyViolationsByRule,
} from "./check-import-policy.mjs";
import { checkGovernedToolContractNegatives } from "./check-governed-tool-contract.mjs";
import { runBareSpecifierVisibilityProbe } from "./lib/bare-specifier-visibility-probe.mjs";

const RULES_FILE = ".dependency-cruiser.cjs";
const FIXTURE_PATH = "tests/architecture/fixtures";
// The bare-specifier visibility probe (Wave-2 audit #2627) writes a temporary source file
// under a `keiko-security` src path, imports `@oscharko-dev/keiko-harness` by its workspace
// package name, runs dependency-cruiser, verifies rule 2 fires against
// `packages/keiko-harness/dist/index.js`, and unconditionally cleans up. This proves the
// production `includeOnly` regex sees cross-package bare-specifier resolutions through the
// workspace `exports` map — the exact class of edge the audit found the previous gate blind
// to — without introducing a persistent test fixture whose lifecycle depends on an external
// build step. The dist file MUST exist for the resolver to reach it, so a preflight below
// fails loudly with `run \`npm run build:packages\` first` when the target is missing.
const PROBE_HOST_PACKAGE_SRC = "packages/keiko-security/src";
const PROBE_FILE_BASENAME = "__arch_check_negative_bare_specifier_probe__.ts";
const PROBE_TARGET_SPECIFIER = "@oscharko-dev/keiko-harness";
const PROBE_EXPECTED_RULE = "adr-0019-direction-2-security-only-contracts";
const PROBE_EXPECTED_RESOLVED = "packages/keiko-harness/dist/index.js";
const REQUIRED_DIST_ENTRYPOINTS = [PROBE_EXPECTED_RESOLVED];
// Superset of the production `includeOnly`: fixtures + relative-path targets + src +
// packages/<name>/(src|dist) + the external trust destinations. The `dist` suffix mirrors the
// production widening from Wave-2 audit #2627 so the bare-specifier visibility probe (run
// separately below) has the same graph shape available to the fixture scan. The provider-SDK
// and `node:fs`/`node:fs/promises` alternatives mirror the production EXTERNAL_TRUST_DESTINATIONS
// widening (audit KEIKO-0255) so trust rules 1, 4 and 5 are proven live by name here instead of
// being silently pruned before evaluation. This override must stay a superset of the production
// `includeOnly`; assertProductionIncludeOnlyIsCovered() below fails the gate if it drifts below it.
// DERIVED from the production filter, not restated beside it. A hand-copied twin drifts silently:
// production could admit a new destination alternative that this copy lacks, and the fixture scan
// would prune that destination while every assertion stayed green — the rule it proves would be
// dead exactly the way KEIKO-0255 found trust-1/4/5 dead (review finding on #3159).
const PRODUCTION_INCLUDE_ONLY = createRequire(import.meta.url)(join(process.cwd(), RULES_FILE))
  .options.includeOnly;
const INCLUDE_ONLY_OVERRIDE =
  String.raw`^(tests/architecture/fixtures|\.\./|` +
  // Strip the production regex's own `^(` … `)` wrapper and fold its alternatives in.
  PRODUCTION_INCLUDE_ONLY.replace(/^\^\(/u, "").replace(/\)$/u, "") +
  ")";

// One expected rule per physically-extracted package boundary. Most rules should fire exactly once
// against their dedicated fixture subdir; workflows intentionally fires twice because it pins both
// the non-allow-listed sibling violation and the allow-listed sibling package-source bypass, and
// direction-8 (ui) fires three times because it pins three distinct Node-domain boundaries the
// browser tier must not value-import: keiko-tools, keiko-quality-intelligence, and
// keiko-local-knowledge (the two latter added for the native QI UI surface, issue #280). The
// editor browser-tier rule (adr-0042-editor-not-node-domain-values) fires ten times against its
// dedicated editor-browser fixture, pinning model-gateway plus the ADR-0042 audit gap targets:
// the five existing keiko-memory-* packages, keiko-verification, keiko-ui internals, and (added by
// KEIKO-0638 to mirror the ui-browser fixture) keiko-quality-intelligence + keiko-local-knowledge.
// The
// import-policy expectations below cover literal import specifiers dependency-cruiser does not
// expose as source graph edges in this repository configuration.
const EXPECTED_DEPCRUISER_RULE_COUNTS = {
  "adr-0128-connectors-only-contracts-security": 1,
  "adr-0019-direction-1-contracts-leaf": 1,
  "adr-0019-direction-2-security-only-contracts": 1,
  "adr-0019-direction-2b-git-only-contracts": 1,
  "adr-0019-direction-3a-model-gateway-only-contracts-security": 1,
  "adr-0019-direction-3b-workspace-only-contracts-security": 1,
  "adr-0019-direction-3c-tools-only-contracts-security-workspace": 1,
  "adr-0043-sandbox-only-contracts": 1,
  "adr-0019-direction-3d-evidence-only-contracts-security-workspace": 1,
  "adr-0019-direction-3e-local-knowledge-only-contracts-security-workspace-model-gateway": 1,
  "adr-0019-direction-3k-verification-only-contracts-security-workspace-tools": 1,
  "adr-0019-direction-3l-evaluations-only-contracts-security-model-gateway-workspace-tools-harness-workflows-verification-evidence-local-knowledge": 1,
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
  "adr-0019-direction-8-ui-not-node-domain-values": 3,
  "adr-0042-editor-not-node-domain-values": 10,
  "adr-0019-direction-9-root-product-composition-only": 1,
  // trust-1/4/5 target destinations outside the first-party namespace (provider SDKs under
  // node_modules, the node:fs and node:fs/promises builtins). Until audit KEIKO-0255 they were
  // pruned by `includeOnly` before evaluation and fired nowhere — present in the config, dead in
  // practice, and covered only by the AST checker below. These three entries are the pin that
  // keeps the dependency-cruiser layer live: drop the includeOnly widening or the fixture path
  // from either rule's from.path and the expected count falls to 0 and this gate goes red.
  "adr-0019-trust-1-provider-sdk-isolation": 1,
  "adr-0019-trust-2-ui-no-provider-config": 1,
  "adr-0019-trust-3-ui-no-gateway-internals": 1,
  "adr-0019-trust-4-no-direct-fs-outside-workspace": 1,
  "adr-0019-trust-5-patch-routes-through-tools": 1,
  "adr-0019-trust-6-evidence-allowed-callers": 1,
  "adr-0019-trust-7-cli-server-no-port-bypass": 1,
  "adr-0019-trust-8-no-do-not-follow-in-prod": 1,
  "adr-0165-editor-read-allowed-callers": 2,
};

// Representative module paths spanning every alternative of the production `includeOnly`.
// The fixture-scan override must admit everything production admits: if it ever drops below the
// production filter, fixtures would be evaluated against a NARROWER graph than production and a
// rule could pass here while being dead in the real scan — the exact failure mode KEIKO-0255
// found. Regex superset is not decidable in general, so this asserts it behaviourally.
const INCLUDE_ONLY_COVERAGE_SAMPLES = [
  "src/cli/index.ts",
  "packages/keiko-tools/src/exec.ts",
  "packages/keiko-harness/dist/index.js",
  "node_modules/openai/index.js",
  "node_modules/@anthropic-ai/sdk/index.js",
  "node_modules/some-ai-sdk/index.js",
  "node:fs",
  "fs",
  "node:fs/promises",
  "fs/promises",
];

function assertProductionIncludeOnlyIsCovered() {
  const productionRe = new RegExp(PRODUCTION_INCLUDE_ONLY);
  const overrideRe = new RegExp(INCLUDE_ONLY_OVERRIDE);
  const uncovered = INCLUDE_ONLY_COVERAGE_SAMPLES.filter(
    (sample) => productionRe.test(sample) && !overrideRe.test(sample),
  );
  if (uncovered.length > 0) {
    console.error(
      "arch-check-negative: FAIL — the fixture-scan includeOnly override is no longer a superset " +
        "of the production includeOnly; these paths are cruised in production but pruned here:",
    );
    for (const sample of uncovered) {
      console.error(`  - ${sample}`);
    }
    process.exit(1);
  }
}

const EXPECTED_IMPORT_POLICY_RULE_COUNTS = {
  "adr-0165-raw-coordinate-owner": 1,
  "adr-0005-owned-root-authority-implementation-private": 1,
  "adr-0005-owned-root-containment-allowed-callers": 1,
  "adr-0005-owned-root-lookup-allowed-callers": 1,
  "adr-0005-owned-root-mint-allowed-callers": 1,
  "adr-0005-owned-root-preserve-allowed-callers": 1,
  "gen-perf-cli-001-cli-heavy-graphs-load-lazily": 1,
  "adr-0019-trust-1-provider-sdk-isolation": 1,
  "adr-0019-trust-4-no-direct-fs-outside-workspace": 1,
  "adr-0019-trust-5-patch-routes-through-tools": 1,
  "adr-0019-trust-9-local-knowledge-no-egress": 1,
  "adr-0128-connectors-no-direct-egress": 1,
  "gen-arch-coding-runtime-restricted-egress": 1,
  "adr-0112-provider-runtime-no-internal-bypass": 3,
};

// Fail loudly if a required dist entrypoint is missing. The bare-specifier visibility probe
// (Wave-2 audit #2627) needs the workspace `exports` map to resolve `@oscharko-dev/keiko-*`
// specifiers into `packages/keiko-<name>/dist/index.js`; without dist the resolver drops the
// edge and the probe assertion silently under-fires. Running `npm run build:packages` produces
// every dist target enumerated above.
const missingDist = REQUIRED_DIST_ENTRYPOINTS.filter(
  (entrypoint) => !existsSync(join(process.cwd(), entrypoint)),
);
if (missingDist.length > 0) {
  console.error(
    "arch-check-negative: FAIL — required dist entrypoint(s) missing; run `npm run build:packages` first.",
  );
  for (const entrypoint of missingDist) {
    console.error(`  - ${entrypoint}`);
  }
  process.exit(1);
}

const contractNegativeErrors = checkGovernedToolContractNegatives(process.cwd());
if (contractNegativeErrors.length > 0) {
  for (const error of contractNegativeErrors) console.error(`arch-check-negative: ${error}`);
  process.exit(1);
}

assertProductionIncludeOnlyIsCovered();

const probeOutcome = runBareSpecifierVisibilityProbe({
  repoRoot: process.cwd(),
  rulesFile: RULES_FILE,
  hostPackageSrc: PROBE_HOST_PACKAGE_SRC,
  probeFileBasename: PROBE_FILE_BASENAME,
  targetSpecifier: PROBE_TARGET_SPECIFIER,
  expectedRule: PROBE_EXPECTED_RULE,
  expectedResolved: PROBE_EXPECTED_RESOLVED,
});
if (!probeOutcome.ok) {
  // Redacted diagnostics per AGENTS.md §7: emit only a bounded reason label
  // (and, when the subprocess ran, its numeric exit status). Raw dep-cruiser
  // stdout/stderr is intentionally not surfaced so path fragments and other
  // subprocess text never leak into the gate log. Reproducing the failure
  // locally is one `npm run arch:check:negative` away.
  const suffix =
    typeof probeOutcome.exitStatus === "number" ? ` (exit ${String(probeOutcome.exitStatus)})` : "";
  console.error(
    `arch-check-negative: FAIL — bare-specifier visibility probe reason=${probeOutcome.reason}${suffix}`,
  );
  process.exit(1);
}

// Calling the dependency-cruiser bin through Node keeps the gate hermetic without
// going through platform-specific npm/npx shell shims.
const result = spawnSync(
  process.execPath,
  [
    join(process.cwd(), "node_modules", "dependency-cruiser", "bin", "dependency-cruise.mjs"),
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
