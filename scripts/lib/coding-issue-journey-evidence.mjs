// Pure cross-referencing logic for the #3390 qualification-manifest evidence gate. Kept free of
// node:fs and the keiko-contracts import (mirroring scripts/lib/code-task-acceptance.mjs's split
// between a pure projection/validator and its I/O-performing CLI wrapper) so it has direct vitest
// coverage without a package build. The CLI wrapper
// (scripts/check-coding-issue-journey-evidence.mjs) supplies the actual contract validators, the
// current git head commit/tree SHAs, and the receipts discovered on disk; this module only
// combines what it is handed.

const PLATFORM_KEY_BY_OS_ARCH = Object.freeze({
  "darwin:arm64": "macos-arm64",
  "darwin:x64": "macos-x64",
  "win32:x64": "windows-x64",
  "linux:x64": "linux-x64",
});

/**
 * Maps a Node `os.platform()`/`os.arch()` pair to a `CODE_TASK_EVIDENCE_PLATFORMS` member, or
 * `undefined` for a combination this repository has no evidence platform for.
 */
export function platformKeyFor(osName, archName) {
  return PLATFORM_KEY_BY_OS_ARCH[`${osName}:${archName}`];
}

function receiptBindingFailures(scenario, receipt, headCommitSha) {
  const failures = [];
  if (receipt.commitSha !== headCommitSha) {
    failures.push(
      `${scenario.scenarioId}: receipt is bound to a stale or foreign commit (expected ` +
        `${headCommitSha}, got ${String(receipt.commitSha)})`,
    );
  }
  if (receipt.platform !== scenario.platform) {
    failures.push(
      `${scenario.scenarioId}: receipt platform ${String(receipt.platform)} does not match the ` +
        `manifest's ${scenario.platform}`,
    );
  }
  if (receipt.digest !== scenario.receiptDigest.value) {
    failures.push(
      `${scenario.scenarioId}: receipt artifact digest does not match the manifest (wrong-SHA receipt)`,
    );
  }
  return failures;
}

function receiptTestStatusFailures(scenario, receipt) {
  if (receipt.testStatus === "skipped" || receipt.testStatus === "unreachable") {
    return [
      `${scenario.scenarioId}: receipt test status is ${String(receipt.testStatus)}, which is ` +
        "not release qualification evidence",
    ];
  }
  if (receipt.testStatus !== "passed" && scenario.outcome === "passed") {
    return [
      `${scenario.scenarioId}: receipt reports ${String(receipt.testStatus)} tests, which cannot ` +
        "support a passed outcome",
    ];
  }
  return [];
}

function scenarioReceiptFailures(scenario, receiptsByScenarioId, headCommitSha) {
  if (scenario.receiptDigest.outcome !== "known") {
    return scenario.outcome === "passed"
      ? [`${scenario.scenarioId}: a passed scenario requires a known receipt digest`]
      : [];
  }
  const receipt = receiptsByScenarioId.get(scenario.scenarioId);
  if (receipt === undefined) {
    return [`${scenario.scenarioId}: missing receipt`];
  }
  return [
    ...receiptBindingFailures(scenario, receipt, headCommitSha),
    ...receiptTestStatusFailures(scenario, receipt),
  ];
}

/**
 * Cross-references a structurally validated qualification manifest against the qualified git
 * head and the receipts actually found on disk. Structural/binding failures already produced by
 * the contract layer (`codeTaskQualificationManifestFailures`) are passed in as `manifestFailures`
 * so this module stays dependency-free; a structurally invalid manifest short-circuits to its own
 * (prefixed) validation errors.
 */
export function evidenceGateFailures({
  manifestValidation,
  manifestFailures,
  headCommitSha,
  headTreeSha,
  receiptsByScenarioId,
}) {
  if (!manifestValidation.ok) {
    return manifestValidation.errors.map((error) => `manifest: ${error}`);
  }
  const manifest = manifestValidation.value;
  const failures = [];
  if (manifest.sourceTreeSha !== headTreeSha) {
    failures.push(
      `manifest is not bound to the qualified head: expected tree ${headTreeSha}, got ` +
        manifest.sourceTreeSha,
    );
  }
  for (const failure of manifestFailures) {
    failures.push(`manifest: ${failure}`);
  }
  for (const scenario of manifest.scenarios) {
    failures.push(...scenarioReceiptFailures(scenario, receiptsByScenarioId, headCommitSha));
  }
  return failures;
}

/**
 * The manifest-level gate verdict: a genuinely failed scenario is always "failed"; otherwise any
 * evidence-gate failure (a stale head, a missing/tampered/misbound receipt, an unreachable/skipped
 * test) downgrades the contract's own verdict to "blocked" and never upgrades one.
 */
export function deriveGateVerdict({ contractVerdict, failures, manifestValidation }) {
  if (!manifestValidation.ok) return "blocked";
  if (contractVerdict === "failed") return "failed";
  return failures.length === 0 ? contractVerdict : "blocked";
}
