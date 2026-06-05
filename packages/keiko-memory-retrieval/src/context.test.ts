import { describe, expect, it } from "vitest";

import { assembleContextBlock, estimateTokens } from "./context.js";
import type { IncludedMemory } from "./types.js";
import { buildRecord, memoryId } from "./_support.js";

function included(id: string, score = 1): IncludedMemory {
  return {
    memoryId: memoryId(id),
    score,
    subscores: { relevance: 0, recency: 0, confidence: 0, pinned: 0, correction: 0, graph: 0 },
    inclusionReason: `id ${id}`,
  };
}

describe("estimateTokens", () => {
  it("returns 0 for an empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("returns ceil(wordCount * 1.3)", () => {
    expect(estimateTokens("one two three four five")).toBe(Math.ceil(5 * 1.3)); // 7
    expect(estimateTokens("a b c d e f g h i j")).toBe(Math.ceil(10 * 1.3)); // 13
  });

  it("ignores extra whitespace", () => {
    expect(estimateTokens("   one   two   ")).toBe(Math.ceil(2 * 1.3));
  });

  it("is deterministic", () => {
    const t = "the quick brown fox jumps over the lazy dog";
    expect(estimateTokens(t)).toBe(estimateTokens(t));
  });
});

describe("assembleContextBlock — empty / clean cases", () => {
  it("returns empty text and no entries when ranked is empty", () => {
    const result = assembleContextBlock([], [], { budgetTokens: 100, maxIncluded: 12 });
    expect(result.included).toEqual([]);
    expect(result.omitted).toEqual([]);
    expect(result.contextBlock.text).toBe("");
    expect(result.contextBlock.memories).toEqual([]);
    expect(result.budget.used).toBe(0);
  });

  it("uses ranked order and produces a header + bullet per included memory", () => {
    const records = [
      buildRecord({ id: "a", body: "alpha note" }),
      buildRecord({ id: "b", body: "beta note" }),
    ];
    const ranked = [included("a", 0.9), included("b", 0.7)];
    const result = assembleContextBlock(ranked, records, { budgetTokens: 1000, maxIncluded: 12 });
    expect(result.included.map((e) => e.memoryId)).toEqual([memoryId("a"), memoryId("b")]);
    expect(result.contextBlock.text).toMatch(/^# Relevant memories/);
    expect(result.contextBlock.text).toMatch(/alpha note/);
    expect(result.contextBlock.text).toMatch(/beta note/);
  });
});

describe("assembleContextBlock — caps and pressure", () => {
  it("omits ranked entries beyond maxIncluded with reason budget-exceeded", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const records = ids.map((id) => buildRecord({ id, body: `body ${id}` }));
    const ranked = ids.map((id) => included(id));
    const result = assembleContextBlock(ranked, records, { budgetTokens: 10_000, maxIncluded: 2 });
    expect(result.included.length).toBe(2);
    expect(result.omitted.length).toBe(3);
    expect(result.omitted.every((o) => o.reason === "budget-exceeded")).toBe(true);
  });

  it("under heavy budget pressure (100 candidates, tiny budget) omits most as budget-exceeded", () => {
    const records = Array.from({ length: 100 }, (_, i) =>
      buildRecord({ id: `m${String(i)}`, body: "alpha beta gamma delta epsilon zeta eta theta" }),
    );
    const ranked = records.map((r) => included(r.id, 1));
    const result = assembleContextBlock(ranked, records, { budgetTokens: 30, maxIncluded: 12 });
    expect(result.included.length).toBeLessThanOrEqual(12);
    expect(result.budget.used).toBeLessThanOrEqual(30);
    expect(result.omitted.length).toBeGreaterThan(60);
    expect(result.omitted.every((o) => o.reason === "budget-exceeded")).toBe(true);
  });

  it("body excerpt is clipped on a word boundary with an ellipsis when over per-entry budget", () => {
    const record = buildRecord({
      id: "long",
      body: "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi",
    });
    const ranked = [included("long")];
    // budget 8 tokens, maxIncluded 1 -> per-entry ~ 8 tokens -> ~6 words after the 1.3x.
    const result = assembleContextBlock(ranked, [record], { budgetTokens: 8, maxIncluded: 1 });
    const entry = result.contextBlock.memories[0];
    expect(entry?.bodyExcerpt.endsWith("…")).toBe(true);
    // Excerpt strictly shorter than the original body.
    expect((entry?.bodyExcerpt.length ?? 0) < record.body.length).toBe(true);
  });

  it("budget.used never exceeds budget.tokens", () => {
    const records = Array.from({ length: 50 }, (_, i) =>
      buildRecord({ id: `m${String(i)}`, body: "alpha beta gamma" }),
    );
    const ranked = records.map((r) => included(r.id));
    const result = assembleContextBlock(ranked, records, { budgetTokens: 20, maxIncluded: 50 });
    expect(result.budget.used).toBeLessThanOrEqual(result.budget.tokens);
  });
});
