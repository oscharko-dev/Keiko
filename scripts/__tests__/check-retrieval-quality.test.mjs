import { describe, expect, it } from "vitest";

import {
  evaluateQualityBudget,
  ndcgAtK,
  recallAtK,
  reciprocalRank,
  uniquePathsInOrder,
} from "../check-retrieval-quality.mjs";

describe("check-retrieval-quality helpers", () => {
  it("deduplicates paths while preserving first-seen order", () => {
    expect(uniquePathsInOrder(["b.ts", "a.ts", "b.ts", "c.ts", "a.ts"])).toEqual([
      "b.ts",
      "a.ts",
      "c.ts",
    ]);
  });

  it("computes reciprocal rank for the first relevant path", () => {
    expect(reciprocalRank(["a.ts", "b.ts", "c.ts"], ["c.ts"])).toBeCloseTo(1 / 3, 6);
    expect(reciprocalRank(["a.ts", "b.ts"], ["missing.ts"])).toBe(0);
  });

  it("computes recall@k over a binary relevant set", () => {
    expect(recallAtK(["a.ts", "b.ts", "c.ts"], ["b.ts", "d.ts"], 2)).toBe(0.5);
    expect(recallAtK(["a.ts"], [], 5)).toBe(1);
  });

  it("computes nDCG@k with ideal ordering normalized to 1", () => {
    expect(ndcgAtK(["a.ts", "b.ts"], ["a.ts", "b.ts"], 2)).toBe(1);
    expect(ndcgAtK(["x.ts", "a.ts"], ["a.ts"], 2)).toBeCloseTo(1 / Math.log2(3), 6);
  });

  it("reports every failed budget dimension", () => {
    const result = evaluateQualityBudget(
      {
        top1Rate: 0.9,
        recallAtK: 1,
        mrr: 0.9,
        ndcgAtK: 1,
        lineHitRate: 1,
        generatedLeakCount: 1,
        failedCases: ["case-a"],
      },
      {
        minTop1Rate: 1,
        minRecallAtK: 1,
        minMrr: 1,
        minNdcgAtK: 1,
        minLineHitRate: 1,
        maxGeneratedLeakCount: 0,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(["top1Rate", "mrr", "generatedLeakCount", "caseFailures"]);
  });
});
