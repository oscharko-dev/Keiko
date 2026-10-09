import {
  linkSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { detectWorkspaceAt } from "./detect.js";
import { nodeWorkspaceFs, type WorkspaceFs } from "./fs.js";
import { DEFAULT_SEARCH_LIMITS, readExcerpt, searchText, type SearchScope } from "./repoSearch.js";
import {
  createFileWorkspaceIndexStore,
  createWorkspaceIndex,
  type WorkspaceIndex,
} from "./workspaceIndex.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const QUERY: RetrievalQuery = {
  kind: "natural-language",
  text: "Vesper temperature",
  caseSensitive: false,
  maxResults: 20,
  emittedAtMs: 0,
};
const LIMITS = { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: null, elapsedMsMax: null };

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(): {
  readonly scope: SearchScope;
  readonly fs: WorkspaceFs;
  readonly reads: ReturnType<typeof vi.fn<NonNullable<WorkspaceFs["readFileBytes"]>>>;
} {
  const root = mkdtempSync(join(tmpdir(), "keiko-streaming-index-"));
  roots.push(root);
  for (let index = 0; index < 12; index += 1) {
    writeFileSync(
      join(root, `manual-${String(index)}.html`),
      index === 11 ? "<p>Vesper temperature is 73.5 C.</p>\n" : "<p>Navigation and upkeep.</p>\n",
    );
  }
  const reads = vi.fn(nodeWorkspaceFs.readFileBytes);
  return {
    scope: {
      workspace: detectWorkspaceAt(root, undefined, { scanSourceFilesForLanguages: false }),
      scopeId: "manuals",
      relativePaths: [],
    },
    fs: { ...nodeWorkspaceFs, readFileBytes: reads },
    reads,
  };
}

