// Tests for `ScriptedAnswerGenerator` (Epic #189, Issue #200). Pin the determinism
// contract — same inputs ⇒ byte-identical output — and the marker emission so the
// downstream citation-attacher round-trip is provable without a real model.

import { describe, expect, it } from "vitest";

import type {
  CitationReference,
  KnowledgeCapsuleId,
  RetrievalReference,
} from "@oscharko-dev/keiko-contracts";

import { assembleGroundedContext } from "../retrieval/context-pack-assembler.js";
import { ScriptedAnswerGenerator, buildScriptedAnswer } from "./scripted-answer-generator.js";
import type { ConversationGroundedQuery } from "./types.js";

function citation(capsule: string, chunk: string): CitationReference {
  return {
    documentId: `doc-${chunk}` as CitationReference["documentId"],
    capsuleId: capsule as KnowledgeCapsuleId,
    sourceId: `src-${capsule}` as CitationReference["sourceId"],
    chunkId: chunk as CitationReference["chunkId"],
    safeDisplayName: `display-${chunk}`,
  };
}

function reference(capsule: string, chunk: string, score = 0.9): RetrievalReference {
  return {
    chunkId: chunk as RetrievalReference["chunkId"],
    capsuleId: capsule as KnowledgeCapsuleId,
    score,
    citation: citation(capsule, chunk),
  };
}

const baseQuery: ConversationGroundedQuery = {
  conversationId: "conv-1",
  capsuleId: "cap-a" as KnowledgeCapsuleId,
  text: "what is alpha?",
};

describe("ScriptedAnswerGenerator", () => {
  it("emits one [n] marker per reference in the pack", async () => {
    const refs = [reference("cap-a", "ch-1"), reference("cap-a", "ch-2")];
    const pack = assembleGroundedContext(refs);
    const text = await new ScriptedAnswerGenerator().generate({
      query: baseQuery,
      pack,
      references: refs,
    });
    expect(text).toContain("[1]");
    expect(text).toContain("[2]");
    expect(text).not.toContain("[3]");
    expect(text).toContain("Found 2 references");
  });

  it("is deterministic across repeated invocations with identical input", async () => {
    const refs = [reference("cap-b", "ch-x"), reference("cap-b", "ch-y")];
    const pack = assembleGroundedContext(refs);
    const generator = new ScriptedAnswerGenerator();
    const first = await generator.generate({ query: baseQuery, pack, references: refs });
    const second = await generator.generate({ query: baseQuery, pack, references: refs });
    const third = buildScriptedAnswer({ query: baseQuery, pack, references: refs });
    expect(first).toBe(second);
    expect(first).toBe(third);
  });

  it("does not consult Date.now or any global clock", async () => {
    // If the generator read Date.now, two calls separated by an advanced clock would
    // diverge. We stub Date.now to return a moving value and pin equality.
    const original = Date.now;
    try {
      let tick = 0;
      Date.now = (): number => {
        tick += 1;
        return tick * 1_000_000;
      };
      const refs = [reference("cap-c", "ch-z")];
      const pack = assembleGroundedContext(refs);
      const a = await new ScriptedAnswerGenerator().generate({
        query: baseQuery,
        pack,
        references: refs,
      });
      const b = await new ScriptedAnswerGenerator().generate({
        query: baseQuery,
        pack,
        references: refs,
      });
      expect(a).toBe(b);
    } finally {
      Date.now = original;
    }
  });

  it("surfaces all capsule ids in the pack scope, lex-ordered", async () => {
    // Lex order is enforced by the pack assembler; the generator merely repeats it.
    const refs = [reference("cap-z", "c1"), reference("cap-a", "c2"), reference("cap-m", "c3")];
    const pack = assembleGroundedContext(refs);
    const text = await new ScriptedAnswerGenerator().generate({
      query: baseQuery,
      pack,
      references: refs,
    });
    expect(text).toContain("cap-a, cap-m, cap-z");
  });

  it("returns the empty string when the pack carries zero references", async () => {
    const pack = assembleGroundedContext([]);
    const text = await new ScriptedAnswerGenerator().generate({
      query: baseQuery,
      pack,
      references: [],
    });
    expect(text).toBe("");
  });
});
