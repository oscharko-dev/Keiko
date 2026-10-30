// The review precision gate (Issue #4132, ADR-0182 D9), ported in meaning from the retired
// reviewer's `precision-gate-lib.mjs`: of the findings that could be decided, how many were
// actionable — with the absolute counts, the per-category and per-severity breakdown, the findings
// per pull request, the cost per pull request and a Wilson interval next to every rate.
//
// Precision is measured over decided findings only (hits plus false alarms). Undecided, unmeasured
// and unmatched findings are reported and never folded into a favourable cell; a run with nothing
// decided is `unmeasured`, never a 0 % or 100 % verdict. A precision rate cannot see true findings
// a model suppressed — that is the seed gate's job, and both gates stay.

import {
  REVIEW_FINDING_CATEGORIES,
  REVIEW_FINDING_SEVERITIES,
  REVIEW_SETTLEMENT_KINDS,
  type ReviewSettlementKind,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import { wilsonInterval } from "@oscharko-dev/keiko-contracts/runtime/eval-metrics";

import { REVIEW_EVALUATION_MANIFEST } from "./manifest.js";
import type {
  ReviewCostSummary,
  ReviewEvaluationManifest,
  ReviewOutcomeCounts,
  ReviewPrecisionGateResult,
  ReviewPrecisionSummary,
  ReviewReplayFinding,
  ReviewReplayRun,
  ReviewRunCost,
} from "./types.js";

/** Counts and the actionable rate of one population of replayed findings. */
export function countReviewOutcomes(findings: readonly ReviewReplayFinding[]): ReviewOutcomeCounts {
  const tally = { hit: 0, falseAlarm: 0, undecided: 0, unmeasured: 0, unmatched: 0 };
  for (const finding of findings) {
    if (finding.outcome === "false-alarm") tally.falseAlarm += 1;
    else tally[finding.outcome] += 1;
  }
  return {
    findings: findings.length,
    ...tally,
    actionableRate: wilsonInterval(tally.hit, tally.hit + tally.falseAlarm),
  };
}

function groupedCounts<const Key extends string>(
  keys: readonly Key[],
  findings: readonly ReviewReplayFinding[],
  keyOf: (finding: ReviewReplayFinding) => Key,
): Readonly<Record<Key, ReviewOutcomeCounts>> {
  const groups = {} as Record<Key, ReviewOutcomeCounts>;
  for (const key of keys) {
    groups[key] = countReviewOutcomes(findings.filter((finding) => keyOf(finding) === key));
  }
  return groups;
}

function costSummary(
  costs: readonly ReviewRunCost[],
  field: keyof ReviewRunCost,
): ReviewCostSummary {
  const total = costs.reduce((sum, cost) => sum + cost[field], 0);
  return { total, meanPerPullRequest: costs.length === 0 ? null : total / costs.length };
}

function settlementCounts(run: ReviewReplayRun): Readonly<Record<ReviewSettlementKind, number>> {
  const counts = Object.fromEntries(REVIEW_SETTLEMENT_KINDS.map((kind) => [kind, 0])) as Record<
    ReviewSettlementKind,
    number
  >;
  for (const pullRequest of run.pullRequests) counts[pullRequest.settlement.kind] += 1;
  return counts;
}

/** Summarizes one replay run for the precision gate. */
export function summarizeReviewPrecision(run: ReviewReplayRun): ReviewPrecisionSummary {
  const findings = run.pullRequests.flatMap((pullRequest) => pullRequest.findings);
  const perPullRequest = run.pullRequests.map((pullRequest) => pullRequest.findings.length);
  const costs = run.pullRequests.map((pullRequest) => pullRequest.cost);
  return {
    split: run.split,
    purpose: run.purpose,
    holdoutFromPullRequest: run.holdoutFromPullRequest,
    modelId: run.modelId,
    pullRequests: run.pullRequests.length,
    overall: countReviewOutcomes(findings),
    byCategory: groupedCounts(REVIEW_FINDING_CATEGORIES, findings, (finding) => finding.category),
    bySeverity: groupedCounts(REVIEW_FINDING_SEVERITIES, findings, (finding) => finding.severity),
    findingsPerPullRequest: {
      mean: perPullRequest.length === 0 ? null : findings.length / perPullRequest.length,
      max: perPullRequest.reduce((max, count) => Math.max(max, count), 0),
    },
    settlements: settlementCounts(run),
    cost: {
      modelCalls: costSummary(costs, "modelCalls"),
      inputTokens: costSummary(costs, "inputTokens"),
      outputTokens: costSummary(costs, "outputTokens"),
      wallTimeMs: costSummary(costs, "wallTimeMs"),
    },
  };
}

/**
 * The offline verdict against ADR-0182 D9's thresholds: at least the minimum actionable rate over
 * decided findings and at most the presented-finding limit on every pull request. Nothing decided
 * is `unmeasured`. The verdict is evidence for the offline gate only on a holdout evaluation run.
 */
export function evaluateReviewPrecisionGate(
  summary: ReviewPrecisionSummary,
  manifest: Pick<
    ReviewEvaluationManifest,
    "minimumActionableRate" | "maximumFindingsPerPullRequest"
  > = REVIEW_EVALUATION_MANIFEST,
): ReviewPrecisionGateResult {
  const reasons: string[] = [];
  if (summary.findingsPerPullRequest.max > manifest.maximumFindingsPerPullRequest) {
    reasons.push(
      `a pull request presented ${String(summary.findingsPerPullRequest.max)} findings ` +
        `(limit ${String(manifest.maximumFindingsPerPullRequest)})`,
    );
  }
  const rate = summary.overall.actionableRate.rate;
  if (rate === null) {
    return { verdict: "unmeasured", reasons: [...reasons, "no decided finding to grade"] };
  }
  if (rate < manifest.minimumActionableRate) {
    reasons.push(
      `actionable rate ${String(summary.overall.hit)}/${String(summary.overall.actionableRate.trials)} ` +
        `is below ${String(manifest.minimumActionableRate)}`,
    );
  }
  return { verdict: reasons.length === 0 ? "pass" : "fail", reasons };
}
