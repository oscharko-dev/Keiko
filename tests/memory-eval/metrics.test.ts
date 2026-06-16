// Unit tests for the pure graded-quality metrics (Epic #204 / #215).
//
// These pin the arithmetic of recall@k, precision@k, and FAMA independently of any retrieval run,
// so a regression in the metric layer itself is caught before it can mask a regression in the
// system under test. Every case is exact integer arithmetic — no tolerances needed.

import { describe, expect, it } from "vitest";

import { famaScore, precisionAtK, recallAtK, roundMetric } from "./metrics.js";

describe("graded eval metrics", () => {
  describe("recallAtK", () => {
    it("is the fraction of relevant ids found within the top-k surfaced set", () => {
      expect(recallAtK(["a", "b", "c", "d"], ["a", "c"], 4)).toBe(1);
      expect(recallAtK(["a", "x", "y", "c"], ["a", "b", "c"], 4)).toBe(roundMetric(2 / 3));
    });

    it("respects the k cut-off", () => {
      // target "c" sits at rank 3 (0-indexed 2); k=2 excludes it.
      expect(recallAtK(["a", "b", "c"], ["c"], 2)).toBe(0);
      expect(recallAtK(["a", "b", "c"], ["c"], 3)).toBe(1);
    });

    it("returns 1 for an empty relevant set (nothing to miss)", () => {
      expect(recallAtK(["a"], [], 5)).toBe(1);
    });

    it("returns 0 when nothing relevant was surfaced", () => {
      expect(recallAtK(["x", "y"], ["a", "b"], 5)).toBe(0);
    });
  });

  describe("precisionAtK", () => {
    it("is the fraction of the top-k surfaced ids that are relevant", () => {
      expect(precisionAtK(["a", "b", "c", "d"], ["a", "b"], 4)).toBe(0.5);
      expect(precisionAtK(["a", "b"], ["a", "b"], 5)).toBe(1);
    });

    it("returns 0 for an empty surfaced set", () => {
      expect(precisionAtK([], ["a"], 5)).toBe(0);
    });
  });

  describe("famaScore", () => {
    it("is perfect when every valid target is included and every invalid id is omitted", () => {
      const score = famaScore({
        includedRanked: ["valid-1"],
        validTargetIds: ["valid-1"],
        invalidIds: ["stale-1", "stale-2"],
      });
      expect(score).toEqual({ mpa: 1, faa: 1, fama: 1 });
    });

    it("penalises a leaked stale fact even when recall of valid targets is perfect", () => {
      // valid target included (MPA=1) but one of two stale ids leaked (FAA=0.5) => FAMA = 1 - 0.5.
      const score = famaScore({
        includedRanked: ["valid-1", "stale-2"],
        validTargetIds: ["valid-1"],
        invalidIds: ["stale-1", "stale-2"],
      });
      expect(score.mpa).toBe(1);
      expect(score.faa).toBe(0.5);
      expect(score.fama).toBe(0.5);
    });

    it("never drops below 0 and weights the forgetting error by lambda", () => {
      // MPA=0.5, FAA=0 => 0.5 - 1*(1) = -0.5 -> clamped to 0.
      const score = famaScore({
        includedRanked: ["valid-1", "stale-1"],
        validTargetIds: ["valid-1", "valid-2"],
        invalidIds: ["stale-1"],
      });
      expect(score.fama).toBe(0);
    });

    it("treats empty target / invalid sets as fully satisfied", () => {
      expect(famaScore({ includedRanked: [], validTargetIds: [], invalidIds: [] })).toEqual({
        mpa: 1,
        faa: 1,
        fama: 1,
      });
    });
  });
});
