// Pure projection for the #3390 qualification manifest producer. Mirrors
// scripts/lib/code-task-acceptance.mjs's split between a pure descriptor+receipts join and its
// I/O-performing CLI wrapper (scripts/generate-coding-issue-journey-manifest.mjs), so the join
// logic has direct v8 coverage without a package build or a receipts directory on disk.
//
// A descriptor names two kinds of registered scenario: `scenarios` actually run and need a
// receipt, and `blocked` scenarios that are known, named, closed external gaps (issue #3390
// contract-correction 1: #2951/#2952/#2198 stay open) and carry their reason directly -- they
// never need a receipt, matching the evidence gate's own rule that a blocked scenario is never
// cross-referenced against the receipts directory (scripts/lib/coding-issue-journey-evidence.mjs).

function fact(value) {
  return value === undefined ? { outcome: "unknown" } : { outcome: "known", value };
}

/**
 * Projects one descriptor scenario that actually ran to a `CodeTaskQualificationScenarioV1`. A
 * missing receipt is a pipeline error (mirroring `buildCodeTaskAcceptanceContribution`'s own
 * rule): a declared non-blocked scenario must never fall back to a silent partial manifest.
 */
function buildRanScenario(entry, receiptsByScenarioId) {
  const receipt = receiptsByScenarioId.get(entry.scenarioId);
  if (receipt === undefined) throw new Error(`missing receipt for ${entry.scenarioId}`);
  return {
    scenarioId: entry.scenarioId,
    evidenceClass: entry.evidenceClass,
    platform: entry.platform,
    provenance: receipt.provenance,
    // Only a receipt reporting "passed" ever becomes a passed scenario; every other test status
    // (failed, skipped, unreachable) is recorded as "failed" here -- the evidence gate's own
    // `receiptTestStatusFailures` names the more specific reason (e.g. "not release qualification
    // evidence" for a skipped test) when it cross-references this receipt again.
    outcome: receipt.testStatus === "passed" ? "passed" : "failed",
    recordedAt: receipt.recordedAt,
    blockedReason: { outcome: "absent" },
    artifactDigests: [receipt.digest],
    receiptDigest: { outcome: "known", value: receipt.digest },
  };
}

/**
 * Projects one descriptor `blocked` row directly: its closed reason comes from the descriptor,
 * never from a receipt (issue #3390 contract-correction 1's blocked rows are a documented,
 * reviewed disposition, not a runtime observation). `generatedAt` timestamps the determination
 * since a blocked scenario has no execution of its own to timestamp.
 */
function buildBlockedScenario(entry, generatedAt) {
  return {
    scenarioId: entry.scenarioId,
    evidenceClass: entry.evidenceClass,
    platform: entry.platform,
    provenance: "scripted",
    outcome: "blocked",
    recordedAt: generatedAt,
    blockedReason: { outcome: "known", value: entry.blockedReason },
    artifactDigests: [],
    receiptDigest: { outcome: "absent" },
  };
}

/**
 * Joins a descriptor and its per-scenario receipts into a `CodeTaskQualificationManifestV1`
 * payload (unvalidated -- the CLI wrapper validates against the contract before writing).
 *
 * @param {object} input
 * @param {{
 *   epicIssue: number,
 *   childIssue: number,
 *   scenarios: readonly { scenarioId: string, evidenceClass: string, platform: string }[],
 *   blocked: readonly {
 *     scenarioId: string, evidenceClass: string, platform: string, blockedReason: string,
 *   }[],
 *   knownLimitations: readonly string[],
 * }} input.descriptor
 * @param {ReadonlyMap<string, {
 *   scenarioId: string, testStatus: string, recordedAt: string, provenance: string, digest: string,
 * }>} input.receiptsByScenarioId
 */
export function buildCodingIssueJourneyManifest({
  descriptor,
  receiptsByScenarioId,
  generatedAt,
  sourceCommitSha,
  sourceTreeSha,
  runtimeIdentity,
  modelIdentity,
  fixtureRevision,
  rubricDigest,
  issueReference,
  pullRequestReference,
  runReference,
  readinessSnapshotDigest,
  journeyOutcomeDigest,
  humanMergeAttestationDigest,
  auditReference,
  auditDigest,
  requiredTools,
  spendBudgetUsd,
  observedSpendUsd,
}) {
  const scenarios = [
    ...descriptor.scenarios.map((entry) => buildRanScenario(entry, receiptsByScenarioId)),
    ...descriptor.blocked.map((entry) => buildBlockedScenario(entry, generatedAt)),
  ];
  return {
    kind: "code-task-qualification-manifest",
    schemaVersion: 1,
    epicIssue: descriptor.epicIssue,
    childIssue: descriptor.childIssue,
    sourceCommitSha,
    sourceTreeSha,
    runtimeIdentity,
    modelIdentity,
    fixtureRevision,
    rubricDigest,
    issueReference: fact(issueReference),
    pullRequestReference: fact(pullRequestReference),
    runReference: fact(runReference),
    readinessSnapshotDigest: fact(readinessSnapshotDigest),
    journeyOutcomeDigest: fact(journeyOutcomeDigest),
    auditReference: fact(auditReference),
    auditDigest: fact(auditDigest),
    humanMergeAttestationDigest: fact(humanMergeAttestationDigest),
    requiredTools,
    spendBudgetUsd,
    observedSpendUsd: fact(observedSpendUsd),
    scenarios,
    knownLimitations: descriptor.knownLimitations,
  };
}
