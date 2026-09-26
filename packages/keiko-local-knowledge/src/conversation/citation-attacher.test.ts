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

  it("maps CJK lenticular markers 【1】【2】 (gpt-oss emits these)", () => {
    const refs = [reference("ch-a"), reference("ch-b")];
    const result = attachCitationsToAnswer("alpha 【1】 beta 【2】 gamma", refs);
    expect(result.text).toBe("alpha 【1】 beta 【2】 gamma");
    expect(result.citations).toHaveLength(2);
    expect(result.citations[0]?.marker).toBe("【1】");
    expect(result.citations[0]?.index).toBe(1);
    expect(result.citations[0]?.reference.chunkId).toBe("ch-a");
    expect(result.citations[1]?.marker).toBe("【2】");
    expect(result.citations[1]?.reference.chunkId).toBe("ch-b");
  });

  it("maps fullwidth square-bracket markers ［1］", () => {
    const refs = [reference("ch-a")];
    const result = attachCitationsToAnswer("see ［1］ here", refs);
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]?.marker).toBe("［1］");
    expect(result.citations[0]?.index).toBe(1);
  });

  it("drops out-of-bounds lenticular markers (numeric phrases like 【2024】)", () => {
    const refs = [reference("ch-a"), reference("ch-b")];
    const result = attachCitationsToAnswer("the year 【2024】 and source 【1】", refs);
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]?.index).toBe(1);
  });

  // #2906 KEIKO-0643 — MARKER_PATTERN's open-bracket and close-bracket character classes
  // are independent by design so any of the three opens ({[, 【, ［}) can pair with any of
  // the three closes. The comment at citation-attacher.ts calls this deliberate tolerance
  // for untrusted LLM output. Pin the cross-family behavior so a future "fix" that requires
  // matching families cannot silently regress citation recovery for a model that emits
  // mismatched glyphs.
  it("tolerates a mismatched bracket-pair marker (ASCII open, CJK lenticular close)", () => {
    const refs = [reference("ch-mixed")];
    const result = attachCitationsToAnswer("see [1】 here", refs);
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]?.marker).toBe("[1】");
    expect(result.citations[0]?.index).toBe(1);
    expect(result.citations[0]?.reference.chunkId).toBe("ch-mixed");
  });

  it("keeps a marker when the claim sentence overlaps the cited excerpt", () => {
    const refs = [reference("ch-a")];
    const result = attachCitationsToAnswer(
      "The SOC2 control requires quarterly access reviews [1].",
      refs,
      {
        excerptForReference: () =>
          "SOC2 control AC-3 requires quarterly access reviews by the platform owner.",
      },
    );
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]?.reference.chunkId).toBe("ch-a");
  });

  it("drops a marker when the answer claim has no significant overlap with the excerpt", () => {
    const refs = [reference("ch-a")];
    const result = attachCitationsToAnswer(
      "The SOC2 control requires quarterly access reviews [1].",
      refs,
      {
        excerptForReference: () =>
          "The deployment guide documents database backup schedules and storage retention.",
      },
    );
    expect(result.text).toBe("The SOC2 control requires quarterly access reviews [1].");
    expect(result.citations).toEqual([]);
  });

  // Repository-pod regressions. Answers grounded on a code repository name files and members
  // constantly ("implemented in code-parser.ts", "calls parser.parse"), and a period is only a
  // sentence break when it is not inside a token. Treating every dot as a boundary shattered the
  // claim — the sentence around the marker collapsed to the fragment after the last dot, which no
  // longer overlapped the evidence — so every such citation was silently dropped while retrieval
  // itself was healthy. Observed live against a real indexed repository before the fix.
  it("keeps a citation whose claim names a file, since the dot in a filename is not a sentence end", () => {
    const refs = [reference("ch-a")];
    const result = attachCitationsToAnswer(
      "The definition check lives in `code-parser.ts`[1].",
      refs,
      {
        excerptForReference: () =>
          "code-parser.ts · function isCodeSymbolDefinitionLine\n" +
          "// decides whether a line is a code symbol definition",
      },
    );
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]?.reference.chunkId).toBe("ch-a");
  });

  it("keeps a citation whose claim names a dotted member expression", () => {
    const refs = [reference("ch-a")];
    const result = attachCitationsToAnswer("The loop calls parser.parse on each unit[1].", refs, {
      excerptForReference: () => "for (const unit of units) { parser.parse(unit); }",
    });
    expect(result.citations).toHaveLength(1);
  });

  it("attributes a marker placed after the closing period to the sentence it follows", () => {
    const refs = [reference("ch-a")];
    const result = attachCitationsToAnswer(
      "The function is `isCodeSymbolDefinitionLine`.[1]",
      refs,
      {
        excerptForReference: () =>
          "export function isCodeSymbolDefinitionLine(line: string): boolean {",
      },
    );
    expect(result.citations).toHaveLength(1);
  });

  // The guard must still bite: the fixes above widen which text counts as the claim, they do not
  // weaken the faithfulness comparison. A file-naming claim cited against unrelated evidence is
  // exactly the unfaithful case the check exists to catch.
  it("still drops a file-naming claim when the excerpt is unrelated", () => {
    const refs = [reference("ch-a")];
    const result = attachCitationsToAnswer("It is implemented in `code-parser.ts`[1].", refs, {
      excerptForReference: () => "The release checklist covers signing, notarization, and upload.",
    });
    expect(result.citations).toEqual([]);
  });
});
