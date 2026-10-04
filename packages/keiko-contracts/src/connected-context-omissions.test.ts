import { describe, expect, it } from "vitest";
import {
  CANDIDATE_OMISSION_REASONS,
  DEFAULT_EXPLORATION_BUDGET,
  validateConnectedContextPack,
  validateOmittedContextEntries,
  type ConnectedContextPack,
} from "./connected-context.js";

function omissionCounts(): Record<string, number> {
  return Object.fromEntries(CANDIDATE_OMISSION_REASONS.map((reason) => [reason, 0]));
}

function packWithCounts(counts: unknown): ConnectedContextPack {
  return {
    schemaVersion: "1",
    stableId: "pack-1",
    scope: {
      schemaVersion: "1",
      scopeId: "scope-1",
      workspaceRoot: "/workspace",
      kind: "workspace-root",
      relativePaths: [],
      conversationId: undefined,
      connectedAtMs: 0,
    },
    query: {
      kind: "natural-language",
      text: "facts",
      caseSensitive: false,
      maxResults: 10,
      emittedAtMs: 0,
    },
    budget: DEFAULT_EXPLORATION_BUDGET,
    usage: {
      searchCalls: 0,
      filesRead: 0,
      excerptBytes: 0,
      modelInputTokens: 0,
      modelOutputTokens: 0,
      elapsedMs: 0,
      rerankCalls: 0,
    },
    files: [],
    omitted: [{ scopePath: "large.txt", reason: "size-exceeded", omittedAtMs: 0 }],
    omittedCounts: counts,
    uncertainty: [],
    emittedAtMs: 0,
    ledgerRef: undefined,
  } as ConnectedContextPack;
}

describe("connected-context aggregate omission validation", () => {
  it("accepts matching closed per-reason counts", () => {
    const counts = { ...omissionCounts(), "size-exceeded": 1 };
    expect(validateConnectedContextPack(packWithCounts(counts))).toEqual({ ok: true });
  });

  it.each([
    null,
    [],
    {},
    { ...omissionCounts(), unknown: 1 },
    { ...omissionCounts(), "size-exceeded": -1 },
    { ...omissionCounts(), "size-exceeded": Number.NaN },
    { ...omissionCounts(), "size-exceeded": Number.MAX_SAFE_INTEGER + 1 },
    { ...omissionCounts(), "size-exceeded": 0 },
    { ...omissionCounts(), "size-exceeded": 8000 },
  ])("rejects malformed or unaccounted omission totals %#", (counts) => {
    expect(validateConnectedContextPack(packWithCounts(counts)).ok).toBe(false);
  });
  it.each([
    { paths: ["facts/parent", "facts/parent-other", "facts/parent/child"] },
    { paths: ["facts/parent/child", "facts/parent-other", "facts/parent"] },
  ])("preserves omitted ancestor overlap rejection in either arrival order %#", ({ paths }) => {
    const pack = packWithCounts({ ...omissionCounts(), "size-exceeded": 1 });
    const omitted = paths.map((scopePath) => ({
      scopePath,
      reason: "budget-exhausted" as const,
      omittedAtMs: 0,
    }));
    expect(validateOmittedContextEntries(omitted, pack.scope, []).ok).toBe(false);
  });

  it("distinguishes path components from similar filename prefixes", () => {
    const pack = packWithCounts({ ...omissionCounts(), "size-exceeded": 1 });
    const omitted = ["facts/parent", "facts/parent-other"].map((scopePath) => ({
      scopePath,
      reason: "budget-exhausted" as const,
      omittedAtMs: 0,
    }));
    expect(validateOmittedContextEntries(omitted, pack.scope, [])).toEqual({ ok: true });
  });
});
