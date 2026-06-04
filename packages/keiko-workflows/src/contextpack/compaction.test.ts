// Tests for excerpt compaction and budget checkpoint helpers (Issue #183).

import { describe, expect, it } from "vitest";

import {
  DEFAULT_EXPLORATION_BUDGET,
  type EvidenceAtom,
  type ExplorationUsage,
} from "@oscharko-dev/keiko-contracts/connected-context";

import { compactExcerpt, nextAtomFitsBudget, type BudgetCheckpoint } from "./compaction.js";

function atom(scopePath: string): EvidenceAtom {
  return {
    schemaVersion: "1",
    stableId: `atom-${scopePath}`,
    scopePath,
    lineRange: undefined,
    score: 0.5,
    provenance: { kind: "lexical-search", tool: "ripgrep", queryFingerprint: "fp" },
    redactionState: "redacted",
    emittedAtMs: 0,
    ledgerRef: undefined,
  };
}

function zeroUsage(): ExplorationUsage {
  return {
    searchCalls: 0,
    filesRead: 0,
    excerptBytes: 0,
    modelInputTokens: 0,
    modelOutputTokens: 0,
    elapsedMs: 0,
    rerankCalls: 0,
  };
}

describe("compactExcerpt", () => {
  it("returns full content when under the byte budget", () => {
    const result = compactExcerpt({
      atom: atom("src/a.ts"),
      rawContent: "hello world",
      maxBytes: 1024,
    });
    expect(result.excerpt.content).toBe("hello world");
    expect(result.excerpt.contentBytes).toBe(11);
    expect(result.bytesConsumed).toBe(11);
    expect(result.truncated).toBe(false);
  });

  it("truncates to maxBytes when content exceeds the budget", () => {
    const longAscii = "x".repeat(200);
    const result = compactExcerpt({
      atom: atom("src/b.ts"),
      rawContent: longAscii,
      maxBytes: 32,
    });
    expect(result.excerpt.contentBytes).toBeLessThanOrEqual(32);
    expect(result.excerpt.contentBytes).toBe(32);
    expect(result.truncated).toBe(true);
  });

  it("does not split a multi-byte UTF-8 character at the clamp boundary", () => {
    // Each "あ" is 3 UTF-8 bytes. Clamping at 7 must produce ≤ 6 bytes of valid content
    // (two characters), never a partial 3-byte sequence.
    const multibyte = "あ".repeat(10);
    const result = compactExcerpt({
      atom: atom("src/c.ts"),
      rawContent: multibyte,
      maxBytes: 7,
    });
    expect(result.excerpt.contentBytes).toBeLessThanOrEqual(7);
    expect(result.excerpt.contentBytes % 3).toBe(0);
    expect(result.excerpt.content.includes("�")).toBe(false);
    expect(result.truncated).toBe(true);
  });

  it("returns an empty excerpt when maxBytes is zero", () => {
    const result = compactExcerpt({
      atom: atom("src/d.ts"),
      rawContent: "anything",
      maxBytes: 0,
    });
    expect(result.excerpt.content).toBe("");
    expect(result.excerpt.contentBytes).toBe(0);
    expect(result.truncated).toBe(true);
  });

  it("throws RangeError for negative maxBytes", () => {
    expect(() =>
      compactExcerpt({
        atom: atom("src/e.ts"),
        rawContent: "x",
        maxBytes: -1,
      }),
    ).toThrow(RangeError);
  });
});

describe("nextAtomFitsBudget", () => {
  const baseCp: BudgetCheckpoint = {
    atoms: [],
    budget: DEFAULT_EXPLORATION_BUDGET,
    currentUsage: zeroUsage(),
  };

  it("fits when both excerptBytes and filesRead remain within budget", () => {
    const result = nextAtomFitsBudget(baseCp, 1024);
    expect(result.fits).toBe(true);
    expect(result.violatedDim).toBeUndefined();
  });

  it("rejects when adding bytes would exceed excerptBytesMax", () => {
    const cp: BudgetCheckpoint = {
      atoms: [],
      budget: { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 100 },
      currentUsage: { ...zeroUsage(), excerptBytes: 80 },
    };
    const result = nextAtomFitsBudget(cp, 50);
    expect(result.fits).toBe(false);
    expect(result.violatedDim).toBe("excerptBytes");
  });

  it("rejects when filesRead budget is exhausted", () => {
    const cp: BudgetCheckpoint = {
      atoms: [],
      budget: { ...DEFAULT_EXPLORATION_BUDGET, filesReadMax: 2 },
      currentUsage: { ...zeroUsage(), filesRead: 2 },
    };
    const result = nextAtomFitsBudget(cp, 16);
    expect(result.fits).toBe(false);
    expect(result.violatedDim).toBe("filesRead");
  });

  it("rejects when candidate byte count is negative or non-finite", () => {
    expect(nextAtomFitsBudget(baseCp, -1).fits).toBe(false);
    expect(nextAtomFitsBudget(baseCp, Number.NaN).fits).toBe(false);
  });
});
