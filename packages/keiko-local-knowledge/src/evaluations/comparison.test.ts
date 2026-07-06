// Tests for the unified retrieval-mode comparison (Epic #1826, child #2010). These prove the
// comparison (a) reuses only shipped fixtures, (b) groups them into per-leg rows that clear the
// gate floor, and (c) fails closed with a below-floor row when a leg regresses — so a mode
// regression is never hidden inside a single aggregate score. The comparison consumes the same
// `runRetrievalEval` scorecards the shipping gate already produces; it adds no retrieval path.
//
// The "surfaces a silent fusion regression" case below is the audit-fix regression test: it
// proves the "fused" row cannot pass on recall/precision/MRR/nDCG alone when NO underlying query
// actually exercised both retrieval lanes together. Before the fix `RetrievalComparisonRow` had
// no fusion-evidence signal at all, so a perfect-recall-but-single-leg scorecard set would have
// passed; confirmed by temporarily reverting `passesFusionEvidence` to `() => true` and re-running
// this file — the assertion on `fused?.passed` failed as expected.

import { describe, expect, it } from "vitest";

import type { ChunkId } from "@oscharko-dev/keiko-contracts";

import {
  RETRIEVAL_COMPARISON_MODE_MAP,
  computeRetrievalModeComparison,
  renderRetrievalModeComparisonReport,
} from "./comparison.js";
import { ALL_FIXTURES, exactTechnicalFixture, semanticParaphraseFixture } from "./fixtures.js";
import { runRetrievalEval } from "./runner.js";
import type { RetrievalEvalScorecard, RetrievalEvalFixture } from "./types.js";

const DECOY_CHUNK = "__absent_decoy_chunk__" as ChunkId;

async function scoreAllFixtures(): Promise<RetrievalEvalScorecard[]> {
  const cards: RetrievalEvalScorecard[] = [];
  for (const fixture of ALL_FIXTURES) cards.push(await runRetrievalEval(fixture));
  return cards;
}

// Synthesises a scorecard shaped exactly like a real "fused" fixture's would look if RRF fusion
// silently degraded to a single retrieval leg: every ranking dimension is a perfect 1.0 (the
// expected chunk still happens to be findable by whichever leg survived), but
// `retrievalModeCounts` records only that single leg — never "hybrid" — because the two lanes
// never both contributed to one fused result. This is the exact failure scenario from the audit:
// a regression the recall/precision/MRR/nDCG floor alone cannot see.
function perfectButSingleLegScorecard(fixtureId: string): RetrievalEvalScorecard {
  return {
    fixtureId,
    runId: `synthetic-${fixtureId}`,
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
    },
    outcomes: {
      queryCount: 1,
      referenceCount: 1,
      noEvidenceCount: 0,
      expectedNoEvidenceCount: 0,
      noEvidenceReasonCounts: {},
      retrievalModeCounts: { "dense-only": 1 },
    },
    passed: true,
  };
}

// Repoints every ground-truth query at a decoy chunk that retrieval will never return, keeping
// the fixture id so it still maps to its leg. Recall/MRR/nDCG then collapse for that fixture —
// the same injected-regression technique the shipping retrieval-quality gate uses.
function regressExpectations(fixture: RetrievalEvalFixture): RetrievalEvalFixture {
  return {
    ...fixture,
    queries: fixture.queries.map((query) => ({ ...query, expectedChunkIds: [DECOY_CHUNK] })),
  };
}

