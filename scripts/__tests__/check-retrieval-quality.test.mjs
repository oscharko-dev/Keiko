import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  evaluateQualityBudget,
  ndcgAtK,
  recallAtK,
  reciprocalRank,
  regressFixtureExpectations,
  runLocalKnowledgeQualityCheck,
  runLocalKnowledgeRegressionProbes,
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

function scorecard(fixtureId, dimensions, retrievalModeCounts = {}) {
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
    outcomes: {
      queryCount: 1,
      referenceCount: 1,
      noEvidenceCount: 0,
      expectedNoEvidenceCount: 0,
      noEvidenceReasonCounts: {},
      retrievalModeCounts,
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

  it("reports mode-specific Local Knowledge comparison rows from the retrieval gate", async () => {
    const logs = [];
    const fixtures = [
      { id: "exact-technical" },
      { id: "semantic-paraphrase" },
      { id: "mixed-strategy" },
    ];
    // `mixed-strategy` maps to the "fused" row, which requires at least one query where both
    // the lexical and dense lanes contributed ("hybrid" diagnostics mode) — see comparison.ts's
    // fusion-evidence gate. Without it a perfect-recall scorecard alone would not be enough to
    // prove fusion actually happened, matching what production reports for this fixture.
    const retrievalModeCountsFor = (fixtureId) =>
      fixtureId === "mixed-strategy" ? { hybrid: 1 } : {};
    const result = await runLocalKnowledgeQualityCheck(
      (line) => logs.push(line),
      fixtures,
      (fixture) => Promise.resolve(scorecard(fixture.id, {}, retrievalModeCountsFor(fixture.id))),
    );

    expect(result.ok).toBe(true);
    expect(logs).toContain(
      "local-knowledge-retrieval-comparison report: # Local Knowledge Retrieval Mode Comparison",
    );
    expect(logs.some((line) => line.includes("| lexical | exact-technical |"))).toBe(true);
    expect(logs.some((line) => line.includes("| vector | semantic-paraphrase |"))).toBe(true);
    expect(logs.some((line) => line.includes("| fused | mixed-strategy |"))).toBe(true);
  });

  it("fails the fused comparison row when no query shows genuine hybrid fusion", async () => {
    const logs = [];
    const fixtures = [{ id: "mixed-strategy" }];
    const result = await runLocalKnowledgeQualityCheck(
      (line) => logs.push(line),
      fixtures,
      (fixture) => Promise.resolve(scorecard(fixture.id, {}, { "dense-only": 1 })),
    );

    expect(result.ok).toBe(false);
    expect(
      logs.some((line) => line.includes("local-knowledge-retrieval-comparison failure: fused:")),
    ).toBe(true);
    expect(logs.some((line) => line.includes("hybrid-queries=0"))).toBe(true);
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
        regressionProbes: () => Promise.resolve({ ok: true, tautological: [], probed: 1 }),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    expect(failures).toEqual(["local knowledge quality failed: fixture-a"]);
  });
});

function probeFixture(id) {
  return {
    id,
    description: "regression probe sample",
    capsules: [
      {
        id: "cap-probe",
        displayName: "Probe",
        answerGroundingPolicy: "best-effort",
        embeddingModelIdentity: { provider: "eval", modelId: "m", vectorDimensions: 16 },
        sources: [
          {
            id: "src-probe",
            documents: [
              {
                id: "doc-probe",
                safeDisplayName: "probe.md",
                parsedUnits: [],
                chunks: [
                  { id: "c-gold", text: "gold" },
                  { id: "c-decoy", text: "decoy" },
                ],
              },
            ],
          },
        ],
      },
    ],
    queries: [
      {
        id: "q-probe",
        text: "probe",
        scope: { kind: "capsule", capsuleId: "cap-probe" },
        expectedChunkIds: ["c-gold"],
        topK: 1,
      },
    ],
  };
}

describe("check-retrieval-quality regression probes", () => {
  it("repoints ground-truth expectations at a decoy chunk in the same corpus", () => {
    const regressed = regressFixtureExpectations(probeFixture("exact-technical"));

    expect(regressed.id).toBe("exact-technical-regression-probe");
    expect(regressed.queries).toHaveLength(1);
    expect(regressed.queries[0].expectedChunkIds).toEqual(["c-decoy"]);
  });

  it("passes when every regressed probe drops below the pass floors", async () => {
    const logs = [];
    const result = await runLocalKnowledgeRegressionProbes(
      (line) => logs.push(line),
      [probeFixture("exact-technical")],
      () => Promise.resolve(scorecard("exact-technical-regression-probe", { recall: 0, ndcg: 0 })),
      ["exact-technical"],
    );

    expect(result).toEqual({ ok: true, tautological: [], probed: 1, unresolved: [] });
    expect(logs.some((line) => line.includes("observed=below-floors"))).toBe(true);
  });

  it("flags a tautological gate when a regressed probe still clears the floors", async () => {
    const result = await runLocalKnowledgeRegressionProbes(
      () => undefined,
      [probeFixture("semantic-paraphrase")],
      () => Promise.resolve(scorecard("semantic-paraphrase-regression-probe", {})),
      ["semantic-paraphrase"],
    );

    expect(result.ok).toBe(false);
    expect(result.tautological).toEqual(["semantic-paraphrase"]);
  });

  it("reports probed=0 when no probe fixtures match the registry", async () => {
    const result = await runLocalKnowledgeRegressionProbes(
      () => undefined,
      [probeFixture("unrelated-fixture")],
      () => Promise.reject(new Error("runner must not be called")),
      ["exact-technical"],
    );

    expect(result).toEqual({
      ok: false,
      tautological: [],
      probed: 0,
      unresolved: ["exact-technical"],
    });
  });

  it("fails closed when a registered probe id does not resolve to any fixture (AUDIT-E1858-OPT-001)", async () => {
    const logs = [];
    const result = await runLocalKnowledgeRegressionProbes(
      (line) => logs.push(line),
      [probeFixture("exact-technical")],
      () => Promise.resolve(scorecard("exact-technical-regression-probe", { recall: 0, ndcg: 0 })),
      ["exact-technical", "typo-id-that-does-not-exist"],
    );

    expect(result).toEqual({
      ok: false,
      tautological: [],
      probed: 1,
      unresolved: ["typo-id-that-does-not-exist"],
    });
    expect(logs.some((line) => line.includes("unresolved probe fixture ids"))).toBe(true);
  });

  it("fails the aggregate gate when the regression probes are tautological", async () => {
    const { dir, path } = budgetFile();
    const failures = [];
    try {
      await runRetrievalQualityCheck({
        budgetPath: path,
        workspaceCases: [],
        log: () => undefined,
        fail: (message) => failures.push(message),
        localKnowledgeQualityCheck: () =>
          Promise.resolve({ ok: true, summary: { failedFixtureIds: [] }, scorecards: [] }),
        regressionProbes: () =>
          Promise.resolve({ ok: false, tautological: ["exact-technical"], probed: 1 }),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    expect(failures).toEqual([
      "local knowledge regression probes were tautological: exact-technical",
    ]);
  });
});
