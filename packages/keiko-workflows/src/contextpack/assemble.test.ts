// Tests for the assembleContextPack facade (Issue #183). Covers deterministic stable IDs,
// micro-index reuse, reranker integration over the seam, budget-clipped and no-evidence
// uncertainty markers, editable/read-only role assignment, the empty-atom corner, and
// contract-level validity of the produced pack.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_EXPLORATION_BUDGET,
  validateConnectedContextPack,
  type CandidateFile,
  type EvidenceAtom,
  type OmittedContextEntry,
  type RetrievalQuery,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";

import { assembleContextPack, type AssembleInput } from "./assemble.js";
import { createMicroIndex } from "./microIndex.js";
import type { RerankerSeam } from "./reranker.js";

const FIXED_NOW = 1_700_000_000_000;

function fixedNow(): number {
  return FIXED_NOW;
}

function scope(): SelectedScope {
  return {
    schemaVersion: "1",
    scopeId: "scope-1",
    workspaceRoot: "/workspace",
    kind: "files",
    relativePaths: ["a.ts", "b.ts"],
    conversationId: undefined,
    connectedAtMs: 0,
  };
}

function query(): RetrievalQuery {
  return {
    kind: "natural-language",
    text: "where is auth wired",
    caseSensitive: false,
    maxResults: 10,
    emittedAtMs: 0,
  };
}

function atom(scopePath: string, stableId: string): EvidenceAtom {
  return {
    schemaVersion: "1",
    stableId,
    scopePath,
    lineRange: undefined,
    score: 0.7,
    provenance: { kind: "lexical-search", tool: "ripgrep", queryFingerprint: "fp" },
    redactionState: "redacted",
    emittedAtMs: 0,
    ledgerRef: undefined,
  };
}

function candidate(scopePath: string, score: number): CandidateFile {
  return {
    scopePath,
    score,
    signals: [{ name: "anchor-overlap", value: 1 }],
    omitted: undefined,
  };
}

function baseInput(): AssembleInput {
  const atomA = atom("a.ts", "atom-a");
  const atomB = atom("b.ts", "atom-b");
  return {
    scope: scope(),
    query: query(),
    budget: DEFAULT_EXPLORATION_BUDGET,
    atoms: [atomA, atomB],
    ranked: [candidate("a.ts", 0.9), candidate("b.ts", 0.5)],
    omittedFromRanking: [],
    excerpts: new Map([
      ["a.ts", "export const a = 1;"],
      ["b.ts", "export const b = 2;"],
    ]),
  };
}

