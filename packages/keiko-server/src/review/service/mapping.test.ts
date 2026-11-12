// Exhaustive maps of each building block's closed refusals onto the child 1 table (Issue #4136).

import { describe, expect, it } from "vitest";
import {
  REVIEW_SETTLEMENT_REASONS,
  REVIEW_TARGET_REFUSAL_REASONS,
  REVIEW_WORKTREE_REFUSAL_REASONS,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import type { ReviewCandidateFinding } from "../runtime/findingIntake.js";
import {
  reviewerFailureReason,
  reviewerOutcomeFact,
  runtimeRefusalSettlement,
  targetRefusalSettlement,
  worktreeRefusalSettlement,
} from "./mapping.js";

const SKIPPED: ReadonlySet<string> = new Set(REVIEW_SETTLEMENT_REASONS.skipped);

describe("settlement mapping", () => {
  it("maps every target refusal to a skipped reason of the table", () => {
    for (const reason of REVIEW_TARGET_REFUSAL_REASONS) {
      const settlement = targetRefusalSettlement(reason);
      expect(settlement.kind).toBe("skipped");
      expect(SKIPPED.has(settlement.reason)).toBe(true);
    }
    expect(targetRefusalSettlement("target-changed")).toEqual({
      kind: "skipped",
      reason: "target-changed",
    });
    expect(targetRefusalSettlement("fetch-failed")).toEqual({
      kind: "skipped",
      reason: "worktree-failed",
    }); // R4130-036: a target without a usable merge base never claims that the target changed.
    for (const reason of ["no-merge-base", "shallow-history"] as const) {
      expect(targetRefusalSettlement(reason), reason).toEqual({
        kind: "skipped",
        reason: "worktree-failed",
      });
    }
  });

  it("maps every worktree refusal: cancelled abandons, the rest skip as worktree-failed", () => {
    for (const reason of REVIEW_WORKTREE_REFUSAL_REASONS) {
      expect(worktreeRefusalSettlement(reason)).toEqual(
        reason === "cancelled"
          ? { kind: "abandoned", reason: "cancelled" }
          : { kind: "skipped", reason: "worktree-failed" },
      );
    }
  });

  it("maps every review runtime refusal", () => {
    expect(runtimeRefusalSettlement("rules-file-invalid")).toEqual({
      kind: "skipped",
      reason: "rules-file-invalid",
    });
    expect(runtimeRefusalSettlement("task-too-large")).toEqual({
      kind: "skipped",
      reason: "diff-too-large",
    });
    expect(runtimeRefusalSettlement("runtime-unavailable")).toEqual({
      kind: "skipped",
      reason: "model-unavailable",
    });
    for (const reason of [
      "review-profile-invalid",
      "native-profile",
      "authority-missing",
    ] as const) {
      expect(runtimeRefusalSettlement(reason)).toEqual({
        kind: "skipped",
        reason: "policy-invalid",
      });
    }
    for (const reason of ["rules-read-failed", "busy"] as const) {
      expect(runtimeRefusalSettlement(reason)).toEqual({
        kind: "abandoned",
        reason: "interrupted",
      });
    }
  });

  it("maps the Reviewer's failure codes and outcomes", () => {
    expect(reviewerFailureReason("prompt-allowance-exhausted")).toBe("budget-exhausted");
    expect(reviewerFailureReason("authority-budget-exceeded")).toBe("budget-exhausted");
    expect(reviewerFailureReason("envelope-duration-exhausted")).toBe("deadline-exceeded");
    expect(reviewerFailureReason("provider-unavailable")).toBe("model-failed");
    expect(reviewerFailureReason(undefined)).toBe("model-failed");
    const base = {
      ok: true as const,
      rules: "absent" as const,
      candidates: [],
      rejections: {
        "schema-invalid": 0,
        "path-outside-worktree": 0,
        "range-invalid": 0,
        "evidence-mismatch": 0,
        "limit-reached": 0,
      },
    };
    expect(reviewerOutcomeFact({ ...base, outcome: "completed" })).toEqual({
      outcome: "completed",
    });
    expect(reviewerOutcomeFact({ ...base, outcome: "cancelled" })).toEqual({
      outcome: "cancelled",
    });
    expect(reviewerOutcomeFact({ ...base, outcome: "refused" })).toEqual({
      kind: "skipped",
      reason: "model-unavailable",
    });
    expect(
      reviewerOutcomeFact({ ...base, outcome: "failed", failureCode: "model-turn-failed" }),
    ).toEqual({
      outcome: "failed",
      reason: "model-failed",
    });
  });

  // R4130-054: a session the read allowance stopped ended its turn as told, and its part settled
  // as a clean `complete` with nothing reported. Before the allowance that session ran out of
  // prompt budget and settled `incomplete/budget-exhausted`.
  describe("a completed session and its read allowance", () => {
    const completed = {
      ok: true as const,
      outcome: "completed" as const,
      rules: "absent" as const,
      rejections: {
        "schema-invalid": 0,
        "path-outside-worktree": 0,
        "range-invalid": 0,
        "evidence-mismatch": 0,
        "limit-reached": 0,
      },
    };
    const candidate = { fingerprint: "f".repeat(64) } as ReviewCandidateFinding;

    it("fails a session with a refused read and no accepted report as budget-exhausted", () => {
      expect(
        reviewerOutcomeFact({
          ...completed,
          candidates: [],
          readCalls: { admitted: 24, refused: 1 },
        }),
      ).toEqual({ outcome: "failed", reason: "budget-exhausted" });
    });

    it("keeps a session that reported after a refused read completed", () => {
      expect(
        reviewerOutcomeFact({
          ...completed,
          candidates: [candidate],
          readCalls: { admitted: 24, refused: 3 },
        }),
      ).toEqual({ outcome: "completed" });
    });

    it("keeps a session without a refused read completed, with or without a report", () => {
      expect(
        reviewerOutcomeFact({
          ...completed,
          candidates: [],
          readCalls: { admitted: 24, refused: 0 },
        }),
      ).toEqual({ outcome: "completed" });
      expect(reviewerOutcomeFact({ ...completed, candidates: [] })).toEqual({
        outcome: "completed",
      });
    });

    it("leaves a failed session's own reason in place", () => {
      expect(
        reviewerOutcomeFact({
          ...completed,
          outcome: "failed",
          failureCode: "envelope-duration-exhausted",
          candidates: [],
          readCalls: { admitted: 24, refused: 2 },
        }),
      ).toEqual({ outcome: "failed", reason: "deadline-exceeded" });
    });
  });
});
