// Pure projection for the Code-task acceptance contribution (#2642). Extracted from
// scripts/generate-code-task-acceptance.mjs so the projection logic has direct v8 coverage — the
// spawnSync harness pattern (used by the CLI-side generator test) does not contribute coverage to
// the vitest parent process, so any bug in the projection would ride uncovered otherwise.
// docs/acceptance/README.md explains where this fits in the Code-task delivery pipeline and who
// consumes the emitted CodeTaskAcceptanceContributionV1.

/**
 * Projects a descriptor and its per-scenario receipts to a CodeTaskAcceptanceContributionV1
 * payload. The function is intentionally strict: a missing receipt is a programming error, not a
 * silent partial contribution, so the caller can fix the pipeline instead of the aggregator
 * inheriting a hole.
 *
 * @param {object} input
 * @param {{
 *   epicIssue: number,
 *   childIssue: number,
 *   scenarios: readonly {
 *     scenarioId: string,
 *     evidenceClass: string,
 *     platform: string,
 *   }[],
 *   salvage: readonly {
 *     sourceBranch: string,
 *     sourceSha: string,
 *     path: string,
 *     disposition: string,
 *     reshaping: { outcome: string, value?: string },
 *   }[],
 *   knownLimitations: readonly string[],
 * }} input.descriptor
 * @param {readonly {
 *   scenarioId: string,
 *   outcome: string,
 *   recordedAt: string,
 *   digest: string,
 * }[]} input.receipts
 * @param {string} input.sourceCommitSha
 * @param {string} input.sourceTreeSha
 * @param {boolean} input.cleanupResidue Whether the run left residue behind (typically derived
 *   from the existence of a cleanup-root sentinel path by the CLI wrapper).
 */
export function buildCodeTaskAcceptanceContribution({
  descriptor,
  receipts,
  sourceCommitSha,
  sourceTreeSha,
  cleanupResidue,
}) {
  const receiptByScenario = new Map(receipts.map((receipt) => [receipt.scenarioId, receipt]));
  const scenarios = descriptor.scenarios.map((scenario) => {
    const receipt = receiptByScenario.get(scenario.scenarioId);
    if (receipt === undefined) throw new Error(`missing receipt for ${scenario.scenarioId}`);
    return {
      ...scenario,
      outcome: receipt.outcome,
      recordedAt: receipt.recordedAt,
      artifactDigests: [receipt.digest],
      receiptDigest: { outcome: "known", value: receipt.digest },
    };
  });
  return {
    kind: "code-task-acceptance-contribution",
    schemaVersion: 1,
    epicIssue: descriptor.epicIssue,
    childIssue: descriptor.childIssue,
    sourceCommitSha,
    sourceTreeSha,
    scenarios,
    salvage: descriptor.salvage.map((row) => ({ ...row, verifiedAtSha: sourceCommitSha })),
    knownLimitations: descriptor.knownLimitations,
    cleanup: cleanupResidue ? { state: "incomplete", residueCount: 1 } : { state: "complete" },
  };
}
