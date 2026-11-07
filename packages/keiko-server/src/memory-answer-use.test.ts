import { describe, expect, it } from "vitest";
import type { MemoryId } from "@oscharko-dev/keiko-contracts";
import { memoriesUsedInAnswer } from "./memory-answer-use.js";

function blockEntry(id: string, bodyExcerpt: string): { memoryId: MemoryId; bodyExcerpt: string } {
  return { memoryId: id as MemoryId, bodyExcerpt };
}

describe("memoriesUsedInAnswer", () => {
  it("names a memory only when the answer uses its distinctive content", () => {
    expect(
      memoriesUsedInAnswer(
        [
          blockEntry("used", "Use pnpm instead of npm for installs."),
          blockEntry("unused", "The user prefers compact terminal prompts."),
        ],
        "Use pnpm instead of npm for the install command.",
      ),
    ).toEqual(["used"]);
  });

  it("allows a short identity answer when the memory has few distinctive tokens", () => {
    expect(memoriesUsedInAnswer([blockEntry("name", "The user's name is Paul.")], "Paul")).toEqual([
      "name",
    ]);
  });

  it("names at most three memories per answer and each one once", () => {
    expect(
      memoriesUsedInAnswer(
        [
          blockEntry("a", "The deploy target is staging-alpha."),
          blockEntry("a", "The deploy target is staging-alpha."),
          blockEntry("b", "The editor theme is solarized-light."),
          blockEntry("c", "The shell profile is zsh-prod."),
          blockEntry("d", "The registry mirror is artifactory-east."),
        ],
        "Use staging-alpha with solarized-light, zsh-prod and artifactory-east.",
      ),
    ).toEqual(["a", "b", "c"]);
  });

  it("names nothing for an empty answer or a memory of generic words only", () => {
    expect(memoriesUsedInAnswer([blockEntry("a", "Keiko uses Vitest.")], "")).toEqual([]);
    expect(memoriesUsedInAnswer([blockEntry("g", "user preference")], "user preference")).toEqual(
      [],
    );
  });
});
