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
    });
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
