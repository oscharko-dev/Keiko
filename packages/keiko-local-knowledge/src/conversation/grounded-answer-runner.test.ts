// Tests for `runGroundedAnswer` (Epic #189, Issue #200). The runner is wiring, so the
// tests pin the *composition* with the real retrieval layer (#199) plus a fake generator:
//   * Happy path: retrieval produces N refs ⇒ generator is invoked ⇒ citations attached.
//   * No-evidence: retrieval returns noEvidence ⇒ generator is NEVER called.
//   * Cancellation: an aborted signal propagates to the generator (retrieval forwards
//     the same signal to the embedding adapter).
//
// We seed real vectors via the retrieval `_support.ts` helpers so the test exercises the
// production retrieval path end-to-end. A fake generator is used so we can assert on
// whether it was called and pin the answer string.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { freshStore } from "../_support.js";
import { scriptedAdapter, seedCapsuleWithVectors } from "../retrieval/_support.js";
import type { KnowledgeStore } from "../store.js";

import { runGroundedAnswer } from "./grounded-answer-runner.js";
import { ScriptedAnswerGenerator } from "./scripted-answer-generator.js";
import type { AnswerGenerator, AnswerGeneratorInput, ConversationGroundedQuery } from "./types.js";

interface Fixture {
  readonly store: KnowledgeStore;
  readonly cleanup: () => void;
}

let fixture: Fixture | undefined;

beforeEach(() => {
  fixture = freshStore();
});

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

function getFixture(): Fixture {
  if (fixture === undefined) throw new Error("fixture not initialised");
  return fixture;
}

function fakeGenerator(text: string): AnswerGenerator & {
  readonly calls: AnswerGeneratorInput[];
} {
  const calls: AnswerGeneratorInput[] = [];
  const generator = {
    calls,
    generate: async (input: AnswerGeneratorInput): Promise<string> => {
      calls.push(input);
      return Promise.resolve(text);
    },
  };
  return generator;
}

describe("runGroundedAnswer — happy path", () => {
  it("invokes the generator with the assembled pack and attaches citations", async () => {
    const { store } = getFixture();
    const seeded = await seedCapsuleWithVectors(store, { capsuleId: "cap-a" });
    const generator = fakeGenerator("Found evidence [1] and [2].");
    const query: ConversationGroundedQuery = {
      conversationId: "conv-1",
      capsuleId: seeded.capsuleId,
      text: "alpha beta",
    };
    const result = await runGroundedAnswer(
      {
        retrieval: { store, embeddingAdapter: scriptedAdapter() },
        answerGenerator: generator,
      },
      query,
    );
    expect(result.noEvidence).toBe(false);
    expect(result.answer).toBe("Found evidence [1] and [2].");
    expect(result.references.length).toBeGreaterThan(0);
    expect(generator.calls).toHaveLength(1);
    expect(generator.calls[0]?.pack.counts.totalReferences).toBe(result.references.length);
    expect(result.citations.length).toBeGreaterThanOrEqual(1);
    expect(result.pack.scope.capsuleIds).toContain(seeded.capsuleId);
  });

  it("integrates with ScriptedAnswerGenerator end-to-end", async () => {
    const { store } = getFixture();
    const seeded = await seedCapsuleWithVectors(store, { capsuleId: "cap-b" });
    const result = await runGroundedAnswer(
      {
        retrieval: { store, embeddingAdapter: scriptedAdapter() },
        answerGenerator: new ScriptedAnswerGenerator(),
      },
      {
        conversationId: "conv-2",
        capsuleId: seeded.capsuleId,
        text: "alpha",
      },
    );
    expect(result.noEvidence).toBe(false);
    expect(result.answer).toContain("Found");
    expect(result.citations.length).toBeGreaterThan(0);
  });
});

describe("runGroundedAnswer — no-evidence short-circuit", () => {
  it("does not call the generator when query has no scope", async () => {
    const { store } = getFixture();
    const generator = vi.fn((): Promise<string> => Promise.resolve("should not be called"));
    const result = await runGroundedAnswer(
      {
        retrieval: { store, embeddingAdapter: scriptedAdapter() },
        answerGenerator: { generate: generator },
      },
      { conversationId: "conv-3", text: "alpha" },
    );
    expect(result.noEvidence).toBe(true);
    expect(result.reason).toBe("no-scope");
    expect(result.answer).toBe("");
    expect(result.citations).toEqual([]);
    expect(generator).not.toHaveBeenCalled();
  });

  it("does not call the generator on empty-query path", async () => {
    const { store } = getFixture();
    const seeded = await seedCapsuleWithVectors(store, { capsuleId: "cap-c" });
    const generator = vi.fn((): Promise<string> => Promise.resolve("should not be called"));
    const result = await runGroundedAnswer(
      {
        retrieval: { store, embeddingAdapter: scriptedAdapter() },
        answerGenerator: { generate: generator },
      },
      { conversationId: "conv-4", capsuleId: seeded.capsuleId, text: "   " },
    );
    expect(result.noEvidence).toBe(true);
    expect(result.reason).toBe("empty-query");
    expect(generator).not.toHaveBeenCalled();
  });
});

describe("runGroundedAnswer — cancellation", () => {
  it("forwards the AbortSignal to the generator", async () => {
    const { store } = getFixture();
    const seeded = await seedCapsuleWithVectors(store, { capsuleId: "cap-d" });
    const generator = fakeGenerator("ok [1]");
    const controller = new AbortController();
    await runGroundedAnswer(
      {
        retrieval: { store, embeddingAdapter: scriptedAdapter() },
        answerGenerator: generator,
        signal: controller.signal,
      },
      { conversationId: "conv-5", capsuleId: seeded.capsuleId, text: "alpha" },
    );
    expect(generator.calls[0]?.signal).toBe(controller.signal);
  });
});
