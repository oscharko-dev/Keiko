// Tests for the reranker seam (Issue #183). The default reranker is always unavailable
// and identity; a test-fake reranker that reverses the input proves the seam works for
// downstream consumers without involving live model calls.

import { describe, expect, it } from "vitest";

import type { CandidateFile, EvidenceAtom } from "@oscharko-dev/keiko-contracts/connected-context";

import { disabledReranker, type RerankerSeam } from "./reranker.js";

function candidate(scopePath: string, score: number): CandidateFile {
  return {
    scopePath,
    score,
    signals: [{ name: "anchor-overlap", value: 1 }],
    omitted: undefined,
  };
}

describe("disabledReranker", () => {
  it("reports unavailable with a structured reason", async () => {
    const availability = await disabledReranker.isAvailable();
    expect(availability.available).toBe(false);
    if (!availability.available) {
      expect(availability.reason).toBe("reranker-not-configured");
    }
  });

  it("rerank() returns the input candidates unchanged (identity)", async () => {
    const input: readonly CandidateFile[] = [candidate("a.ts", 0.9), candidate("b.ts", 0.5)];
    const atomsByPath = new Map<string, readonly EvidenceAtom[]>();
    const out = await disabledReranker.rerank(input, atomsByPath, 5);
    expect(out).toEqual(input);
    expect(out).toBe(input);
  });

  it("has a stable name for telemetry / audit", () => {
    expect(disabledReranker.name).toBe("disabled-reranker");
  });
});

describe("test-fake reranker over the seam", () => {
  const reverseFake: RerankerSeam = {
    name: "reverse-fake",
    isAvailable: () => Promise.resolve({ available: true, modelLabel: "fake-reverse" }),
    rerank: (candidates) => Promise.resolve([...candidates].reverse()),
  };

  it("reverses the candidate order", async () => {
    const input = [candidate("a.ts", 0.9), candidate("b.ts", 0.5), candidate("c.ts", 0.1)];
    const atomsByPath = new Map<string, readonly EvidenceAtom[]>();
    const out = await reverseFake.rerank(input, atomsByPath, 3);
    expect(out.map((c) => c.scopePath)).toEqual(["c.ts", "b.ts", "a.ts"]);
  });

  it("reports available with a model label", async () => {
    const availability = await reverseFake.isAvailable();
    expect(availability.available).toBe(true);
    if (availability.available) {
      expect(availability.modelLabel).toBe("fake-reverse");
    }
  });
});
