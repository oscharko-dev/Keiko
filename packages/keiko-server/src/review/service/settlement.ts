// The settlement of one review run (ADR-0182 D6, Issue #4136): one pure function over the facts
// the run sequence collected, mapping them onto exactly the child 1 reason table. Incomplete work
// never settles `complete`: a cancellation abandons the run, a preparation failure skips it, and any
// unprocessed file, exhausted budget, exceeded deadline or failed model makes it incomplete.

import type {
  ReviewDiffSettlementInput,
  ReviewIncompleteReason,
  ReviewRunSettlement,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import type { CounterCheckEffect } from "../counter-check/activity-log.js";

/** How the Reviewer run ended, as the settlement reads it. */
export type ReviewerSettlementFact =
  | { readonly outcome: "completed" }
  | { readonly outcome: "cancelled" }
  | { readonly outcome: "failed"; readonly reason: ReviewIncompleteReason };

export interface ReviewSettlementFacts {
  /** A cancellation requested by a person, in any phase. */
  readonly cancelled: boolean;
  /** The server stopped (shutdown, restart) or failed to record the run before it settled. */
  readonly interrupted?: boolean | undefined;
  /** A preparation failure settles the run on its own (skipped, or abandoned for a Git failure). */
  readonly preparation?:
    Exclude<ReviewRunSettlement, { readonly kind: "complete" | "incomplete" }> | undefined;
  readonly coverage?: ReviewDiffSettlementInput | undefined;
  readonly reviewer?: ReviewerSettlementFact | undefined;
  readonly counterChecks: readonly CounterCheckEffect[];
  /** Candidates no counter-check settled because the run's allowance ran out first. */
  readonly uncheckedCandidates: number;
}

/** When several incomplete reasons apply, the most consequential one names the run. */
const INCOMPLETE_PRIORITY: readonly ReviewIncompleteReason[] = [
  "model-failed",
  "budget-exhausted",
  "deadline-exceeded",
  "files-unprocessed",
];

function incompleteReasons(facts: ReviewSettlementFacts): Set<ReviewIncompleteReason> {
  const reasons = new Set<ReviewIncompleteReason>();
  if (facts.reviewer?.outcome === "failed") reasons.add(facts.reviewer.reason);
  for (const effect of facts.counterChecks) {
    if (
      effect === "model-failed" ||
      effect === "budget-exhausted" ||
      effect === "deadline-exceeded"
    ) {
      reasons.add(effect);
    }
  }
  if (facts.uncheckedCandidates > 0) reasons.add("budget-exhausted");
  if (facts.coverage?.kind === "incomplete") reasons.add(facts.coverage.reason);
  return reasons;
}

function wasCancelled(facts: ReviewSettlementFacts): boolean {
  return (
    facts.cancelled ||
    facts.reviewer?.outcome === "cancelled" ||
    facts.counterChecks.includes("cancelled")
  );
}

/** The one settlement of a run. Pure; exhaustively tested against the reason table. */
export function settleReviewRun(facts: ReviewSettlementFacts): ReviewRunSettlement {
  if (facts.interrupted === true) return { kind: "abandoned", reason: "interrupted" };
  if (wasCancelled(facts)) return { kind: "abandoned", reason: "cancelled" };
  if (facts.preparation !== undefined) return facts.preparation;
  if (facts.coverage !== undefined && facts.coverage.kind !== "reviewable") {
    if (facts.coverage.kind !== "incomplete") return facts.coverage;
  }
  const reasons = incompleteReasons(facts);
  const reason = INCOMPLETE_PRIORITY.find((candidate) => reasons.has(candidate));
  return reason === undefined ? { kind: "complete" } : { kind: "incomplete", reason };
}
