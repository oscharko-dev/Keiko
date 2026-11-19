import { describe, expect, it, vi } from "vitest";

import { buildRankBySignal, rankMemories, sourceImportance } from "./ranking.js";
import { DEFAULT_RANKING_WEIGHTS, type IncludedSubscores } from "./types.js";
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

describe("buildRankBySignal — tie-aware fractional ranks", () => {
  // All roles fixed except the one signal under test, so every pair is tied on it and shares one rank.
  function tiedSubscores(relevance: number): IncludedSubscores {
    return {
      relevance,
      recency: 0,
      confidence: 0,
      pinned: 0,
      correction: 0,
      graph: 0,
      semantic: 0,
      strength: 0,
      importance: 0,
    };
  }

  it("loads each candidate's subscores once across all active signals", () => {
    const records = Array.from({ length: 16 }, (_, i) =>
      buildRecord({ id: String(i), updatedAt: now }),
    );
    const subscores = new Map(records.map((record, i) => [record.id, tiedSubscores(i % 3)]));
    const get = vi.spyOn(subscores, "get");
    const ranks = buildRankBySignal(records, subscores, ["relevance", "recency", "importance"]);
    expect(ranks.get("relevance")?.size).toBe(records.length);
    expect(get).toHaveBeenCalledTimes(records.length);
  });

  it("gives equal subscores one shared mean rank, whatever the ids and the input order", () => {
    // Scrambled input order and ids: a tie must never be broken by id (#4228). Three tied records
    // occupy positions 1..3, so each gets the mean rank 2.
    const c = buildRecord({ id: "c", updatedAt: now });
    const a = buildRecord({ id: "a", updatedAt: now });
    const b = buildRecord({ id: "b", updatedAt: now });
    const subscoresById = new Map([
      [memoryId("a"), tiedSubscores(5)],
      [memoryId("b"), tiedSubscores(5)],
      [memoryId("c"), tiedSubscores(5)],
    ]);
    const rankBySignal = buildRankBySignal([c, a, b], subscoresById, ["relevance"]);
    const ranks = rankBySignal.get("relevance");
    expect(ranks?.get(memoryId("a"))).toBe(2);
    expect(ranks?.get(memoryId("b"))).toBe(2);
    expect(ranks?.get(memoryId("c"))).toBe(2);
  });

  it("ranks a tied group at the mean of its positions between distinct values", () => {
    const records = ["w", "x", "y", "z"].map((id) => buildRecord({ id, updatedAt: now }));
    const subscoresById = new Map([
      [memoryId("w"), tiedSubscores(0.2)],
      [memoryId("x"), tiedSubscores(0.9)],
      [memoryId("y"), tiedSubscores(0.2)],
      [memoryId("z"), tiedSubscores(0.5)],
    ]);
    const ranks = buildRankBySignal(records, subscoresById, ["relevance"]).get("relevance");
    expect(ranks?.get(memoryId("x"))).toBe(1);
    expect(ranks?.get(memoryId("z"))).toBe(2);
    expect(ranks?.get(memoryId("w"))).toBe(3.5);
    expect(ranks?.get(memoryId("y"))).toBe(3.5);
  });

  it("ranks a duplicated id once, as a tied pair, without throwing", () => {
    // A data-integrity edge case (duplicate id), not a normal caller shape: both entries share the
    // same id and subscore, so they are tied (positions 1..2, mean rank 1.5) under the shared key.
    const first = buildRecord({ id: "dup", updatedAt: now });
    const second = buildRecord({ id: "dup", updatedAt: now });
    const subscoresById = new Map([[memoryId("dup"), tiedSubscores(5)]]);
    const rankBySignal = buildRankBySignal([first, second], subscoresById, ["relevance"]);
    expect(rankBySignal.get("relevance")?.get(memoryId("dup"))).toBe(1.5);
  });
});

