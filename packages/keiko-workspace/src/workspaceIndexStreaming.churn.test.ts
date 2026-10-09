import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { detectWorkspaceAt } from "./detect.js";
import { nodeWorkspaceFs } from "./fs.js";
import { DEFAULT_SEARCH_LIMITS, searchText, type SearchScope } from "./repoSearch.js";
import {
  DEFAULT_FILE_WORKSPACE_INDEX_MAX_SNAPSHOT_ENTRIES,
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

async function fullRetiredShard(): Promise<{
  readonly scope: SearchScope;
  readonly fs: typeof nodeWorkspaceFs;
  readonly reads: ReturnType<typeof vi.fn<NonNullable<typeof nodeWorkspaceFs.readFileBytes>>>;
  readonly index: ReturnType<typeof createWorkspaceIndex>;
  readonly key: WorkspaceIndexScopeKey;
}> {
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
  const index = createWorkspaceIndex();
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
  const original = first?.snapshot.records[0];
  if (first === undefined || original === undefined)
    throw new TypeError("Expected a production matching record");
  // A bounded provider fixture represents prior files that no longer exist. Matching metadata
  // and its query/scope identity come from the actual producer, never a copied scoring formula.
  const records = Array.from(
    { length: DEFAULT_FILE_WORKSPACE_INDEX_MAX_SNAPSHOT_ENTRIES / 2 },
    (_value, index) => ({ ...original, scopePath: `retired-${String(index)}.html` }),
  );
  await index.saveSnapshot(first.key, {
    ...first.snapshot,
    records,
    discovery: { ...first.snapshot.discovery, files: records, filesDiscovered: records.length },
  });
  expect((await index.loadSnapshot(first.key))?.records).toHaveLength(records.length);
  reads.mockClear();
  return { scope, fs, reads, index, key: first.key };
}

describe("bounded matching-index capacity under ordinary-folder churn", () => {
  it("recovers reusable capacity after previously retained paths leave the fresh scope", async () => {
    const { scope, fs, reads, index } = await fullRetiredShard();
    const first = await searchText(scope, QUERY, LIMITS, { fs, workspaceIndex: index, nowMs: NOW });
    expect(first.filesScanned).toBe(1);
    expect(first.coverage.reasons).toEqual([]);
    expect(first.atoms[0]?.scopePath).toBe("manual.html");
    expect(first.workspaceIndex).toMatchObject({ indexedRecords: 0, droppedRecords: 1 });
    expect(reads).toHaveBeenCalledOnce();
    const second = await searchText(scope, QUERY, LIMITS, {
      fs,
      workspaceIndex: index,
      nowMs: NOW,
    });
    expect(second.atoms).toEqual(first.atoms);
    reads.mockClear();
    const warm = await searchText(scope, QUERY, LIMITS, { fs, workspaceIndex: index, nowMs: NOW });
    expect(warm.atoms).toEqual(first.atoms);
    expect(warm.filesScanned).toBe(1);
    expect(warm.workspaceIndex).toMatchObject({ reusedRecords: 1 });
    expect(reads).not.toHaveBeenCalled();
  });

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
