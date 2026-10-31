// Scoring of a local pair qualification (Issue #4137): each seed case's review run becomes a
// `ReviewSeedRunResult` from its presented findings and is scored with child 1's one rule,
// `scoreReviewSeedRun`, both per case (for the case's own result) and for the whole corpus. A run
// that did not settle `complete` or `incomplete` has no presented findings to score: the case is
// `not-scored` and the qualification can only end `incomplete`, never qualified or failed.

import type {
  ReviewFindingCategory,
  ReviewPairQualificationOutcome,
  ReviewRunView,
  ReviewSeedCase,
  ReviewSeedCaseResult,
  ReviewSeedRunResult,
  ReviewSeedScore,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import { scoreReviewSeedRun } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review-rules";

/** The scoreable result of one case's settled run, or `undefined` when it cannot be scored. */
export function seedRunResult(
  seed: ReviewSeedCase,
  view: ReviewRunView | undefined,
): ReviewSeedRunResult | undefined {
  const kind = view?.settlement?.kind;
  if (view === undefined || (kind !== "complete" && kind !== "incomplete")) return undefined;
  return {
    caseId: seed.id,
    outcome: view.stale ? "stale" : "settled",
    findings: view.presentedFindings.map(({ report }) => ({
      file: report.file,
      startLine: report.startLine,
      endLine: report.endLine,
    })),
  };
}

/** One case's result under the shared scoring rule. */
export function seedCaseResult(
  seed: ReviewSeedCase,
  result: ReviewSeedRunResult | undefined,
): ReviewSeedCaseResult {
  if (result === undefined) return "not-scored";
  const score = scoreReviewSeedRun([seed], [result]);
  if (seed.cleanControl) return score.falseAlarms > 0 ? "false-alarm" : "clean";
  if (score.stale > 0) return "stale";
  return score.found > 0 ? "found" : "missed";
}

/** Results that do not count as a missed required seed: found, or a run that was not scored. */
const NOT_MISSED: ReadonlySet<ReviewSeedCaseResult> = new Set(["found", "not-scored"]);

export interface ScoredCase {
  readonly seed: ReviewSeedCase;
  readonly result: ReviewSeedRunResult | undefined;
}

export interface QualificationScore {
  readonly score: ReviewSeedScore;
  readonly missedSeedClasses: readonly ReviewFindingCategory[];
  readonly unscored: number;
}

/** The corpus score and the classes of the required seeds that were not found, in corpus order. */
export function scoreQualification(cases: readonly ScoredCase[]): QualificationScore {
  const results = cases.flatMap((entry) => (entry.result === undefined ? [] : [entry.result]));
  const missed = cases.filter(
    (entry) => entry.seed.required && !NOT_MISSED.has(seedCaseResult(entry.seed, entry.result)),
  );
  return {
    score: scoreReviewSeedRun(
      cases.map((entry) => entry.seed),
      results,
    ),
    missedSeedClasses: [...new Set(missed.map((entry) => entry.seed.seedClass))],
    unscored: cases.length - results.length,
  };
}

/**
 * The qualification's end: a cancellation, an exceeded deadline or any unscored case leaves it
 * `incomplete` (or `cancelled`); otherwise every required seed found is `seed-qualified` and one
 * required seed missed is `seed-failed`. False alarms are reported and never change the status.
 */
export function qualificationOutcome(
  scored: QualificationScore,
  stop: "none" | "cancelled" | "deadline",
): ReviewPairQualificationOutcome {
  if (stop === "cancelled") return "cancelled";
  if (stop === "deadline" || scored.unscored > 0) return "incomplete";
  return scored.score.requiredFound === scored.score.requiredCount
    ? "seed-qualified"
    : "seed-failed";
}
