// HTML Manual goldset extensions (Epic #1858, Issues #1902/#1903). These tests drive the new
// `html-manual-*` fixtures through the SAME `runRetrievalEval` runner and `PASS_THRESHOLDS` the
// shipping `check:retrieval-quality` gate uses — this issue adds fixture coverage, not a new
// scorecard mechanism. They prove three things the child issues require:
//   1. Every new manual query class clears all eight scorecard dimensions deterministically.
//   2. The denied-link and malformed-page classes return no evidence with the `below-min-score`
//      reason rather than a confident wrong answer.
//   3. A repointed ground-truth expectation drops the scorecard below the floors, so a real
//      retrieval/citation regression is caught and the failing dimension identifies the root area.

import { describe, expect, it } from "vitest";

import {
  htmlManualCodeBlockFixture,
  htmlManualDeniedLinkFixture,
  htmlManualFramesetFixture,
  htmlManualIndexPageFixture,
  htmlManualMalformedFixture,
  htmlManualMultilingualFixture,
  htmlManualTableRowFixture,
} from "./fixtures.js";
import { runRetrievalEval } from "./runner.js";
import { PASS_THRESHOLDS, type RetrievalEvalFixture } from "./types.js";

const NEW_MANUAL_FIXTURES: readonly RetrievalEvalFixture[] = [
  htmlManualTableRowFixture,
  htmlManualFramesetFixture,
  htmlManualCodeBlockFixture,
  htmlManualMalformedFixture,
  htmlManualDeniedLinkFixture,
  htmlManualIndexPageFixture,
  htmlManualMultilingualFixture,
];

function expectClearsAllFloors(dimensions: {
  readonly recall: number;
  readonly precision: number;
  readonly meanReciprocalRank: number;
  readonly ndcg: number;
  readonly sourceIsolation: number;
  readonly citationQuality: number;
  readonly noEvidenceAccuracy: number;
  readonly contextBudgetFit: number;
}): void {
  expect(dimensions.recall).toBeGreaterThanOrEqual(PASS_THRESHOLDS.recall);
  expect(dimensions.precision).toBeGreaterThanOrEqual(PASS_THRESHOLDS.precision);
  expect(dimensions.meanReciprocalRank).toBeGreaterThanOrEqual(PASS_THRESHOLDS.meanReciprocalRank);
  expect(dimensions.ndcg).toBeGreaterThanOrEqual(PASS_THRESHOLDS.ndcg);
  expect(dimensions.sourceIsolation).toBeGreaterThanOrEqual(PASS_THRESHOLDS.sourceIsolation);
  expect(dimensions.citationQuality).toBeGreaterThanOrEqual(PASS_THRESHOLDS.citationQuality);
  expect(dimensions.noEvidenceAccuracy).toBeGreaterThanOrEqual(PASS_THRESHOLDS.noEvidenceAccuracy);
  expect(dimensions.contextBudgetFit).toBeGreaterThanOrEqual(PASS_THRESHOLDS.contextBudgetFit);
}

describe("html-manual goldset fixtures — every new class passes the shipping thresholds", () => {
  for (const fixture of NEW_MANUAL_FIXTURES) {
    it(`${fixture.id} clears all eight scorecard dimensions and passes`, async () => {
      const scorecard = await runRetrievalEval(fixture);
      expectClearsAllFloors(scorecard.dimensions);
      expect(scorecard.passed).toBe(true);
    });
  }
});

describe("html-manual goldset fixtures — html-block citations stay well-formed", () => {
  it("table-row, code-block, and index-page scorecards keep citationQuality at 1.0", async () => {
    for (const fixture of [
      htmlManualTableRowFixture,
      htmlManualCodeBlockFixture,
      htmlManualIndexPageFixture,
    ]) {
      const scorecard = await runRetrievalEval(fixture);
      // html-block units carry a heading path, so every returned citation resolves a section path.
      expect(scorecard.dimensions.citationQuality).toBe(1);
    }
  });
});

describe("html-manual goldset fixtures — denied link and malformed page abstain honestly", () => {
  it("returns no evidence with the below-min-score reason for out-of-scope and dropped content", async () => {
    for (const fixture of [htmlManualDeniedLinkFixture, htmlManualMalformedFixture]) {
      const scorecard = await runRetrievalEval(fixture);
      expect(scorecard.dimensions.noEvidenceAccuracy).toBe(1);
      // Exactly the no-evidence query abstains; its recorded reason is the min-score floor.
      expect(scorecard.outcomes.expectedNoEvidenceCount).toBe(1);
      expect(scorecard.outcomes.noEvidenceReasonCounts["below-min-score"]).toBe(1);
    }
  });
});

describe("html-manual goldset fixtures — the scorecard is non-tautological", () => {
  it("repointing a ground-truth expectation at a decoy chunk drops recall below the floor", async () => {
    // Mirror the gate's regression probe: swap the first citation-open query's expected chunk for a
    // sibling the retriever will NOT return, and assert the scorecard now fails on recall — proving
    // the pass in the suites above reflects real retrieval, not a vacuous fixture.
    const baseline = await runRetrievalEval(htmlManualDeniedLinkFixture);
    expect(baseline.passed).toBe(true);

    // Pull the already-branded decoy ChunkId from the fixture rather than casting a raw string.
    const allChunks = htmlManualDeniedLinkFixture.capsules.flatMap((capsule) =>
      capsule.sources.flatMap((source) => source.documents.flatMap((doc) => doc.chunks)),
    );
    const decoy = allChunks.find((chunk) => String(chunk.id) === "c-denied-scope-note");
    if (decoy === undefined) throw new Error("expected decoy chunk c-denied-scope-note not found");

    const regressed: RetrievalEvalFixture = {
      ...htmlManualDeniedLinkFixture,
      id: "html-manual-denied-link-regression-probe",
      queries: htmlManualDeniedLinkFixture.queries.map((query) =>
        query.id === "q-denied-citation-open" ? { ...query, expectedChunkIds: [decoy.id] } : query,
      ),
    };
    const scorecard = await runRetrievalEval(regressed);
    expect(scorecard.dimensions.recall).toBeLessThan(PASS_THRESHOLDS.recall);
    expect(scorecard.passed).toBe(false);
  });
});

describe("html-manual goldset fixtures — scorecards are deterministic", () => {
  it("produces byte-identical dimensions across two runs of the same fixture", async () => {
    const first = await runRetrievalEval(htmlManualFramesetFixture);
    const second = await runRetrievalEval(htmlManualFramesetFixture);
    expect(second.dimensions).toEqual(first.dimensions);
  });
});