describe("rankMemories — RRF fusion keeps the intended signals decisive (#4228)", () => {
  // The unpinned records have the SMALLEST ids, so an id-ordered tie-break would put them first.
  const crowd = Array.from({ length: 40 }, (_, i) =>
    buildRecord({ id: `a${String(i).padStart(2, "0")}`, body: "plain note", updatedAt: now }),
  );
  const query = { nowMs: now, weights: DEFAULT_RANKING_WEIGHTS, fusion: "rrf" } as const;

  it("ranks a pinned memory first among otherwise-equal memories with smaller ids", () => {
    const pinned = buildRecord({ id: "zzz", body: "plain note", pinned: true, updatedAt: now });
    expect(rankMemories([...crowd, pinned], query)[0]?.memoryId).toBe(memoryId("zzz"));
  });

  it("ranks an accepted correction first among otherwise-equal memories with smaller ids", () => {
    const correction = buildRecord({
      id: "zzz",
      body: "plain note",
      type: "correction",
      sourceKind: "accepted-correction",
      updatedAt: now,
    });
    expect(rankMemories([...crowd, correction], query)[0]?.memoryId).toBe(memoryId("zzz"));
  });

  it("scores memories that differ only by id exactly alike, so ids break ties only", () => {
    const ranked = rankMemories(crowd, query);
    expect(new Set(ranked.map((e) => e.score)).size).toBe(1);
    expect(ranked.map((e) => e.memoryId)).toEqual(crowd.map((r) => r.id));
  });

  it("lets the semantically nearest memory beat the ids' order in a large store", () => {
    const semanticById = new Map(crowd.map((r, i) => [r.id, i === 39 ? 0.9 : 0.5]));
    const ranked = rankMemories(crowd, { ...query, semanticById });
    expect(ranked[0]?.memoryId).toBe(crowd[39]?.id);
  });

  it("names no signal in the inclusion reason when every subscore is zero", () => {
    const ranked = rankMemories([buildRecord({ id: "q", body: "plain note", confidence: 0 })], {
      ...query,
      weights: { ...DEFAULT_RANKING_WEIGHTS, recency: 0, importance: 0 },
    });
    expect(ranked[0]?.inclusionReason).toBe("included by default ranking");
  });
});

describe("rankMemories — the graph high-rank set never follows the id (#4228)", () => {
  const ID_DRAWS = 30;
  // Deterministic, distinct ids per draw (an LCG shuffle of 20 slots).
  function idsFor(draw: number): string[] {
    let state = draw * 7919 + 13;
    return Array.from({ length: 20 }, (_, slot) => {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      return `${state.toString(16).padStart(8, "0")}-${String(slot)}`;
    });
  }
  const link = (
    from: string,
    to: string,
  ): Map<ReturnType<typeof memoryId>, ReturnType<typeof buildEdge>[]> => {
    const edge = buildEdge({ from, to });
    return new Map([
      [memoryId(from), [edge]],
      [memoryId(to), [edge]],
    ]);
  };

  it.each(["weighted-sum", "rrf"] as const)(
    "gives a record the same graph subscore for every id draw when a tie straddles the cut (%s)",
    (fusion) => {
      const seen = new Set<number>();
      for (let draw = 0; draw < ID_DRAWS; draw += 1) {
        const ids = idsFor(draw);
        // 20 records of identical evidence; slot 0 is linked to slot 10; the cut (8) is inside the tie.
        const records = ids.map((id) => buildRecord({ id, body: "same note", updatedAt: now }));
        const ranked = rankMemories(
          records,
          { nowMs: now, weights: DEFAULT_RANKING_WEIGHTS, fusion },
          { edgesByMemory: link(ids[0] ?? "", ids[10] ?? "") },
        );
        const graph = ranked.find((e) => e.memoryId === ids[0])?.subscores.graph ?? -1;
        seen.add(graph);
      }
      expect([...seen]).toEqual([0]);
    },
  );

  it.each(["weighted-sum", "rrf"] as const)(
    "keeps the plain top-N set when no tie straddles the cut (%s)",
    (fusion) => {
      // Distinct recency => distinct scores. Top 3 (cut 3): r0, r1, r2. r5 links to r1 (in), r6 to r4 (out).
      const records = Array.from({ length: 8 }, (_, i) =>
        buildRecord({ id: `r${String(i)}`, body: "x", updatedAt: now - i * 86_400_000 }),
      );
      const edgeIn = buildEdge({ from: "r5", to: "r1" });
      const edgeOut = buildEdge({ from: "r6", to: "r4" });
      const edgesByMemory = new Map([
        [memoryId("r5"), [edgeIn]],
        [memoryId("r1"), [edgeIn]],
        [memoryId("r6"), [edgeOut]],
        [memoryId("r4"), [edgeOut]],
      ]);
      const ranked = rankMemories(
        records,
        { nowMs: now, weights: DEFAULT_RANKING_WEIGHTS, fusion },
        { edgesByMemory, graphHighRankCount: 3 },
      );
      const graph = (id: string): number =>
        ranked.find((e) => e.memoryId === id)?.subscores.graph ?? -1;
      expect(graph("r5")).toBe(0.5); // neighbour r1 is inside the top 3
      expect(graph("r6")).toBe(0); // neighbour r4 is outside
      expect(graph("r1")).toBe(0); // r5 is outside
    },
  );

  it("keeps a tied group that lies wholly inside the top-N in the set", () => {
    // r0 and r1 tie at the top (same updatedAt), r2.. are older; cut 3 does not split the r0/r1 tie.
    const records = [
      buildRecord({ id: "r0", body: "x", updatedAt: now }),
      buildRecord({ id: "r1", body: "x", updatedAt: now }),
      buildRecord({ id: "r2", body: "x", updatedAt: now - 86_400_000 }),
      buildRecord({ id: "r3", body: "x", updatedAt: now - 2 * 86_400_000 }),
      buildRecord({ id: "r9", body: "x", updatedAt: now - 3 * 86_400_000 }),
    ];
    const edge = buildEdge({ from: "r9", to: "r0" });
    const edgesByMemory = new Map([
      [memoryId("r9"), [edge]],
      [memoryId("r0"), [edge]],
    ]);
    const ranked = rankMemories(
      records,
      { nowMs: now, weights: DEFAULT_RANKING_WEIGHTS },
      { edgesByMemory, graphHighRankCount: 3 },
    );
    expect(ranked.find((e) => e.memoryId === "r9")?.subscores.graph).toBe(0.5);
  });
});

