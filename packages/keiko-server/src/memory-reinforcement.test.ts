import { describe, expect, it } from "vitest";
import type { MemoryId } from "@oscharko-dev/keiko-contracts";
import type { IncludedMemory, IncludedSubscores } from "@oscharko-dev/keiko-memory-retrieval";
import { reinforcementAccessIds } from "./memory-reinforcement.js";

const ZERO: IncludedSubscores = {
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

function included(id: string, subscores: Partial<IncludedSubscores>): IncludedMemory {
  return {
    memoryId: id as MemoryId,
    score: 1,
    inclusionReason: "test",
    subscores: { ...ZERO, ...subscores },
  };
}

describe("reinforcementAccessIds", () => {
  it("records access only for lexical or semantic hits", () => {
    expect(
      reinforcementAccessIds([
        included("lexical", { relevance: 0.2 }),
        included("semantic", { semantic: 0.3 }),
        included("graph-only", { graph: 1 }),
        included("strength-only", { strength: 1 }),
      ]),
    ).toEqual(["lexical", "semantic"]);
  });

  it("respects an explicit semantic floor", () => {
    expect(
      reinforcementAccessIds(
        [included("below", { semantic: 0.4 }), included("above", { semantic: 0.6 })],
        0.5,
      ),
    ).toEqual(["above"]);
  });
});
