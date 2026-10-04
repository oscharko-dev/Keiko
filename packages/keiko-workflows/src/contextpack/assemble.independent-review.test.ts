import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPLORATION_BUDGET,
  validateConnectedContextPack,
  type EvidenceAtom,
  type LineRange,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { assembleContextPack, type AssembleInput, type ExcerptWindow } from "./assemble.js";

function inputForWindows(
  windows: readonly ExcerptWindow[],
  ranges: readonly LineRange[],
): AssembleInput {
  const atoms: EvidenceAtom[] = ranges.map((lineRange, index) => ({
    schemaVersion: "1",
    stableId: `atom-${String(index)}`,
    scopePath: "manual.txt",
    lineRange,
    score: 1,
    provenance: { kind: "lexical-search", tool: "repo.searchText", queryFingerprint: "query" },
    redactionState: "redacted",
    emittedAtMs: 0,
    ledgerRef: undefined,
  }));
  return {
    scope: {
      schemaVersion: "1",
      scopeId: "scope",
      workspaceRoot: "/workspace",
      kind: "workspace-root",
      relativePaths: [],
      conversationId: undefined,
      connectedAtMs: 0,
    },
    query: {
      kind: "exact-symbol",
      text: "Probe",
      caseSensitive: true,
      maxResults: 8,
      emittedAtMs: 0,
    },
    budget: DEFAULT_EXPLORATION_BUDGET,
    atoms,
    ranked: [{ scopePath: "manual.txt", score: 1, signals: [], omitted: undefined }],
    omittedFromRanking: [],
    excerpts: new Map([["manual.txt", windows]]),
  };
}

describe("independent source-window review", () => {
  it("accepts a requested range covered completely by intersecting consistent windows", async () => {
    const input = inputForWindows(
      [
        { startLine: 3, endLine: 5, content: "three\nfour\nfive" },
        { startLine: 1, endLine: 3, content: "one\ntwo\nthree" },
      ],
      [{ startLine: 2, endLine: 4 }],
    );
    const { pack } = await assembleContextPack(input, { includeSurroundingContext: true });
    expect(pack.files[0]?.excerpts[0]?.content).toBe("one\ntwo\nthree\nfour\nfive");
    expect(pack.usage.excerptBytes).toBe(Buffer.byteLength("one\ntwo\nthree\nfour\nfive"));
    expect(validateConnectedContextPack(pack)).toEqual({ ok: true });
    expect(pack.uncertainty).toEqual([]);
  });

  it("does not manufacture a continuous range across contradictory overlap", async () => {
    const input = inputForWindows(
      [
        { startLine: 1, endLine: 3, content: "one\ntwo\nold-three" },
        { startLine: 3, endLine: 5, content: "new-three\nfour\nfive" },
      ],
      [{ startLine: 2, endLine: 4 }],
    );
    const { pack } = await assembleContextPack(input, { includeSurroundingContext: true });
    expect(pack.files).toEqual([]);
    expect(pack.uncertainty.map((marker) => marker.kind)).toEqual([
      "scope-incomplete",
      "no-evidence",
    ]);
    expect(validateConnectedContextPack(pack)).toEqual({ ok: true });
  });

  it("keeps adjacent disjoint windows unavailable for a range spanning their gap", async () => {
    const input = inputForWindows(
      [
        { startLine: 1, endLine: 2, content: "one\ntwo" },
        { startLine: 4, endLine: 5, content: "four\nfive" },
      ],
      [{ startLine: 2, endLine: 4 }],
    );
    const { pack } = await assembleContextPack(input, { includeSurroundingContext: true });
    expect(pack.files).toEqual([]);
    expect(pack.uncertainty.some((marker) => marker.kind === "scope-incomplete")).toBe(true);
    expect(validateConnectedContextPack(pack)).toEqual({ ok: true });
  });

  it("accounts for an admitted candidate whose source excerpt is unavailable", async () => {
    const input = inputForWindows([], [{ startLine: 1, endLine: 1 }]);
    const { pack } = await assembleContextPack(input, { includeSurroundingContext: true });
    expect(pack.files).toEqual([]);
    expect(pack.uncertainty.some((marker) => marker.kind === "scope-incomplete")).toBe(true);
    expect(pack.omitted.map((entry) => entry.scopePath)).toEqual(["manual.txt"]);
    expect(validateConnectedContextPack(pack)).toEqual({ ok: true });
  });
});
