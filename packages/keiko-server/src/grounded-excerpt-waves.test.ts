import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPLORATION_BUDGET,
  MAX_OMITTED_CONTEXT_ENTRIES,
  connectedContextOmittedCount,
  type EvidenceAtom,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { assembleContextPack } from "@oscharko-dev/keiko-workflows";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";
import type { WorkspaceFs, WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { _readKeptExcerptsForTests, type ExcerptReadSummary } from "./grounded-orchestrator.js";

const ROOT = "/workspace/excerpt-waves";
const WORKSPACE: WorkspaceInfo = {
  root: ROOT,
  selectedRoot: ROOT,
  name: "wave fixture",
  version: undefined,
  testFramework: "unknown",
  sourceDirs: [],
  testDirs: [],
  languages: [],
  ignoreLines: [],
};

function atom(path: string): EvidenceAtom {
  return {
    schemaVersion: "1",
    stableId: path,
    scopePath: path,
    lineRange: { startLine: 1, endLine: 1 },
    score: 1,
    provenance: {
      kind: "lexical-search",
      tool: "repo.searchText",
      queryFingerprint: "wave-fixture",
    },
    redactionState: "redacted",
    emittedAtMs: 0,
    ledgerRef: undefined,
  };
}

function read(
  files: Readonly<Record<string, string>>,
  bytes: number,
  options: { fs?: WorkspaceFs; nowMs?: () => number; deadlineAtMs?: number } = {},
): Promise<ExcerptReadSummary> {
  const paths = Object.keys(files);
  return _readKeptExcerptsForTests(paths, {
    searchScope: { workspace: WORKSPACE, scopeId: "wave-fixture", relativePaths: [] },
    fs: options.fs ?? memFs(ROOT, files),
    budget: { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: bytes },
    initialUsage: {
      searchCalls: 0,
      filesRead: 0,
      excerptBytes: 0,
      elapsedMs: 0,
      rerankCalls: 0,
      modelInputTokens: 0,
      modelOutputTokens: 0,
    },
    atomsByPath: new Map(paths.map((path) => [path, [atom(path)]])),
    nowMs: options.nowMs ?? ((): number => 0),
    deadlineAtMs: options.deadlineAtMs ?? Infinity,
  });
}

function contents(result: ExcerptReadSummary): readonly (readonly [string, string])[] {
  return [...result.excerpts].map(([path, windows]) => [
    path,
    windows.map((window) => window.content).join(""),
  ]);
}

function content(result: ExcerptReadSummary, path: string): string | undefined {
  return result.excerpts.get(path)?.[0]?.content;
}

function consumedBytes(result: ExcerptReadSummary): number {
  return contents(result).reduce((total, [, content]) => total + Buffer.byteLength(content), 0);
}

describe("multi-file excerpt wave accounting", () => {
  it("recycles unused grants and reports the exact unread byte tail", async () => {
    const files = { "a.txt": "AAA", "b.txt": "BBBB", "c.txt": "CCCCC", "d.txt": "DDDDDD" };
    const result = await read(files, 12);
    expect(contents(result)).toEqual([
      ["a.txt", "AAA"],
      ["b.txt", "BBBB"],
      ["c.txt", "CCCCC"],
    ]);
    expect(consumedBytes(result)).toBe(12);
    expect(result.byteBudgetOmittedPaths).toEqual(["d.txt"]);
    expect([...result.excerpts.keys(), ...(result.byteBudgetOmittedPaths ?? [])]).toEqual(
      Object.keys(files),
    );
    expect(
      result.uncertainty.filter((marker) =>
        marker.claim.includes("budget-exhausted on excerptBytes"),
      ),
    ).toHaveLength(1);
    expect(result.observation).toMatchObject({ unreadFileCount: 1, stopReasons: ["byte-grant"] });
  });

  it("keeps complete small files alongside partial large files without exceeding the grant", async () => {
    const source = "x".repeat(30_000);
    const baseline = await read({ "probe.txt": source }, 30_000);
    const windowBytes = consumedBytes(baseline);
    expect(windowBytes).toBeGreaterThan(0);
    expect(windowBytes).toBeLessThan(source.length);
    const budget = windowBytes * 2 + 64;
    const files = {
      "a.txt": "small",
      "b.txt": source,
      "c.txt": "tiny",
      "d.txt": source,
      "e.txt": source,
      "f.txt": "tail",
    };
    const result = await read(files, budget);
    expect(content(result, "a.txt")).toBe("small");
    expect(content(result, "c.txt")).toBe("tiny");
    expect(content(result, "b.txt")).toHaveLength(windowBytes);
    expect(content(result, "d.txt")).toHaveLength(windowBytes);
    expect(content(result, "e.txt")).toHaveLength(55);
    expect(consumedBytes(result)).toBe(budget);
    expect(result.byteBudgetOmittedPaths).toEqual(["f.txt"]);
    expect(result.observation).toMatchObject({
      unreadFileCount: 1,
      truncatedWindowCount: 3,
      stopReasons: ["byte-grant"],
    });
  });

  it.each(["before-read", "after-read"])(
    "keeps completed files and accounts every unread file at a %s deadline",
    async (phase) => {
      const files = { "a.txt": "AAA", "b.txt": "BBBB", "c.txt": "CCCCC", "d.txt": "DDDDDD" };
      const base = memFs(ROOT, files);
      const readBytes = base.readFileBytes;
      if (readBytes === undefined) throw new TypeError("Byte read port is required.");
      let now = 0;
      const reads: string[] = [];
      const fs: WorkspaceFs = {
        ...base,
        stat: (path) => {
          if (phase === "before-read" && path.endsWith("/b.txt")) now = 10;
          return base.stat(path);
        },
        readFileBytes: async (...args) => {
          reads.push(args[0]);
          const value = await readBytes(...args);
          if (phase === "after-read" && args[0].endsWith("/b.txt")) now = 10;
          return value;
        },
      };
      const result = await read(files, 64, { fs, nowMs: () => now, deadlineAtMs: 10 });
      expect(contents(result)).toEqual([["a.txt", "AAA"]]);
      expect([...new Set(reads)]).toEqual(
        phase === "before-read" ? [`${ROOT}/a.txt`] : [`${ROOT}/a.txt`, `${ROOT}/b.txt`],
      );
      expect(result.omitted?.map((entry) => [entry.scopePath, entry.reason])).toEqual([
        ["b.txt", "budget-exhausted"],
        ["c.txt", "budget-exhausted"],
        ["d.txt", "budget-exhausted"],
      ]);
      expect(result.elapsedBudgetBlocked).toBe(true);
      expect(result.observation).toMatchObject({ unreadFileCount: 3, stopReasons: ["deadline"] });
      expect(consumedBytes(result)).toBe(3);
    },
  );

  it("advances past zero-byte files without losing a later readable fact", async () => {
    const files = {
      ...Object.fromEntries(
        Array.from({ length: 128 }, (_, index) => [`empty-${String(index)}.txt`, ""]),
      ),
      "fact.txt": "final fact",
    };
    const result = await read(files, 10);
    expect(result.excerpts.get("fact.txt")?.[0]?.content).toBe("final fact");
    expect(consumedBytes(result)).toBe(10);
    const accounted = new Set([
      ...result.excerpts.keys(),
      ...(result.omitted ?? []).map((entry) => entry.scopePath),
      ...(result.byteBudgetOmittedPaths ?? []),
    ]);
    expect(accounted).toEqual(new Set(Object.keys(files)));
    expect(result.elapsedBudgetBlocked).toBe(false);
  });

  it("retains a completed sibling when the deadline crosses within a concurrent wave", async () => {
    const baseline = await read({ "probe.txt": "x".repeat(30_000) }, 30_000);
    const files = { "a.txt": "AAA", "b.txt": "BBBB", "c.txt": "CCCCC", "d.txt": "DDDDDD" };
    const base = memFs(ROOT, files);
    const readBytes = base.readFileBytes;
    if (readBytes === undefined) throw new TypeError("Byte read port is required.");
    let now = 0;
    const reads: string[] = [];
    const fs: WorkspaceFs = {
      ...base,
      readFileBytes: async (...args) => {
        reads.push(args[0]);
        if (args[0].endsWith("/b.txt")) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          now = 10;
        }
        return readBytes(...args);
      },
    };
    const result = await read(files, consumedBytes(baseline) * 2, {
      fs,
      nowMs: () => now,
      deadlineAtMs: 10,
    });
    expect(contents(result)).toEqual([["a.txt", "AAA"]]);
    expect([...new Set(reads)]).toEqual([`${ROOT}/a.txt`, `${ROOT}/b.txt`]);
    expect(result.omitted?.map((entry) => [entry.scopePath, entry.reason])).toEqual([
      ["b.txt", "budget-exhausted"],
      ["c.txt", "budget-exhausted"],
      ["d.txt", "budget-exhausted"],
    ]);
    expect(consumedBytes(result)).toBe(3);
    expect(result.elapsedBudgetBlocked).toBe(true);
    expect(result.observation).toMatchObject({ unreadFileCount: 3, stopReasons: ["deadline"] });
  });

  it("accounts omitted paths beyond argument-spread capacity through the real read and pack producers", async () => {
    const count = 200_001;
    const paths = Array.from({ length: count }, (_, index) => `file-${String(index)}.txt`);
    const result = await _readKeptExcerptsForTests(paths, {
      searchScope: { workspace: WORKSPACE, scopeId: "wave-fixture", relativePaths: [] },
      fs: memFs(ROOT, {}),
      budget: DEFAULT_EXPLORATION_BUDGET,
      initialUsage: {
        searchCalls: 0,
        filesRead: 0,
        excerptBytes: DEFAULT_EXPLORATION_BUDGET.excerptBytesMax,
        elapsedMs: 0,
        rerankCalls: 0,
        modelInputTokens: 0,
        modelOutputTokens: 0,
      },
      atomsByPath: new Map(),
      nowMs: () => 0,
      deadlineAtMs: Infinity,
    });
    expect(result.excerpts.size).toBe(0);
    expect(result.omitted?.map((entry) => entry.scopePath)).toEqual(paths);
    const assembled = await assembleContextPack(
      {
        scope: {
          schemaVersion: "1",
          scopeId: "wave-fixture",
          workspaceRoot: ROOT,
          kind: "workspace-root",
          relativePaths: [],
          connectedAtMs: 0,
          explicitConnection: true,
          conversationId: undefined,
        },
        query: {
          kind: "exact-symbol",
          text: "WaveProbe",
          maxResults: count,
          caseSensitive: true,
          emittedAtMs: 0,
        },
        budget: DEFAULT_EXPLORATION_BUDGET,
        atoms: [],
        ranked: [],
        omittedFromRanking: result.omitted ?? [],
        excerpts: result.excerpts,
      },
      { nowMs: () => 0 },
    );
    expect(connectedContextOmittedCount(assembled.pack)).toBe(count);
    expect(assembled.pack.omitted).toHaveLength(MAX_OMITTED_CONTEXT_ENTRIES);
  });
});
