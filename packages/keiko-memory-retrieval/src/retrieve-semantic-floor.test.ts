import type { MemoryId } from "@oscharko-dev/keiko-contracts/memory";
import { describe, expect, it } from "vitest";

import { retrieveMemoryContext } from "./retrieve.js";
import type { MemoryQueryPort, MemoryRetrievalRequest } from "./types.js";
import { buildRecord, memoryId, userScope } from "./_support.js";

// Measured 2026-11-19 with qwen3-embedding-8b in the product's own format (question with the
// instruction, memory raw): the lowest memory an answer needs scores 0.461 and shares no word with
// the question; the highest unrelated memory scores 0.410, and four unrelated memories of one probe
// (0.404 to 0.410) lie above the floor of 0.40 by design: the floor sits at the low end of the gap.
const NOW = 7 * 86_400_000;
const QUESTION = "Wie heißt mein Team?";
const NEEDED: readonly [string, number] = ["needed", 0.461];
const REFUSED_AT_040: readonly (readonly [string, number])[] = [
  ["hobby", 0.311],
  ["food", 0.391],
];
const ADMITTED_AT_040: readonly (readonly [string, number])[] = [
  ["peer-a", 0.404],
  ["peer-b", 0.41],
];

function fixture(): {
  readonly port: MemoryQueryPort;
  readonly semantic: ReadonlyMap<MemoryId, number>;
} {
  const scores = [NEEDED, ...REFUSED_AT_040, ...ADMITTED_AT_040];
  const records = scores.map(([id]) =>
    buildRecord({
      id,
      body: id === "needed" ? "Die Gruppe heißt Atlas." : `Notiz ${id} über etwas anderes.`,
      status: "accepted",
    }),
  );
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
  return retrieveMemoryContext(request(semantic, floor), port)
    .included.map((entry) => entry.memoryId as string)
    .sort();
}

const ids = (pairs: readonly (readonly [string, number])[]): string[] => pairs.map(([id]) => id);

describe("calibrated semantic floor (#4228)", () => {
  it("the default floor of 0.30 supplies every unrelated memory", () => {
    expect(includedIds(0.3)).toEqual(
      [NEEDED[0], ...ids(REFUSED_AT_040), ...ids(ADMITTED_AT_040)].sort(),
    );
  });

  it("an omitted floor behaves exactly like 0.30", () => {
    expect(includedIds(undefined)).toEqual(includedIds(0.3));
  });

  it("the Qwen3-8B floor of 0.40 keeps the needed memory and refuses the unrelated ones below it", () => {
    const supplied = includedIds(0.4);
    expect(supplied).toContain(NEEDED[0]);
    for (const id of ids(REFUSED_AT_040)) expect(supplied).not.toContain(id);
  });

  it("documents the limit: unrelated memories between 0.40 and 0.410 still pass 0.40", () => {
    expect(includedIds(0.4)).toEqual([NEEDED[0], ...ids(ADMITTED_AT_040)].sort());
  });

  it("a floor of 0.42 would supply the needed memory alone", () => {
    expect(includedIds(0.42)).toEqual([NEEDED[0]]);
  });
});
