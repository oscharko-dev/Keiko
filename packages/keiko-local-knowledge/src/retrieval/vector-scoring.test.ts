// Cross-consistency test for the shared vector-scoring primitives (#2906 KEIKO-0632).
// The USearch ANN service (`usearch-ann-index.ts`) and the exact-search resilience
// fallback (`scoped-vector-search.ts`) used to keep byte-duplicated scoring functions.
// Once extracted here, both callers import from this module — a single change to any
// metric handler moves both paths together. These tests pin the numeric invariants that
// hold that promise: identical scores for identical inputs, cosine's fast-path/inline
// form parity, and stable rankings across the three supported metrics.

import { describe, expect, it } from "vitest";

import {
  cosineScore,
  cosineSimilarity,
  dotProduct,
  negativeEuclideanDistance,
  scoreVector,
  scoreVectorWithNorms,
  vectorNorm,
} from "./vector-scoring.js";

function f32(values: readonly number[]): Float32Array {
  return Float32Array.from(values);
}

describe("vector-scoring shared primitives", () => {
  it("cosineScore with precomputed norms equals cosineSimilarity for the same inputs", () => {
    const a = f32([0.1, -0.4, 0.7, 0.2]);
    const b = f32([0.6, 0.3, -0.2, 0.5]);
    const na = vectorNorm(a);
    const nb = vectorNorm(b);
    const inline = cosineSimilarity(a, b);
    const fast = cosineScore(a, na, b, nb);
    expect(fast).toBe(inline);
  });

  it("scoreVectorWithNorms and scoreVector agree for cosine on nonzero vectors", () => {
    const q = f32([0.2, 0.4, -0.1, 0.8, -0.3, 0.5, 0.05, 0.0]);
    const v = f32([-0.1, 0.5, 0.3, 0.6, -0.4, 0.2, 0.15, 0.1]);
    const qn = vectorNorm(q);
    const vn = vectorNorm(v);
    expect(scoreVectorWithNorms("cosine", q, qn, v, vn)).toBe(scoreVector("cosine", q, v));
  });

  it("dot and euclidean dispatch the same result through both entry points", () => {
    const q = f32([1, -2, 3, -4]);
    const v = f32([2, 1, -1, 0.5]);
    const qn = vectorNorm(q);
    const vn = vectorNorm(v);
    expect(scoreVectorWithNorms("dot", q, qn, v, vn)).toBe(scoreVector("dot", q, v));
    expect(scoreVectorWithNorms("euclidean", q, qn, v, vn)).toBe(scoreVector("euclidean", q, v));
  });

  it("dotProduct is commutative and matches the two-loop reference", () => {
    const a = f32([0.5, 0.25, 0.125]);
    const b = f32([2, 4, 8]);
    const forward = dotProduct(a, b);
    const backward = dotProduct(b, a);
    let manual = 0;
    for (let i = 0; i < a.length; i += 1) {
      manual += (a[i] ?? 0) * (b[i] ?? 0);
    }
    expect(forward).toBe(backward);
    expect(forward).toBe(manual);
  });

  it("negativeEuclideanDistance is <= 0 and larger (closer to 0) for closer vectors", () => {
    const q = f32([0, 0, 0]);
    const close = f32([0.1, -0.1, 0.1]);
    const far = f32([10, -20, 30]);
    expect(negativeEuclideanDistance(q, close)).toBeGreaterThan(negativeEuclideanDistance(q, far));
    expect(negativeEuclideanDistance(q, close)).toBeLessThanOrEqual(0);
  });

  it("cosineSimilarity returns 0 when either vector has zero norm (numerical guard)", () => {
    const q = f32([0, 0, 0]);
    const v = f32([1, 2, 3]);
    expect(cosineSimilarity(q, v)).toBe(0);
    expect(cosineSimilarity(v, q)).toBe(0);
  });

  it("cosineSimilarity of a vector with itself is 1 (within IEEE-754 tolerance)", () => {
    const v = f32([0.3, 0.6, -0.4, 0.2, 0.5]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 6);
  });

  // Rankings — the property both callers depend on — must agree between the ANN path and the
  // fallback path. Two identical inputs cannot rank differently based on which entry point
  // computed them.
  it("orders three candidates identically through both dispatchers for cosine and euclidean", () => {
    const query = f32([1, 0, 0, 0]);
    const candidates = [f32([0.9, 0.1, 0, 0]), f32([0.5, 0.4, 0.1, 0]), f32([0, 1, 0, 0])];
    const qNorm = vectorNorm(query);
    for (const metric of ["cosine", "euclidean"] as const) {
      const inline = candidates.map((c) => scoreVector(metric, query, c));
      const fast = candidates.map((c) =>
        scoreVectorWithNorms(metric, query, qNorm, c, vectorNorm(c)),
      );
      expect(inline).toEqual(fast);
    }
  });
});
