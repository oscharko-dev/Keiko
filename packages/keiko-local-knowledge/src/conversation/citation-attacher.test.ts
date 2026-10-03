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

  // The lexical overlap gate used to DROP a marker whose claim shared too few tokens with the
  // excerpt. It is a token-equality heuristic (no stemming), so faithful German or paraphrased
  // citations failed it routinely and were left as dead text: no link, no footer count. An
  // in-range marker now stays attached and is flagged weak here. The user-visible guard this pin
  // once held moved to the server: an answer with a weak citation carries the fail-closed
  // "support could not be verified" caveat (keiko-server `withWeakCitationCaveat`, pinned in
  // local-knowledge-grounded-qa.rescue.test.ts "weakly supported citations").
  it("keeps a marker attached and flags it weak when the claim has no significant overlap", () => {
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
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]?.reference.chunkId).toBe("ch-a");
    expect(result.citations[0]?.lexicalSupport).toBe("weak");
    expect(result.weakOverlapCount).toBe(1);
  });

  it("does not flag a marker whose claim overlaps the excerpt", () => {
    const refs = [reference("ch-a")];
    const result = attachCitationsToAnswer(
      "The SOC2 control requires quarterly access reviews [1].",
      refs,
      {
        excerptForReference: () =>
          "SOC2 control AC-3 requires quarterly access reviews by the platform owner.",
      },
    );
    expect(result.citations[0]?.lexicalSupport).toBeUndefined();
    expect(result.weakOverlapCount).toBe(0);
  });

  // The customer's German answer: the claim is a paraphrase in another inflection, so almost no
  // token matches the excerpt exactly, and it ends in a bare marker list. Every one of these
  // markers used to be dropped (the list because a lone "," counted as the claim).
  it("keeps every in-range marker of a German paraphrase, including a trailing marker list", () => {
    const refs = [reference("ch-1"), reference("ch-2"), reference("ch-3")];
    const result = attachCitationsToAnswer(
      "Die Anwendungen laufen auf einer aktuellen Laufzeitumgebung laut Betriebsvorgaben. [1], [2], [3]",
      refs,
      { excerptForReference: () => "Java runtime baseline: JDK 17 for all services." },
    );
    expect(result.citations.map((entry) => entry.marker)).toEqual(["[1]", "[2]", "[3]"]);
    expect(result.weakOverlapCount).toBe(3);
  });

  it("attaches one entry per index of a grouped marker, each with its own single-index literal", () => {
    const refs = [reference("ch-a"), reference("ch-b"), reference("ch-c")];
    const result = attachCitationsToAnswer("Java 17 wird verwendet [1, 3].", refs);
    expect(result.text).toBe("Java 17 wird verwendet [1, 3].");
    expect(result.citations.map((entry) => entry.marker)).toEqual(["[1]", "[3]"]);
    expect(result.citations.map((entry) => entry.index)).toEqual([1, 3]);
    expect(result.citations.map((entry) => entry.reference.chunkId)).toEqual(["ch-a", "ch-c"]);
  });

  it.each([
    ["[1,2]", ["[1]", "[2]"]],
    ["[1; 2]", ["[1]", "[2]"]],
    ["【1, 2】", ["【1】", "【2】"]],
  ])("accepts the grouped marker style %s", (group, markers) => {
    const refs = [reference("ch-a"), reference("ch-b")];
    const result = attachCitationsToAnswer(`Alpha beta ${group}.`, refs);
    expect(result.citations.map((entry) => entry.marker)).toEqual(markers);
  });

  it("drops only the out-of-range indices of a grouped marker", () => {
    const refs = [reference("ch-a"), reference("ch-b")];
    const result = attachCitationsToAnswer("Alpha [2, 9, 0].", refs);
    expect(result.citations.map((entry) => entry.index)).toEqual([2]);
  });

  it("judges each entry of a grouped marker against its own excerpt", () => {
    const refs = [reference("ch-a"), reference("ch-b")];
    const result = attachCitationsToAnswer(
      "The retention period spans thirty days by policy [1, 2].",
      refs,
      {
        excerptForReference: (ref) =>
          ref.chunkId === "ch-a"
            ? "The retention period spans thirty days by policy."
            : "Unrelated release checklist covering signing and notarization.",
      },
    );
    expect(result.citations.map((entry) => entry.lexicalSupport)).toEqual([undefined, "weak"]);
    expect(result.weakOverlapCount).toBe(1);
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

  // The comparison itself is not weakened: a file-naming claim cited against unrelated evidence is
  // still recognised as unfaithful. It is flagged weak instead of being silently erased, and the
  // server turns that flag into the answer's unverified-support caveat (see the pin above).
  it("flags a file-naming claim as weak when the excerpt is unrelated", () => {
    const refs = [reference("ch-a")];
    const result = attachCitationsToAnswer("It is implemented in `code-parser.ts`[1].", refs, {
      excerptForReference: () => "The release checklist covers signing, notarization, and upload.",
    });
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]?.lexicalSupport).toBe("weak");
    expect(result.weakOverlapCount).toBe(1);
  });
});
