import { describe, expect, it } from "vitest";

import { rankMemories, sourceImportance } from "./ranking.js";
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

  it("boosts accepted-correction provenance even when the durable type is semantic", () => {
    const correction = buildRecord({
      id: "correction-preference",
      type: "preference",
      sourceKind: "accepted-correction",
      body: "user prefers npm ci",
      updatedAt: now,
    });
    const [ranked] = rankMemories([correction], {
      queryText: "npm ci",
      nowMs: now,
      weights: DEFAULT_RANKING_WEIGHTS,
    });
    expect(ranked?.subscores.correction).toBe(1);
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
      strength: 0,
      // buildRecord defaults sourceKind to explicit-user-instruction => importance 1.
      importance: 1,
    });
  });

  it("normalizes exported scores into the documented [0, 1] range", () => {
    const r = buildRecord({ id: "x", pinned: true, updatedAt: now });
    const [first] = rankMemories([r], { nowMs: now, weights: DEFAULT_RANKING_WEIGHTS });
    expect(first?.score).toBeGreaterThanOrEqual(0);
    expect(first?.score).toBeLessThanOrEqual(1);
    expect(first?.score).toBeCloseTo((0.12 + 0.096 + 0.3 + 0.1) / 1.09);
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
    // must equal the score computed without the semantic denominator.
    const r = buildRecord({ id: "x", pinned: true, updatedAt: now });
    const [first] = rankMemories([r], { nowMs: now, weights: DEFAULT_RANKING_WEIGHTS });
    expect(first?.score).toBeCloseTo((0.12 + 0.096 + 0.3 + 0.1) / 1.09);
  });
});

describe("rankMemories — reinforcement strength subscore (#204 plasticity)", () => {
  it("is dormant by default: no strengthById => strength subscore 0 and the lexical denominator", () => {
    const r = buildRecord({ id: "x", pinned: true, updatedAt: now });
    const [first] = rankMemories([r], { nowMs: now, weights: DEFAULT_RANKING_WEIGHTS });
    expect(first?.subscores.strength).toBe(0);
    // The strength weight is zeroed alongside semantic, so the denominator stays the documented
    // non-semantic/non-strength default.
    // — supplying no strengthById must not perturb any legacy score.
    expect(first?.score).toBeCloseTo((0.12 + 0.096 + 0.3 + 0.1) / 1.09);
  });

  it("ranks a reused memory above an otherwise-identical never-accessed one", () => {
    const reused = buildRecord({ id: "reused", updatedAt: now });
    const fresh = buildRecord({ id: "fresh", updatedAt: now });
    const strengthById = new Map([[memoryId("reused"), 0.9]]);
    const ranked = rankMemories([fresh, reused], {
      nowMs: now,
      weights: DEFAULT_RANKING_WEIGHTS,
      strengthById,
    });
    expect(ranked[0]?.memoryId).toBe(memoryId("reused"));
    expect(ranked[0]?.subscores.strength).toBe(0.9);
    expect(ranked[1]?.subscores.strength).toBe(0);
    // CONTROL: with no strengthById the two are equal and fall back to the id tiebreak (fresh < reused),
    // proving the re-ordering above is the strength signal, not fixture chance.
    const control = rankMemories([fresh, reused], { nowMs: now, weights: DEFAULT_RANKING_WEIGHTS });
    expect(control[0]?.memoryId).toBe(memoryId("fresh"));
  });

  it("names reinforcement as the inclusion reason when strength dominates", () => {
    // Stale (low recency), bodyless, zero-confidence record so strength is the only live signal.
    const r = buildRecord({ id: "x", body: "", confidence: 0, updatedAt: now - 30 * 86_400_000 });
    const strengthById = new Map([[memoryId("x"), 1]]);
    const [first] = rankMemories([r], {
      nowMs: now,
      weights: DEFAULT_RANKING_WEIGHTS,
      strengthById,
    });
    expect(first?.inclusionReason).toContain("reinforced");
  });
});

describe("sourceImportance (#204, O-F5)", () => {
  it("ranks capture provenance by authority, descending", () => {
    expect(
      sourceImportance(buildRecord({ id: "a", sourceKind: "explicit-user-instruction" })),
    ).toBe(1);
    expect(sourceImportance(buildRecord({ id: "b", sourceKind: "accepted-correction" }))).toBe(
      0.85,
    );
    expect(sourceImportance(buildRecord({ id: "c", sourceKind: "workflow-outcome" }))).toBe(0.6);
    expect(sourceImportance(buildRecord({ id: "d", sourceKind: "consolidation" }))).toBe(0.5);
    expect(sourceImportance(buildRecord({ id: "e", sourceKind: "system-default" }))).toBe(0.4);
  });
});

