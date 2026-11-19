import type { MemoryId, MemoryRecord } from "@oscharko-dev/keiko-contracts/memory";
import { describe, expect, it } from "vitest";

import { retrieveMemoryContext } from "./retrieve.js";
import type { MemoryQueryPort, MemoryRetrievalRequest, RankingFusionMode } from "./types.js";
import { buildEdge, buildRecord, memoryId, userScope } from "./_support.js";

// The order of the memories a question admits depends on those memories alone (#4228): records the
// floor removes must not decide it. Ranked over the whole read window, the hundreds of unrelated
// records between two admitted memories in recency turned a small recency difference into a lead
// the semantic order could not outweigh (lab: long-horizon-distractors-en room and
// long-horizon-oft-genutzt-en caterer, the needed memory at position 7 or later).
const DAY = 86_400_000;
const NOW = 400 * DAY;
const QUESTION = "Which room is the audit review in?";

function admittedRecord(id: string, ageDays: number): MemoryRecord {
  return buildRecord({
    id,
    body: `Note ${id} about the quarterly planning.`,
    updatedAt: NOW - ageDays * DAY,
    createdAt: NOW - ageDays * DAY,
  });
}

function unrelatedRecords(count: number, fromDays: number, toDays: number): MemoryRecord[] {
  return Array.from({ length: count }, (_, index) => {
    const ageDays = fromDays + ((toDays - fromDays) * (index + 1)) / (count + 1);
    return buildRecord({
      id: `u${String(index)}`,
      body: `Unrelated entry number ${String(index)} on gardening.`,
      updatedAt: NOW - ageDays * DAY,
      createdAt: NOW - ageDays * DAY,
    });
  });
}

// Ten admitted memories: the semantic order runs a0 (closest) .. a9, the recency order the other
// way round (a0 is the oldest). Between consecutive admitted memories in recency lie the unrelated
// records the floor removes.
const ADMITTED = Array.from({ length: 10 }, (_, index) =>
  admittedRecord(`a${String(index)}`, 300 - index * 30),
);
const SEMANTIC = new Map<MemoryId, number>(
  ADMITTED.map((record, index) => [record.id, 0.9 - index * 0.04]),
);

function supplied(
  records: readonly MemoryRecord[],
  fusion: RankingFusionMode,
  overrides: Partial<MemoryRetrievalRequest> = {},
): string[] {
  return retrieveMemoryContext(
    {
      scopes: [userScope()],
      nowMs: NOW,
      queryText: QUESTION,
      strictRelevanceFloor: true,
      semanticById: SEMANTIC,
      semanticMinScore: 0.4,
      maxIncluded: 6,
      fusion,
      ...overrides,
    },
    { listByScope: () => records },
  ).included.map((entry) => entry.memoryId);
}

describe("rank fusion over the admitted memories (#4228)", () => {
  for (const fusion of ["rrf", "weighted-sum"] as const) {
    it(`${fusion}: records the floor removes do not change which memories are supplied, or their order`, () => {
      const alone = supplied(ADMITTED, fusion);
      const crowded = supplied([...ADMITTED, ...unrelatedRecords(400, 0, 310)], fusion);
      expect(alone).toHaveLength(6);
      expect(crowded).toEqual(alone);
    });
  }

  it("rrf: the six closest memories are supplied in semantic order, though they are the oldest", () => {
    // Ranked over the window, the 400 newer unrelated records pushed the recency rank of the
    // closest (and oldest) memories past 300, and the two farthest, newest ones took their place.
    const crowded = supplied([...ADMITTED, ...unrelatedRecords(400, 0, 310)], "rrf");
    expect(crowded).toEqual(["a0", "a1", "a2", "a3", "a4", "a5"]);
  });

  // A wrong repair that ordered the admitted memories by similarity alone would pass the tests
  // above; the signals that do not depend on the question still order the memories the question
  // admitted, now among themselves.
  it("rrf: of two almost equally close memories the pinned and newer one comes first", () => {
    const close = [
      buildRecord({ id: "plain", body: "Note on planning.", updatedAt: NOW - DAY }),
      buildRecord({ id: "kept", body: "Note on budgets.", updatedAt: NOW, pinned: true }),
    ];
    const ids = retrieveMemoryContext(
      {
        scopes: [userScope()],
        nowMs: NOW,
        queryText: QUESTION,
        strictRelevanceFloor: true,
        semanticById: new Map([
          [memoryId("plain"), 0.81],
          [memoryId("kept"), 0.8],
        ]),
        semanticMinScore: 0.4,
        fusion: "rrf",
      },
      { listByScope: () => [...close, ...unrelatedRecords(50, 0, 10)] },
    ).included.map((entry) => entry.memoryId);
    expect(ids).toEqual(["kept", "plain"]);
  });

  it("control: the unrelated records are removed by the floor, not supplied", () => {
    const crowded = supplied([...ADMITTED, ...unrelatedRecords(400, 0, 310)], "rrf", {
      maxIncluded: 50,
    });
    expect(crowded.filter((id) => id.startsWith("u"))).toEqual([]);
    expect(crowded).toHaveLength(ADMITTED.length);
  });

  it("control: with nothing removed the order is the plain fused order (a single ranking)", () => {
    const ids = supplied(ADMITTED, "rrf", { maxIncluded: 10 });
    expect([...ids].sort()).toEqual(ADMITTED.map((record) => record.id).sort());
    expect(new Set(ids).size).toBe(ADMITTED.length);
  });

  // The lenient floor also admits by graph proximity, which refers to the window's top memories:
  // there the order stays the window ranking, so a memory admitted by its graph score keeps it.
  it("lenient floor: a memory admitted by graph proximity alone keeps its graph score", () => {
    const anchor = buildRecord({ id: "anchor", body: "Fresh note on gardening.", updatedAt: NOW });
    const linked = buildRecord({
      id: "linked",
      body: "Old note on weather.",
      updatedAt: NOW - 300 * DAY,
    });
    const match = buildRecord({
      id: "match",
      body: "The audit review is in room Willow.",
      updatedAt: NOW - 200 * DAY,
    });
    const newer = unrelatedRecords(10, 1, 100);
    const port: MemoryQueryPort = {
      listByScope: () => [anchor, linked, match, ...newer],
      listIncomingEdges: (id) =>
        id === memoryId("linked") ? [buildEdge({ from: "anchor", to: "linked" })] : [],
    };
    const result = retrieveMemoryContext(
      { scopes: [userScope()], nowMs: NOW, queryText: QUESTION, maxIncluded: 6, budgetTokens: 500 },
      port,
    );
    const ids = result.included.map((entry) => entry.memoryId);
    // Not vacuous: the anchor the graph score refers to is refused, the match is admitted.
    expect(ids).not.toContain("anchor");
    expect(ids).toContain("match");
    const entry = result.included.find((included) => included.memoryId === memoryId("linked"));
    expect(entry?.subscores.graph).toBeGreaterThan(0);
  });
});
