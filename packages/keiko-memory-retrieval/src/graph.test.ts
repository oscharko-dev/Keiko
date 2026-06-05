import { describe, expect, it } from "vitest";

import { graphProximityScore } from "./graph.js";
import { buildEdge, memoryId } from "./_support.js";

describe("graphProximityScore", () => {
  it("returns 0 when the memory has no edges in the map", () => {
    const score = graphProximityScore(memoryId("m1"), new Map(), new Set());
    expect(score).toBe(0);
  });

  it("returns 0 when no connected memory is in the highRank set", () => {
    const edges = [buildEdge({ from: "m1", to: "m2", kind: "related" })];
    const map = new Map([[memoryId("m1"), edges]]);
    const score = graphProximityScore(memoryId("m1"), map, new Set());
    expect(score).toBe(0);
  });

  it("returns a positive boost when a connected memory IS in highRank", () => {
    const edges = [buildEdge({ from: "m1", to: "m2", kind: "related" })];
    const map = new Map([[memoryId("m1"), edges]]);
    const score = graphProximityScore(memoryId("m1"), map, new Set<string>([memoryId("m2")]));
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("only counts edges of kinds related|supersedes|corrects", () => {
    const edges = [
      buildEdge({ from: "m1", to: "m2", kind: "conflicts-with" }),
      buildEdge({ from: "m1", to: "m3", kind: "temporal-precedes" }),
      buildEdge({ from: "m1", to: "m4", kind: "derived-from" }),
    ];
    const map = new Map([[memoryId("m1"), edges]]);
    const highRank = new Set<string>([memoryId("m2"), memoryId("m3"), memoryId("m4")]);
    expect(graphProximityScore(memoryId("m1"), map, highRank)).toBe(0);
  });

  it("score saturates near 1.0 as connection count grows", () => {
    const targets = ["m2", "m3", "m4", "m5", "m6", "m7"] as const;
    const edges = targets.map((t) => buildEdge({ from: "m1", to: t, kind: "related" }));
    const map = new Map([[memoryId("m1"), edges]]);
    const highRank = new Set<string>(targets.map((t) => memoryId(t)));
    const score = graphProximityScore(memoryId("m1"), map, highRank);
    expect(score).toBeGreaterThan(0.8);
    expect(score).toBeLessThanOrEqual(1);
  });
});