describe("rankMemories — source-authority importance subscore (#204, O-F5)", () => {
  it("computes importance from provenance and contributes by default", () => {
    const r = buildRecord({ id: "x", pinned: true, updatedAt: now });
    const [first] = rankMemories([r], { nowMs: now, weights: DEFAULT_RANKING_WEIGHTS });
    expect(first?.subscores.importance).toBe(1);
    expect(first?.score).toBeCloseTo((0.12 + 0.096 + 0.3 + 0.1) / 1.09);
  });

  it("ranks a more-authoritative source above a passive one by default", () => {
    // ids chosen so a zero-importance control would put the LESS authoritative record first.
    const explicit = buildRecord({
      id: "zzz-explicit",
      sourceKind: "explicit-user-instruction",
      updatedAt: now,
    });
    const inferred = buildRecord({
      id: "aaa-inferred",
      sourceKind: "system-default",
      updatedAt: now,
    });
    const ranked = rankMemories([inferred, explicit], {
      nowMs: now,
      weights: DEFAULT_RANKING_WEIGHTS,
    });
    expect(ranked[0]?.memoryId).toBe(memoryId("zzz-explicit"));
    expect(ranked[0]?.subscores.importance).toBe(1);
    // CONTROL: at importance weight 0 the two tie and fall back to the id order, surfacing the
    // inferred record first — proving the re-order above is the importance signal.
    const control = rankMemories([inferred, explicit], {
      nowMs: now,
      weights: { ...DEFAULT_RANKING_WEIGHTS, importance: 0 },
    });
    expect(control[0]?.memoryId).toBe(memoryId("aaa-inferred"));
  });
});

describe("rankMemories — RRF fusion (#204, O-F2)", () => {
  const onlyRelevanceRecency = {
    ...DEFAULT_RANKING_WEIGHTS,
    confidence: 0,
    pinned: 0,
    correction: 0,
    graph: 0,
    semantic: 0,
    strength: 0,
    importance: 0,
    relevance: 1,
    recency: 1,
  };

  it("explicit fusion 'weighted-sum' is identical to the default (omitted) fusion", () => {
    const a = buildRecord({ id: "a", body: "alpha beta", updatedAt: now });
    const b = buildRecord({ id: "b", body: "alpha gamma", updatedAt: now - 1 });
    const base = { queryText: "alpha", nowMs: now, weights: DEFAULT_RANKING_WEIGHTS } as const;
    const def = rankMemories([a, b], base);
    const explicit = rankMemories([a, b], { ...base, fusion: "weighted-sum" });
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(def));
  });

  it("RRF with no positive-weight signals falls back to the rank sort (full tie breaks on id asc)", () => {
    // All weights zero => no RRF signals => the early return path; the weighted sum is also 0 for
    // every entry, so the two records tie on score AND updatedAt and the comparator's id tiebreak
    // decides the order (z after a).
    const zeroWeights = {
      ...DEFAULT_RANKING_WEIGHTS,
      relevance: 0,
      recency: 0,
      confidence: 0,
      pinned: 0,
      correction: 0,
      graph: 0,
      semantic: 0,
      strength: 0,
      importance: 0,
    };
    const z = buildRecord({ id: "z", body: "x", updatedAt: now });
    const a = buildRecord({ id: "a", body: "x", updatedAt: now });
    const out = rankMemories([z, a], {
      queryText: "x",
      nowMs: now,
      weights: zeroWeights,
      fusion: "rrf",
    });
    expect(out.map((e) => String(e.memoryId))).toEqual(["a", "z"]);
    expect(out.every((e) => e.score === 0)).toBe(true);
  });

  it("is deterministic and returns every memory", () => {
    const a = buildRecord({ id: "a", body: "alpha beta", updatedAt: now });
    const b = buildRecord({ id: "b", body: "gamma", updatedAt: now - 10 });
    const c = buildRecord({ id: "c", body: "alpha", updatedAt: now - 5 });
    const q = {
      queryText: "alpha",
      nowMs: now,
      weights: onlyRelevanceRecency,
      fusion: "rrf",
    } as const;
    const r1 = rankMemories([a, b, c], q);
    const r2 = rankMemories([a, b, c], q);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
    expect(new Set(r1.map((e) => String(e.memoryId)))).toEqual(new Set(["a", "b", "c"]));
  });

  it("a memory ranked first in every positive-weight signal scores 1.0 and leads", () => {
    // dominant matches the query (rank 1 relevance) and is the most recent (rank 1 recency).
    const dominant = buildRecord({ id: "dominant", body: "alpha topic", updatedAt: now });
    const other = buildRecord({ id: "other", body: "unrelated", updatedAt: now - 30 * 86_400_000 });
    const ranked = rankMemories([other, dominant], {
      queryText: "alpha",
      nowMs: now,
      weights: onlyRelevanceRecency,
      fusion: "rrf",
    });
    expect(ranked[0]?.memoryId).toBe(memoryId("dominant"));
    expect(ranked[0]?.score).toBeCloseTo(1, 10);
    expect(ranked[1]?.memoryId).toBe(memoryId("other"));
    // normalized RRF keeps every score within [0,1].
    for (const e of ranked) {
      expect(e.score).toBeGreaterThanOrEqual(0);
      expect(e.score).toBeLessThanOrEqual(1);
    }
  });
});
