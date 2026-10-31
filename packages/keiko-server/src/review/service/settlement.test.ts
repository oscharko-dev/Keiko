// The settlement rule (ADR-0182 D6, Issue #4136): every settlement and reason of the child 1 table
// is reachable, and no run with unprocessed files, an exhausted budget, a failed model, a
// cancellation or an interruption settles `complete`.

import { describe, expect, it } from "vitest";
import {
  REVIEW_SETTLEMENT_REASONS,
  type ReviewRunSettlement,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import { settleReviewRun, type ReviewSettlementFacts } from "./settlement.js";

const CLEAN: ReviewSettlementFacts = {
  cancelled: false,
  coverage: { kind: "reviewable" },
  reviewer: { outcome: "completed" },
  counterChecks: ["none", "none"],
  uncheckedCandidates: 0,
};

function settle(overrides: Partial<ReviewSettlementFacts>): ReviewRunSettlement {
  return settleReviewRun({ ...CLEAN, ...overrides });
}

describe("settleReviewRun", () => {
  it("settles complete only when everything was processed and every check ended normally", () => {
    expect(settle({})).toEqual({ kind: "complete" });
    expect(settle({ counterChecks: [] })).toEqual({ kind: "complete" });
  });

  it("reaches every incomplete reason", () => {
    expect(settle({ coverage: { kind: "incomplete", reason: "files-unprocessed" } })).toEqual({
      kind: "incomplete",
      reason: "files-unprocessed",
    });
    expect(settle({ reviewer: { outcome: "failed", reason: "model-failed" } }).kind).toBe(
      "incomplete",
    );
    expect(settle({ counterChecks: ["none", "budget-exhausted"] })).toEqual({
      kind: "incomplete",
      reason: "budget-exhausted",
    });
    expect(settle({ uncheckedCandidates: 2 })).toEqual({
      kind: "incomplete",
      reason: "budget-exhausted",
    });
    expect(settle({ counterChecks: ["deadline-exceeded"] })).toEqual({
      kind: "incomplete",
      reason: "deadline-exceeded",
    });
    expect(settle({ counterChecks: ["model-failed"] })).toEqual({
      kind: "incomplete",
      reason: "model-failed",
    });
  });

  it("names the most consequential incomplete reason when several apply", () => {
    expect(
      settle({
        coverage: { kind: "incomplete", reason: "files-unprocessed" },
        counterChecks: ["deadline-exceeded", "model-failed"],
      }),
    ).toEqual({ kind: "incomplete", reason: "model-failed" });
    expect(
      settle({
        coverage: { kind: "incomplete", reason: "files-unprocessed" },
        counterChecks: ["deadline-exceeded"],
      }),
    ).toEqual({ kind: "incomplete", reason: "deadline-exceeded" });
  });

  it("abandons a cancelled or interrupted run in any phase, ahead of everything else", () => {
    expect(settle({ cancelled: true })).toEqual({ kind: "abandoned", reason: "cancelled" });
    expect(settle({ reviewer: { outcome: "cancelled" } })).toEqual({
      kind: "abandoned",
      reason: "cancelled",
    });
    expect(settle({ counterChecks: ["none", "cancelled"] })).toEqual({
      kind: "abandoned",
      reason: "cancelled",
    });
    expect(
      settle({ cancelled: true, preparation: { kind: "skipped", reason: "diff-too-large" } }),
    ).toEqual({ kind: "abandoned", reason: "cancelled" });
    expect(settle({ interrupted: true, cancelled: true })).toEqual({
      kind: "abandoned",
      reason: "interrupted",
    });
  });

  it("passes every skipped reason of the table through from preparation", () => {
    for (const reason of REVIEW_SETTLEMENT_REASONS.skipped) {
      expect(settle({ preparation: { kind: "skipped", reason } })).toEqual({
        kind: "skipped",
        reason,
      });
    }
    expect(settle({ coverage: { kind: "skipped", reason: "no-reviewable-changes" } })).toEqual({
      kind: "skipped",
      reason: "no-reviewable-changes",
    });
  });

  it("never settles complete with any failing fact present", () => {
    const failing: Partial<ReviewSettlementFacts>[] = [
      { coverage: { kind: "incomplete", reason: "files-unprocessed" } },
      { reviewer: { outcome: "failed", reason: "budget-exhausted" } },
      { reviewer: { outcome: "failed", reason: "deadline-exceeded" } },
      { counterChecks: ["budget-exhausted"] },
      { uncheckedCandidates: 1 },
      { cancelled: true },
      { interrupted: true },
    ];
    for (const facts of failing) expect(settle(facts).kind).not.toBe("complete");
  });
});
