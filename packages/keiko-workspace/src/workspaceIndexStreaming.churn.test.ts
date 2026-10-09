import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { detectWorkspaceAt } from "./detect.js";
import { nodeWorkspaceFs, type WorkspaceFs } from "./fs.js";
import { DEFAULT_SEARCH_LIMITS, searchText, type SearchScope } from "./repoSearch.js";
import {
  DEFAULT_FILE_WORKSPACE_INDEX_MAX_SNAPSHOT_ENTRIES,
  createFileWorkspaceIndexStore,
  createWorkspaceIndex,
  type WorkspaceIndexScopeKey,
  type WorkspaceIndexSnapshot,
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
const NOW = (): number => 0;

interface ChurnFixture {
  readonly scope: SearchScope;
  readonly fs: typeof nodeWorkspaceFs;
  readonly reads: ReturnType<typeof vi.fn<NonNullable<typeof nodeWorkspaceFs.readFileBytes>>>;
  readonly index: ReturnType<typeof createWorkspaceIndex>;
  readonly reopen: () => ReturnType<typeof createWorkspaceIndex>;
  readonly key: WorkspaceIndexScopeKey;
}

function indexFixture(persistent: boolean): {
  readonly index: ReturnType<typeof createWorkspaceIndex>;
  readonly reopen: () => ReturnType<typeof createWorkspaceIndex>;
} {
  if (!persistent) {
    const index = createWorkspaceIndex();
    return { index, reopen: () => index };
  }
  const runtimeDir = realpathSync(mkdtempSync(join(tmpdir(), "keiko-index-churn-encrypted-")));
  roots.push(runtimeDir);
  const reopen = (): ReturnType<typeof createWorkspaceIndex> =>
    createWorkspaceIndex(
      createFileWorkspaceIndexStore({ runtimeDir, encryptionKey: Buffer.alloc(32, 31) }),
    );
  return { index: reopen(), reopen };
}

async function fullRetiredShard(persistent = false): Promise<ChurnFixture> {
  const root = mkdtempSync(join(tmpdir(), "keiko-streaming-index-churn-"));
  roots.push(root);
  writeFileSync(join(root, "manual.html"), "Vesper temperature is 73.5 C.\n");
  const scope: SearchScope = {
    workspace: detectWorkspaceAt(root, undefined, { scanSourceFilesForLanguages: false }),
    scopeId: "churn",
    relativePaths: [],
  };
  const reads = vi.fn(nodeWorkspaceFs.readFileBytes);
  const fs = { ...nodeWorkspaceFs, readFileBytes: reads };
  const { index, reopen } = indexFixture(persistent);
  const first = await producedSnapshot(scope, fs, index);
  const records = retiredRecords(first.snapshot);
  await index.saveSnapshot(first.key, {
    ...first.snapshot,
    records,
    discovery: { ...first.snapshot.discovery, files: records, filesDiscovered: records.length },
  });
  expect((await reopen().loadSnapshot(first.key))?.records).toHaveLength(records.length);
  reads.mockClear();
  return { scope, fs, reads, index, reopen, key: first.key };
}

async function producedSnapshot(
  scope: SearchScope,
  fs: WorkspaceFs,
  index: ReturnType<typeof createWorkspaceIndex>,
): Promise<{ readonly key: WorkspaceIndexScopeKey; readonly snapshot: WorkspaceIndexSnapshot }> {
  const saved: { key: WorkspaceIndexScopeKey; snapshot: WorkspaceIndexSnapshot }[] = [];
  await searchText(scope, QUERY, LIMITS, {
    fs,
    nowMs: NOW,
    workspaceIndex: {
      loadSnapshot: index.loadSnapshot,
      saveSnapshot: async (key, snapshot, active) => {
        saved.push({ key, snapshot });
        await index.saveSnapshot(key, snapshot, active);
      },
    },
  });
  const first = saved[0];
  if (first === undefined) throw new TypeError("Expected a production matching snapshot");
  return first;
}

function retiredRecords(snapshot: WorkspaceIndexSnapshot): WorkspaceIndexSnapshot["records"] {
  const original = snapshot.records[0];
  if (original === undefined) throw new TypeError("Expected a production matching record");
  // A bounded provider fixture represents prior files that no longer exist. Matching metadata
  // and its query/scope identity come from the actual producer, never a copied scoring formula.
  return Array.from(
    { length: DEFAULT_FILE_WORKSPACE_INDEX_MAX_SNAPSHOT_ENTRIES / 2 },
    (_value, index) => ({ ...original, scopePath: `retired-${String(index)}.html` }),
  );
}

describe("bounded matching-index capacity under ordinary-folder churn", () => {
  it.each([false, true])(
    "recovers reusable capacity after churn (encrypted=%s)",
    async (encrypted) => {
      const { scope, fs, reads, reopen } = await fullRetiredShard(encrypted);
      const first = await searchText(scope, QUERY, LIMITS, {
        fs,
        workspaceIndex: reopen(),
        nowMs: NOW,
      });
      expect(first.filesScanned).toBe(1);
      expect(first.coverage.reasons).toEqual([]);
      expect(first.coverage.incomplete).toBe(false);
      expect(first.atoms[0]?.scopePath).toBe("manual.html");
      expect(first.workspaceIndex).toMatchObject({
        indexedRecords: 0,
        droppedRecords: 1,
        deletedEntries: 0,
      });
      expect(reads).toHaveBeenCalledOnce();
      const second = await searchText(scope, QUERY, LIMITS, {
        fs,
        workspaceIndex: reopen(),
        nowMs: NOW,
      });
      expect(second.atoms).toEqual(first.atoms);
      reads.mockClear();
      const warm = await searchText(scope, QUERY, LIMITS, {
        fs,
        workspaceIndex: reopen(),
        nowMs: NOW,
      });
      expect(warm.atoms).toEqual(first.atoms);
      expect(warm.filesScanned).toBe(1);
      expect(warm.workspaceIndex).toMatchObject({ reusedRecords: 1 });
      expect(reads).not.toHaveBeenCalled();
    },
  );

  it("does not prune encrypted metadata after a partially enumerated directory fails", async () => {
    const { scope, fs, reads, reopen, key } = await fullRetiredShard(true);
    const before = await reopen().loadSnapshot(key);
    writeFileSync(join(scope.workspace.root, "retired-0.html"), "Vesper temperature is 94.8 C.\n");
    const iterateDirectory = fs.iterateDirectory;
    if (iterateDirectory === undefined) throw new TypeError("Expected the real streaming reader");
    const partial: WorkspaceFs = {
      ...fs,
      iterateDirectory: async function* (path) {
        for await (const entry of iterateDirectory(path)) {
          if (entry.name !== "manual.html") continue;
          yield entry;
          break;
        }
        throw Object.assign(new Error("Directory enumeration failed"), { code: "EACCES" });
      },
    };
    await expect(
      searchText(scope, QUERY, LIMITS, { fs: partial, workspaceIndex: reopen(), nowMs: NOW }),
    ).rejects.toThrow();
    expect(await reopen().loadSnapshot(key)).toEqual(before);
    reads.mockClear();
    const complete = await searchText(scope, QUERY, LIMITS, {
      fs,
      workspaceIndex: reopen(),
      nowMs: NOW,
    });
    expect(complete.filesScanned).toBe(2);
    expect(complete.coverage.incomplete).toBe(false);
    expect(complete.atoms.map((atom) => atom.scopePath)).toContain("retired-0.html");
    expect(reads.mock.calls.some(([path]) => path.endsWith("retired-0.html"))).toBe(true);
    expect(complete.workspaceIndex?.deletedEntries).toBe(0);
  });

  it.each(["aborted", "timeout"])(
    "does not prune encrypted metadata when a real body read ends the request (%s)",
    async (reason) => {
      const { scope, fs, reopen, key } = await fullRetiredShard(true);
      const before = await reopen().loadSnapshot(key);
      const controller = new AbortController();
      let now = 0;
      const readFileBytes = vi.fn(
        async (...args: Parameters<NonNullable<WorkspaceFs["readFileBytes"]>>) => {
          const bytes = await fs.readFileBytes?.(...args);
          if (reason === "aborted") controller.abort();
          else now = 20;
          if (bytes === undefined) throw new TypeError("Expected the real body reader");
          return bytes;
        },
      );
      const result = await searchText(scope, QUERY, LIMITS, {
        fs: { ...fs, readFileBytes },
        workspaceIndex: reopen(),
        nowMs: () => now,
        deadlineAtMs: 10,
        signal: controller.signal,
      });
      expect(result.coverage.reasons).toContain(reason);
      expect(readFileBytes).toHaveBeenCalledOnce();
      expect(await reopen().loadSnapshot(key)).toEqual(before);
    },
  );

  it("does not prune an existing bounded snapshot after request cancellation", async () => {
    const { scope, fs, reads, index, key } = await fullRetiredShard();
    const before = await index.loadSnapshot(key);
    const controller = new AbortController();
    controller.abort();
    const result = await searchText(scope, QUERY, LIMITS, {
      fs,
      workspaceIndex: index,
      signal: controller.signal,
    });
    expect(result.coverage.reasons).toContain("aborted");
    expect(reads).not.toHaveBeenCalled();
    expect(await index.loadSnapshot(key)).toEqual(before);
  });
});
