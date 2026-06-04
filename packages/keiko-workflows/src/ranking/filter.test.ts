// Tests for the negative-context filter (Issue #182). Verifies reason priority, kept/omitted
// partitioning, deterministic sort order, and injected-clock timestamps.

import { describe, expect, it } from "vitest";

import type { CandidateFile } from "@oscharko-dev/keiko-contracts/connected-context";

import {
  DEFAULT_FILTER_OPTIONS,
  filterCandidates,
  type AnnotatedCandidate,
  type FilterOptions,
} from "./filter.js";

const FIXED_NOW = 1_700_000_000_000;

function fixedNow(): number {
  return FIXED_NOW;
}

function options(overrides: Partial<FilterOptions> = {}): FilterOptions {
  return {
    ...DEFAULT_FILTER_OPTIONS,
    nowMs: fixedNow,
    ...overrides,
  };
}

function candidate(scopePath: string, score: number): CandidateFile {
  return { scopePath, score, signals: [], omitted: undefined };
}

function annotated(
  scopePath: string,
  score: number,
  generatedHint = false,
  duplicate = false,
): AnnotatedCandidate {
  return {
    candidate: candidate(scopePath, score),
    generatedHint,
    duplicate,
  };
}

describe("filterCandidates", () => {
  it("omits candidates below minScore with reason low-relevance", () => {
    const result = filterCandidates([annotated("src/a.ts", 0.05)], options());
    expect(result.kept).toEqual([]);
    expect(result.omitted).toEqual([
      { scopePath: "src/a.ts", reason: "low-relevance", omittedAtMs: FIXED_NOW },
    ]);
  });

  it("keeps candidates above minScore that are not generated or duplicates", () => {
    const result = filterCandidates([annotated("src/a.ts", 0.5)], options());
    expect(result.kept.length).toBe(1);
    expect(result.kept[0]?.scopePath).toBe("src/a.ts");
    expect(result.omitted).toEqual([]);
  });

  it("omits generated candidates with reason generated when omitGenerated is true", () => {
    const result = filterCandidates([annotated("src/dist/a.js", 0.9, true)], options());
    expect(result.omitted[0]?.reason).toBe("generated");
  });

  it("omits near-duplicates with reason near-duplicate when omitNearDuplicates is true", () => {
    const result = filterCandidates([annotated("src/a.ts", 0.9, false, true)], options());
    expect(result.omitted[0]?.reason).toBe("near-duplicate");
  });

  it("respects a pre-set omitted reason on the candidate", () => {
    const preset: AnnotatedCandidate = {
      candidate: { scopePath: "src/a.ts", score: 0.9, signals: [], omitted: "binary" },
      generatedHint: false,
      duplicate: false,
    };
    const result = filterCandidates([preset], options());
    expect(result.omitted[0]?.reason).toBe("binary");
  });

  it("respects maxKept and moves the overflow to budget-exhausted", () => {
    const inputs = [
      annotated("src/a.ts", 0.9),
      annotated("src/b.ts", 0.8),
      annotated("src/c.ts", 0.7),
      annotated("src/d.ts", 0.6),
      annotated("src/e.ts", 0.5),
    ];
    const result = filterCandidates(inputs, options({ maxKept: 2 }));
    expect(result.kept.length).toBe(2);
    expect(result.kept[0]?.scopePath).toBe("src/a.ts");
    expect(result.kept[1]?.scopePath).toBe("src/b.ts");
    const overflowReasons = result.omitted.map((o) => o.reason);
    expect(overflowReasons.every((r) => r === "budget-exhausted")).toBe(true);
    expect(result.omitted.length).toBe(3);
  });

  it("sorts kept by score desc with stable path tiebreak", () => {
    const inputs = [
      annotated("src/b.ts", 0.5),
      annotated("src/a.ts", 0.5),
      annotated("src/c.ts", 0.7),
    ];
    const result = filterCandidates(inputs, options());
    expect(result.kept.map((c) => c.scopePath)).toEqual(["src/c.ts", "src/a.ts", "src/b.ts"]);
  });

  it("sorts omitted entries by scopePath asc", () => {
    const inputs = [
      annotated("src/z.ts", 0.05),
      annotated("src/a.ts", 0.05),
      annotated("src/m.ts", 0.05),
    ];
    const result = filterCandidates(inputs, options());
    expect(result.omitted.map((o) => o.scopePath)).toEqual(["src/a.ts", "src/m.ts", "src/z.ts"]);
  });

  it("uses the injected nowMs for omittedAtMs", () => {
    const result = filterCandidates([annotated("src/a.ts", 0.01)], options());
    expect(result.omitted[0]?.omittedAtMs).toBe(FIXED_NOW);
  });

  it("does not omit generated when omitGenerated is false", () => {
    const result = filterCandidates(
      [annotated("src/dist/a.js", 0.9, true)],
      options({ omitGenerated: false }),
    );
    expect(result.kept.length).toBe(1);
  });
});
