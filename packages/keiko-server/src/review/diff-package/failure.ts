// Fail-closed outcomes of the review diff package (ADR-0182 D6, Issue #4134).
//
// Every exceeded time or byte bound of the packaging as a whole becomes `diff-too-large` with its
// closed detail, a cancellation becomes `cancelled`, and any unexpected Git result `git-failed`:
// no partial package is ever returned in their place.

import type {
  ReviewDiffPackageFailure,
  ReviewDiffTooLargeDetail,
} from "@oscharko-dev/keiko-contracts";
import type { GitProcessResult } from "@oscharko-dev/keiko-git";

export class ReviewDiffPackagingFailure extends Error {
  public constructor(public readonly failure: ReviewDiffPackageFailure) {
    super(`review diff packaging failed: ${failure.reason}`);
    this.name = "ReviewDiffPackagingFailure";
  }
}

/** The packaging's abort: the caller's cancellation or the packaging deadline, told apart. */
export interface ReviewDiffPackagingAbort {
  readonly signal: AbortSignal;
  readonly cancelled: () => boolean;
}

export function reviewDiffPackagingAbort(
  deadlineMs: number,
  caller: AbortSignal | undefined,
): ReviewDiffPackagingAbort {
  const deadline = AbortSignal.timeout(deadlineMs);
  const signal = caller === undefined ? deadline : AbortSignal.any([caller, deadline]);
  return { signal, cancelled: (): boolean => caller?.aborted === true };
}

function stopped(abort: ReviewDiffPackagingAbort): ReviewDiffPackagingFailure {
  return new ReviewDiffPackagingFailure(
    abort.cancelled() ? { reason: "cancelled" } : { reason: "diff-too-large", detail: "deadline" },
  );
}

/** Throws when the packaging was cancelled or ran out of time; called between steps. */
export function throwIfReviewDiffStopped(abort: ReviewDiffPackagingAbort): void {
  if (abort.signal.aborted) throw stopped(abort);
}

export function isReviewDiffCapCut(result: GitProcessResult): boolean {
  return result.truncated && result.timedOut !== true && result.aborted !== true;
}

/** The packaging failure for a Git step whose failure fails the whole package. */
export function reviewDiffStepFailure(
  result: GitProcessResult,
  abort: ReviewDiffPackagingAbort,
  capDetail: ReviewDiffTooLargeDetail,
): ReviewDiffPackagingFailure {
  if (result.aborted === true || abort.signal.aborted) return stopped(abort);
  if (result.timedOut === true) {
    return new ReviewDiffPackagingFailure({ reason: "diff-too-large", detail: "deadline" });
  }
  if (isReviewDiffCapCut(result)) {
    return new ReviewDiffPackagingFailure({ reason: "diff-too-large", detail: capDetail });
  }
  return new ReviewDiffPackagingFailure({ reason: "git-failed" });
}

export function tooLarge(detail: ReviewDiffTooLargeDetail): ReviewDiffPackagingFailure {
  return new ReviewDiffPackagingFailure({ reason: "diff-too-large", detail });
}

export function gitFailed(): ReviewDiffPackagingFailure {
  return new ReviewDiffPackagingFailure({ reason: "git-failed" });
}
