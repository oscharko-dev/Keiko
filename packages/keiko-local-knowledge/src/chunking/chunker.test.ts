// Pure-function tests for `chunkParsedUnit`. No SQLite required; the runner-integration
// coverage lives in `chunker-runner.test.ts`.

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { DocumentId, ParsedUnit } from "@oscharko-dev/keiko-contracts";

import { chunkParsedUnit, chunkingStrategyKey } from "./chunker.js";
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
});
