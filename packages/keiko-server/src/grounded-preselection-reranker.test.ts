import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPLORATION_BUDGET,
  type CandidateFile,
  type ExplorationUsage,
} from "@oscharko-dev/keiko-contracts/connected-context";
import type { RerankerSeam } from "@oscharko-dev/keiko-workflows";
import {
  rerankGroundedCandidates,
  type PreselectionRerankerInput,
} from "./grounded-preselection-reranker.js";

const USAGE: ExplorationUsage = {
  searchCalls: 0,
  filesRead: 0,
  excerptBytes: 0,
  modelInputTokens: 0,
  modelOutputTokens: 0,
  elapsedMs: 0,
  rerankCalls: 0,
};
const CANDIDATES: readonly CandidateFile[] = [
  { scopePath: "first.ts", score: 0.9, signals: [], omitted: undefined },
  { scopePath: "second.ts", score: 0.1, signals: [], omitted: undefined },
];

function fixtureInput(reranker: RerankerSeam): PreselectionRerankerInput {
  return {
    reranker,
    candidates: CANDIDATES,
    atomsByPath: new Map(),
    budget: DEFAULT_EXPLORATION_BUDGET,
    usage: USAGE,
    nowMs: (): number => 1,
    deadlineAtMs: 101,
    literal: false,
  };
}

describe("preselection reranker bounded outcomes", () => {
  it("preserves exact identity ordering when a call fails", async () => {
    const result = await rerankGroundedCandidates(
      fixtureInput({
        name: "failed",
        isAvailable: () => Promise.resolve({ available: true, modelLabel: "fixture" }),
        rerank: () => Promise.reject(new Error("synthetic failure")),
      }),
    );
    expect(result.candidates).toBe(CANDIDATES);
    expect(result).toMatchObject({
      rerankerDisposition: "failed",
      reranked: false,
      rerankFailedCalls: 1,
    });
  });

  it("preserves identity fallback when a call rejects at the absolute deadline", async () => {
    let now = 1;
    const input = fixtureInput({
      name: "deadline",
      isAvailable: () => Promise.resolve({ available: true, modelLabel: "fixture" }),
      rerank: () => {
        now = 101;
        return Promise.reject(new Error("late failure"));
      },
    });
    const result = await rerankGroundedCandidates({ ...input, nowMs: () => now });
    expect(result.candidates).toBe(CANDIDATES);
    expect(result).toMatchObject({ rerankerDisposition: "skipped-budget", reranked: false });
    expect(result.usage.rerankCalls).toBe(1);
  });

  it("charges a configured identity failure as failed rather than applied", async () => {
    const result = await rerankGroundedCandidates(
      fixtureInput({
        name: "configured failure",
        isAvailable: () => Promise.resolve({ available: true, modelLabel: "fixture" }),
        rerank: (candidates) => Promise.resolve(candidates),
        getDiagnostics: () => ({
          status: "unavailable",
          candidateCount: 2,
          documentCount: 2,
          keptCount: 2,
          failureKind: "transport",
        }),
      }),
    );
    expect(result.candidates).toBe(CANDIDATES);
    expect(result).toMatchObject({
      rerankerDisposition: "failed",
      reranked: false,
      rerankFailedCalls: 1,
    });
  });

  it("rejects authority-widening results and keeps the original pool", async () => {
    const result = await rerankGroundedCandidates(
      fixtureInput({
        name: "invalid result",
        isAvailable: () => Promise.resolve({ available: true, modelLabel: "fixture" }),
        rerank: () =>
          Promise.resolve([{ scopePath: "outside.ts", score: 1, signals: [], omitted: undefined }]),
      }),
    );
    expect(result.candidates).toBe(CANDIDATES);
    expect(result.rerankerDisposition).toBe("failed");
  });

  it("observes no availability or provider call with a zero grant", async () => {
    let calls = 0;
    const input = fixtureInput({
      name: "zero grant",
      isAvailable: () => {
        calls += 1;
        return Promise.resolve({ available: true, modelLabel: "fixture" });
      },
      rerank: (candidates) => {
        calls += 1;
        return Promise.resolve(candidates);
      },
    });
    const result = await rerankGroundedCandidates({
      ...input,
      budget: { ...input.budget, rerankCallsMax: 0 },
    });
    expect(calls).toBe(0);
    expect(result.rerankerDisposition).toBe("skipped-budget");
  });

  it("reranks at most sixty-four candidates and preserves the remaining eligible pool", async () => {
    let count = 0;
    const input = fixtureInput({
      name: "cap",
      isAvailable: () => Promise.resolve({ available: true, modelLabel: "fixture" }),
      rerank: (candidates, _atoms, topK) => {
        count = candidates.length;
        expect(topK).toBe(64);
        return Promise.resolve([...candidates].reverse());
      },
    });
    const candidates = Array.from({ length: 100 }, (_value, index) => ({
      scopePath: `file-${String(index)}.ts`,
      score: 0.5,
      signals: [],
      omitted: undefined,
    }));
    const result = await rerankGroundedCandidates({ ...input, candidates });
    expect(count).toBe(64);
    expect(result.candidates).toHaveLength(100);
    expect(result.candidates[64]).toBe(candidates[64]);
  });
});
