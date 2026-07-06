import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  evaluateQualityBudget,
  ndcgAtK,
  recallAtK,
  reciprocalRank,
  runLocalKnowledgeQualityCheck,
  runRetrievalQualityCheck,
  uniquePathsInOrder,
} from "../check-retrieval-quality.mjs";

function budgetFile() {
  const dir = mkdtempSync(join(tmpdir(), "keiko-retrieval-quality-test-"));
  const path = join(dir, "budget.json");
  writeFileSync(
    path,
    JSON.stringify({
      minTop1Rate: 0,
      minRecallAtK: 0,
      minMrr: 0,
      minNdcgAtK: 0,
      minLineHitRate: 0,
      maxGeneratedLeakCount: 0,
    }),
  );
  return { dir, path };
}

function scorecard(fixtureId, dimensions) {
  return {
    fixtureId,
    runId: `eval-${fixtureId}`,
    dimensions: {
      recall: 1,
      precision: 1,
      meanReciprocalRank: 1,
      ndcg: 1,
      sourceIsolation: 1,
      citationQuality: 1,
      noEvidenceAccuracy: 1,
      contextBudgetFit: 1,
      latencyMs: 1,
      ...dimensions,
    },
    passed: Object.values(dimensions).every((value) => value >= 1),
  };
}

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

  it("reports failing Local Knowledge retrieval scorecards", async () => {
    const logs = [];
    const result = await runLocalKnowledgeQualityCheck(
      (line) => logs.push(line),
      [{ id: "fixture-a" }],
      () => Promise.resolve(scorecard("fixture-a", { recall: 0 })),
    );

    expect(result.ok).toBe(false);
    expect(result.summary.failedFixtureIds).toEqual(["fixture-a"]);
    expect(logs.some((line) => line.includes("local-knowledge-retrieval-quality failure"))).toBe(
      true,
    );
  });

  it("fails the aggregate gate when the Local Knowledge branch regresses", async () => {
    const { dir, path } = budgetFile();
    const failures = [];
    try {
      await runRetrievalQualityCheck({
        budgetPath: path,
        workspaceCases: [],
        log: () => undefined,
        fail: (message) => failures.push(message),
        localKnowledgeQualityCheck: () =>
          Promise.resolve({
            ok: false,
            summary: { failedFixtureIds: ["fixture-a"] },
            scorecards: [],
          }),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    expect(failures).toEqual(["local knowledge quality failed: fixture-a"]);
  });
});
