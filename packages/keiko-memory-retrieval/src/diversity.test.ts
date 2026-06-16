import { describe, expect, it } from "vitest";

import { reorderByMmr, DEFAULT_MMR_LAMBDA, type MmrItem } from "./diversity.js";
import { memoryId } from "./_support.js";

function item(id: string, score: number): MmrItem {
  return { memoryId: memoryId(id), score };
}

// Three "duplicate" vectors (cosine ~1 to each other) and one orthogonal "novel" vector.
const DUP = Float32Array.from([1, 0, 0]);
const DUP2 = Float32Array.from([0.99, 0.01, 0]);
const DUP3 = Float32Array.from([0.98, 0.02, 0]);
const NOVEL = Float32Array.from([0, 1, 0]);

describe("reorderByMmr (#204, O-F3)", () => {
  it("is a no-op (byte-identical order) when no embeddings are supplied", () => {
    const ranked = [item("a", 0.9), item("b", 0.8), item("c", 0.7)];
    expect(reorderByMmr(ranked, new Map())).toEqual(ranked);
  });

  it("is a no-op when lambda >= 1 (pure relevance)", () => {
    const ranked = [item("a", 0.9), item("b", 0.8), item("c", 0.7)];
    const vecs = new Map([
      [memoryId("a"), DUP],
      [memoryId("b"), DUP2],
      [memoryId("c"), NOVEL],
    ]);
    expect(reorderByMmr(ranked, vecs, 1)).toEqual(ranked);
  });

  it("promotes a novel memory ahead of a near-duplicate of the top result", () => {
    // Rank order: dup1 (0.9) > dup2 (0.85) > novel (0.6). dup2 is near-identical to dup1; the lower-
    // ranked-but-novel item should be pulled up ahead of dup2 once dup1 is selected.
    const ranked = [item("dup1", 0.9), item("dup2", 0.85), item("novel", 0.6)];
    const vecs = new Map([
      [memoryId("dup1"), DUP],
      [memoryId("dup2"), DUP2],
      [memoryId("novel"), NOVEL],
    ]);
    const order = reorderByMmr(ranked, vecs, 0.7).map((i) => String(i.memoryId));
    expect(order[0]).toBe("dup1");
    expect(order[1]).toBe("novel");
    expect(order[2]).toBe("dup2");
  });

  it("keeps the most relevant first and breaks ties on original rank (deterministic)", () => {
    const ranked = [item("a", 0.9), item("b", 0.9), item("c", 0.9)];
    const vecs = new Map([
      [memoryId("a"), DUP],
      [memoryId("b"), DUP2],
      [memoryId("c"), DUP3],
    ]);
    // All near-duplicates; the first pick is the top-ranked, then the order stays stable by rank.
    const order = reorderByMmr(ranked, vecs, DEFAULT_MMR_LAMBDA).map((i) => String(i.memoryId));
    expect(order[0]).toBe("a");
    expect(order).toHaveLength(3);
    expect(new Set(order)).toEqual(new Set(["a", "b", "c"]));
  });

  it("treats a candidate with no embedding as maximally novel (no diversity penalty)", () => {
    // 'noemb' has no vector: maxSimilarity must short-circuit to 0 and it must never be pushed to the
    // selected-vector set. With three items the MMR loop runs; the no-embedding item keeps its score.
    const ranked = [item("dup1", 0.9), item("dup2", 0.85), item("noemb", 0.84)];
    const vecs = new Map([
      [memoryId("dup1"), DUP],
      [memoryId("dup2"), DUP2],
    ]);
    const order = reorderByMmr(ranked, vecs, 0.7).map((i) => String(i.memoryId));
    expect(order[0]).toBe("dup1");
    // noemb (novel, penalty 0) is pulled ahead of dup2 (near-identical to dup1).
    expect(order[1]).toBe("noemb");
    expect(order[2]).toBe("dup2");
  });

  it("scores degenerate vectors as zero similarity (length mismatch, zero norm, opposite)", () => {
    // Each non-top candidate exercises one defensive cosine branch against the selected top vector:
    //   wronglen -> length mismatch    zero -> zero magnitude    opposite -> non-positive cosine
    // All yield similarity 0, so the loop completes and every item survives in score order.
    const ranked = [
      item("top", 0.9),
      item("opposite", 0.8),
      item("wronglen", 0.7),
      item("zero", 0.6),
    ];
    const vecs = new Map([
      [memoryId("top"), Float32Array.from([1, 0, 0])],
      [memoryId("opposite"), Float32Array.from([-1, 0, 0])],
      [memoryId("wronglen"), Float32Array.from([1, 0])],
      [memoryId("zero"), Float32Array.from([0, 0, 0])],
    ]);
    const order = reorderByMmr(ranked, vecs, 0.7).map((i) => String(i.memoryId));
    expect(order[0]).toBe("top");
    expect(order).toHaveLength(4);
    expect(new Set(order)).toEqual(new Set(["top", "opposite", "wronglen", "zero"]));
  });

  it("returns a copy (not the same reference) on the inert path", () => {
    const ranked = [item("a", 0.9), item("b", 0.8)];
    const out = reorderByMmr(ranked, new Map());
    expect(out).toEqual(ranked);
    expect(out).not.toBe(ranked);
  });
});
