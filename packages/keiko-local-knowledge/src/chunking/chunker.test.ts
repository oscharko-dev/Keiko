// Pure-function tests for `chunkParsedUnit`. No SQLite required; the runner-integration
// coverage lives in `chunker-runner.test.ts`.

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { DocumentId, ParsedUnit } from "@oscharko-dev/keiko-contracts";

import { chunkParsedUnit, chunkingStrategyKey } from "./chunker.js";
import { CODE_PARSER_ID } from "../parsers/code-parser.js";
import {
  CONSERVATIVE_TOKENIZER_ID,
  QWEN3_SENTENCEPIECE_TOKENIZER_ID,
  type LocalKnowledgeTokenizer,
} from "./types.js";

const DOC_ID = "doc-1" as DocumentId;

function pageUnit(start: number, end: number): ParsedUnit {
  return {
    kind: "page",
    documentId: DOC_ID,
    pageNumber: 1,
    characterStart: start,
    characterEnd: end,
  };
}

function unsupportedUnit(): ParsedUnit {
  return { kind: "unsupported-media", documentId: DOC_ID, reason: "image/png" };
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("chunkParsedUnit — pure", () => {
  it("prefers symbol boundaries only for units produced by the code parser", () => {
    const text = [
      "function alpha() { return 1; }",
      "// padding between symbols",
      "function beta() { return 2; }",
      "// later non-symbol line",
      "// latest non-symbol line",
    ].join("\n");
    const options = {
      maxTokens: 115,
      minTokens: 0,
      overlapTokens: 0,
      tokenEstimator: (value: string): number => value.length,
    };
    const unit = pageUnit(0, text.length);
    const codeChunks = chunkParsedUnit(unit, text, options, { parserId: CODE_PARSER_ID });
    const proseChunks = chunkParsedUnit(unit, text, options, { parserId: "text" });
    expect(codeChunks[0]?.characterEnd).toBe(text.indexOf("function beta"));
    expect(proseChunks[0]?.characterEnd).toBeGreaterThan(codeChunks[0]?.characterEnd ?? 0);
  });

  // `chooseChunkEnd` runs the symbol probe over every line of a code unit, inside the caller's
  // open BEGIN/COMMIT transaction. A quadratic symbol pattern therefore did not just slow the
  // parser down, it held a write transaction open for the same tens of seconds. The probe is now
  // bounded per line, so a hostile long-space code unit chunks in ordinary time.
  it("chunks a hostile long-space code unit in bounded time", () => {
    const hostile = `a${" ".repeat(60_000)}b`;
    const text = [hostile, "function alpha() { return 1; }", hostile, hostile].join("\n");
    const startedAt = Date.now();
    const chunks = chunkParsedUnit(
      pageUnit(0, text.length),
      text,
      { maxTokens: 4_000, minTokens: 0, overlapTokens: 0, tokenEstimator: (v) => v.length },
      { parserId: CODE_PARSER_ID },
    );
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("keeps prose chunk boundaries byte-identical without code-parser provenance", () => {
    const text = "First sentence. Second sentence.\nThird line.\nFourth line.";
    const options = { maxTokens: 8, minTokens: 0, overlapTokens: 0 };
    expect(chunkParsedUnit(pageUnit(0, text.length), text, options)).toEqual(
      chunkParsedUnit(pageUnit(0, text.length), text, options, { parserId: "text" }),
    );
  });

  it("includes the active tokenizer identity in the strategy key", () => {
    const qwenTokenizer: LocalKnowledgeTokenizer = {
      identity: QWEN3_SENTENCEPIECE_TOKENIZER_ID,
      kind: "tokenizer",
      countTokens: (text) => text.length,
    };

    expect(chunkingStrategyKey(undefined)).toContain(`tokenizer=${CONSERVATIVE_TOKENIZER_ID}`);
    expect(chunkingStrategyKey({ tokenizer: qwenTokenizer })).toContain(
      `tokenizer=${QWEN3_SENTENCEPIECE_TOKENIZER_ID}`,
    );
  });

  it("emits exactly one chunk for a unit smaller than maxTokens", () => {
    const text = "Hello world.";
    const unit = pageUnit(0, text.length);
    const chunks = chunkParsedUnit(unit, text, {
      maxTokens: 400,
      minTokens: 64,
      overlapTokens: 32,
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.characterStart).toBe(0);
    expect(chunks[0]?.characterEnd).toBe(text.length);
  });

  it("emits one chunk even when the unit is far below minTokens (never drops content)", () => {
    const text = "tiny.";
    const unit = pageUnit(0, text.length);
    const chunks = chunkParsedUnit(unit, text, { minTokens: 1024 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.tokenCount).toBeGreaterThan(0);
  });

  it("splits a unit larger than maxTokens with overlap", () => {
    const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu ".repeat(6);
    const unit = pageUnit(0, text.length);
    const chunks = chunkParsedUnit(unit, text, {
      maxTokens: 10,
      minTokens: 0,
      overlapTokens: 2,
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.characterStart).toBe(0);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(10);
      expect(text.slice(chunk.characterStart, chunk.characterEnd).length).toBeGreaterThan(0);
    }
    const second = chunks[1];
    expect(second?.characterStart).toBeGreaterThan(0);
    expect(second?.characterStart).toBeLessThan(chunks[0]?.characterEnd ?? 0);
    const last = chunks[chunks.length - 1];
    expect(last?.characterEnd).toBe(text.length);
  });

  it("prefers paragraph and sentence boundaries for English and German prose", () => {
    const english =
      "First paragraph explains the scope. It ends cleanly here.\n\n" +
      "Second paragraph starts with a new topic. It also has a complete sentence.";
    const englishChunks = chunkParsedUnit(pageUnit(0, english.length), english, {
      maxTokens: 18,
      minTokens: 0,
      overlapTokens: 0,
    });
    expect(englishChunks.length).toBeGreaterThan(1);
    expect(english.slice(englishChunks[0]?.characterStart, englishChunks[0]?.characterEnd)).toMatch(
      /\n\s*\n\s*$/u,
    );

    const german =
      "Die erste Passage beschreibt die Überweisung. Sie endet an einer Satzgrenze. " +
      "Der nächste Abschnitt erklärt Zahlungsziele und Fristen.";
    const germanChunks = chunkParsedUnit(pageUnit(0, german.length), german, {
      maxTokens: 14,
      minTokens: 0,
      overlapTokens: 0,
    });
    expect(germanChunks.length).toBeGreaterThan(1);
    expect(german.slice(germanChunks[0]?.characterStart, germanChunks[0]?.characterEnd)).toMatch(
      /[.!?]\s*$/u,
    );
  });

  it("does not begin or end chunks inside a word when whitespace boundaries are available", () => {
    const text =
      "Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima. ".repeat(5);
    const unit = pageUnit(0, text.length);
    const chunks = chunkParsedUnit(unit, text, {
      maxTokens: 9,
      minTokens: 0,
      overlapTokens: 1,
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const beforeStart = text[chunk.characterStart - 1] ?? " ";
      const atStart = text[chunk.characterStart] ?? " ";
      const beforeEnd = text[chunk.characterEnd - 1] ?? " ";
      const atEnd = text[chunk.characterEnd] ?? " ";
      expect(/\w/u.test(beforeStart) && /\w/u.test(atStart)).toBe(false);
      expect(/\w/u.test(beforeEnd) && /\w/u.test(atEnd)).toBe(false);
      expect(text.slice(chunk.characterStart, chunk.characterEnd)).toBe(
        text.substring(chunk.characterStart, chunk.characterEnd),
      );
    }
  });

  it("produces disjoint chunks when overlapTokens=0", () => {
    const text = "x".repeat(120);
    const unit = pageUnit(0, text.length);
    const chunks = chunkParsedUnit(unit, text, {
      maxTokens: 10,
      minTokens: 0,
      overlapTokens: 0,
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1];
      const curr = chunks[i];
      expect(prev).toBeDefined();
      expect(curr).toBeDefined();
      // Disjoint = next chunk starts at or after the previous chunk's end.
      if (curr === undefined || prev === undefined) continue;
      expect(curr.characterStart).toBeGreaterThanOrEqual(prev.characterEnd);
    }
  });

  it("chunks a long German Markdown document with headings, table text, and paragraphs on boundaries", () => {
    const paragraph =
      "Die Überweisung wird im Fachprozess geprüft. Zahlungsziele, Fristen und Statuswerte bleiben nachvollziehbar.";
    const table =
      "| Feld | Bedeutung |\n| --- | --- |\n| Zahlungsziel | Datum der Fälligkeit |\n| Status | Bearbeitungsstand |\n";
    const text = Array.from({ length: 18 }, (_unused, i) =>
      [`## Abschnitt ${String(i + 1)}`, paragraph, table, paragraph].join("\n\n"),
    ).join("\n\n");
    const chunks = chunkParsedUnit(pageUnit(0, text.length), text, {
      maxTokens: 48,
      minTokens: 0,
      overlapTokens: 4,
    });

    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks[0]?.characterStart).toBe(0);
    expect(chunks[chunks.length - 1]?.characterEnd).toBe(text.length);
    expect(
      chunks.some((chunk) =>
        text.slice(chunk.characterStart, chunk.characterEnd).includes("| Feld |"),
      ),
    ).toBe(true);
    for (const chunk of chunks) {
      const excerpt = text.slice(chunk.characterStart, chunk.characterEnd);
      expect(excerpt).toBe(text.substring(chunk.characterStart, chunk.characterEnd));
      expect(chunk.tokenCount).toBeLessThanOrEqual(48);
      const beforeStart = text[chunk.characterStart - 1] ?? " ";
      const atStart = text[chunk.characterStart] ?? " ";
      const beforeEnd = text[chunk.characterEnd - 1] ?? " ";
      const atEnd = text[chunk.characterEnd] ?? " ";
      expect(/\p{L}/u.test(beforeStart) && /\p{L}/u.test(atStart)).toBe(false);
      expect(/\p{L}/u.test(beforeEnd) && /\p{L}/u.test(atEnd)).toBe(false);
    }
  });

  it("bounds chunks by character count for hostile no-whitespace long input", () => {
    // 100 KB single line, no whitespace. The chunker MUST still emit bounded slices.
    const text = "z".repeat(100_000);
    const unit = pageUnit(0, text.length);
    const chunks = chunkParsedUnit(unit, text, {
      maxTokens: 400,
      minTokens: 0,
      overlapTokens: 0,
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(400);
    }
    // Coverage: chunks span [0, text.length].
    expect(chunks[0]?.characterStart).toBe(0);
    expect(chunks[chunks.length - 1]?.characterEnd).toBe(text.length);
  });

  it("hard-caps caller-supplied maxTokens before sizing chunks", () => {
    const text = "z".repeat(20_000);
    const unit = pageUnit(0, text.length);
    const chunks = chunkParsedUnit(unit, text, {
      maxTokens: Number.MAX_SAFE_INTEGER,
      minTokens: 0,
      overlapTokens: 0,
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.characterEnd - chunk.characterStart).toBeLessThanOrEqual(8_192);
    }
  });

  it("still splits on a literal HTML heading tag boundary", () => {
    const paragraph =
      "Die Ueberweisung wird im Fachprozess geprueft und dokumentiert Schritt fuer Schritt genau.";
    const text = [paragraph, paragraph, "<h2>Naechster Abschnitt</h2>", paragraph, paragraph].join(
      " ",
    );
    const unit = pageUnit(0, text.length);
    const chunks = chunkParsedUnit(unit, text, { maxTokens: 24, minTokens: 0, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(
      chunks.some((chunk) =>
        text.slice(chunk.characterStart, chunk.characterEnd).trimStart().startsWith("<h2>"),
      ),
    ).toBe(true);
  });

  // Regression for typescript/javascript:S8786. HTML_HEADING_PATTERN used to be
  // `/\n?[ \t]*<\/?h[1-6](?:\s|>|$)/gi`: nothing gates entry into the `[ \t]*` run before the
  // required `<` literal, so an unanchored global search (`collectBoundaryMatches` runs this via
  // `RegExp#exec` in a loop) over a long stretch of plain spaces/tabs with no heading tag re-tries
  // the same greedy-then-backtrack walk at every offset inside the run — quadratic in run length.
  // A large padded document (long non-heading whitespace runs between real paragraphs) would have
  // taken far longer; the bounded pattern keeps chunking linear.
  it("chunks a large document with long non-heading whitespace runs in linear time", () => {
    const text = [
      "Intro paragraph with real words that needs chunking on its own.",
      " ".repeat(300_000),
      "Trailing paragraph content after the long run of plain whitespace padding.",
    ].join(" ");
    const unit = pageUnit(0, text.length);
    const start = Date.now();
    const chunks = chunkParsedUnit(unit, text, { maxTokens: 2048, minTokens: 1, overlapTokens: 0 });
    const elapsedMs = Date.now() - start;
    // Budget widened 1_000 -> 3_000: the 1s ceiling flaked on a loaded box (observed 1.1s-1.8s on
    // an unmodified tree). The guard is unaffected — the quadratic form this pins costs orders of
    // magnitude more than 3s over a 300k-character whitespace run, so the two remain far apart.
    expect(elapsedMs).toBeLessThan(3_000);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("safeExcerptHash is deterministic across runs", () => {
    const text = "The quick brown fox jumps over the lazy dog.";
    const unit = pageUnit(0, text.length);
    const a = chunkParsedUnit(unit, text);
    const b = chunkParsedUnit(unit, text);
    expect(a).toEqual(b);
    expect(a[0]?.safeExcerptHash).toBe(sha256Hex(text));
  });

  it("returns empty when the parsed unit is unsupported-media", () => {
    expect(chunkParsedUnit(unsupportedUnit(), "anything", {})).toEqual([]);
  });

  it("filters empty and punctuation-only noisy chunks", () => {
    const text = " \n\t--- *** ... ";
    const unit = pageUnit(0, text.length);
    expect(chunkParsedUnit(unit, text)).toEqual([]);
  });

  it("returns empty when the unit span is empty or inverted", () => {
    const unit = pageUnit(50, 50);
    expect(chunkParsedUnit(unit, "0123456789".repeat(10))).toEqual([]);
  });

  it("fails closed when a parsed unit exceeds maxChunks", () => {
    const text = "alpha ".repeat(40);
    const unit = pageUnit(0, text.length);
    expect(() =>
      chunkParsedUnit(unit, text, {
        maxTokens: 1,
        minTokens: 0,
        overlapTokens: 0,
        maxChunks: 2,
      }),
    ).toThrow(/maxChunks/);
  });

  it("clamps overlapTokens that meet or exceed maxTokens so it makes progress", () => {
    const text = "y".repeat(160);
    const unit = pageUnit(0, text.length);
    // overlapTokens=10 == maxTokens=10 would collapse stride to 0; the chunker must clamp.
    const chunks = chunkParsedUnit(unit, text, {
      maxTokens: 10,
      minTokens: 0,
      overlapTokens: 10,
    });
    expect(chunks.length).toBeGreaterThan(1);
    // stride must be ≥ 1 to terminate.
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1];
      const curr = chunks[i];
      if (curr === undefined || prev === undefined) continue;
      expect(curr.characterStart).toBeGreaterThan(prev.characterStart);
    }
  });

  it("emits character offsets relative to the document, not the unit slice", () => {
    const sourceText = "x".repeat(50) + "yyyyyyyyyy" + "x".repeat(50);
    const unit = pageUnit(50, 60);
    const chunks = chunkParsedUnit(unit, sourceText, { minTokens: 0, maxTokens: 400 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.characterStart).toBe(50);
    expect(chunks[0]?.characterEnd).toBe(60);
    expect(chunks[0]?.safeExcerptHash).toBe(sha256Hex("yyyyyyyyyy"));
  });

  // Epic #1855 / Issue #1887: a too-large code block or one-per-line table must split at line
  // starts, not mid-line, so preserved code lines and serialized rows stay intact. Lines are kept
  // short relative to the token budget so a line boundary is always available within budget.
  it("splits an oversized code/table unit at line boundaries, never mid-line", () => {
    const lines = Array.from({ length: 30 }, (_, index) => `k${String(index % 10)}`);
    const sourceText = lines.join("\n");
    const unit = pageUnit(0, sourceText.length);
    const chunks = chunkParsedUnit(unit, sourceText, {
      minTokens: 1,
      maxTokens: 4,
      overlapTokens: 0,
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      if (chunk.characterEnd >= sourceText.length) continue;
      // Chunk boundary lands exactly after a newline (the start of the next line), never mid-line.
      expect(sourceText.charAt(chunk.characterEnd - 1)).toBe("\n");
    }
  });

  // Epic #1855 / Issue #1887 (post-merge audit): the same content class the line-boundary
  // probe was built to protect — code lines with inline decimal literals, and table rows
  // with decimal cell values — also contains sentence-boundary-shaped punctuation (a period
  // followed by whitespace) *mid-line*, not just at the line's end. Regression:
  // SENTENCE_BOUNDARY_PATTERN was checked before LINE_BOUNDARY_PATTERN in chooseChunkEnd's
  // priority ladder, so a mid-line "digit-period-space" match starved the line-boundary
  // probe and produced a mid-line/mid-statement cut even though a newline boundary existed
  // within budget. (A period immediately before the newline is not adversarial here — the
  // sentence pattern's trailing `\s+` swallows the newline too, so it coincides with the
  // line boundary; the period must sit *before* trailing content on the same line to expose
  // the bug, which is what these fixtures do.)
  it("prefers a line boundary over a mid-line sentence-shaped period in code content", () => {
    const lines = ["a=1.5. b=2", "c=3.5. d=4", "e=5.5. f=6", "g=7.5. h=8"];
    const sourceText = lines.join("\n");
    const unit = pageUnit(0, sourceText.length);
    const chunks = chunkParsedUnit(unit, sourceText, {
      minTokens: 1,
      maxTokens: 10,
      overlapTokens: 0,
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      if (chunk.characterEnd >= sourceText.length) continue;
      // Every non-final chunk boundary must land at a line start, never mid-line/mid-statement.
      expect(sourceText.charAt(chunk.characterEnd - 1)).toBe("\n");
    }
  });

  // Same class, table-row shape: a decimal cell value followed by more cells on the same
  // row contains a sentence-boundary-shaped "digit-period-space" sequence mid-row, which
  // must not out-rank an available row (line) boundary.
  it("prefers a row boundary over a mid-row sentence-shaped period in table content", () => {
    const rows = ["| Widget | 19.99. | ea |", "| Gadget | 4.50. | ea |", "| Gizmo | 8.00. | ea |"];
    const sourceText = rows.join("\n");
    const unit = pageUnit(0, sourceText.length);
    const chunks = chunkParsedUnit(unit, sourceText, {
      minTokens: 1,
      maxTokens: 12,
      overlapTokens: 0,
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      if (chunk.characterEnd >= sourceText.length) continue;
      expect(sourceText.charAt(chunk.characterEnd - 1)).toBe("\n");
    }
  });
});
