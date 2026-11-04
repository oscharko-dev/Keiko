// #4179: a grounded turn that offers the requirements tool learns how many detected requirements
// the Chat's Pods hold against how many its ranked excerpts show.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Chat } from "./store/index.js";
import { podFixture, specification, type PodFixture } from "./_requirementSupport.js";
import { resetRequirementTurnCache } from "./requirement-inventory.js";
import {
  requirementCoverage,
  requirementCoverageNote,
  type RequirementCoverage,
} from "./requirement-coverage-note.js";

const fixtures: PodFixture[] = [];

beforeEach(() => {
  resetRequirementTurnCache();
});
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

async function fixture(count: number): Promise<PodFixture> {
  const created = await podFixture([{ capsuleId: "pod-a", text: specification(count).text }]);
  fixtures.push(created);
  return created;
}

/** The Chat as the Jira catalog sees it: with or without a Jira binding. */
function withBinding(
  f: PodFixture,
  bound: boolean,
): Parameters<typeof requirementCoverage>[0]["deps"] {
  const findChatById = (id: string): Chat | undefined => {
    const chat = f.deps.store.findChatById(id);
    if (chat === undefined || !bound) return chat;
    return { ...chat, jiraPodBinding: { podId: "pod", authenticationGeneration: 1 } } as Chat;
  };
  return {
    diagnostics: f.deps.diagnostics,
    store: { ...f.deps.store, findChatById },
  };
}

function coverageOf(
  f: PodFixture,
  bound: boolean,
  sentText: string,
): RequirementCoverage | undefined {
  let coverage: RequirementCoverage | undefined;
  f.withStore((store) => {
    coverage = requirementCoverage({
      deps: withBinding(f, bound),
      store,
      chatId: f.chatId,
      userMessageId: "turn-1",
      correlationId: "coverage-0001",
      sentText,
    });
  });
  return coverage;
}

describe("requirement coverage of grounded excerpts", () => {
  it("counts the detected requirements against those the excerpts show", async () => {
    const f = await fixture(12);
    expect(coverageOf(f, true, "Excerpt [1] LH-001 ... [2] LH-002 and LH-012")).toEqual({
      unitCount: 12,
      shownCount: 3,
    });
  });

  it("does not count a longer identifier as a shorter one", async () => {
    const f = await fixture(12);
    expect(coverageOf(f, true, "LH-0010 LH-0011 xLH-001")?.shownCount).toBe(0);
  });

  it("stays silent for a Chat without a Jira binding: the tool is not offered there", async () => {
    const f = await fixture(12);
    expect(coverageOf(f, false, "LH-001")).toBeUndefined();
  });

  it("phrases the note only when the excerpts miss some requirements", () => {
    expect(requirementCoverageNote({ unitCount: 41, shownCount: 13 })).toBe(
      " The attached Pods hold 41 detected requirements; the excerpts show 13. For all of them call knowledge.requirements.",
    );
    expect(requirementCoverageNote({ unitCount: 5, shownCount: 5 })).toBe("");
    expect(requirementCoverageNote(undefined)).toBe("");
  });
});