describe("assembleContextPack", () => {
  it("produces a deterministic stable ID for the same input", async () => {
    const r1 = await assembleContextPack(baseInput(), { nowMs: fixedNow });
    const r2 = await assembleContextPack(baseInput(), { nowMs: fixedNow });
    expect(r1.pack.stableId).toBe(r2.pack.stableId);
    expect(r1.fromIndex).toBe(false);
    expect(r2.fromIndex).toBe(false);
  });

  it("serves the second call from the micro-index when one is provided", async () => {
    const idx = createMicroIndex({ ttlMs: 60_000, maxEntries: 8, nowMs: fixedNow });
    const r1 = await assembleContextPack(baseInput(), { nowMs: fixedNow, microIndex: idx });
    const r2 = await assembleContextPack(baseInput(), { nowMs: fixedNow, microIndex: idx });
    expect(r1.fromIndex).toBe(false);
    expect(r2.fromIndex).toBe(true);
    expect(r2.pack).toBe(r1.pack);
  });

  it("respects a reranker that reverses the candidate order when budget allows", async () => {
    const reverse: RerankerSeam = {
      name: "reverse-fake",
      isAvailable: () => Promise.resolve({ available: true, modelLabel: "fake" }),
      rerank: (cs) => Promise.resolve([...cs].reverse()),
    };
    // DEFAULT_EXPLORATION_BUDGET.rerankCallsMax = 0 (disabled). Allow exactly one rerank
    // call so the seam fires.
    const input: AssembleInput = {
      ...baseInput(),
      budget: { ...DEFAULT_EXPLORATION_BUDGET, rerankCallsMax: 1 },
    };
    const result = await assembleContextPack(input, {
      nowMs: fixedNow,
      reranker: reverse,
    });
    const paths = result.pack.files.map((f) => f.scopePath);
    expect(paths).toEqual(["b.ts", "a.ts"]);
    expect(result.pack.usage.rerankCalls).toBe(1);
  });

  it("skips reranking when budget.rerankCallsMax is zero (default)", async () => {
    const reverse: RerankerSeam = {
      name: "reverse-fake",
      isAvailable: () => Promise.resolve({ available: true, modelLabel: "fake" }),
      rerank: (cs) => Promise.resolve([...cs].reverse()),
    };
    const result = await assembleContextPack(baseInput(), {
      nowMs: fixedNow,
      reranker: reverse,
    });
    const paths = result.pack.files.map((f) => f.scopePath);
    expect(paths).toEqual(["a.ts", "b.ts"]);
    expect(result.pack.usage.rerankCalls).toBe(0);
  });

  it("emits a budget-clipped uncertainty marker when the excerpt budget is tiny", async () => {
    const input: AssembleInput = {
      ...baseInput(),
      budget: { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 5 },
    };
    const result = await assembleContextPack(input, { nowMs: fixedNow });
    const clipped = result.pack.uncertainty.find((u) => u.kind === "budget-clipped");
    expect(clipped).toBeDefined();
    // The first candidate exceeds 5 bytes, so processing stops immediately and the second
    // file is never added.
    expect(result.pack.files.length).toBe(0);
    expect(result.pack.omitted.some((o) => o.reason === "budget-exhausted")).toBe(true);
  });

  it("emits a no-evidence marker when an excerpt is missing for a candidate path", async () => {
    const input: AssembleInput = {
      ...baseInput(),
      excerpts: new Map([["a.ts", "export const a = 1;"]]),
    };
    const result = await assembleContextPack(input, { nowMs: fixedNow });
    const missing = result.pack.uncertainty.find((u) => u.kind === "no-evidence");
    expect(missing).toBeDefined();
    expect(missing?.claim).toContain("b.ts");
    expect(result.pack.files.map((f) => f.scopePath)).toEqual(["a.ts"]);
  });

  it("assigns editable role to listed paths and read-only to others", async () => {
    const editable = new Set(["a.ts"]);
    const result = await assembleContextPack(baseInput(), {
      nowMs: fixedNow,
      editablePaths: editable,
    });
    const byPath = new Map(result.pack.files.map((f) => [f.scopePath, f.role]));
    expect(byPath.get("a.ts")).toBe("editable");
    expect(byPath.get("b.ts")).toBe("read-only");
  });

  it("respects CandidateFile.omitted and excludes the file from pack.files", async () => {
    // Copilot review on PR #252: the ranker can pre-mark candidates as omitted (e.g.
    // "generated"); the assembler must not put them in pack.files even when an excerpt
    // is available.
    const input: AssembleInput = {
      ...baseInput(),
      ranked: [
        { scopePath: "a.ts", score: 0.9, signals: [], omitted: "generated" },
        { scopePath: "b.ts", score: 0.8, signals: [], omitted: undefined },
      ],
    };
    const result = await assembleContextPack(input, { nowMs: fixedNow });
    expect(result.pack.files.map((f) => f.scopePath)).toEqual(["b.ts"]);
    expect(
      result.pack.omitted.some((o) => o.scopePath === "a.ts" && o.reason === "generated"),
    ).toBe(true);
  });

  it("micro-index key is sensitive to budget so cached packs cannot violate a new budget", async () => {
    // Copilot review on PR #252: a cached pack assembled for budget A would otherwise be
    // returned for a request with budget B, even if usage would exceed B.excerptBytesMax.
    // The cache key now includes budget, so the second call is a miss and the produced
    // pack carries the new budget.
    const idx = createMicroIndex({ ttlMs: 60_000, maxEntries: 8, nowMs: fixedNow });
    const r1 = await assembleContextPack(baseInput(), { nowMs: fixedNow, microIndex: idx });
    const r2 = await assembleContextPack(
      { ...baseInput(), budget: { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 1 } },
      { nowMs: fixedNow, microIndex: idx },
    );
    expect(r1.fromIndex).toBe(false);
    expect(r2.fromIndex).toBe(false);
    expect(r2.pack.budget.excerptBytesMax).toBe(1);
  });

  it("produces an empty pack when there are no atoms or candidates", async () => {
    const input: AssembleInput = {
      scope: scope(),
      query: query(),
      budget: DEFAULT_EXPLORATION_BUDGET,
      atoms: [],
      ranked: [],
      omittedFromRanking: [],
      excerpts: new Map<string, string>(),
    };
    const result = await assembleContextPack(input, { nowMs: fixedNow });
    expect(result.pack.files).toEqual([]);
    expect(result.pack.uncertainty).toEqual([]);
    expect(result.pack.usage.filesRead).toBe(0);
    expect(result.pack.usage.excerptBytes).toBe(0);
  });

  it("produces a pack that passes validateConnectedContextPack", async () => {
    const result = await assembleContextPack(baseInput(), { nowMs: fixedNow });
    const validation = validateConnectedContextPack(result.pack);
    expect(validation.ok).toBe(true);
  });

  it("preserves omittedFromRanking input in the produced pack", async () => {
    const inputOmitted: OmittedContextEntry[] = [
      { scopePath: "skipped.ts", reason: "low-relevance", omittedAtMs: FIXED_NOW - 1 },
    ];
    const input: AssembleInput = { ...baseInput(), omittedFromRanking: inputOmitted };
    const result = await assembleContextPack(input, { nowMs: fixedNow });
    expect(result.pack.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scopePath: "skipped.ts", reason: "low-relevance" }),
      ]),
    );
  });

  it("derives selectionReason from the first signal name", async () => {
    const input: AssembleInput = {
      ...baseInput(),
      ranked: [
        {
          scopePath: "a.ts",
          score: 0.9,
          signals: [{ name: "path-bonus", value: 1 }],
          omitted: undefined,
        },
      ],
    };
    const result = await assembleContextPack(input, { nowMs: fixedNow });
    const entry = result.pack.files.find((f) => f.scopePath === "a.ts");
    expect(entry?.selectionReason).toBe("ranked by path-bonus");
  });
});
