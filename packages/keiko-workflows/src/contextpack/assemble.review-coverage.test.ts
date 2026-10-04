import { describe, expect, it, vi } from "vitest";
import * as compaction from "./compaction.js";
import {
  DEFAULT_EXPLORATION_BUDGET,
  validateConnectedContextPack,
  type EvidenceAtom,
  type LineRange,
} from "@oscharko-dev/keiko-contracts/connected-context";
import {
  assembleContextPack,
  contextPackIndexKey,
  type AssembleInput,
  type ExcerptSource,
} from "./assemble.js";

function evidence(path: string, range: LineRange, index = 0): EvidenceAtom {
  return {
    schemaVersion: "1",
    stableId: `atom-${String(index)}`,
    scopePath: path,
    lineRange: range,
    score: 1,
    provenance: { kind: "lexical-search", tool: "repo.searchText", queryFingerprint: "query" },
    redactionState: "redacted",
    emittedAtMs: 0,
    ledgerRef: undefined,
  };
}

function inputFor(atoms: readonly EvidenceAtom[], source?: ExcerptSource): AssembleInput {
  const paths = [...new Set(atoms.map((atom) => atom.scopePath))];
  return {
    scope: {
      schemaVersion: "1",
      scopeId: "review",
      workspaceRoot: "/workspace",
      kind: "workspace-root",
      relativePaths: [],
      conversationId: undefined,
      connectedAtMs: 0,
    },
    query: {
      kind: "exact-symbol",
      text: "ReviewProbe",
      caseSensitive: true,
      maxResults: 1000,
      emittedAtMs: 0,
    },
    budget: DEFAULT_EXPLORATION_BUDGET,
    atoms,
    ranked: paths.map((scopePath) => ({ scopePath, score: 1, signals: [], omitted: undefined })),
    omittedFromRanking: [],
    excerpts: source === undefined ? new Map() : new Map([["manual.txt", source]]),
  };
}

const OPTIONS = { includeSurroundingContext: true, nowMs: (): number => 0 };

function assertValid(pack: Awaited<ReturnType<typeof assembleContextPack>>["pack"]): void {
  expect(validateConnectedContextPack(pack)).toEqual({ ok: true });
}

