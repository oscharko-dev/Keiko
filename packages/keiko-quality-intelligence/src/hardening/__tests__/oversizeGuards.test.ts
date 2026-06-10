// Boundary coverage for oversize guards (Issue #284).

import { describe, expect, it } from "vitest";

import {
  MAX_CANDIDATES_PER_RUN,
  MAX_PROMPT_BYTES,
  MAX_SOURCE_BYTES,
  assertCandidateCount,
  assertPromptSize,
  assertSourceSize,
} from "../oversizeGuards.js";

describe("assertSourceSize", () => {
  it("accepts an empty source", () => {
    expect(assertSourceSize("")).toEqual({ ok: true });
  });

  it("accepts exactly MAX_SOURCE_BYTES", () => {
    const value = "a".repeat(MAX_SOURCE_BYTES);
    expect(assertSourceSize(value)).toEqual({ ok: true });
  });

  it("rejects one byte over MAX_SOURCE_BYTES", () => {
    const value = "a".repeat(MAX_SOURCE_BYTES + 1);
    const outcome = assertSourceSize(value);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.limit).toBe(MAX_SOURCE_BYTES);
      expect(outcome.observed).toBe(MAX_SOURCE_BYTES + 1);
      expect(outcome.reason).toContain("MAX_SOURCE_BYTES");
    }
  });

  it("measures multi-byte UTF-8 characters honestly", () => {
    // "あ" is 3 bytes UTF-8. A string of N copies is 3N bytes.
    const charCount = Math.floor(MAX_SOURCE_BYTES / 3) + 1;
    const value = "あ".repeat(charCount);
    const outcome = assertSourceSize(value);
    expect(outcome.ok).toBe(false);
  });
});

describe("assertPromptSize", () => {
  it("accepts exactly MAX_PROMPT_BYTES", () => {
    expect(assertPromptSize("a".repeat(MAX_PROMPT_BYTES))).toEqual({ ok: true });
  });

  it("rejects one byte over MAX_PROMPT_BYTES", () => {
    const outcome = assertPromptSize("a".repeat(MAX_PROMPT_BYTES + 1));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.limit).toBe(MAX_PROMPT_BYTES);
      expect(outcome.reason).toContain("MAX_PROMPT_BYTES");
    }
  });
});

describe("assertCandidateCount", () => {
  it("accepts zero", () => {
    expect(assertCandidateCount(0)).toEqual({ ok: true });
  });

  it("accepts exactly MAX_CANDIDATES_PER_RUN", () => {
    expect(assertCandidateCount(MAX_CANDIDATES_PER_RUN)).toEqual({ ok: true });
  });

  it("rejects one over MAX_CANDIDATES_PER_RUN", () => {
    const outcome = assertCandidateCount(MAX_CANDIDATES_PER_RUN + 1);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.observed).toBe(MAX_CANDIDATES_PER_RUN + 1);
    }
  });

  it("rejects a negative count", () => {
    expect(assertCandidateCount(-1).ok).toBe(false);
  });

  it("rejects a non-integer count", () => {
    expect(assertCandidateCount(1.5).ok).toBe(false);
  });

  it("rejects NaN", () => {
    expect(assertCandidateCount(Number.NaN).ok).toBe(false);
  });

  it("rejects Infinity", () => {
    expect(assertCandidateCount(Number.POSITIVE_INFINITY).ok).toBe(false);
  });
});
