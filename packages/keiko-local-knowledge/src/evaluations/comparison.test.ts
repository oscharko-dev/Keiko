// Tests for the unified retrieval-mode comparison (Epic #1826, child #2010). These prove the
// comparison (a) reuses only shipped fixtures, (b) groups them into per-leg rows that clear the
// gate floor, and (c) fails closed with a below-floor row when a leg regresses — so a mode
// regression is never hidden inside a single aggregate score. The comparison consumes the same
// `runRetrievalEval` scorecards the shipping gate already produces; it adds no retrieval path.

import { describe, expect, it } from "vitest";

import type { ChunkId } from "@oscharko-dev/keiko-contracts";

import {
  RETRIEVAL_COMPARISON_MODE_MAP,
  computeRetrievalModeComparison,
  renderRetrievalModeComparisonReport,
} from "./comparison.js";
import { ALL_FIXTURES, exactTechnicalFixture, semanticParaphraseFixture } from "./fixtures.js";
import { runRetrievalEval } from "./runner.js";
import type { RetrievalEvalFixture, RetrievalEvalScorecard } from "./types.js";

const DECOY_CHUNK = "__absent_decoy_chunk__" as ChunkId;

async function scoreAllFixtures(): Promise<RetrievalEvalScorecard[]> {
  const cards: RetrievalEvalScorecard[] = [];
  for (const fixture of ALL_FIXTURES) cards.push(await runRetrievalEval(fixture));
  return cards;
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

  it("renders one row per mode, not a single aggregate", async () => {
    const report = renderRetrievalModeComparisonReport(
      computeRetrievalModeComparison(await scoreAllFixtures()),
    );
    expect(report).toContain("| lexical |");
    expect(report).toContain("| vector |");
    expect(report).toContain("| fused |");
  });
});
