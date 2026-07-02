import { describe, expect, it } from "vitest";
import type { MemoryId } from "@oscharko-dev/keiko-contracts";
import type { IncludedMemory, IncludedSubscores } from "@oscharko-dev/keiko-memory-retrieval";
import {
  reinforcementAccessIds,
  reinforcementAccessIdsForAssistantUse,
} from "./memory-reinforcement.js";

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
  it("records access only for strong lexical or semantic hits", () => {
    expect(
      reinforcementAccessIds([
        included("weak-lexical", { relevance: 0.05 }),
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

  it("caps per-turn inclusion reinforcement", () => {
    expect(
      reinforcementAccessIds(
        [
          included("a", { relevance: 0.9 }),
          included("b", { relevance: 0.8 }),
          included("c", { relevance: 0.7 }),
          included("d", { relevance: 0.6 }),
        ],
        0.5,
        2,
      ),
    ).toEqual(["a", "b"]);
  });
});

function blockEntry(id: string, bodyExcerpt: string): { memoryId: MemoryId; bodyExcerpt: string } {
  return { memoryId: id as MemoryId, bodyExcerpt };
}

describe("reinforcementAccessIdsForAssistantUse", () => {
  it("records access only when the assistant response uses distinctive recalled content", () => {
    expect(
      reinforcementAccessIdsForAssistantUse(
        [
          blockEntry("used", "Use pnpm instead of npm for installs."),
          blockEntry("unused", "The user prefers compact terminal prompts."),
        ],
        "Use pnpm instead of npm for the install command.",
      ),
    ).toEqual(["used"]);
  });

  it("allows a short identity answer when the memory has few distinctive tokens", () => {
    expect(
      reinforcementAccessIdsForAssistantUse(
        [blockEntry("name", "The user's name is Paul.")],
        "Paul",
      ),
    ).toEqual(["name"]);
  });

  it("caps demonstrated-use reinforcement", () => {
    expect(
      reinforcementAccessIdsForAssistantUse(
        [
          blockEntry("a", "The deploy target is staging-alpha."),
          blockEntry("b", "The editor theme is solarized-light."),
          blockEntry("c", "The shell profile is zsh-prod."),
        ],
        "Use staging-alpha with solarized-light and zsh-prod.",
        2,
      ),
    ).toEqual(["a", "b"]);
  });
});