describe("retrieval mode comparison (#2010)", () => {
  it("maps only shipped fixtures — no parallel fixture set", () => {
    const shipped = new Set(ALL_FIXTURES.map((fixture) => fixture.id));
    for (const id of Object.keys(RETRIEVAL_COMPARISON_MODE_MAP)) {
      expect(shipped.has(id)).toBe(true);
    }
  });

  it("groups shipped scorecards into lexical/vector/fused rows that clear the floor", async () => {
    const comparison = computeRetrievalModeComparison(await scoreAllFixtures());
    expect(comparison.rows.map((row) => row.mode)).toEqual(["lexical", "vector", "fused"]);
    for (const row of comparison.rows) {
      expect(row.passed).toBe(true);
      expect(row.floorHeadroom).toBeGreaterThanOrEqual(0);
    }
    const vector = comparison.rows.find((row) => row.mode === "vector");
    expect(vector?.fixtureIds).toContain("semantic-paraphrase");
    expect(vector?.fixtureIds).toContain("multilingual-retrieval");
  });

  it("surfaces a lexical-leg regression as a below-floor mode row", async () => {
    const regressed = await runRetrievalEval(regressExpectations(exactTechnicalFixture));
    const comparison = computeRetrievalModeComparison([regressed]);
    const lexical = comparison.rows.find((row) => row.mode === "lexical");
    expect(lexical?.passed).toBe(false);
    expect(lexical?.floorHeadroom).toBeLessThan(0);
  });

  it("surfaces a vector-leg regression as a below-floor mode row", async () => {
    const regressed = await runRetrievalEval(regressExpectations(semanticParaphraseFixture));
    const comparison = computeRetrievalModeComparison([regressed]);
    const vector = comparison.rows.find((row) => row.mode === "vector");
    expect(vector?.passed).toBe(false);
    expect(vector?.floorHeadroom).toBeLessThan(0);
  });

  it("surfaces a silent fusion regression even when recall/precision/MRR/nDCG stay perfect", () => {
    // Each fused-labelled fixture, individually, would still clear the floor with its
    // ground-truth chunk found by a single surviving leg — proving the floor check alone cannot
    // catch a fusion regression.
    const singleLegOnly = [
      perfectButSingleLegScorecard("broad-query-diversity"),
      perfectButSingleLegScorecard("mixed-strategy"),
      perfectButSingleLegScorecard("multi-space"),
    ];
    const comparison = computeRetrievalModeComparison(singleLegOnly);
    const fused = comparison.rows.find((row) => row.mode === "fused");
    expect(fused?.recall).toBe(1);
    expect(fused?.floorHeadroom).toBeGreaterThanOrEqual(0);
    expect(fused?.hybridQueryCount).toBe(0);
    expect(fused?.passed).toBe(false);
  });

  it("passes the fused row when at least one query is genuinely hybrid", async () => {
    const comparison = computeRetrievalModeComparison(await scoreAllFixtures());
    const fused = comparison.rows.find((row) => row.mode === "fused");
    expect(fused?.hybridQueryCount).toBeGreaterThan(0);
    expect(fused?.passed).toBe(true);
  });

  // Audit fix (#2016 post-merge audit, confirmed defect): a row's `passed` must reflect only the
  // dimensions the row itself displays and aggregates (recall/precision/MRR/nDCG) plus the
  // fusion-evidence gate — never an orthogonal per-card dimension the row does not surface (e.g.
  // citationQuality, contextBudgetFit, sourceIsolation, noEvidenceAccuracy). Before the fix,
  // `rowForMode` used `cards.every((card) => card.passed)`, so a scorecard failing ONLY on a
  // dimension outside recall/precision/MRR/nDCG dragged the whole row to FAIL even though every
  // metric the row prints (and floorHeadroom) cleared its floor — losing all attribution for an
  // operator reading the comparison table.
  it("does not fail a row for an orthogonal dimension the row does not display", async () => {
    const [card] = await scoreAllFixtures();
    if (card === undefined) throw new Error("expected at least one scorecard");
    const orthogonalMiss: RetrievalEvalScorecard = {
      ...card,
      fixtureId: "exact-technical",
      dimensions: { ...card.dimensions, citationQuality: 0 },
      passed: false,
    };
    const comparison = computeRetrievalModeComparison([orthogonalMiss]);
    const lexical = comparison.rows.find((row) => row.mode === "lexical");
    expect(lexical?.floorHeadroom).toBeGreaterThanOrEqual(0);
    expect(lexical?.passed).toBe(true);
  });

  it("renders one row per mode, not a single aggregate", async () => {
    const report = renderRetrievalModeComparisonReport(
      computeRetrievalModeComparison(await scoreAllFixtures()),
    );
    expect(report).toContain("| lexical |");
    expect(report).toContain("| vector |");
    expect(report).toContain("| fused |");
  });
});