describe("rankMemories — which entries stay in the graph high-rank set (audit B2)", () => {
  const DAY = 86_400_000;
  function edgeMap(
    pairs: readonly (readonly [string, string])[],
  ): Map<ReturnType<typeof memoryId>, ReturnType<typeof buildEdge>[]> {
    const map = new Map<ReturnType<typeof memoryId>, ReturnType<typeof buildEdge>[]>();
    for (const [from, to] of pairs) {
      const edge = buildEdge({ from, to });
      for (const id of [from, to]) map.set(memoryId(id), [...(map.get(memoryId(id)) ?? []), edge]);
    }
    return map;
  }
  const graphOf = (ranked: ReturnType<typeof rankMemories>, id: string): number =>
    ranked.find((e) => e.memoryId === id)?.subscores.graph ?? -1;
  const rec = (id: string, ageDays: number): ReturnType<typeof buildRecord> =>
    buildRecord({ id, body: "x", updatedAt: now - ageDays * DAY });

  it.each(["weighted-sum", "rrf"] as const)(
    "keeps the distinct records above a straddling tie and drops only the tied group (%s)",
    (fusion) => {
      // u1, u2 are distinct and newest; g1..g3 tie (same score and updatedAt) below them; the cut of 3
      // ends inside that tie. n1..n3 are far older, each linked to one of u1, g1, g3.
      const records = [
        rec("u1", 0),
        rec("u2", 1),
        rec("g1", 3),
        rec("g2", 3),
        rec("g3", 3),
        rec("n1", 10),
        rec("n2", 11),
        rec("n3", 12),
      ];
      const edgesByMemory = edgeMap([
        ["n1", "u1"],
        ["n2", "g1"],
        ["n3", "g3"],
      ]);
      const ranked = rankMemories(
        records,
        { nowMs: now, weights: DEFAULT_RANKING_WEIGHTS, fusion },
        { edgesByMemory, graphHighRankCount: 3 },
      );
      expect(graphOf(ranked, "n1")).toBe(0.5); // neighbour of a distinct record keeps its score
      expect(graphOf(ranked, "n2")).toBe(0); // neighbours of group members get nothing
      expect(graphOf(ranked, "n3")).toBe(0);
    },
  );

  it.each(["weighted-sum", "rrf"] as const)(
    "keeps the plain top N when the tied scores differ in updatedAt across the cut (%s)",
    (fusion) => {
      // Recency weighted to 0: every score is equal, the sort falls to updatedAt, which differs at the
      // cut, so the order is decided by evidence and not by the id and the plain top 2 stays.
      const records = [rec("r0", 0), rec("r1", 1), rec("r2", 2), rec("r3", 3), rec("r4", 4)];
      const ranked = rankMemories(
        records,
        { nowMs: now, weights: { ...DEFAULT_RANKING_WEIGHTS, recency: 0 }, fusion },
        { edgesByMemory: edgeMap([["r4", "r1"]]), graphHighRankCount: 2 },
      );
      expect(graphOf(ranked, "r4")).toBe(0.5);
    },
  );

  it("keeps every record when the count reaches the number of records, even all tied", () => {
    const records = ["a", "b", "c"].map((id) => rec(id, 0));
    for (const count of [3, 10]) {
      const ranked = rankMemories(
        records,
        { nowMs: now, weights: DEFAULT_RANKING_WEIGHTS },
        { edgesByMemory: edgeMap([["a", "b"]]), graphHighRankCount: count },
      );
      expect(graphOf(ranked, "a")).toBe(0.5);
      expect(graphOf(ranked, "b")).toBe(0.5);
    }
  });

  it("keeps no record when the count is 0", () => {
    const ranked = rankMemories(
      [rec("a", 0), rec("b", 1)],
      { nowMs: now, weights: DEFAULT_RANKING_WEIGHTS },
      { edgesByMemory: edgeMap([["a", "b"]]), graphHighRankCount: 0 },
    );
    expect(graphOf(ranked, "a")).toBe(0);
    expect(graphOf(ranked, "b")).toBe(0);
  });
});

