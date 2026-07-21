// Co-located unit tests for the canonical retrieval-evaluation primitives. The repo-wide
// architecture scan under `tests/architecture/eval-metrics-single-owner.test.ts` proves ONE owner
// exists; this file proves the ONE owner emits the exact math the pre-consolidation server and
// harness copies emitted, so a future edit to the formula cannot silently move the ADR-0152 D5
// gate floors under it.

import { describe, expect, it } from "vitest";

import { binaryNdcgAtK, mean } from "./eval-metrics.js";

describe("mean", () => {
  it("returns 0 for an empty input so a callers' empty-case aggregate does not divide by zero", () => {
    expect(mean([])).toBe(0);
  });

  it("computes the arithmetic mean using left-to-right IEEE-754 summation", () => {
    // The server pre-consolidation `average` and the harness pre-consolidation `mean` both summed
    // left-to-right starting from 0. The GroundedRetrievalScorecard scorecard values are compared
    // byte-identically pre/post consolidation — a shape change here would move real gate floors.
    expect(mean([1, 0, 1])).toBe(2 / 3);
    expect(mean([1])).toBe(1);
    expect(mean([0])).toBe(0);
    // Left-to-right summation is not associative in IEEE-754: `((0 + 0.1) + 0.2) + 0.3` yields
    // `0.6000000000000001`, whose /3 quotient is `0.20000000000000004` — different from the
    // right-associated `0.6 / 3 === 0.19999999999999998`. Pinning the actual left-to-right result
    // proves the summation order is the shape the pre-consolidation copies used.
    expect(mean([0.1, 0.2, 0.3])).toBe((0 + 0.1 + 0.2 + 0.3) / 3);
  });

  it("preserves single-element input verbatim", () => {
    expect(mean([0.21309297535714578])).toBe(0.21309297535714578);
  });
});

describe("binaryNdcgAtK", () => {
  it("returns 1 for the ideal ordering because IDCG equals actual gain", () => {
    expect(binaryNdcgAtK(["a", "b"], ["a", "b"], 2)).toBe(1);
  });

  it("applies the position-2 discount `1 / log2(index + 2)` for a rank-2 relevant hit", () => {
    // Position 1 (zero-indexed) yields `1 / log2(3)` — the exact discount the server's local
    // `ndcgAtK` used to emit for a single-relevant case with `paths.indexOf(relevantPath) === 1`.
    expect(binaryNdcgAtK(["x", "a"], ["a"], 2)).toBeCloseTo(1 / Math.log2(3), 6);
  });

  it("returns 0 when no relevant item falls within the top-k prefix", () => {
    expect(binaryNdcgAtK(["a", "b", "c"], ["x"], 3)).toBe(0);
  });

  it("returns 0 when the relevant item lands outside the requested prefix", () => {
    expect(binaryNdcgAtK(["x", "a"], ["a"], 1)).toBe(0);
  });

  it("returns 1 for the no-relevance convention so an empty gold-set does not spuriously fail", () => {
    // `binaryNdcgAtK(paths, [], k)` — when there is nothing relevant to find, any ranking is
    // vacuously perfect. This matches the pre-consolidation harness convention `[…]/[…]` used by
    // `check:retrieval-quality`.
    expect(binaryNdcgAtK(["x"], [], 5)).toBe(1);
  });

  it("returns 1 when the top-k prefix is empty (k = 0) for the same no-work-to-do convention", () => {
    expect(binaryNdcgAtK(["a"], ["a"], 0)).toBe(1);
  });

  it("reduces to the single-relevant discount `1 / log2(index + 2)` the server retrieval eval relies on", () => {
    // `packages/keiko-server/src/grounded-retrieval-eval.ts` deduplicates paths before calling in,
    // so `binaryNdcgAtK(paths, [relevantPath], k)` collapses to raw discount at the item's index.
    // This pins the exact shape so the grounded-retrieval scorecard values stay byte-identical
    // against the ADR-0152 D5 gate floors (0.8 / 0.9 / 0.85 / 0.8).
    expect(binaryNdcgAtK(["a", "b", "c"], ["a"], 3)).toBe(1 / Math.log2(2));
    expect(binaryNdcgAtK(["a", "b", "c"], ["b"], 3)).toBe(1 / Math.log2(3));
    expect(binaryNdcgAtK(["a", "b", "c"], ["c"], 3)).toBe(1 / Math.log2(4));
  });

  it("clamps a fractional k down to its integer prefix so the discount table stays consistent", () => {
    // Fractional k → the integer prefix takes effect. Negative/NaN/Infinity now fail closed and
    // are covered by the dedicated malformed-cutoff case below.
    expect(binaryNdcgAtK(["a", "b"], ["b"], 2.9)).toBeCloseTo(1 / Math.log2(3), 6);
    expect(binaryNdcgAtK(["a", "b"], ["b"], 2.1)).toBeCloseTo(1 / Math.log2(3), 6);
  });

  it("fails closed on non-finite or negative k so a bad input does not look like a perfect ranking", () => {
    // Pre-hardening, `Math.max(0, Math.floor(NaN))` yielded `0` and the empty-prefix branch
    // returned `1`, silently classifying malformed input as a perfect nDCG. Fail-closed returns
    // `0` so the caller sees the shape of the input drift instead of a spuriously green metric.
    expect(binaryNdcgAtK(["a", "b"], ["a"], Number.NaN)).toBe(0);
    expect(binaryNdcgAtK(["a", "b"], ["a"], -1)).toBe(0);
    expect(binaryNdcgAtK(["a", "b"], ["a"], -0.1)).toBe(0);
    expect(binaryNdcgAtK(["a", "b"], ["a"], Number.POSITIVE_INFINITY)).toBe(0);
    expect(binaryNdcgAtK(["a", "b"], ["a"], Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it("deduplicates ranked values so a caller that forgot to dedupe cannot produce nDCG > 1", () => {
    // A normalised nDCG must sit in `[0, 1]`. Pre-hardening, `["a", "a"]` with relevant `["a"]`
    // scored `1 + 1/log2(3) ≈ 1.63` because both slots earned discount. Deduplicating ranked
    // input in first-seen order preserves the unique-ranking result callers (server + gate
    // script) already produce via their own `rankedPaths()` dedupe step.
    expect(binaryNdcgAtK(["a", "a"], ["a"], 2)).toBe(1);
    expect(binaryNdcgAtK(["a", "a", "b", "b"], ["b"], 3)).toBe(1 / Math.log2(3));
    // Duplicates outside the prefix also collapse: unique-first-seen order is what indexes the
    // discount, so `["a", "a", "b"]` at k=2 sees `["a", "b"]` and misses relevant `["c"]`.
    expect(binaryNdcgAtK(["a", "a", "b"], ["c"], 2)).toBe(0);
  });
});
