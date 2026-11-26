import { describe, expect, it, vi } from "vitest";
import {
  CODING_SAFE_ACTIVITY_ANSWER_PAGE_MAX_CHARS,
  CODING_SAFE_ACTIVITY_MAX_TEXT_DELTA_CHARS,
  CODING_SAFE_ACTIVITY_MAX_TEXT_DELTAS,
  validateCodingSafeActivityTextDeltas,
} from "@oscharko-dev/keiko-contracts/runtime/coding-safe-activity";

import {
  cloneRetainedTexts,
  createRetainedTexts,
  releaseUnlistedTexts,
  restoreRetainedTexts,
  retainText,
  retainedTextPage,
  takeTextDeltas,
} from "./codingSafeActivityAnswers.js";

const ALL = (): boolean => true;
const EMOJI = "\u{1F600}";

function validDeltas(value: unknown): boolean {
  const errors: string[] = [];
  validateCodingSafeActivityTextDeltas(value, "textDeltas", errors);
  return errors.length === 0;
}

describe("retained model texts", () => {
  it("holds a trailing high surrogate back until its pair arrives", () => {
    const store = createRetainedTexts(1_000);
    const [high, low] = [EMOJI.slice(0, 1), EMOJI.slice(1)];
    expect(retainText(store, "answer", "m", `ok${high}`).kept).toBe("ok");
    // No page and no delta ever ends in half a character.
    expect(
      retainedTextPage(store, "run", { messageId: "m", part: "answer", offset: 0 })?.text,
    ).toBe("ok");
    expect(takeTextDeltas(store, ALL, 10_000)).toEqual([
      { messageId: "m", part: "answer", offset: 0, text: "ok" },
    ]);

    expect(retainText(store, "answer", "m", `${low}!`).kept).toBe(`${EMOJI}!`);
    expect(takeTextDeltas(store, ALL, 10_000)).toEqual([
      { messageId: "m", part: "answer", offset: 2, text: `${EMOJI}!` },
    ]);
    expect(store.chars).toBe(5);
  });

  it("cuts at the memory bound on a whole character and takes nothing after the cut", () => {
    const store = createRetainedTexts(3);
    const { retained, kept } = retainText(store, "answer", "m", `ab${EMOJI}`);
    expect(kept).toBe("ab");
    expect(retained).toMatchObject({ text: "ab", truncated: true });
    expect(retainText(store, "answer", "m", "c").kept).toBe("");
    expect(store.counts.answer).toEqual({ named: 0, clipped: 1, sourceCut: 0 });
    expect(store.counts.reasoning).toEqual({ named: 0, clipped: 0, sourceCut: 0 });
  });

  it("lets reasoning fill at most half the bound, so a later answer still fits whole", () => {
    const store = createRetainedTexts(1_000);
    const thought = retainText(store, "reasoning", "m1", "t".repeat(900));
    expect(thought.kept).toHaveLength(500);
    expect(thought.retained.truncated).toBe(true);
    expect(store.counts.reasoning.clipped).toBe(1);
    const answer = retainText(store, "answer", "m2", "a".repeat(500));
    expect(answer.kept).toHaveLength(500);
    expect(answer.retained.truncated).toBe(false);
    // Released reasoning gives its half back.
    releaseUnlistedTexts(store, (messageId) => messageId !== "m1");
    expect(store.reasoningChars).toBe(0);
    expect(retainText(store, "reasoning", "m3", "t".repeat(400)).kept).toHaveLength(400);
  });

  it("keeps answer and reasoning of one message apart", () => {
    const store = createRetainedTexts(1_000);
    retainText(store, "answer", "m", "answer");
    retainText(store, "reasoning", "m", "thought");
    expect(
      retainedTextPage(store, "run", { messageId: "m", part: "reasoning", offset: 0 }),
    ).toMatchObject({ part: "reasoning", text: "thought", length: 7 });
    expect(
      retainedTextPage(store, "run", { messageId: "m", part: "answer", offset: 0 }),
    ).toMatchObject({ part: "answer", text: "answer", length: 6 });
  });

  it("rolls back to a clone without the rejected growth", () => {
    const store = createRetainedTexts(1_000);
    retainText(store, "answer", "m", "kept");
    const prior = cloneRetainedTexts(store);
    retainText(store, "answer", "m", " rejected");
    retainText(store, "reasoning", "m", "rejected too");

    restoreRetainedTexts(store, prior);
    expect(store.chars).toBe(4);
    expect(
      retainedTextPage(store, "run", { messageId: "m", part: "answer", offset: 0 })?.text,
    ).toBe("kept");
    expect(
      retainedTextPage(store, "run", { messageId: "m", part: "reasoning", offset: 0 }),
    ).toBeNull();
  });

  it("releases the texts of a message the feed no longer lists", () => {
    const store = createRetainedTexts(1_000);
    retainText(store, "answer", "gone", "12345");
    retainText(store, "reasoning", "gone", "678");
    retainText(store, "answer", "kept", "ab");
    releaseUnlistedTexts(store, (id) => id === "kept");
    expect(store.chars).toBe(2);
    expect(store.byKey.size).toBe(1);
  });
});

