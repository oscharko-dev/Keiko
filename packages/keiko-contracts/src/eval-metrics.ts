// ADR-0152 D5 (amended by Issue #2635): the deterministic numeric primitives every retrieval
// evaluation harness uses live on the leaf package so their one implementation is reachable from
// every layer above — the folded harness in `keiko-evaluations`, the gate script in `scripts/`, and
// the server retrieval eval — without an inward-pointing dependency edge. Pre-M2.14 these lived in
// `keiko-evaluations/src/metrics.ts` and `keiko-server` carried a locally-named `average()` +
// `ndcgAtK()` because it could not depend on the harness; consolidating on contracts is the option
// the leaf's dependency direction admits without adding a server → evaluations edge.
//
// These helpers are the exact math the ADR-0152 D5 gate floors (0.8 / 0.9 / 0.85 / 0.8 for grounded
// retrieval) are calibrated against. Any change to the values they emit shifts every scorecard
// downstream, so the shape (left-to-right summation, `+ 2` discount offset, no-relevance = perfect
// nDCG) is deliberately pinned. `tests/architecture/eval-metrics-single-owner.test.ts` guards the
// single-owner invariant structurally so a copy that renames itself is still caught.

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

function discountedGain(relevance: readonly boolean[]): number {
  let score = 0;
  for (let index = 0; index < relevance.length; index += 1) {
    if (relevance[index] === true) score += 1 / Math.log2(index + 2);
  }
  return score;
}

export function binaryNdcgAtK<Value>(
  ranked: readonly Value[],
  relevant: readonly Value[],
  k: number,
): number {
  // Fail-closed on malformed cutoffs. `Math.floor(NaN)` and `Math.floor(-1)` used to collapse to
  // `0` through the max-clamp and reach the no-work-to-do fallback that returns `1`; a bad input
  // silently classified as a perfect ranking is exactly the drift the retrieval-metrics gate
  // exists to catch. `k = 0` remains the intentional no-relevance case that still returns `1`.
  if (!Number.isFinite(k) || k < 0) return 0;
  const limit = Math.floor(k);
  const relevantSet = new Set(relevant);
  // Deduplicate ranked values while preserving first-seen order. `rankedPaths()` in the server
  // retrieval eval and the gate script already dedupe before calling in, so this preserves their
  // byte-identical scorecards; without it a caller that forgot to dedupe could feed
  // `["a", "a"]` and produce `nDCG > 1` — impossible for a normalised score.
  const seen = new Set<Value>();
  const uniqueRanked: Value[] = [];
  for (const value of ranked) {
    if (!seen.has(value)) {
      seen.add(value);
      uniqueRanked.push(value);
    }
  }
  const actual = uniqueRanked.slice(0, limit).map((value): boolean => relevantSet.has(value));
  const idealCount = Math.min(limit, relevantSet.size);
  const ideal = Array.from({ length: idealCount }, (): true => true);
  const idealGain = discountedGain(ideal);
  return idealGain === 0 ? 1 : discountedGain(actual) / idealGain;
}
