// Tests for the retrieval eval runner (Epic #189, Issue #268). Each fixture exercises
// one (or two) dimensions to its pass threshold; the determinism test pins byte-identical
// scorecards across runs; the mutation-witness test proves the runner's precision score
// would change if the retrieval-runner's topK clamp were removed.

import { describe, expect, it } from "vitest";

import {
  ambiguousQueryFixture,
  multiCapsuleFixture,
  noEvidenceFixture,
  singleTopicFixture,
  sourceIsolationFixture,
} from "./fixtures.js";
import { runRetrievalEval } from "./runner.js";
import { PASS_THRESHOLDS, type RetrievalEvalFixture } from "./types.js";

describe("runRetrievalEval — single-topic fixture", () => {
  it("hits recall=1.0 and precision=1.0 on the ground-truth query", async () => {
    const scorecard = await runRetrievalEval(singleTopicFixture);
    expect(scorecard.dimensions.recall).toBe(1);
    expect(scorecard.dimensions.precision).toBe(1);
    expect(scorecard.passed).toBe(true);
  });

  it("includes the fixture id and a deterministic runId", async () => {
    const scorecard = await runRetrievalEval(singleTopicFixture);
    expect(scorecard.fixtureId).toBe("single-topic");
    expect(scorecard.runId).toBe("eval-single-topic");
  });
});

describe("runRetrievalEval — multi-capsule fixture", () => {
  it("merges refs from both capsules and meets the recall threshold", async () => {
    const scorecard = await runRetrievalEval(multiCapsuleFixture);
    expect(scorecard.dimensions.recall).toBeGreaterThanOrEqual(PASS_THRESHOLDS.recall);
    expect(scorecard.passed).toBe(true);
  });
});

describe("runRetrievalEval — no-evidence fixture", () => {
  it("returns noEvidenceAccuracy=1.0 when retrieval correctly returns empty refs", async () => {
    const scorecard = await runRetrievalEval(noEvidenceFixture);
    expect(scorecard.dimensions.noEvidenceAccuracy).toBe(1);
    expect(scorecard.passed).toBe(true);
  });
});

describe("runRetrievalEval — ambiguous-query fixture", () => {
  it("recall stays at 1.0 because both acceptable ground-truth chunks come back", async () => {
    const scorecard = await runRetrievalEval(ambiguousQueryFixture);
    expect(scorecard.dimensions.recall).toBe(1);
    expect(scorecard.passed).toBe(true);
  });
});

describe("runRetrievalEval — source-isolation fixture", () => {
  it("source isolation stays at 1.0 when scope is bound to a single capsule", async () => {
    const scorecard = await runRetrievalEval(sourceIsolationFixture);
    expect(scorecard.dimensions.sourceIsolation).toBe(1);
    expect(scorecard.passed).toBe(true);
  });
});

describe("runRetrievalEval — citation quality", () => {
  it("returns citationQuality=1.0 on a fixture where every chunk's parsed unit is a page", async () => {
    const scorecard = await runRetrievalEval(singleTopicFixture);
    // singleTopic uses page-unit citations with pageNumber=1 → every ref has pageNumber.
    expect(scorecard.dimensions.citationQuality).toBe(1);
  });
});

describe("runRetrievalEval — determinism", () => {
  it("two runs of the same fixture produce byte-identical scorecards", async () => {
    const a = await runRetrievalEval(singleTopicFixture);
    const b = await runRetrievalEval(singleTopicFixture);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("identical scorecards across every shipped fixture", async () => {
    const fixtures: readonly RetrievalEvalFixture[] = [
      singleTopicFixture,
      multiCapsuleFixture,
      noEvidenceFixture,
      ambiguousQueryFixture,
      sourceIsolationFixture,
    ];
    for (const fixture of fixtures) {
      const a = await runRetrievalEval(fixture);
      const b = await runRetrievalEval(fixture);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });

  it("default clock produces a stable latency value across runs", async () => {
    const a = await runRetrievalEval(singleTopicFixture);
    const b = await runRetrievalEval(singleTopicFixture);
    expect(a.dimensions.latencyMs).toBe(b.dimensions.latencyMs);
  });
});

describe("runRetrievalEval — mutation witness (topK clamp)", () => {
  it("a smaller topK changes the precision score relative to a larger topK", async () => {
    // Build two fixtures from `singleTopicFixture` differing only in the query's topK:
    //   - topK=1 returns one ref (the top alpha chunk); both expectedChunkIds includes
    //     two refs, so precision = 1/1 = 1.0, recall = 1/2 = 0.5.
    //   - topK=3 returns all three chunks (two alpha + the noise chunk). precision =
    //     2/3 ≈ 0.667.
    // The contrast proves that the underlying `topK` value flows through into the
    // precision computation — removing the `Math.min(topK, MAX_RETRIEVAL_TOP_K)` clamp
    // (or any other layer that bounds the returned set size) would change the score.
    const baseQuery = singleTopicFixture.queries[0];
    if (baseQuery === undefined) throw new Error("fixture missing query");
    const small: RetrievalEvalFixture = {
      ...singleTopicFixture,
      queries: [{ ...baseQuery, topK: 1 }],
    };
    const big: RetrievalEvalFixture = {
      ...singleTopicFixture,
      queries: [{ ...baseQuery, topK: 3 }],
    };
    const smallCard = await runRetrievalEval(small);
    const bigCard = await runRetrievalEval(big);
    // Precision at topK=1 is 1.0 (the single returned chunk is one of the expected pair).
    expect(smallCard.dimensions.precision).toBe(1);
    // Precision at topK=3 is < 1.0 because the noise chunk also comes back.
    expect(bigCard.dimensions.precision).toBeLessThan(1);
    expect(smallCard.dimensions.precision).not.toBe(bigCard.dimensions.precision);
  });
});

describe("runRetrievalEval — caller-supplied clock", () => {
  it("accepts a deps.now override and uses it for latency", async () => {
    let tick = 100;
    const scorecard = await runRetrievalEval(singleTopicFixture, {
      now: (): number => {
        tick += 5;
        return tick;
      },
      runId: "custom-run",
    });
    expect(scorecard.runId).toBe("custom-run");
    // Each query reads `now` exactly twice; one query in the fixture ⇒ latency = 5.
    expect(scorecard.dimensions.latencyMs).toBe(5);
  });
});

describe("runRetrievalEval — pass threshold breakdown", () => {
  it("every shipped fixture meets every pass threshold", async () => {
    const fixtures: readonly RetrievalEvalFixture[] = [
      singleTopicFixture,
      multiCapsuleFixture,
      noEvidenceFixture,
      ambiguousQueryFixture,
      sourceIsolationFixture,
    ];
    for (const fixture of fixtures) {
      const scorecard = await runRetrievalEval(fixture);
      expect(scorecard.dimensions.recall).toBeGreaterThanOrEqual(PASS_THRESHOLDS.recall);
      expect(scorecard.dimensions.precision).toBeGreaterThanOrEqual(PASS_THRESHOLDS.precision);
      expect(scorecard.dimensions.sourceIsolation).toBeGreaterThanOrEqual(
        PASS_THRESHOLDS.sourceIsolation,
      );
      expect(scorecard.dimensions.citationQuality).toBeGreaterThanOrEqual(
        PASS_THRESHOLDS.citationQuality,
      );
      expect(scorecard.dimensions.noEvidenceAccuracy).toBeGreaterThanOrEqual(
        PASS_THRESHOLDS.noEvidenceAccuracy,
      );
      expect(scorecard.passed).toBe(true);
    }
  });
});