describe("review source-window integrity and omission accounting", () => {
  it("discloses compaction loss even when a late match shares the same physical line", async () => {
    const input = inputFor([evidence("manual.txt", { startLine: 1, endLine: 1 })], {
      identity: "partial-line",
      startLine: 1,
      endLine: 1,
      content: "prefix followed by the actual ReviewProbe",
    });
    const { pack } = await assembleContextPack(input, { ...OPTIONS, maxBytesPerExcerpt: 6 });
    expect(pack.files[0]?.excerpts[0]?.content).toBe("prefix");
    expect(pack.uncertainty.some((marker) => marker.kind === "scope-incomplete")).toBe(true);
    assertValid(pack);
  });
  it("discloses an exact requested match removed by compaction", async () => {
    const input = inputFor(
      [
        evidence("manual.txt", { startLine: 1, endLine: 1 }),
        evidence("manual.txt", { startLine: 2, endLine: 2 }, 1),
      ],
      { startLine: 1, endLine: 2, content: "first\nlate-match" },
    );
    const { pack } = await assembleContextPack(input, { ...OPTIONS, maxBytesPerExcerpt: 5 });
    expect(pack.files[0]?.excerpts[0]?.content).toBe("first");
    expect(pack.uncertainty.some((marker) => marker.kind === "scope-incomplete")).toBe(true);
    assertValid(pack);
  });

  it("does not claim the unsent empty next line after clipping at a newline", async () => {
    const input = inputFor([evidence("manual.txt", { startLine: 1, endLine: 1 })], {
      startLine: 1,
      endLine: 3,
      content: "a\nb\nc",
    });
    const { pack } = await assembleContextPack(input, { ...OPTIONS, maxBytesPerExcerpt: 4 });
    expect(pack.files[0]?.excerpts[0]?.atom.lineRange).toEqual({ startLine: 1, endLine: 2 });
    assertValid(pack);
  });

  it("retains a useful partial read while disclosing its unavailable requested tail", async () => {
    const input = inputFor([evidence("manual.txt", { startLine: 1, endLine: 4 })], {
      startLine: 1,
      endLine: 2,
      content: "first\nsecond",
    });
    const { pack } = await assembleContextPack(input, OPTIONS);
    expect(pack.files[0]?.excerpts[0]?.content).toBe("first\nsecond");
    expect(pack.files[0]?.excerpts[0]?.atom.lineRange).toEqual({ startLine: 1, endLine: 2 });
    expect(pack.uncertainty.some((marker) => marker.kind === "scope-incomplete")).toBe(true);
    assertValid(pack);
  });

  it("preserves structural edge identities while charging a shared body once", async () => {
    const atoms = (["import", "call"] as const).map((kind, index) => ({
      ...evidence("manual.txt", { startLine: 1, endLine: 1 }, index),
      edge: {
        kind,
        source: { scopePath: "manual.txt" },
        target: { scopePath: "target.ts" },
        confidence: "resolved" as const,
      },
    }));
    const { pack } = await assembleContextPack(inputFor(atoms, "one body"), OPTIONS);
    expect(pack.files[0]?.excerpts.map((excerpt) => excerpt.atom.edge?.kind)).toEqual([
      "import",
      "call",
    ]);
    expect(new Set(pack.files[0]?.excerpts.map((excerpt) => excerpt.atom.stableId)).size).toBe(2);
    expect(pack.usage.excerptBytes).toBe(Buffer.byteLength("one body"));
    assertValid(pack);
  });

  it("compacts a shared structural source body once rather than once per edge", async () => {
    const atoms = (["import", "call"] as const).map((kind, index) => ({
      ...evidence("manual.txt", { startLine: 1, endLine: 1 }, index),
      edge: {
        kind,
        source: { scopePath: "manual.txt" },
        target: { scopePath: "target.ts" },
        confidence: "resolved" as const,
      },
    }));
    const compact = vi.spyOn(compaction, "compactExcerpt");
    try {
      const { pack } = await assembleContextPack(inputFor(atoms, "one body"), OPTIONS);
      expect(compact).toHaveBeenCalledOnce();
      expect(pack.files[0]?.excerpts).toHaveLength(2);
      assertValid(pack);
    } finally {
      compact.mockRestore();
    }
  });

  it.each([true, false])(
    "merges verified full-line windows regardless of digest identity: overlapping=%s",
    async (overlap) => {
      const startLine = overlap ? 2 : 3;
      const input = inputFor(
        [evidence("manual.txt", { startLine: 2, endLine: 3 })],
        [
          { identity: "first-digest", startLine: 1, endLine: 2, content: "one\ntwo" },
          {
            identity: overlap ? "second-digest" : "first-digest",
            startLine,
            endLine: 4,
            content: overlap ? "two\nthree\nfour" : "three\nfour",
          },
        ],
      );
      const { pack } = await assembleContextPack(input, OPTIONS);
      expect(pack.files[0]?.excerpts[0]?.content).toBe("one\ntwo\nthree\nfour");
      expect(pack.usage.excerptBytes).toBe(Buffer.byteLength("one\ntwo\nthree\nfour"));
      expect(pack.uncertainty).toEqual([]);
      assertValid(pack);
    },
  );

  it("merges compatible open windows even when a shorter conflicting window intervenes", async () => {
    const input = inputFor(
      [
        evidence("manual.txt", { startLine: 4, endLine: 4 }),
        evidence("manual.txt", { startLine: 6, endLine: 6 }, 1),
      ],
      [
        { startLine: 1, endLine: 5, content: "one\ntwo\nthree\nfour\nfive" },
        { startLine: 2, endLine: 2, content: "changed-two" },
        { startLine: 4, endLine: 6, content: "four\nfive\nsix" },
      ],
    );
    const { pack } = await assembleContextPack(input, OPTIONS);
    expect(pack.files[0]?.excerpts).toHaveLength(1);
    expect(pack.files[0]?.excerpts[0]?.content).toBe("one\ntwo\nthree\nfour\nfive\nsix");
    expect(
      pack.uncertainty.some((marker) =>
        marker.claim.includes("1 conflicting source window comparisons"),
      ),
    ).toBe(true);
    assertValid(pack);
  });

  it("reports conflicting comparisons rather than claiming a unique-window count", async () => {
    const { pack } = await assembleContextPack(
      inputFor(
        [evidence("manual.txt", { startLine: 1, endLine: 1 })],
        [
          { startLine: 1, endLine: 4, content: "one\nfirst-two\nthree\nfour" },
          { startLine: 2, endLine: 2, content: "second-two" },
          { startLine: 2, endLine: 3, content: "third-two\nthird-three" },
          { startLine: 2, endLine: 4, content: "fourth-two\nfourth-three\nfourth-four" },
        ],
      ),
      OPTIONS,
    );
    expect(pack.files[0]?.excerpts[0]?.content).toBe("one\nfirst-two\nthree\nfour");
    expect(
      pack.uncertainty.some((marker) =>
        marker.claim.includes("6 conflicting source window comparisons"),
      ),
    ).toBe(true);
    assertValid(pack);
  });

  it("skips closed disjoint windows without quadratic backward comparisons", async () => {
    let endReads = 0;
    const windows = Array.from({ length: 2000 }, (_, index) => ({
      startLine: index * 3 + 1,
      get endLine(): number {
        endReads += 1;
        return index * 3 + 1;
      },
      content: `line-${String(index)}`,
    }));
    const { pack } = await assembleContextPack(
      inputFor([evidence("manual.txt", { startLine: 1, endLine: 1 })], windows),
      OPTIONS,
    );
    expect(pack.files[0]?.excerpts[0]?.content).toBe("line-0");
    expect(endReads).toBeLessThan(10 * windows.length);
    assertValid(pack);
  });

  it("keeps unavailable metadata bounded and emits no duplicate no-evidence marker", async () => {
    const atoms = Array.from({ length: 500 }, (_, index) =>
      evidence(`unreadable-${String(index)}.txt`, { startLine: 1, endLine: 1 }, index),
    );
    const input = inputFor(atoms);
    const { pack } = await assembleContextPack(
      {
        ...input,
        initialUncertainty: [
          {
            kind: "no-evidence",
            claim: "existing abstention",
            impactedAtomIds: [],
            emittedAtMs: 0,
          },
        ],
      },
      OPTIONS,
    );
    expect(pack.omitted).toHaveLength(500);
    expect(pack.uncertainty.filter((marker) => marker.kind === "scope-incomplete")).toHaveLength(1);
    expect(pack.uncertainty.filter((marker) => marker.kind === "no-evidence")).toHaveLength(1);
    expect(JSON.stringify(pack.uncertainty).length).toBeLessThan(500);
    assertValid(pack);
  });

  it("preserves an actual upstream size exclusion instead of replacing its cause", async () => {
    const input = inputFor([evidence("manual.txt", { startLine: 1, endLine: 1 })]);
    const { pack } = await assembleContextPack(
      {
        ...input,
        omittedFromRanking: [{ scopePath: "manual.txt", reason: "size-exceeded", omittedAtMs: 0 }],
      },
      OPTIONS,
    );
    expect(pack.omitted).toEqual([
      { scopePath: "manual.txt", reason: "size-exceeded", omittedAtMs: 0 },
    ]);
    assertValid(pack);
  });

  it("reconciles an earlier omission of a successfully admitted selected file", async () => {
    const input = inputFor([evidence("manual.txt", { startLine: 1, endLine: 1 })], "observed fact");
    const { pack } = await assembleContextPack(
      {
        ...input,
        omittedFromRanking: [{ scopePath: "manual.txt", reason: "generated", omittedAtMs: 0 }],
      },
      OPTIONS,
    );
    expect(pack.files).toHaveLength(1);
    expect(pack.omitted).toEqual([]);
    assertValid(pack);
  });

  it("canonicalizes omission order for stable pack identity and cache keys", async () => {
    const input = inputFor([]);
    const omissions = ["z.txt", "a.txt"].map((scopePath) => ({
      scopePath,
      reason: "tool-unavailable" as const,
      omittedAtMs: 0,
    }));
    const first = { ...input, omittedFromRanking: omissions };
    const second = { ...input, omittedFromRanking: [...omissions].reverse() };
    expect(contextPackIndexKey(first)).toBe(contextPackIndexKey(second));
    const packs = await Promise.all([
      assembleContextPack(first, OPTIONS),
      assembleContextPack(second, OPTIONS),
    ]);
    expect(packs[0].pack.stableId).toBe(packs[1].pack.stableId);
    expect(packs[0].pack.omitted).toEqual(packs[1].pack.omitted);
  });

  it("reports invalid producer metadata with a bounded content-free error", async () => {
    const input = inputFor([]);
    const invalid = Array.from({ length: 500 }, (_, index) => ({
      scopePath: `../private-${String(index)}.txt`,
      reason: "tool-unavailable" as const,
      omittedAtMs: 0,
    }));
    const error = await assembleContextPack(
      { ...input, omittedFromRanking: invalid },
      OPTIONS,
    ).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("fixture expected validation failure");
    expect(error.message.length).toBeLessThan(250);
    expect(error.message).not.toContain("private-");
  });
});
