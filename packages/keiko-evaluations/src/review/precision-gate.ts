// The review precision gate (Issue #4132, ADR-0182 D9), ported in meaning from the retired
// reviewer's `precision-gate-lib.mjs`: of the findings that could be decided, how many were
// actionable — with the absolute counts, the per-category and per-severity breakdown, the findings
// per pull request, the cost per pull request and a Wilson interval next to every rate.
//
// The gated actionable rate is hits over hits, false alarms and undecided findings (owner decision
// 2026-11-04, R4130-006): a finding that lands on a thread nobody answered or acted on counts
// against the agent. Duplicate findings join that denominator; this is the implementation's rule
// for R4130-014, not an owner decision: a restatement of an already credited hit adds no hit.
// Hits over hits plus false alarms is reported apart as the acceptance rate and never gated.
// Unmeasured and unmatched findings are reported and never folded into a favourable cell; a run with
// no finding on a measurable thread is `unmeasured`, never a 0 % or 100 % verdict. A precision rate
// cannot see true findings a model suppressed — that is the seed gate's job, and both gates stay.

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
  const tally = { hit: 0, falseAlarm: 0, undecided: 0, duplicate: 0, unmeasured: 0, unmatched: 0 };
  for (const finding of findings) {
    if (finding.outcome === "false-alarm") tally.falseAlarm += 1;
    else tally[finding.outcome] += 1;
  }
  const accepted = tally.hit + tally.falseAlarm;
  return {
    findings: findings.length,
    ...tally,
    actionableRate: wilsonInterval(tally.hit, accepted + tally.undecided + tally.duplicate),
    acceptanceRate: wilsonInterval(tally.hit, accepted),
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
    selection: run.selection,
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

type GateManifest = Pick<
  ReviewEvaluationManifest,
  "minimumActionableRate" | "maximumFindingsPerPullRequest" | "maximumNotCompleteShare"
>;

function isGateEvidence(summary: ReviewPrecisionSummary): boolean {
  return (
    summary.split === "holdout" &&
    summary.purpose === "evaluation" &&
    summary.selection === "default"
  );
}

function percent(share: number): string {
  return `${(share * 100).toFixed(1)} %`;
}

/** The share of a run's reviews that settled other than `complete`; null for an empty run. */
export function reviewNotCompleteShare(summary: ReviewPrecisionSummary): number | null {
  if (summary.pullRequests === 0) return null;
  return (summary.pullRequests - summary.settlements.complete) / summary.pullRequests;
}

function notCompleteReason(summary: ReviewPrecisionSummary, ceiling: number): string | undefined {
  const share = reviewNotCompleteShare(summary);
  if (share === null || share <= ceiling) return undefined;
  const notComplete = summary.pullRequests - summary.settlements.complete;
  return (
    `${String(notComplete)} of ${String(summary.pullRequests)} reviews (${percent(share)}) ` +
    `did not settle complete (at most ${percent(ceiling)})`
  );
}

function findingLimitReason(
  summary: ReviewPrecisionSummary,
  manifest: GateManifest,
): string | undefined {
  if (summary.findingsPerPullRequest.max <= manifest.maximumFindingsPerPullRequest)
    return undefined;
  return (
    `a pull request presented ${String(summary.findingsPerPullRequest.max)} findings ` +
    `(limit ${String(manifest.maximumFindingsPerPullRequest)})`
  );
}

function rateReason(summary: ReviewPrecisionSummary, minimum: number): string | undefined {
  const { hit, actionableRate } = summary.overall;
  if (actionableRate.rate === null || actionableRate.rate >= minimum) return undefined;
  return `actionable rate ${String(hit)}/${String(actionableRate.trials)} is below ${String(minimum)}`;
}

function defined(values: readonly (string | undefined)[]): string[] {
  return values.filter((value): value is string => value !== undefined);
}

/**
 * The offline verdict against ADR-0182 D9's thresholds: at least the minimum actionable rate, at
 * most the presented-finding limit on every pull request and at most the manifest's share of
 * reviews that did not settle `complete`. Only a holdout evaluation over the default selection is
 * gate evidence (R4130-011); any other run, an empty run and a run with no finding on a measurable
 * thread are `unmeasured`.
 */
export function evaluateReviewPrecisionGate(
  summary: ReviewPrecisionSummary,
  manifest: GateManifest = REVIEW_EVALUATION_MANIFEST,
): ReviewPrecisionGateResult {
  if (!isGateEvidence(summary)) {
    return {
      verdict: "unmeasured",
      reasons: ["not a holdout evaluation over the default selection"],
    };
  }
  if (summary.pullRequests === 0) {
    return { verdict: "unmeasured", reasons: ["no pull request was reviewed"] };
  }
  const reasons = defined([
    findingLimitReason(summary, manifest),
    notCompleteReason(summary, manifest.maximumNotCompleteShare),
  ]);
  if (summary.overall.actionableRate.rate === null) {
    return {
      verdict: "unmeasured",
      reasons: [...reasons, "no finding landed on a measurable thread"],
    };
  }
  reasons.push(...defined([rateReason(summary, manifest.minimumActionableRate)]));
  return { verdict: reasons.length === 0 ? "pass" : "fail", reasons };
}