describe("live text deltas", () => {
  it("announces each gain once, as a contiguous append", () => {
    const store = createRetainedTexts(1_000);
    retainText(store, "answer", "m", "Hello");
    const first = takeTextDeltas(store, ALL, 10_000);
    retainText(store, "answer", "m", ", world");
    const second = takeTextDeltas(store, ALL, 10_000);
    expect(takeTextDeltas(store, ALL, 10_000)).toEqual([]);

    expect(first).toEqual([{ messageId: "m", part: "answer", offset: 0, text: "Hello" }]);
    expect(second).toEqual([{ messageId: "m", part: "answer", offset: 5, text: ", world" }]);
    expect(validDeltas(first) && validDeltas(second)).toBe(true);
  });

  it("leaves out a gain over the byte budget or a delta's bound, and never announces it later", () => {
    const store = createRetainedTexts(10 * CODING_SAFE_ACTIVITY_ANSWER_PAGE_MAX_CHARS);
    retainText(store, "answer", "small", "x".repeat(100));
    retainText(store, "answer", "big", "y".repeat(CODING_SAFE_ACTIVITY_MAX_TEXT_DELTA_CHARS + 1));
    retainText(store, "reasoning", "small", "z".repeat(5_000));
    const deltas = takeTextDeltas(store, ALL, 1_000);
    expect(deltas.map((delta) => [delta.messageId, delta.part])).toEqual([["small", "answer"]]);
    // What was left out reaches the reader as pages: the next update starts after it.
    retainText(store, "reasoning", "small", "!");
    expect(takeTextDeltas(store, ALL, 10_000)).toEqual([
      { messageId: "small", part: "reasoning", offset: 5_000, text: "!" },
    ]);
  });

  it("never serializes a gain too long for a delta", () => {
    const store = createRetainedTexts(10 * CODING_SAFE_ACTIVITY_ANSWER_PAGE_MAX_CHARS);
    retainText(store, "answer", "big", "y".repeat(CODING_SAFE_ACTIVITY_MAX_TEXT_DELTA_CHARS + 1));
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      expect(takeTextDeltas(store, ALL, Number.MAX_SAFE_INTEGER)).toEqual([]);
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }
  });

  it("carries at most the contract's number of deltas and none for an unlisted message", () => {
    const store = createRetainedTexts(100_000);
    // The unlisted text comes first, so only the listing check keeps it out of a free slot.
    retainText(store, "answer", "unlisted", "secret");
    for (let index = 0; index <= CODING_SAFE_ACTIVITY_MAX_TEXT_DELTAS; index += 1) {
      retainText(store, "answer", `m${String(index)}`, "t");
    }
    const deltas = takeTextDeltas(store, (id) => id !== "unlisted", 1_000_000);
    expect(deltas).toHaveLength(CODING_SAFE_ACTIVITY_MAX_TEXT_DELTAS);
    expect(deltas.some((delta) => delta.messageId === "unlisted")).toBe(false);
    expect(validDeltas(deltas)).toBe(true);
  });
});
