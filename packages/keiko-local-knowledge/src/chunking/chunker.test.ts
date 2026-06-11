// Pure-function tests for `chunkParsedUnit`. No SQLite required; the runner-integration
// coverage lives in `chunker-runner.test.ts`.

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { DocumentId, ParsedUnit } from "@oscharko-dev/keiko-contracts";

import { chunkParsedUnit } from "./chunker.js";

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
    // maxTokens=10 → maxChars=40. overlapTokens=2 → overlapChars=8. stride=32.
    const text = "a".repeat(120);
    const unit = pageUnit(0, text.length);
    const chunks = chunkParsedUnit(unit, text, {
      maxTokens: 10,
      minTokens: 0,
      overlapTokens: 2,
    });
    expect(chunks.length).toBeGreaterThan(1);
    // Each non-final chunk has length 40; positions advance by stride=32.
    expect(chunks[0]?.characterStart).toBe(0);
    expect(chunks[0]?.characterEnd).toBe(40);
    expect(chunks[1]?.characterStart).toBe(32);
    expect(chunks[1]?.characterEnd).toBe(72);
    // Final chunk ends exactly at the unit boundary, never beyond.
    const last = chunks[chunks.length - 1];
    expect(last?.characterEnd).toBe(120);
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
    // No chunk exceeds the character budget (maxTokens=400 → 1600 chars).
    for (const chunk of chunks) {
      expect(chunk.characterEnd - chunk.characterStart).toBeLessThanOrEqual(1600);
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
