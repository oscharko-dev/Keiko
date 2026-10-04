import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPLORATION_BUDGET,
  validateConnectedContextPack,
  type EvidenceAtom,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { assembleContextPack, contextPackIndexKey, type AssembleInput } from "./assemble.js";
import { createMicroIndex } from "./microIndex.js";

const NOW = 1_700_000_000_000;
const TEXT = `${"ordinary source line\n".repeat(3500)}actual final fact\n`;

function inputForQualifiedSources(): AssembleInput {
  const paths = ["manual.html", "ordinary.txt"];
  const atoms: EvidenceAtom[] = paths.map((scopePath) => ({
    schemaVersion: "1",
    stableId: `atom-${scopePath}`,
    scopePath,
    lineRange: { startLine: 1, endLine: 3502 },
    score: 1,
    provenance: { kind: "file-listing", tool: "repo.findFiles", queryFingerprint: "fp" },
    redactionState: "redacted",
    emittedAtMs: NOW,
    ledgerRef: undefined,
  }));
  return {
    scope: {
      schemaVersion: "1",
      scopeId: "qualified",
      workspaceRoot: "/workspace",
      kind: "workspace-root",
      relativePaths: [],
      conversationId: undefined,
      connectedAtMs: NOW,
    },
    query: {
      kind: "natural-language",
      text: "Explain this folder",
      caseSensitive: false,
      maxResults: 10,
      emittedAtMs: NOW,
    },
    budget: DEFAULT_EXPLORATION_BUDGET,
    atoms,
    ranked: paths.map((scopePath) => ({ scopePath, score: 1, signals: [], omitted: undefined })),
    omittedFromRanking: [],
    excerpts: new Map(paths.map((path) => [path, TEXT])),
  };
}

describe("qualified source excerpt byte limits", () => {
  it("does not reuse a cached ordinary 8 KiB pack for a qualified complete source", async () => {
    const input = inputForQualifiedSources();
    const microIndex = createMicroIndex({ ttlMs: 60_000, maxEntries: 8, nowMs: () => NOW });
    const options = { microIndex, nowMs: (): number => NOW };
    const ordinary = await assembleContextPack(input, options);
    expect(ordinary.pack.files[0]?.excerpts[0]?.content).not.toContain("actual final fact");
    const qualifiedOptions = {
      ...options,
      maxBytesPerExcerptByPath: new Map([["manual.html", Buffer.byteLength(TEXT)]]),
    };
    const qualified = await assembleContextPack(input, qualifiedOptions);
    expect(qualified.fromIndex).toBe(false);
    expect(qualified.pack.files[0]?.excerpts[0]?.content).toContain("actual final fact");
    expect(qualified.pack.files[1]?.excerpts[0]?.contentBytes).toBeLessThanOrEqual(8192);
    expect(qualified.pack.usage.excerptBytes).toBeLessThanOrEqual(input.budget.excerptBytesMax);
    expect(validateConnectedContextPack(qualified.pack)).toEqual({ ok: true });
    expect((await assembleContextPack(input, qualifiedOptions)).fromIndex).toBe(true);
  });

  it("fingerprints the qualified limits independently of map insertion order", () => {
    const input = inputForQualifiedSources();
    const entries: [string, number][] = [
      ["manual.html", Buffer.byteLength(TEXT)],
      ["ordinary.txt", 8192],
    ];
    expect(contextPackIndexKey(input, { maxBytesPerExcerptByPath: new Map(entries) })).toBe(
      contextPackIndexKey(input, { maxBytesPerExcerptByPath: new Map([...entries].reverse()) }),
    );
    expect(contextPackIndexKey(input, { maxBytesPerExcerptByPath: new Map(entries) })).not.toBe(
      contextPackIndexKey(input),
    );
  });

  it("preserves explicit aggregate byte limits and accounts for remaining source omissions", async () => {
    const input = inputForQualifiedSources();
    const { pack } = await assembleContextPack(
      { ...input, budget: { ...input.budget, excerptBytesMax: 16384 } },
      { maxBytesPerExcerptByPath: new Map([["manual.html", Buffer.byteLength(TEXT)]]) },
    );
    expect(pack.files.some((file) => file.scopePath === "ordinary.txt")).toBe(false);
    expect(pack.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scopePath: "ordinary.txt", reason: "budget-exhausted" }),
      ]),
    );
    expect(pack.uncertainty.some((marker) => marker.kind === "budget-clipped")).toBe(true);
    expect(pack.usage.excerptBytes).toBeLessThanOrEqual(16384);
    expect(validateConnectedContextPack(pack)).toEqual({ ok: true });
  });
});
