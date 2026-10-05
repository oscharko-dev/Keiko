import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPLORATION_BUDGET,
  MAX_OMITTED_CONTEXT_ENTRIES,
  validateConnectedContextPack,
  type CandidateFile,
  type EvidenceAtom,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { buildGroundedAnswerContextPackSummary } from "@oscharko-dev/keiko-contracts/bff-wire";
import { assembleContextPack, type AssembleInput } from "./assemble.js";

function largeOmissionInput(): AssembleInput {
  const paths = Array.from({ length: 8000 }, (_, index) => `facts/f${String(index)}.ts`);
  const content = `export const fact = "${"x".repeat(8192)}";`;
  return {
    scope: {
      schemaVersion: "1",
      scopeId: "large-facts",
      workspaceRoot: "/workspace",
      kind: "workspace-root",
      relativePaths: [],
      conversationId: undefined,
      connectedAtMs: 0,
    },
    query: {
      kind: "natural-language",
      text: "List facts",
      caseSensitive: false,
      maxResults: 8000,
      emittedAtMs: 0,
    },
    budget: DEFAULT_EXPLORATION_BUDGET,
    atoms: paths.map((scopePath, index): EvidenceAtom => ({
      schemaVersion: "1",
      stableId: `atom-${String(index)}`,
      scopePath,
      lineRange: { startLine: 1, endLine: 1 },
      score: 0.7,
      provenance: { kind: "lexical-search", tool: "repo.searchText", queryFingerprint: "facts" },
      redactionState: "redacted",
      emittedAtMs: 0,
      ledgerRef: undefined,
    })),
    ranked: paths.map((scopePath): CandidateFile => ({
      scopePath,
      score: 0.7,
      signals: [],
      omitted: undefined,
    })),
    omittedFromRanking: [],
    excerpts: new Map(paths.map((path) => [path, content])),
  };
}

describe("large connected-context omission projection", () => {
  it("keeps 8000 known candidates valid while retaining bounded details and exact totals", async () => {
    const input = largeOmissionInput();
    const { pack } = await assembleContextPack(input, { nowMs: () => 0 });
    expect(pack.files).toHaveLength(16);
    expect(pack.omitted).toHaveLength(MAX_OMITTED_CONTEXT_ENTRIES);
    expect(validateConnectedContextPack(pack)).toEqual({ ok: true });
    const summary = buildGroundedAnswerContextPackSummary(pack, 0, 0);
    expect(summary.omittedCount).toBe(7984);
    expect(summary.omittedCounts["budget-exhausted"]).toBe(7984);
    expect(pack.usage.excerptBytes).toBeLessThanOrEqual(input.budget.excerptBytesMax);
    expect(summary.usage.filesRead).toBe(16);
    expect(JSON.stringify(summary)).not.toContain("facts/");
  });
  it("retains size-exclusion metadata alongside complete aggregate reasons", async () => {
    const input = largeOmissionInput();
    const { pack } = await assembleContextPack(
      {
        ...input,
        omittedFromRanking: [
          { scopePath: "manuals/above.txt", reason: "size-exceeded", omittedAtMs: 0 },
        ],
      },
      { nowMs: () => 0 },
    );
    expect(validateConnectedContextPack(pack)).toEqual({ ok: true });
    expect(pack.omitted).toContainEqual({
      scopePath: "manuals/above.txt",
      reason: "size-exceeded",
      omittedAtMs: 0,
    });
    const summary = buildGroundedAnswerContextPackSummary(pack, 0, 0);
    expect(summary.omittedCount).toBe(7985);
    expect(summary.omittedCounts["size-exceeded"]).toBe(1);
    expect(summary.omittedCounts["budget-exhausted"]).toBe(7984);
  });

  it("fingerprints omissions beyond the retained detail list", async () => {
    const input = largeOmissionInput();
    const first = await assembleContextPack(input, { nowMs: () => 0 });
    const renamed = "facts/renamed-final.ts";
    const ranked = input.ranked.map((entry, index) =>
      index === 7999 ? { ...entry, scopePath: renamed } : entry,
    );
    const second = await assembleContextPack({ ...input, ranked }, { nowMs: () => 0 });
    expect(first.pack.omitted).toEqual(second.pack.omitted);
    expect(first.pack.omittedCounts).toEqual(second.pack.omittedCounts);
    expect(first.pack.stableId).not.toBe(second.pack.stableId);
    expect(validateConnectedContextPack(second.pack)).toEqual({ ok: true });
  });

  it.each([
    { scopePath: "../escape.txt", reason: "budget-exhausted" as const, omittedAtMs: 0 },
    { scopePath: "facts", reason: "budget-exhausted" as const, omittedAtMs: 0 },
    { scopePath: "outside.txt", reason: "budget-exhausted" as const, omittedAtMs: 0 },
    {
      scopePath: "facts/omitted-0.ts/child.ts",
      reason: "budget-exhausted" as const,
      omittedAtMs: 0,
    },
  ])("refuses invalid or overlapping omitted paths beyond retained details %#", async (tail) => {
    const input = largeOmissionInput();
    const hidden = Array.from({ length: 5000 }, (_, index) => ({
      scopePath: `facts/omitted-${String(index)}.ts`,
      reason: "budget-exhausted" as const,
      omittedAtMs: 0,
    }));
    await expect(
      assembleContextPack(
        {
          ...input,
          scope: { ...input.scope, kind: "directory", relativePaths: ["facts"] },
          omittedFromRanking: [...hidden, tail],
        },
        { nowMs: () => 0 },
      ),
    ).rejects.toThrow(/omitted/u);
  });
});
