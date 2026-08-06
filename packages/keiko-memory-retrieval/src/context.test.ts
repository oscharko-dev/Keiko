import { describe, expect, it } from "vitest";

import { assembleContextBlock, clipToTokenBudget, estimateTokens } from "./context.js";
import type { IncludedMemory } from "./types.js";
import { buildRecord, memoryId } from "./_support.js";

function included(id: string, score = 1): IncludedMemory {
  return {
    memoryId: memoryId(id),
    score,
    subscores: {
      relevance: 0,
      recency: 0,
      confidence: 0,
      pinned: 0,
      correction: 0,
      graph: 0,
      semantic: 0,
      strength: 0,
      importance: 0,
    },
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

  // A word count is a serviceable token proxy for prose and a catastrophic one for the inputs a
  // memory vault most often captures verbatim: a URL, a hash, a base64 blob or a line of minified
  // JSON is ONE whitespace-free "word" of arbitrary length. Charging it flat priced a 4096-char
  // run at 2 tokens against a real cost near 1024.
  it("charges a long whitespace-free run proportionally to its length", () => {
    const longRun = "x".repeat(4096);
    expect(estimateTokens(longRun)).toBeGreaterThan(500);
    // Same order of magnitude as a real tokenizer's ~bytes/4, not an exact match to one.
    expect(estimateTokens(longRun)).toBeLessThan(2048);
  });

  it("prices a long run higher than the same character count split into prose words", () => {
    const chars = 400;
    const longRun = "x".repeat(chars);
    const prose = Array.from({ length: chars / 8 }, () => "xxxxxxx").join(" ");
    expect(estimateTokens(longRun)).toBeGreaterThan(estimateTokens(prose));
  });
});

describe("clipToTokenBudget", () => {
  it("returns the body unchanged when it already fits", () => {
    const body = "alpha beta gamma delta";
    expect(clipToTokenBudget(body, 100)).toBe(body);
  });

  it("clips ordinary prose on a word boundary with an ellipsis", () => {
    const clipped = clipToTokenBudget("alpha beta gamma delta epsilon zeta eta theta", 4);
    expect(clipped).toBe("alpha beta gamma…");
    expect(estimateTokens(clipped)).toBeLessThanOrEqual(4);
  });

  it("returns an empty string for a non-positive budget", () => {
    expect(clipToTokenBudget("alpha beta", 0)).toBe("");
  });

  // The mirror image of the estimator gap: the old word-budget comparison was against word COUNT,
  // so a single 4096-char "word" (1 <= 38) was returned whole no matter how small the budget.
  it("hard-truncates a single long run that alone exceeds the budget", () => {
    const longRun = "x".repeat(4096);
    const clipped = clipToTokenBudget(longRun, 50);
    expect(clipped.length).toBeLessThan(longRun.length);
    expect(estimateTokens(clipped)).toBeLessThanOrEqual(50);
    expect(clipped.endsWith("…")).toBe(true);
  });

  it("never splits a surrogate pair when hard-truncating", () => {
    const clipped = clipToTokenBudget("😀".repeat(2048), 20);
    expect(estimateTokens(clipped)).toBeLessThanOrEqual(20);
    expect(clipped).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    expect(clipped).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
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
    expect(result.included).toHaveLength(2);
    expect(result.omitted).toHaveLength(3);
    expect(result.omitted.every((o) => o.reason === "budget-exceeded")).toBe(true);
  });

  it("omits a ranked memory whose record is absent (out-of-scope)", () => {
    // 'ghost' is ranked but has no record in the supplied set — it must be omitted, not crash.
    const present = buildRecord({ id: "present", body: "hello world" });
    const ranked = [included("present"), included("ghost")];
    const result = assembleContextBlock(ranked, [present], { budgetTokens: 1000, maxIncluded: 12 });
    expect(result.included.map((e) => String(e.memoryId))).toEqual(["present"]);
    expect(result.omitted).toContainEqual({ memoryId: memoryId("ghost"), reason: "out-of-scope" });
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
    // budget 16 tokens, maxIncluded 1 -> includes rendered header/reason overhead and still clips
    // the long body on a word boundary.
    const result = assembleContextBlock(ranked, [record], { budgetTokens: 16, maxIncluded: 1 });
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

  // The per-entry allowance used to be budget/maxIncluded — the CONFIGURED ceiling — so the common
  // case of fewer surviving candidates than slots pre-divided the budget among slots that would
  // never be filled, clipping the entries that did survive while most of the budget sat unused.
  it("gives a lone candidate the whole budget instead of a 1/maxIncluded share", () => {
    // 1200 ordinary words price at ~1560 tokens, comfortably past the 1500-token budget, so the
    // budget — not the body — is what bounds the excerpt.
    const body = Array.from({ length: 1200 }, (_, i) => `word${String(i)}`).join(" ");
    const record = buildRecord({ id: "long", body });
    const result = assembleContextBlock([included("long")], [record], {
      budgetTokens: 1500,
      maxIncluded: 12,
    });
    expect(result.included).toHaveLength(1);
    expect(result.budget.used).toBeGreaterThan(0.5 * result.budget.tokens);
    expect(result.budget.used).toBeLessThanOrEqual(result.budget.tokens);
    // The old ceiling-based divisor gave this entry floor(1500/12) = 125 tokens, ~96 words.
    expect(result.contextBlock.memories[0]?.bodyExcerpt).toContain("word900");
  });

  it("does not let a lone candidate overrun a budget it cannot fill", () => {
    const record = buildRecord({ id: "short", body: "alpha beta gamma" });
    const result = assembleContextBlock([included("short")], [record], {
      budgetTokens: 1500,
      maxIncluded: 12,
    });
    expect(result.contextBlock.memories[0]?.bodyExcerpt).toBe("alpha beta gamma");
    expect(result.budget.used).toBeLessThanOrEqual(result.budget.tokens);
  });

  it("still shares the budget fairly once candidates reach maxIncluded", () => {
    const ids = ["a", "b", "c", "d"];
    const body = Array.from({ length: 400 }, (_, i) => `word${String(i)}`).join(" ");
    const records = ids.map((id) => buildRecord({ id, body }));
    const result = assembleContextBlock(
      ids.map((id) => included(id)),
      records,
      { budgetTokens: 1500, maxIncluded: 4 },
    );
    expect(result.included).toHaveLength(4);
    expect(result.budget.used).toBeLessThanOrEqual(result.budget.tokens);
    const excerptLengths = result.contextBlock.memories.map((e) => e.bodyExcerpt.length);
    // No entry monopolises the budget: each stays near its 1/4 share.
    expect(Math.max(...excerptLengths) - Math.min(...excerptLengths)).toBeLessThan(
      Math.max(...excerptLengths),
    );
  });

  it("charges the rendered header and inclusion reason against the budget", () => {
    const records = [
      buildRecord({ id: "a", body: "alpha beta gamma" }),
      buildRecord({ id: "b", body: "delta epsilon zeta" }),
    ];
    const ranked = records.map((r) => included(r.id));
    const result = assembleContextBlock(ranked, records, { budgetTokens: 18, maxIncluded: 2 });
    expect(result.budget.used).toBe(estimateTokens(result.contextBlock.text));
    expect(estimateTokens(result.contextBlock.text)).toBeLessThanOrEqual(result.budget.tokens);
  });
});
