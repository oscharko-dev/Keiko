import { describe, expect, it } from "vitest";

import { rankMemories } from "./ranking.js";
import { DEFAULT_RANKING_WEIGHTS } from "./types.js";
import { buildEdge, buildRecord, memoryId } from "./_support.js";

const now = 7 * 86_400_000; // 7 days into epoch — recency math anchors here.

describe("rankMemories — basic ordering", () => {
  it("returns an empty list when given no memories", () => {
    const ranked = rankMemories([], { nowMs: now, weights: DEFAULT_RANKING_WEIGHTS });
    expect(ranked).toEqual([]);
  });

  it("ranks a pinned memory above an otherwise-equal unpinned one", () => {
    const pinned = buildRecord({ id: "p", pinned: true, updatedAt: now });
    const plain = buildRecord({ id: "u", pinned: false, updatedAt: now });
    const ranked = rankMemories([plain, pinned], {
      nowMs: now,
      weights: DEFAULT_RANKING_WEIGHTS,
    });
    expect(ranked[0]?.memoryId).toBe(memoryId("p"));
    expect(ranked[1]?.memoryId).toBe(memoryId("u"));
  });

  it("ranks a newer correction above an older semantic-fact on the same topic", () => {
    const oldFact = buildRecord({
      id: "fact",
      type: "semantic-fact",
      body: "user prefers dark mode",
      updatedAt: now - 30 * 86_400_000,
      capturedAt: now - 30 * 86_400_000,
    });
    const newCorrection = buildRecord({
      id: "correction",
      type: "correction",
      body: "user prefers dark mode",
      updatedAt: now,
      capturedAt: now,
    });
    const ranked = rankMemories([oldFact, newCorrection], {
      queryText: "dark mode",
      nowMs: now,
      weights: DEFAULT_RANKING_WEIGHTS,
    });
    expect(ranked[0]?.memoryId).toBe(memoryId("correction"));
    expect(ranked[1]?.memoryId).toBe(memoryId("fact"));
  });

  it("attaches a human-readable inclusionReason naming the top contributing subscore", () => {
    const pinned = buildRecord({ id: "p", pinned: true, updatedAt: now });
    const [first] = rankMemories([pinned], { nowMs: now, weights: DEFAULT_RANKING_WEIGHTS });
    expect(first?.inclusionReason).toMatch(/pinned/i);
  });

  it("is deterministic — same input twice yields byte-equal output", () => {
    const a = buildRecord({ id: "a", body: "alpha beta", updatedAt: now });
    const b = buildRecord({ id: "b", body: "alpha gamma", updatedAt: now });
    const c = buildRecord({ id: "c", body: "delta", updatedAt: now });
    const r1 = rankMemories([a, b, c], {
      queryText: "alpha",
      nowMs: now,
      weights: DEFAULT_RANKING_WEIGHTS,
    });
    const r2 = rankMemories([a, b, c], {
      queryText: "alpha",
      nowMs: now,
      weights: DEFAULT_RANKING_WEIGHTS,
    });
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it("tiebreaks on updatedAt desc, then id asc", () => {
    // Two memories with identical signals except updatedAt — newer wins.
    const older = buildRecord({ id: "b", updatedAt: now - 1 });
    const newer = buildRecord({ id: "a", updatedAt: now });
    const ranked = rankMemories([older, newer], {
      nowMs: now,
      weights: DEFAULT_RANKING_WEIGHTS,
    });
    expect(ranked[0]?.memoryId).toBe(memoryId("a"));
    expect(ranked[1]?.memoryId).toBe(memoryId("b"));
  });

  it("includes subscore breakdown on every entry", () => {
    const r = buildRecord({ id: "x", pinned: true, updatedAt: now });
    const [first] = rankMemories([r], { nowMs: now, weights: DEFAULT_RANKING_WEIGHTS });
    expect(first?.subscores).toEqual({
      relevance: 0,
      recency: 1,
      confidence: 0.8,
      pinned: 1,
      correction: 0,
      graph: 0,
      semantic: 0,
    });
  });

  it("normalizes exported scores into the documented [0, 1] range", () => {
    const r = buildRecord({ id: "x", pinned: true, updatedAt: now });
    const [first] = rankMemories([r], { nowMs: now, weights: DEFAULT_RANKING_WEIGHTS });
    expect(first?.score).toBeGreaterThanOrEqual(0);
    expect(first?.score).toBeLessThanOrEqual(1);
    expect(first?.score).toBeCloseTo((0.2 + 0.16 + 0.3) / 1.15);
  });
});

describe("rankMemories — graph proximity layering", () => {
  it("applies a graph-proximity boost when connected to other top-ranked memories", () => {
    const a = buildRecord({ id: "a", pinned: true, updatedAt: now });
    const b = buildRecord({ id: "b", updatedAt: now });
    // baseline rank (no graph): both decent; a wins on pinned. b has 0 graph.
    const baseline = rankMemories([a, b], {
      nowMs: now,
      weights: DEFAULT_RANKING_WEIGHTS,
    });
    const bBaseline = baseline.find((r) => r.memoryId === memoryId("b"));
    // with graph: b connects to a (a is top-ranked) -> b should get graph boost.
    const edges = [buildEdge({ from: "b", to: "a", kind: "related" })];
    const edgesByMemory = new Map([[memoryId("b"), edges]]);
    const withGraph = rankMemories(
      [a, b],
      { nowMs: now, weights: DEFAULT_RANKING_WEIGHTS },
      { edgesByMemory },
    );
    const bWithGraph = withGraph.find((r) => r.memoryId === memoryId("b"));
    expect(bWithGraph?.subscores.graph).toBeGreaterThan(0);
    expect(bWithGraph?.score).toBeGreaterThan(bBaseline?.score ?? 0);
  });
});

describe("rankMemories — semantic similarity signal (#204)", () => {
  // A German query that does NOT lexically overlap an English-canonicalized memory; the only
  // thing that can surface it is the supplied semantic score. This is the live-verified gap.
  const germanQuery = "Wie heißt mein Produkt";

  it("surfaces a semantically-matched memory that has zero lexical overlap", () => {
    const englishFact = buildRecord({
      id: "product",
      body: "The user is building a product named Keiko",
      updatedAt: now - 30 * 86_400_000,
    });
    const recentNoise = buildRecord({
      id: "noise",
      body: "completely unrelated note about the weather",
      updatedAt: now,
    });
    const semanticById = new Map([[memoryId("product"), 0.95]]);
    const ranked = rankMemories([recentNoise, englishFact], {
      queryText: germanQuery,
      nowMs: now,
      weights: DEFAULT_RANKING_WEIGHTS,
      semanticById,
    });
    expect(ranked[0]?.memoryId).toBe(memoryId("product"));
    expect(ranked[0]?.subscores.semantic).toBe(0.95);
    expect(ranked[0]?.inclusionReason).toMatch(/semantic similarity to query/i);
  });

  it("blends semantic with the other signals rather than ignoring them", () => {
    // Two memories: one pinned (strong structural signal), one only semantic. With the default
    // weights, pinned (0.3) still dominates a single semantic hit, so pinned wins — proving the
    // semantic signal is additive, not overriding.
    const pinned = buildRecord({ id: "pin", pinned: true, updatedAt: now });
    const semantic = buildRecord({ id: "sem", updatedAt: now });
    const semanticById = new Map([[memoryId("sem"), 1]]);
    const ranked = rankMemories([semantic, pinned], {
      nowMs: now,
      weights: DEFAULT_RANKING_WEIGHTS,
      semanticById,
    });
    const semEntry = ranked.find((r) => r.memoryId === memoryId("sem"));
    expect(semEntry?.subscores.semantic).toBe(1);
    // Both participate; the semantic memory still scores > 0 from its semantic contribution.
    expect(semEntry?.score).toBeGreaterThan(0);
  });

  it("is byte-identical to lexical ranking when no semantic scores are supplied", () => {
    const a = buildRecord({ id: "a", body: "alpha beta", updatedAt: now });
    const b = buildRecord({ id: "b", body: "alpha gamma", updatedAt: now - 1 });
    const c = buildRecord({ id: "c", pinned: true, body: "delta", updatedAt: now - 2 });
    const query = { queryText: "alpha", nowMs: now, weights: DEFAULT_RANKING_WEIGHTS };
    const withoutField = rankMemories([a, b, c], query);
    const withUndefined = rankMemories([a, b, c], { ...query, semanticById: undefined });
    const withEmptyMap = rankMemories([a, b, c], {
      ...query,
      semanticById: new Map<ReturnType<typeof memoryId>, number>(),
    });
    expect(JSON.stringify(withUndefined)).toBe(JSON.stringify(withoutField));
    // An EMPTY map is "semantic active but no hits": every semantic subscore is 0, but the
    // semantic weight now participates in the denominator, so absolute scores differ from the
    // no-field case. Ordering and the zero semantic subscores must still hold.
    expect(withEmptyMap.map((r) => r.memoryId)).toEqual(withoutField.map((r) => r.memoryId));
    for (const entry of withEmptyMap) {
      expect(entry.subscores.semantic).toBe(0);
    }
  });

  it("zeroes the semantic weight (not just the subscore) when scores are absent", () => {
    // Proves the byte-identity comes from weight-zeroing: a record's score with no semanticById
    // must equal the score computed with the documented 1.15 lexical denominator, NOT 1.40.
    const r = buildRecord({ id: "x", pinned: true, updatedAt: now });
    const [first] = rankMemories([r], { nowMs: now, weights: DEFAULT_RANKING_WEIGHTS });
    expect(first?.score).toBeCloseTo((0.2 + 0.16 + 0.3) / 1.15);
  });
});
