import type { MemoryId } from "@oscharko-dev/keiko-contracts/memory";
import { describe, expect, it } from "vitest";

import { retrieveMemoryContext } from "./retrieve.js";
import type { MemoryQueryPort, MemoryRetrievalRequest } from "./types.js";
import { buildRecord, memoryId, userScope } from "./_support.js";

// Measured 2026-11-19 with qwen3-embedding-8b in the product's own format (question with the
// instruction, memory raw): the needed memories score 0.461 at the lowest, unrelated memories of
// another topic 0.311 to 0.391, loosely related ones of the same domain 0.400 to 0.480. A floor of
// 0.30 therefore admits unrelated memories; 0.42 admits none and keeps every needed one.
const NOW = 7 * 86_400_000;
const QUESTION = "Wie heißt mein Team?";
const UNRELATED_SCORES: readonly (readonly [string, number])[] = [
  ["hobby", 0.311],
  ["pet", 0.34],
  ["commute", 0.367],
  ["food", 0.391],
  ["domain-peer", 0.41],
];

function fixture(): {
  readonly port: MemoryQueryPort;
  readonly semantic: ReadonlyMap<MemoryId, number>;
} {
  const records = [
    buildRecord({ id: "needed", body: "Die Gruppe heißt Atlas.", status: "accepted" }),
    ...UNRELATED_SCORES.map(([id]) =>
      buildRecord({ id, body: `Notiz ${id} über etwas anderes.`, status: "accepted" }),
    ),
  ];
  const scores: readonly (readonly [string, number])[] = [["needed", 0.46], ...UNRELATED_SCORES];
  const semantic = new Map<MemoryId, number>(scores.map(([id, score]) => [memoryId(id), score]));
  return { port: { listByScope: () => records }, semantic };
}

function request(
  semantic: ReadonlyMap<MemoryId, number>,
  semanticMinScore?: number,
): MemoryRetrievalRequest {
  return {
    scopes: [userScope()],
    nowMs: NOW,
    queryText: QUESTION,
    strictRelevanceFloor: true,
    semanticById: semantic,
    ...(semanticMinScore === undefined ? {} : { semanticMinScore }),
  };
}

function includedIds(floor: number | undefined): string[] {
  const { port, semantic } = fixture();
  return retrieveMemoryContext(request(semantic, floor), port).included.map(
    (entry) => entry.memoryId,
  );
}

describe("calibrated semantic floor (#4228)", () => {
  it("the default floor of 0.30 supplies unrelated memories", () => {
    const ids = includedIds(0.3);
    expect(ids).toContain("needed");
    for (const [id] of UNRELATED_SCORES) expect(ids).toContain(id);
  });

  it("an omitted floor behaves exactly like 0.30", () => {
    expect(includedIds(undefined)).toEqual(includedIds(0.3));
  });

  it("the Qwen3 floor of 0.42 supplies the needed memory and no unrelated one", () => {
    expect(includedIds(0.42)).toEqual(["needed"]);
  });
});