describe("unlimited discovery with fresh query-bound workspace index records", () => {
  it("reuses completed matches without repeating unchanged body reads or declaring index coverage", async () => {
    const { scope, fs, reads } = fixture();
    const workspaceIndex = createWorkspaceIndex();
    const cold = await searchText(scope, QUERY, LIMITS, { fs, workspaceIndex, nowMs: () => 0 });
    expect(cold.workspaceIndex).toMatchObject({ indexedRecords: 12, reusedRecords: 0 });
    expect(reads).toHaveBeenCalledTimes(12);
    reads.mockClear();
    const warm = await searchText(scope, QUERY, LIMITS, { fs, workspaceIndex, nowMs: () => 0 });
    expect(warm.workspaceIndex).toMatchObject({ reusedRecords: 12 });
    expect(warm.atoms).toEqual(cold.atoms);
    expect(warm.filesScanned).toBe(12);
    expect(warm.coverage).toEqual(cold.coverage);
    expect(reads).not.toHaveBeenCalled();
  });

  it("keeps actual selected evidence reads live after a matching index hit", async () => {
    const { scope, fs, reads } = fixture();
    const workspaceIndex = createWorkspaceIndex();
    await searchText(scope, QUERY, LIMITS, { fs, workspaceIndex, nowMs: () => 0 });
    reads.mockClear();
    const request = { scopePath: "manual-11.html", startLine: 1, endLine: 1, maxBytes: 512 };
    const live = await readExcerpt(scope, request, { fs });
    const liveReadCount = reads.mock.calls.length;
    expect(liveReadCount).toBeGreaterThan(0);
    reads.mockClear();
    const warm = await searchText(scope, QUERY, LIMITS, { fs, workspaceIndex, nowMs: () => 0 });
    expect(reads).not.toHaveBeenCalled();
    const atom = warm.atoms[0];
    expect(atom?.scopePath).toBe("manual-11.html");
    const excerpt = await readExcerpt(scope, request, { fs });
    expect(excerpt.content).toContain("73.5");
    expect(excerpt.content).toBe(live.content);
    expect(reads).toHaveBeenCalledTimes(liveReadCount);
  });

  it("rereads changed negative records and discovers newly matching files", async () => {
    const { scope, fs, reads } = fixture();
    const workspaceIndex = createWorkspaceIndex();
    await searchText(scope, QUERY, LIMITS, { fs, workspaceIndex, nowMs: () => 0 });
    writeFileSync(join(scope.workspace.root, "manual-0.html"), "Vesper temperature is 94.8 C.\n");
    reads.mockClear();
    const warm = await searchText(scope, QUERY, LIMITS, { fs, workspaceIndex, nowMs: () => 0 });
    expect(warm.atoms.map((atom) => atom.scopePath)).toContain("manual-0.html");
    expect(reads).toHaveBeenCalledOnce();
  });

  it.each(["new-query", "result-cap", "interpretation"])("keeps %s scans live", async (change) => {
    const { scope, fs, reads } = fixture();
    const workspaceIndex = createWorkspaceIndex();
    await searchText(scope, QUERY, LIMITS, { fs, workspaceIndex, nowMs: () => 0 });
    reads.mockClear();
    await searchText(
      scope,
      change === "new-query" ? { ...QUERY, text: "Navigation" } : QUERY,
      change === "result-cap" ? { ...LIMITS, maxMatchesReturned: 2 } : LIMITS,
      {
        fs,
        workspaceIndex,
        ...(change === "interpretation"
          ? { queryInterpretation: { kind: "literal" as const, terms: ["temperature"] } }
          : {}),
      },
    );
    expect(reads).toHaveBeenCalledTimes(12);
  });

  it("preserves active known-fit observation over every live file", async () => {
    const { scope, fs, reads } = fixture();
    const workspaceIndex = createWorkspaceIndex();
    await searchText(scope, QUERY, LIMITS, { fs, workspaceIndex, nowMs: () => 0 });
    reads.mockClear();
    const observe = vi.fn(() => true);
    await searchText(scope, QUERY, LIMITS, { fs, workspaceIndex, onEligibleTextFile: observe });
    expect(reads).toHaveBeenCalledTimes(12);
    expect(observe).toHaveBeenCalledTimes(12);
  });

  it.each(["symlink", "hardlink"])(
    "revalidates containment and %s aliases before reuse",
    async (kind) => {
      const { scope, fs, reads } = fixture();
      const workspaceIndex = createWorkspaceIndex();
      await searchText(scope, QUERY, LIMITS, { fs, workspaceIndex, nowMs: () => 0 });
      const outside = mkdtempSync(join(tmpdir(), "keiko-streaming-index-outside-"));
      roots.push(outside);
      const secret = join(outside, "manual.html");
      writeFileSync(secret, "Vesper temperature is 211 C.\n");
      const target = join(scope.workspace.root, "manual-11.html");
      unlinkSync(target);
      if (kind === "symlink") symlinkSync(secret, target);
      else linkSync(secret, target);
      reads.mockClear();
      const warm = await searchText(scope, QUERY, LIMITS, { fs, workspaceIndex, nowMs: () => 0 });
      expect(warm.atoms).toEqual([]);
      expect(reads.mock.calls.some(([path]) => path === secret || path === target)).toBe(false);
    },
  );

  it("does no index or workspace work for a pre-aborted request", async () => {
    const { scope, fs, reads } = fixture();
    const workspaceIndex = createWorkspaceIndex();
    await searchText(scope, QUERY, LIMITS, { fs, workspaceIndex, nowMs: () => 0 });
    const load = vi.spyOn(workspaceIndex, "loadSnapshot");
    const stat = vi.fn(fs.stat);
    reads.mockClear();
    const controller = new AbortController();
    controller.abort();
    const result = await searchText(scope, QUERY, LIMITS, {
      fs: { ...fs, stat },
      workspaceIndex,
      signal: controller.signal,
    });
    expect(result.coverage.reasons).toContain("aborted");
    expect(load).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
  });

  it("persists only encrypted matching metadata and reuses it through a new store instance", async () => {
    const { scope, fs, reads } = fixture();
    const runtimeDir = mkdtempSync(join(tmpdir(), "keiko-streaming-index-runtime-"));
    roots.push(runtimeDir);
    const index = (): WorkspaceIndex =>
      createWorkspaceIndex(
        createFileWorkspaceIndexStore({
          runtimeDir,
          workspaceRoot: scope.workspace.root,
          encryptionKey: Buffer.alloc(32, 31),
        }),
      );
    const cold = await searchText(scope, QUERY, LIMITS, {
      fs,
      workspaceIndex: index(),
      nowMs: () => 0,
    });
    for (const entry of readdirSync(runtimeDir)) {
      const encrypted = readFileSync(join(runtimeDir, entry), "utf8");
      expect(encrypted).not.toContain("Vesper");
      expect(encrypted).not.toContain("73.5");
      expect(encrypted).not.toContain("manual-11.html");
    }
    reads.mockClear();
    const warm = await searchText(scope, QUERY, LIMITS, {
      fs,
      workspaceIndex: index(),
      nowMs: () => 0,
    });
    expect(warm.atoms).toEqual(cold.atoms);
    expect(reads).not.toHaveBeenCalled();
    for (const entry of readdirSync(runtimeDir)) writeFileSync(join(runtimeDir, entry), "corrupt");
    reads.mockClear();
    const repaired = await searchText(scope, QUERY, LIMITS, {
      fs,
      workspaceIndex: index(),
      nowMs: () => 0,
    });
    expect(repaired.atoms).toEqual(cold.atoms);
    expect(reads).toHaveBeenCalledTimes(12);
  });

  it.each(["aborted", "timeout"])(
    "does no follow-on work after %s during an index load",
    async (reason) => {
      const { scope, fs, reads } = fixture();
      const workspaceIndex = createWorkspaceIndex();
      await searchText(scope, QUERY, LIMITS, { fs, workspaceIndex, nowMs: () => 0 });
      reads.mockClear();
      const controller = new AbortController();
      let now = 0;
      const save = vi.fn(workspaceIndex.saveSnapshot);
      const guarded: WorkspaceIndex = {
        saveSnapshot: save,
        loadSnapshot: async (key, isActive) => {
          const snapshot = await workspaceIndex.loadSnapshot(key, isActive);
          if (reason === "aborted") controller.abort();
          else now = 20;
          return snapshot;
        },
      };
      const result = await searchText(scope, QUERY, LIMITS, {
        fs,
        workspaceIndex: guarded,
        signal: controller.signal,
        nowMs: () => now,
        deadlineAtMs: 10,
      });
      expect(result.coverage.reasons).toContain(reason);
      expect(reads).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    },
  );

  it("does not make a partial per-file match scan authoritative on the next request", async () => {
    const { scope, fs, reads } = fixture();
    writeFileSync(join(scope.workspace.root, "manual-11.html"), "Vesper temperature\n".repeat(300));
    const workspaceIndex = createWorkspaceIndex();
    const cold = await searchText(
      scope,
      QUERY,
      { ...LIMITS, maxMatchesReturned: 2 },
      { fs, workspaceIndex, nowMs: () => 0 },
    );
    expect(cold.coverage.reasons).toContain("match-cap");
    const partialReadCount = reads.mock.calls.filter(([path]) =>
      path.endsWith("manual-11.html"),
    ).length;
    expect(partialReadCount).toBeGreaterThan(0);
    reads.mockClear();
    const warm = await searchText(
      scope,
      QUERY,
      { ...LIMITS, maxMatchesReturned: 2 },
      { fs, workspaceIndex, nowMs: () => 0 },
    );
    expect(warm.atoms).toEqual(cold.atoms);
    expect(warm.coverage.reasons).toContain("match-cap");
    expect(reads).toHaveBeenCalledTimes(partialReadCount);
    expect(reads.mock.calls.every(([path]) => path.endsWith("manual-11.html"))).toBe(true);
  });

  it("never treats cached paths as discovery authority for deletions or newly added files", async () => {
    const { scope, fs, reads } = fixture();
    const workspaceIndex = createWorkspaceIndex();
    await searchText(scope, QUERY, LIMITS, { fs, workspaceIndex, nowMs: () => 0 });
    unlinkSync(join(scope.workspace.root, "manual-11.html"));
    writeFileSync(join(scope.workspace.root, "new-manual.html"), "Vesper temperature is 49.0 C.\n");
    reads.mockClear();
    const warm = await searchText(scope, QUERY, LIMITS, { fs, workspaceIndex, nowMs: () => 0 });
    expect(warm.atoms.map((atom) => atom.scopePath)).toEqual(["new-manual.html"]);
    expect(reads).toHaveBeenCalledOnce();
  });

  it("keeps changed matching policy and byte grants live", async () => {
    const { scope, fs, reads } = fixture();
    const workspaceIndex = createWorkspaceIndex();
    await searchText(scope, QUERY, LIMITS, { fs, workspaceIndex, nowMs: () => 0 });
    reads.mockClear();
    await searchText(scope, QUERY, LIMITS, {
      fs,
      workspaceIndex,
      nowMs: () => 0,
      searchHints: { retrievalIntent: "project-metadata" },
    });
    expect(reads).toHaveBeenCalledTimes(12);
    const limited = { ...LIMITS, maxBytesPerFileScanned: 32 };
    reads.mockClear();
    const live = await searchText(scope, QUERY, limited, { fs, nowMs: () => 0 });
    const liveReads = reads.mock.calls.length;
    reads.mockClear();
    const cached = await searchText(scope, QUERY, limited, { fs, workspaceIndex, nowMs: () => 0 });
    expect(cached.atoms).toEqual(live.atoms);
    expect(reads).toHaveBeenCalledTimes(liveReads);
  });

  it.each(["load", "save"])(
    "keeps live source search available when index %s throws",
    async (stage) => {
      const { scope, fs } = fixture();
      const live = await searchText(scope, QUERY, LIMITS, { fs, nowMs: () => 0 });
      const workspaceIndex = createWorkspaceIndex();
      const failing: WorkspaceIndex = {
        loadSnapshot: async (key, isActive) => {
          if (stage === "load") throw new Error("synthetic index load failure");
          return workspaceIndex.loadSnapshot(key, isActive);
        },
        saveSnapshot: async (key, snapshot, isActive) => {
          if (stage === "save") throw new Error("synthetic index save failure");
          await workspaceIndex.saveSnapshot(key, snapshot, isActive);
        },
      };
      const result = await searchText(scope, QUERY, LIMITS, {
        fs,
        workspaceIndex: failing,
        nowMs: () => 0,
      });
      expect(result.atoms).toEqual(live.atoms);
      expect(result.coverage).toEqual(live.coverage);
    },
  );

  it.each([false, true])(
    "reports finalization time and timeout truthfully (deadline=%s)",
    async (bounded) => {
      const { scope, fs } = fixture();
      const workspaceIndex = createWorkspaceIndex();
      let now = 0;
      const save = vi.fn((): Promise<void> => {
        now = 20;
        return Promise.resolve();
      });
      const result = await searchText(scope, QUERY, LIMITS, {
        fs,
        workspaceIndex: { loadSnapshot: workspaceIndex.loadSnapshot, saveSnapshot: save },
        nowMs: () => now,
        ...(bounded ? { deadlineAtMs: 10 } : {}),
      });
      expect(save).toHaveBeenCalled();
      expect(result.elapsedMs).toBe(20);
      expect(result.coverage.elapsedMs).toBe(20);
      expect(result.coverage.reasons.includes("timeout")).toBe(bounded);
      expect(result.truncated).toBe(bounded);
      if (bounded) expect(save).toHaveBeenCalledOnce();
    },
  );

  it("counts a cached record as reused only after live post-load identity revalidation", async () => {
    const { scope, fs, reads } = fixture();
    for (let index = 0; index < 11; index += 1)
      unlinkSync(join(scope.workspace.root, `manual-${String(index)}.html`));
    const workspaceIndex = createWorkspaceIndex();
    await searchText(scope, QUERY, LIMITS, { fs, workspaceIndex, nowMs: () => 0 });
    reads.mockClear();
    const result = await searchText(scope, QUERY, LIMITS, {
      fs,
      nowMs: () => 0,
      workspaceIndex: {
        saveSnapshot: workspaceIndex.saveSnapshot,
        loadSnapshot: async (key, isActive) => {
          const snapshot = await workspaceIndex.loadSnapshot(key, isActive);
          writeFileSync(
            join(scope.workspace.root, "manual-11.html"),
            "Vesper temperature is now 19.2 C.\n",
          );
          return snapshot;
        },
      },
    });
    expect(result.atoms[0]?.scopePath).toBe("manual-11.html");
    expect(reads).toHaveBeenCalledOnce();
    expect(result.workspaceIndex?.reusedRecords).toBe(0);
  });

  it("distinguishes complete discovery from bounded retained matching records", async () => {
    const { scope, fs } = fixture();
    writeFileSync(join(scope.workspace.root, "manual-11.html"), "Vesper temperature\n".repeat(130));
    const result = await searchText(scope, { ...QUERY, maxResults: 200 }, LIMITS, {
      fs,
      workspaceIndex: createWorkspaceIndex(),
      nowMs: () => 0,
    });
    expect(result.filesScanned).toBe(12);
    expect(result.coverage.reasons).not.toContain("match-cap");
    expect(result.workspaceIndex).toMatchObject({
      discoveredEntries: 12,
      retainedEntries: 11,
      indexedRecords: 11,
      droppedRecords: 1,
    });
  });

  it.each(["load", "save"])(
    "returns on abort without waiting for a delayed index %s",
    async (stage) => {
      const { scope, fs } = fixture();
      const entered = deferred();
      const pending = deferred();
      const controller = new AbortController();
      const index = createWorkspaceIndex();
      const pause = async (): Promise<void> => {
        entered.resolve();
        await pending.promise;
      };
      const running = searchText(scope, QUERY, LIMITS, {
        fs,
        signal: controller.signal,
        workspaceIndex: {
          loadSnapshot: async (key, isActive) => {
            if (stage === "load") await pause();
            return index.loadSnapshot(key, isActive);
          },
          saveSnapshot: async (key, snapshot, isActive) => {
            if (stage === "save") await pause();
            await index.saveSnapshot(key, snapshot, isActive);
          },
        },
      });
      await entered.promise;
      controller.abort();
      const returnedBeforeRelease = await Promise.race([
        running.then(() => true),
        new Promise<boolean>((resolve) => {
          setTimeout(() => {
            resolve(false);
          }, 20);
        }),
      ]);
      pending.resolve();
      const result = await running;
      expect(returnedBeforeRelease).toBe(true);
      expect(result.coverage.reasons).toContain("aborted");
    },
  );

  it("does not accept or count a cached match when final live metadata validation consumes its deadline", async () => {
    const { scope, fs, reads } = fixture();
    for (let index = 0; index < 11; index += 1)
      unlinkSync(join(scope.workspace.root, `manual-${String(index)}.html`));
    const index = createWorkspaceIndex();
    await searchText(scope, QUERY, LIMITS, { fs, workspaceIndex: index, nowMs: () => 0 });
    reads.mockClear();
    let loaded = false;
    let now = 0;
    const result = await searchText(scope, QUERY, LIMITS, {
      fs: {
        ...fs,
        stat: (path) => {
          if (loaded && path.endsWith("manual-11.html")) now = 20;
          return fs.stat(path);
        },
      },
      workspaceIndex: {
        saveSnapshot: index.saveSnapshot,
        loadSnapshot: async (key, isActive) => {
          const snapshot = await index.loadSnapshot(key, isActive);
          loaded = true;
          return snapshot;
        },
      },
      nowMs: () => now,
      deadlineAtMs: 10,
    });
    expect(result.atoms).toEqual([]);
    expect(result.workspaceIndex?.reusedRecords).toBe(0);
    expect(result.coverage.reasons).toContain("timeout");
    expect(reads).not.toHaveBeenCalled();
  });
});
