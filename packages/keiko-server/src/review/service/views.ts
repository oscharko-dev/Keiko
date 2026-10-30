// Projection of stored review run records onto the wire shapes (Issue #4136). Only presented
// findings leave the server; refuted and undecided candidates stay in the record for measurement.

import {
  REVIEW_CONTRACT_VERSION,
  type ReviewRunFinding,
  type ReviewRunView,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import type { ReviewFindingRow, ReviewRunRow, ReviewRunStore } from "./store.js";

function presentedFinding(row: ReviewFindingRow): ReviewRunFinding {
  return {
    fingerprint: row.fingerprint,
    report: row.report,
    ...(row.verdict === null ? {} : { verdict: row.verdict }),
    presented: true,
    ...(row.presentationRank === null ? {} : { presentationRank: row.presentationRank }),
    reviewerRank: row.reviewerRank,
  };
}

/** The wire view of one run record; `stale` is computed by the caller at read time. */
export function reviewRunView(
  store: ReviewRunStore,
  row: ReviewRunRow,
  stale: boolean,
): ReviewRunView {
  const settled = row.phase === "settled";
  const findings = settled ? store.findings(row.runId).filter((finding) => finding.presented) : [];
  return {
    schemaVersion: REVIEW_CONTRACT_VERSION,
    runId: row.runId,
    repositoryId: row.repositoryId,
    targetKind: row.targetKind,
    pullRequestNumber: row.pullRequestNumber,
    baseSha: row.baseSha,
    headSha: row.headSha,
    reviewerModelId: row.reviewerModelId,
    counterCheckerModelId: row.counterCheckerModelId,
    phase: row.phase,
    settlement: row.settlement,
    createdAt: new Date(row.createdAt).toISOString(),
    settledAt: row.settledAt === null ? null : new Date(row.settledAt).toISOString(),
    coverage: row.coverage,
    coverageEntries: store.coverageEntries(row.runId),
    presentedFindings: findings
      .sort((left, right) => (left.presentationRank ?? 0) - (right.presentationRank ?? 0))
      .map(presentedFinding),
    candidateCount: row.candidateCount,
    totals: { reviewer: row.reviewer, counterChecker: row.counterChecker },
    stale,
  };
}
