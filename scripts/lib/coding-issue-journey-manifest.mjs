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

function buildFlow(entry, flowReceiptsById) {
  const receipt = flowReceiptsById.get(entry.flowId);
  if (receipt === undefined) throw new Error(`missing flow receipt for ${entry.flowId}`);
  const artifact = receipt.artifact;
  return {
    evidenceKind: artifact.evidenceKind,
    schemaVersion: artifact.schemaVersion,
    flowId: artifact.flowId,
    ordinal: artifact.ordinal,
    repository: artifact.repository,
    issueReference: artifact.issueReference,
    issueNumber: artifact.issueNumber,
    issueState: artifact.issueState,
    issueClosedAt: artifact.issueClosedAt,
    mode: artifact.mode,
    taskRunId: artifact.taskRunId,
    pullRequestReference: artifact.pullRequestReference,
    pullRequestNumber: artifact.pullRequestNumber,
    pullRequestHeadSha: artifact.pullRequestHeadSha,
    pullRequestState: artifact.pullRequestState,
    pullRequestMergedAt: artifact.pullRequestMergedAt,
    mergeCommitSha: artifact.mergeCommitSha,
    requiredChecks: artifact.requiredChecks,
    transitions: artifact.transitions,
    sourceCommitSha: artifact.sourceCommitSha,
    observedAt: artifact.observedAt,
    spend: artifact.spend,
    platform: receipt.platform,
    provenance: receipt.provenance,
    recordedAt: receipt.recordedAt,
    artifactDigest: receipt.artifactDigest,
    receiptDigest: receipt.receiptDigest,
  };
}

/** Assembles the opaque-fact fields shared by every manifest -- split out purely to keep
 * `buildCodingIssueJourneyManifest` under the repository's per-function line ceiling. */
function manifestFacts(input) {
  return {
    issueReference: fact(input.issueReference),
    pullRequestReference: fact(input.pullRequestReference),
    runReference: fact(input.runReference),
    readinessSnapshotDigest: fact(input.readinessSnapshotDigest),
    journeyOutcomeDigest: fact(input.journeyOutcomeDigest),
    auditReference: fact(input.auditReference),
    auditDigest: fact(input.auditDigest),
    humanMergeAttestationDigest: fact(input.humanMergeAttestationDigest),
    observedSpendUsd: fact(input.observedSpendUsd),
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
export function buildCodingIssueJourneyManifest(input) {
  const { descriptor, receiptsByScenarioId, generatedAt } = input;
  const flowReceiptsById = input.flowReceiptsById ?? new Map();
  const scenarios = [
    ...descriptor.scenarios.map((entry) => buildRanScenario(entry, receiptsByScenarioId)),
    ...descriptor.blocked.map((entry) => buildBlockedScenario(entry, generatedAt)),
  ];
  const flows = (descriptor.flows ?? []).map((entry) => buildFlow(entry, flowReceiptsById));
  const firstFlow = flows[0];
  const manifestInput =
    firstFlow === undefined
      ? input
      : {
          ...input,
          issueReference: firstFlow.issueReference,
          pullRequestReference: firstFlow.pullRequestReference,
          runReference: firstFlow.taskRunId,
        };
  return {
    kind: "code-task-qualification-manifest",
    schemaVersion: 1,
    epicIssue: descriptor.epicIssue,
    childIssue: descriptor.childIssue,
    sourceCommitSha: input.sourceCommitSha,
    sourceTreeSha: input.sourceTreeSha,
    runtimeIdentity: input.runtimeIdentity,
    modelIdentity: input.modelIdentity,
    fixtureRevision: input.fixtureRevision,
    rubricDigest: input.rubricDigest,
    ...manifestFacts(manifestInput),
    requiredTools: input.requiredTools,
    spendBudgetUsd: input.spendBudgetUsd,
    scenarios,
    flows,
    knownLimitations: descriptor.knownLimitations,
  };
}
