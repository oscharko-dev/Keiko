// Tests for `attachCitationsToAnswer` (Epic #189, Issue #200). Pins extraction of `[n]`
// markers, the out-of-bounds / leading-zero / duplicate-marker tolerance contracts, and
// the no-mutation invariant on the answer text.

import { describe, expect, it } from "vitest";

import type {
  CitationReference,
  KnowledgeCapsuleId,
  RetrievalReference,
} from "@oscharko-dev/keiko-contracts";

import { attachCitationsToAnswer } from "./citation-attacher.js";

function citation(chunk: string): CitationReference {
  return {
    documentId: `doc-${chunk}` as CitationReference["documentId"],
    capsuleId: "cap" as KnowledgeCapsuleId,
    sourceId: "src" as CitationReference["sourceId"],
    chunkId: chunk as CitationReference["chunkId"],
    safeDisplayName: `display-${chunk}`,
  };
}

function reference(chunk: string): RetrievalReference {
  return {
    chunkId: chunk as RetrievalReference["chunkId"],
    capsuleId: "cap" as KnowledgeCapsuleId,
    score: 0.9,
    citation: citation(chunk),
  };
}

describe("attachCitationsToAnswer", () => {
  it("maps [1] and [2] to the matching references by 1-based index", () => {
    const refs = [reference("ch-a"), reference("ch-b")];
    const result = attachCitationsToAnswer("alpha [1] beta [2] gamma", refs);
    expect(result.text).toBe("alpha [1] beta [2] gamma");
    expect(result.citations).toHaveLength(2);
    expect(result.citations[0]?.marker).toBe("[1]");
    expect(result.citations[0]?.index).toBe(1);
    expect(result.citations[0]?.reference.chunkId).toBe("ch-a");
    expect(result.citations[1]?.reference.chunkId).toBe("ch-b");
  });

  it("drops out-of-bounds markers without mutating the text", () => {
    const refs = [reference("ch-a")];
    const result = attachCitationsToAnswer("see [1] and [5] and [0]", refs);
    expect(result.text).toBe("see [1] and [5] and [0]");
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]?.index).toBe(1);
  });

  it("accepts leading-zero markers (some models emit [01])", () => {
    const refs = [reference("ch-a"), reference("ch-b")];
    const result = attachCitationsToAnswer("a [01] b [02]", refs);
    expect(result.citations).toHaveLength(2);
    expect(result.citations[0]?.index).toBe(1);
    expect(result.citations[1]?.index).toBe(2);
  });

  it("preserves duplicate markers in document order", () => {
    const refs = [reference("ch-a")];
    const result = attachCitationsToAnswer("[1] then [1] again [1]", refs);
    expect(result.citations).toHaveLength(3);
    expect(result.citations.every((c) => c.index === 1)).toBe(true);
  });

  it("returns empty citations when the answer text is empty", () => {
    const refs = [reference("ch-a")];
    const result = attachCitationsToAnswer("", refs);
    expect(result.text).toBe("");
    expect(result.citations).toEqual([]);
  });

  it("returns empty citations when no references are supplied", () => {
    const result = attachCitationsToAnswer("answer with [1] marker", []);
    expect(result.text).toBe("answer with [1] marker");
    expect(result.citations).toEqual([]);
  });

  it("ignores non-numeric brackets like [foo]", () => {
    const refs = [reference("ch-a")];
    const result = attachCitationsToAnswer("see [foo] and [1]", refs);
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]?.marker).toBe("[1]");
  });
});
