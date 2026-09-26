// #3390 / Keiko for Quality on #3394: which failed ready-for-review verdicts the live lane retries.
// The route's executionErrorCode is the contract's closed vocabulary (GIT_PR_REJECTION_ERROR_CODE
// maps provider rejections onto it), so the predicate is pinned against those literals.
import { describe, expect, it } from "vitest";
import {
  isRetryableMarkReadyVerdict,
  type MarkReadyVerdict,
} from "./coding-issue-journey-live-mark-ready.js";

function failed(
  executionErrorCode: MarkReadyVerdict["executionErrorCode"],
  rejectionReason?: string,
): MarkReadyVerdict {
  return { status: "failed", executionErrorCode, rejectionReason };
}

describe("isRetryableMarkReadyVerdict", () => {
  it("retries the transient classes: unreachable or slow provider", () => {
    expect(isRetryableMarkReadyVerdict(failed("network-failure", "rate-limited"))).toBe(true);
    expect(isRetryableMarkReadyVerdict(failed("network-failure", "provider-unavailable"))).toBe(
      true,
    );
    expect(isRetryableMarkReadyVerdict(failed("timeout"))).toBe(true);
  });

  // Real flow 3 (run-53): provider-rejected with reason unknown, succeeded on the next attempt.
  it("retries a rejection the classifier could not attribute to a permanent cause", () => {
    expect(isRetryableMarkReadyVerdict(failed("provider-rejected", "unknown"))).toBe(true);
  });

  it("does not retry an attributed rejection or a precondition/internal failure", () => {
    expect(isRetryableMarkReadyVerdict(failed("provider-rejected", "validation-error"))).toBe(
      false,
    );
    expect(isRetryableMarkReadyVerdict(failed("provider-rejected", "permission-denied"))).toBe(
      false,
    );
    expect(isRetryableMarkReadyVerdict(failed("provider-rejected", "not-found"))).toBe(false);
    expect(isRetryableMarkReadyVerdict(failed("provider-rejected"))).toBe(false);
    expect(isRetryableMarkReadyVerdict(failed("precondition-failed"))).toBe(false);
    expect(isRetryableMarkReadyVerdict(failed("conflict"))).toBe(false);
    expect(isRetryableMarkReadyVerdict(failed("internal-error"))).toBe(false);
  });

  it("never retries a verdict that is not a failure or carries no code", () => {
    expect(
      isRetryableMarkReadyVerdict({
        status: "succeeded",
        executionErrorCode: undefined,
        rejectionReason: undefined,
      }),
    ).toBe(false);
    expect(
      isRetryableMarkReadyVerdict({
        status: "aborted",
        executionErrorCode: undefined,
        rejectionReason: undefined,
      }),
    ).toBe(false);
    expect(isRetryableMarkReadyVerdict(failed(undefined))).toBe(false);
  });
});