describe("rankMemories — non-finite subscores say nothing (#4228)", () => {
  it("does not let a NaN or infinite semantic score reorder the other records", () => {
    const records = ["a", "b", "c", "d"].map((id) =>
      buildRecord({ id, body: "x", updatedAt: now }),
    );
    const clean = new Map([
      [memoryId("a"), 0.2],
      [memoryId("b"), 0.9],
      [memoryId("c"), 0.5],
      [memoryId("d"), 0],
    ]);
    const base = { nowMs: now, weights: DEFAULT_RANKING_WEIGHTS, fusion: "rrf" } as const;
    const expected = rankMemories(records, { ...base, semanticById: clean }).map((e) => e.memoryId);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const dirty = new Map(clean).set(memoryId("d"), bad);
      const ranked = rankMemories(records, { ...base, semanticById: dirty });
      expect(ranked.map((e) => e.memoryId)).toEqual(expected);
      expect(ranked.every((e) => Number.isFinite(e.score))).toBe(true);
    }
  });

  // B1 of the audit: the guarantee holds on every path, not only inside the rank building. A
  // non-finite subscore is sanitised where the subscores are produced, so the weighted sum, the
  // baseline that selects the graph high-rank set and the returned subscores all see a plain 0.
  describe("on every path (sanitised where the subscores are produced)", () => {
    const ids = ["a", "b", "c", "d"];
    const semantic = (b: number): Map<ReturnType<typeof memoryId>, number> =>
      new Map([
        [memoryId("a"), 0.9],
        [memoryId("b"), b],
        [memoryId("c"), 0.5],
        [memoryId("d"), 0.1],
      ]);
    const recordsFor = (order: readonly string[]): ReturnType<typeof buildRecord>[] =>
      order.map((id) => buildRecord({ id, body: "x", updatedAt: now }));

    it.each(["weighted-sum", "rrf"] as const)(
      "scores, orders and reports a NaN semantic subscore exactly as a 0 (%s)",
      (fusion) => {
        const base = { nowMs: now, weights: DEFAULT_RANKING_WEIGHTS, fusion } as const;
        const dirty = rankMemories(recordsFor(ids), { ...base, semanticById: semantic(NaN) });
        const zero = rankMemories(recordsFor(ids), { ...base, semanticById: semantic(0) });
        expect(dirty).toEqual(zero);
        const entry = dirty.find((e) => e.memoryId === "b");
        expect(entry?.subscores.semantic).toBe(0);
        expect(Number.isFinite(entry?.score)).toBe(true);
      },
    );

    it.each(["weighted-sum", "rrf"] as const)(
      "does not let the input order change a graph score next to a NaN record (%s)",
      (fusion) => {
        // Cut 2: the NaN record would sit inside or outside depending on the input order of an
        // inconsistent sort. Its neighbour must score the same for every order.
        const edge = buildEdge({ from: "n", to: "b" });
        const edgesByMemory = new Map([
          [memoryId("n"), [edge]],
          [memoryId("b"), [edge]],
        ]);
        const all = [...ids, "n"];
        const query = {
          nowMs: now,
          weights: DEFAULT_RANKING_WEIGHTS,
          fusion,
          semanticById: new Map([...semantic(NaN), [memoryId("n"), 0.2]]),
        } as const;
        const options = { edgesByMemory, graphHighRankCount: 2 };
        const forward = rankMemories(recordsFor(all), query, options);
        const reversed = rankMemories(recordsFor([...all].reverse()), query, options);
        expect(reversed).toEqual(forward);
        // b counts as 0 semantic and is low-ranked, so it is outside the set and n gets no graph score.
        expect(forward.find((e) => e.memoryId === "n")?.subscores.graph).toBe(0);
      },
    );
  });
});
