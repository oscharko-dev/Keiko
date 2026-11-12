// The Reviewer session's read allowance (ADR-0182 D1, Issue #4130): the counter the review runtime
// creates per session, and the predicate the tool facade asks before any admission.

import { describe, expect, it } from "vitest";

import {
  createReviewReadAllowance,
  REVIEW_READ_ALLOWANCE_GUIDANCE,
  REVIEW_RUN_ALLOWED_ACTIONS,
  REVIEW_RUN_READ_ACTIONS,
  reviewReadAllowanceRefuses,
} from "./reviewRuntimeGuard.js";

describe("createReviewReadAllowance", () => {
  it("admits exactly the allowed number of calls and counts every refused one", () => {
    const allowance = createReviewReadAllowance(2);

    expect([allowance.admit(), allowance.admit(), allowance.admit(), allowance.admit()]).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(allowance.counts()).toEqual({ admitted: 2, refused: 2 });
  });

  it("refuses every call of an allowance of zero", () => {
    const allowance = createReviewReadAllowance(0);

    expect(allowance.admit()).toBe(false);
    expect(allowance.counts()).toEqual({ admitted: 0, refused: 1 });
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects %s as an allowance",
    (maxCalls) => {
      expect(() => createReviewReadAllowance(maxCalls)).toThrow(TypeError);
    },
  );
});

describe("reviewReadAllowanceRefuses", () => {
  it("counts the three read actions of a review run and nothing else", () => {
    expect([...REVIEW_RUN_READ_ACTIONS].sort()).toEqual(["discover", "read", "search"]);
    for (const action of REVIEW_RUN_READ_ACTIONS) {
      expect(REVIEW_RUN_ALLOWED_ACTIONS.has(action)).toBe(true);
    }
    const allowance = createReviewReadAllowance(3);

    expect(reviewReadAllowanceRefuses("review", { action: "read" }, allowance)).toBe(false);
    expect(reviewReadAllowanceRefuses("review", { action: "discover" }, allowance)).toBe(false);
    expect(reviewReadAllowanceRefuses("review", { action: "search" }, allowance)).toBe(false);
    expect(reviewReadAllowanceRefuses("review", { action: "read" }, allowance)).toBe(true);
    expect(allowance.counts()).toEqual({ admitted: 3, refused: 1 });
  });

  it("never refuses or counts the report, whatever is left of the allowance", () => {
    const allowance = createReviewReadAllowance(0);

    expect(reviewReadAllowanceRefuses("review", { action: "review-report" }, allowance)).toBe(
      false,
    );
    expect(allowance.counts()).toEqual({ admitted: 0, refused: 0 });
  });

  it("leaves a run without the review purpose, or without an allowance, alone", () => {
    const allowance = createReviewReadAllowance(0);

    expect(reviewReadAllowanceRefuses("coding", { action: "read" }, allowance)).toBe(false);
    expect(reviewReadAllowanceRefuses(undefined, { action: "read" }, allowance)).toBe(false);
    expect(reviewReadAllowanceRefuses("review", { action: "read" }, undefined)).toBe(false);
    expect(allowance.counts()).toEqual({ admitted: 0, refused: 0 });
  });

  it("tells the Reviewer to report and end, and names the report tool", () => {
    expect(REVIEW_READ_ALLOWANCE_GUIDANCE).toContain("keiko_review_report");
    expect(REVIEW_READ_ALLOWANCE_GUIDANCE).toContain("end your turn");
  });
});
