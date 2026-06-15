// Maximal Marginal Relevance (MMR) re-ordering for context selection (#204, O-F3).
//
// The token-budgeted assembler fills greedily by rank, so when several near-duplicate memories sit at
// the top they can ALL be packed into the budget — three paraphrases of one fact crowd out three
// complementary facts. MMR (Carbonell & Goldstein 1998) re-orders the ranked list to balance
// relevance against novelty relative to what is already chosen:
//
//   next = argmax_d [ lambda * score(d) - (1 - lambda) * max_{s in selected} cosine(d, s) ]
//
// Pure & deterministic: same ranked list + same vectors + same lambda => same order. Ties break on
// the ORIGINAL rank index, so the output is stable and, with lambda = 1 (or no vectors), byte-equal
// to the input order. A candidate with no embedding incurs zero diversity penalty (treated as
// maximally novel) — the worst case is "behaves like today", never a regression.

import type { MemoryId } from "@oscharko-dev/keiko-contracts/memory";

export const DEFAULT_MMR_LAMBDA = 0.7;

// Cosine in [0,1], clamped like the rest of the stack (negative => 0). Length-mismatch / zero vector
// => 0 (no penalty).
function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  const c = dot / (Math.sqrt(na) * Math.sqrt(nb));
  if (c <= 0) return 0;
  return c > 1 ? 1 : c;
}

export interface MmrItem {
  readonly memoryId: MemoryId;
  readonly score: number;
}

// Highest cosine of `vec` to any already-selected vector (0 if `vec` is absent or none selected).
function maxSimilarity(vec: Float32Array | undefined, selected: readonly Float32Array[]): number {
  if (vec === undefined) return 0;
  let max = 0;
  for (const sv of selected) {
    const sim = cosine(vec, sv);
    if (sim > max) max = sim;
  }
  return max;
}

// Index in `remaining` of the highest MMR value. Strict `>` so ties keep the earlier (higher-ranked)
// candidate, since `remaining` preserves the input order — that makes the result deterministic.
function bestMmrIndex(
  remaining: readonly MmrItem[],
  embeddingById: ReadonlyMap<MemoryId, Float32Array>,
  selectedVectors: readonly Float32Array[],
  lambda: number,
): number {
  let bestPos = 0;
  let bestValue = -Infinity;
  for (let i = 0; i < remaining.length; i += 1) {
    const cand = remaining[i];
    if (cand === undefined) continue;
    const sim = maxSimilarity(embeddingById.get(cand.memoryId), selectedVectors);
    const value = lambda * cand.score - (1 - lambda) * sim;
    if (value > bestValue) {
      bestValue = value;
      bestPos = i;
    }
  }
  return bestPos;
}

// Re-orders `ranked` by MMR. Returns a NEW array of the same items. When `embeddingById` is empty or
// lambda >= 1, the input order is preserved exactly (the diversity term is inert).
export function reorderByMmr<T extends MmrItem>(
  ranked: readonly T[],
  embeddingById: ReadonlyMap<MemoryId, Float32Array>,
  lambda: number = DEFAULT_MMR_LAMBDA,
): readonly T[] {
  if (ranked.length <= 2 || embeddingById.size === 0 || lambda >= 1) {
    return [...ranked];
  }
  const remaining = [...ranked];
  const selected: T[] = [];
  const selectedVectors: Float32Array[] = [];
  while (remaining.length > 0) {
    const pos = bestMmrIndex(remaining, embeddingById, selectedVectors, lambda);
    const chosen = remaining.splice(pos, 1)[0];
    if (chosen === undefined) break;
    selected.push(chosen);
    const vec = embeddingById.get(chosen.memoryId);
    if (vec !== undefined) selectedVectors.push(vec);
  }
  return selected;
}
