// How each refusal or outcome of a run's building blocks maps onto the child 1 reason table
// (ADR-0182 D6, Issue #4136). Pure and exhaustive over each block's closed vocabulary.

import type {
  ReviewIncompleteReason,
  ReviewRunSettlement,
  ReviewTargetRefusalReason,
  ReviewWorktreeRefusalReason,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import type { ReviewRuntimeRunResult } from "../runtime/instance.js";
import type { ReviewerSettlementFact } from "./settlement.js";

type PreparationSettlement = Exclude<
  ReviewRunSettlement,
  { readonly kind: "complete" | "incomplete" }
>;

const SKIPPED_TARGET_CHANGED: PreparationSettlement = { kind: "skipped", reason: "target-changed" };
const SKIPPED_WORKTREE_FAILED: PreparationSettlement = {
  kind: "skipped",
  reason: "worktree-failed",
};
const ABANDONED_CANCELLED: PreparationSettlement = { kind: "abandoned", reason: "cancelled" };
const ABANDONED_INTERRUPTED: PreparationSettlement = { kind: "abandoned", reason: "interrupted" };

/**
 * A target that moved, or that no longer names the commits asked for, is `target-changed`; a target
 * Keiko cannot fetch (no provider access, no GitHub remote, rate limit, failed fetch) leaves the
 * review worktree unpreparable, which is `worktree-failed`. The closed resolver reason itself is
 * on the `review.target.refused` line.
 */
const TARGET_REFUSALS: Readonly<Record<ReviewTargetRefusalReason, PreparationSettlement>> = {
  "target-changed": SKIPPED_TARGET_CHANGED,
  "not-found": SKIPPED_TARGET_CHANGED,
  "ref-invalid": SKIPPED_TARGET_CHANGED,
  "gh-unavailable": SKIPPED_WORKTREE_FAILED,
  "gh-unauthenticated": SKIPPED_WORKTREE_FAILED,
  "no-github-remote": SKIPPED_WORKTREE_FAILED,
  "fetch-failed": SKIPPED_WORKTREE_FAILED,
  "rate-limited": SKIPPED_WORKTREE_FAILED,
};

export function targetRefusalSettlement(reason: ReviewTargetRefusalReason): PreparationSettlement {
  return TARGET_REFUSALS[reason];
}

export function worktreeRefusalSettlement(
  reason: ReviewWorktreeRefusalReason,
): PreparationSettlement {
  return reason === "cancelled" ? ABANDONED_CANCELLED : SKIPPED_WORKTREE_FAILED;
}

type RuntimeRefusalReason = Extract<ReviewRuntimeRunResult, { readonly ok: false }>["reason"];

/**
 * The review runtime's refusals (Issue #4135): an invalid rules file, a task that cannot fit the
 * first-prompt bound (never truncated), no runtime for the model, or a failed read-only self-check.
 * A failed Git read of the rules or a busy instance interrupt the run.
 */
const RUNTIME_REFUSALS: Readonly<Record<RuntimeRefusalReason, PreparationSettlement>> = {
  "rules-file-invalid": { kind: "skipped", reason: "rules-file-invalid" },
  "task-too-large": { kind: "skipped", reason: "diff-too-large" },
  "runtime-unavailable": { kind: "skipped", reason: "model-unavailable" },
  "review-profile-invalid": { kind: "skipped", reason: "policy-invalid" },
  "native-profile": { kind: "skipped", reason: "policy-invalid" },
  "authority-missing": { kind: "skipped", reason: "policy-invalid" },
  "rules-read-failed": ABANDONED_INTERRUPTED,
  busy: ABANDONED_INTERRUPTED,
};

export function runtimeRefusalSettlement(reason: RuntimeRefusalReason): PreparationSettlement {
  return RUNTIME_REFUSALS[reason];
}

const BUDGET_FAILURES: ReadonlySet<string> = new Set([
  "prompt-allowance-exhausted",
  "authority-budget-exceeded",
  "budget-drift",
]);
const DEADLINE_FAILURES: ReadonlySet<string> = new Set([
  "envelope-duration-exhausted",
  "authority-expired",
]);

/** The incomplete reason of a Reviewer run that started and failed. */
export function reviewerFailureReason(failureCode: string | undefined): ReviewIncompleteReason {
  if (failureCode !== undefined && BUDGET_FAILURES.has(failureCode)) return "budget-exhausted";
  if (failureCode !== undefined && DEADLINE_FAILURES.has(failureCode)) return "deadline-exceeded";
  return "model-failed";
}

/** The Reviewer's outcome as the settlement reads it; a run the runtime never started is skipped. */
export function reviewerOutcomeFact(
  result: Extract<ReviewRuntimeRunResult, { readonly ok: true }>,
): ReviewerSettlementFact | PreparationSettlement {
  if (result.outcome === "completed") return { outcome: "completed" };
  if (result.outcome === "cancelled") return { outcome: "cancelled" };
  if (result.outcome === "refused") return { kind: "skipped", reason: "model-unavailable" };
  return { outcome: "failed", reason: reviewerFailureReason(result.failureCode) };
}
