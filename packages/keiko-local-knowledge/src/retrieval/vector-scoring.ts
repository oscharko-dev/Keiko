// Shared vector-similarity scoring primitives used by both the USearch ANN service
// (`usearch-ann-index.ts`) and the exact-search resilience fallback
// (`scoped-vector-search.ts`) — #2906 KEIKO-0632. Extracting these into a single-owner
// module removes a subtle drift risk: two files that computed mathematically equivalent
// scores today could diverge silently under a future metric-handling or numerical-
// stability change, silently producing different relevance rankings depending on whether
// a query hit the shared USearch service or its brute-force fallback.
//
// Bit-identical scores across callers require a fixed IEEE-754 operation order. Every
// helper here accumulates in ASCENDING index and cosine follows the single-pass form
// `dot += a*b; na += a*a; nb += b*b`. The precomputed-norm cosine (`cosineScore`) MUST
// return the same value as the single-pass `cosineSimilarity` when its `queryNorm` and
// `vectorNormValue` were derived from `vectorNorm(...)` here — that invariant is what
// keeps `denseRowScore`'s cosine fast-path bit-identical to the fallback path.

import type { EmbeddingVectorMetric } from "@oscharko-dev/keiko-contracts";

// L2 norm. Single-pass ascending accumulation matches the `na`/`nb` sums inside
// `cosineSimilarity` below — a cosine value computed as `dot / (vectorNorm(a) * vectorNorm(b))`
// is bit-identical to the single-pass form because both use the same operation order.
export function vectorNorm(vector: Float32Array): number {
  let squared = 0;
  for (const value of vector) {
    squared += value * value;
  }
  return Math.sqrt(squared);
}

// `noUncheckedIndexedAccess` widens `Float32Array[i]` to `number | undefined`; the loops
// stay in-bounds by construction (`i < left.length`), so we narrow with `?? 0` rather
// than a `!` assertion (forbidden by the project's lint rule) — at every index the value
// is always a real Float32 lane, never absent.
export function dotProduct(left: Float32Array, right: Float32Array): number {
  let score = 0;
  const length = left.length;
  for (let index = 0; index < length; index += 1) {
    score += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return score;
}

// Single-pass cosine: accumulates dot, na, nb in one loop. Returns 0 when either norm is
// zero to keep the score numerically stable for a zero vector (matches the fallback
// path's historical behavior).
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const length = a.length;
  for (let index = 0; index < length; index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Precomputed-norm cosine: with both norms available, cosine collapses to
// `dot / (queryNorm * vectorNormValue)`. Callers MUST supply norms produced by
// `vectorNorm` in this module so the IEEE-754 operation order matches `cosineSimilarity`.
export function cosineScore(
  query: Float32Array,
  queryNorm: number,
  vector: Float32Array,
  vectorNormValue: number,
): number {
  return dotProduct(query, vector) / (queryNorm * vectorNormValue);
}

// Negated Euclidean distance: higher = closer, giving cosine/dot/euclidean a uniform
// score-desc sort. Consumers never see the raw distance — only the unified score.
export function negativeEuclideanDistance(a: Float32Array, b: Float32Array): number {
  let squared = 0;
  const length = a.length;
  for (let index = 0; index < length; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    squared += delta * delta;
  }
  return -Math.sqrt(squared);
}

// Precomputed-norm metric dispatcher used by the ANN service. Cosine uses the fast path;
// dot skips normalization entirely; euclidean's negated distance is metric-defined.
export function scoreVectorWithNorms(
  metric: EmbeddingVectorMetric,
  query: Float32Array,
  queryNorm: number,
  vector: Float32Array,
  vectorNormValue: number,
): number {
  if (metric === "cosine") return cosineScore(query, queryNorm, vector, vectorNormValue);
  if (metric === "dot") return dotProduct(query, vector);
  return negativeEuclideanDistance(query, vector);
}

// Inline dispatcher used by the fallback path. Equivalent result to `scoreVectorWithNorms`
// for the same inputs; kept as a separate entry point so the fallback does not have to
// precompute norms per call.
export function scoreVector(
  metric: EmbeddingVectorMetric,
  query: Float32Array,
  vector: Float32Array,
): number {
  if (metric === "cosine") return cosineSimilarity(query, vector);
  if (metric === "dot") return dotProduct(query, vector);
  return negativeEuclideanDistance(query, vector);
}
