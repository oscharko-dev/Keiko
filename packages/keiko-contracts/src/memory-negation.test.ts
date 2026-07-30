import { describe, expect, it } from "vitest";

import {
  MEMORY_NEGATION_TIERS,
  MEMORY_NEGATION_VOCABULARY,
  hasMemoryNegationToken,
  memoryNegationTokens,
} from "./memory-negation.js";
import type { MemoryNegationTier } from "./memory-negation.js";

const ALPHABETIC_TOKEN = /^[a-z]+$/u;

describe("MEMORY_NEGATION_VOCABULARY", () => {
  it("covers every declared tier with a non-empty word list", () => {
    for (const tier of MEMORY_NEGATION_TIERS) {
      expect(MEMORY_NEGATION_VOCABULARY[tier].length).toBeGreaterThan(0);
    }
  });

  it("declares every tier of the table (total — a new tier surfaces here)", () => {
    expect([...MEMORY_NEGATION_TIERS].sort()).toEqual(
      Object.keys(MEMORY_NEGATION_VOCABULARY).sort(),
    );
  });

  it("holds only lowercase alphabetic whole tokens (both callers match normalized tokens)", () => {
    for (const tier of MEMORY_NEGATION_TIERS) {
      for (const token of MEMORY_NEGATION_VOCABULARY[tier]) {
        expect(token).toMatch(ALPHABETIC_TOKEN);
      }
    }
  });

  it("keeps the tiers pairwise disjoint, so a token belongs to exactly one tier", () => {
    const perTierTotal = MEMORY_NEGATION_TIERS.reduce(
      (total, tier) => total + MEMORY_NEGATION_VOCABULARY[tier].length,
      0,
    );
    expect(memoryNegationTokens(MEMORY_NEGATION_TIERS).size).toBe(perTierTotal);
  });

  it("lists no duplicate token inside a tier", () => {
    for (const tier of MEMORY_NEGATION_TIERS) {
      const tokens = MEMORY_NEGATION_VOCABULARY[tier];
      expect(new Set(tokens).size).toBe(tokens.length);
    }
  });
});

describe("memoryNegationTokens", () => {
  it("returns an empty set for an empty tier list (fails closed, never the full vocabulary)", () => {
    expect(memoryNegationTokens([]).size).toBe(0);
  });

  it("collapses a repeated tier instead of double-counting it", () => {
    const once = memoryNegationTokens(["english-particle"]);
    const twice = memoryNegationTokens(["english-particle", "english-particle"]);
    expect(twice.size).toBe(once.size);
  });

  it("unions the requested tiers only", () => {
    const particles = memoryNegationTokens(["english-particle"]);
    const both = memoryNegationTokens(["english-particle", "english-quantifier"]);
    expect(both.size).toBe(
      particles.size + MEMORY_NEGATION_VOCABULARY["english-quantifier"].length,
    );
    for (const token of MEMORY_NEGATION_VOCABULARY["german-particle"]) {
      expect(both.has(token)).toBe(false);
    }
  });
});

describe("hasMemoryNegationToken", () => {
  const everything = memoryNegationTokens(MEMORY_NEGATION_TIERS);

  it("matches every token of every tier", () => {
    for (const tier of MEMORY_NEGATION_TIERS) {
      for (const token of MEMORY_NEGATION_VOCABULARY[tier]) {
        expect(hasMemoryNegationToken([token], everything)).toBe(true);
      }
    }
  });

  it("returns false for an empty token stream", () => {
    expect(hasMemoryNegationToken([], everything)).toBe(false);
  });

  it("returns false for an empty vocabulary even when a negation token is present", () => {
    expect(hasMemoryNegationToken(["not"], new Set<string>())).toBe(false);
  });

  it("matches whole tokens only — never a prefix, suffix or substring", () => {
    expect(
      hasMemoryNegationToken(["important", "notation", "cannotate", "nowhere"], everything),
    ).toBe(false);
  });

  it("is case- and whitespace-sensitive, because the caller normalizes first", () => {
    expect(hasMemoryNegationToken(["NOT", " not ", ""], everything)).toBe(false);
  });

  it("finds a negation anywhere in the stream, not only at the head", () => {
    expect(hasMemoryNegationToken(["we", "do", "not", "ship"], everything)).toBe(true);
  });

  it("accepts any iterable, not just an array (callers pass their own token generators)", () => {
    const tiers: readonly MemoryNegationTier[] = ["german-particle"];
    expect(hasMemoryNegationToken(new Set(["ohne"]), memoryNegationTokens(tiers))).toBe(true);
  });
});
