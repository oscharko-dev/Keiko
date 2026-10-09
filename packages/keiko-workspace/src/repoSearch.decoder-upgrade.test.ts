import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LEGACY_DECODER_MATCH_SNAPSHOT } from "../../../tests/fixtures/connected-retrieval-index/decoder-v8-negative-snapshot.js";
import { memFs } from "./_memfs.js";
import { detectWorkspaceAt } from "./detect.js";
import { type WorkspaceFs } from "./fs.js";
import { DEFAULT_SEARCH_LIMITS, readExcerpt, searchText, type SearchScope } from "./repoSearch.js";
import {
  createFileWorkspaceIndexStore,
  createWorkspaceIndex,
  type WorkspaceIndexSnapshot,
  type WorkspaceIndexStore,
} from "./workspaceIndex.js";

const MANUAL =
  "<script>const sample = '<meta charset=\"windows-1252\">';</script>\n" +
  '<meta charset="utf-8">\n<p>Ölwechsel 937 hours</p>\n';
const QUERY = {
  kind: "natural-language",
  text: "Ölwechsel",
  caseSensitive: false,
  maxResults: 20,
  emittedAtMs: 0,
} as const;
const LIMITS = { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: null, elapsedMsMax: null };
const NOW = (): number => 0;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): {
  readonly scope: SearchScope;
  readonly fs: WorkspaceFs;
  readonly files: Record<string, string>;
  readonly reads: ReturnType<typeof vi.fn<NonNullable<WorkspaceFs["readFileBytes"]>>>;
} {
  const files = { "manual.html": MANUAL };
  const base = memFs("/ws", files);
  const reads = vi.fn(base.readFileBytes);
  const fs: WorkspaceFs = {
    ...base,
    readFileBytes: reads,
    stat: (path) => {
      const stat = base.stat(path);
      return stat.isFile ? { ...stat, fileIdentity: "decoder-upgrade:manual" } : stat;
    },
  };
  return {
    scope: {
      workspace: detectWorkspaceAt("/ws", fs, { scanSourceFilesForLanguages: false }),
      scopeId: "manuals",
      relativePaths: [],
    },
    fs,
    files,
    reads,
  };
}

function persistence(initial?: WorkspaceIndexSnapshot): WorkspaceIndexStore {
  const snapshots = new Map<string, WorkspaceIndexSnapshot>();
  return {
    loadSnapshot: vi.fn((key: string) => snapshots.get(key) ?? initial),
    saveSnapshot: vi.fn((key: string, snapshot: WorkspaceIndexSnapshot) => {
      snapshots.set(key, snapshot);
    }),
  };
}

describe("decoder upgrades cannot reuse historical negative matching authority", () => {
  it("rereads the unchanged UTF-8 manual rather than reusing its actual old-decoder negative", async () => {
    const { scope, fs, reads } = fixture();
    const fresh = await searchText(scope, QUERY, LIMITS, { fs, nowMs: NOW });
    expect(fresh.atoms[0]).toMatchObject({
      scopePath: "manual.html",
      lineRange: { startLine: 3, endLine: 3 },
    });
    const store = persistence(LEGACY_DECODER_MATCH_SNAPSHOT);
    reads.mockClear();
    const upgraded = await searchText(scope, QUERY, LIMITS, {
      fs,
      workspaceIndex: createWorkspaceIndex(store),
      nowMs: NOW,
    });
    expect(upgraded.atoms).toEqual(fresh.atoms);
    expect(upgraded.coverage).toEqual(fresh.coverage);
    expect(upgraded.workspaceIndex).toMatchObject({ indexedRecords: 1, reusedRecords: 0 });
    expect(reads).toHaveBeenCalledOnce();
  });

  it("retains same-version persistence reuse while selected physical evidence stays live", async () => {
    const { scope, fs, reads } = fixture();
    const store = persistence();
    const cold = await searchText(scope, QUERY, LIMITS, {
      fs,
      workspaceIndex: createWorkspaceIndex(store),
      nowMs: NOW,
    });
    expect(reads).toHaveBeenCalledOnce();
    reads.mockClear();
    const warm = await searchText(scope, QUERY, LIMITS, {
      fs,
      workspaceIndex: createWorkspaceIndex(store),
      nowMs: NOW,
    });
    expect(warm.atoms).toEqual(cold.atoms);
    expect(warm.workspaceIndex).toMatchObject({ reusedRecords: 1, indexedRecords: 0 });
    expect(reads).not.toHaveBeenCalled();
    const excerpt = await readExcerpt(
      scope,
      {
        scopePath: "manual.html",
        startLine: 3,
        endLine: 3,
        maxBytes: 512,
      },
      { fs },
    );
    expect(excerpt.content).toBe("<p>Ölwechsel 937 hours</p>");
  });

  it("does not resurrect a deleted historical negative record", async () => {
    const { scope, fs, files, reads } = fixture();
    delete files["manual.html"];
    const result = await searchText(scope, QUERY, LIMITS, {
      fs,
      workspaceIndex: createWorkspaceIndex(persistence(LEGACY_DECODER_MATCH_SNAPSHOT)),
      nowMs: NOW,
    });
    expect(result.atoms).toEqual([]);
    expect(result.filesScanned).toBe(0);
    expect(result.coverage.incomplete).toBe(false);
    expect(reads).not.toHaveBeenCalled();
  });

  it("retains live fallback when the historical file has changed", async () => {
    const { scope, fs, files, reads } = fixture();
    files["manual.html"] = MANUAL.replace("937", "211");
    const result = await searchText(scope, QUERY, LIMITS, {
      fs,
      workspaceIndex: createWorkspaceIndex(persistence(LEGACY_DECODER_MATCH_SNAPSHOT)),
      nowMs: NOW,
    });
    expect(result.atoms[0]?.scopePath).toBe("manual.html");
    expect(reads).toHaveBeenCalledOnce();
  });

  it("does not read or save after abort while loading the historical snapshot", async () => {
    const { scope, fs, reads } = fixture();
    const controller = new AbortController();
    const saveSnapshot = vi.fn();
    const result = await searchText(scope, QUERY, LIMITS, {
      fs,
      workspaceIndex: createWorkspaceIndex({
        loadSnapshot: async () => {
          await Promise.resolve();
          controller.abort();
          return LEGACY_DECODER_MATCH_SNAPSHOT;
        },
        saveSnapshot,
      }),
      signal: controller.signal,
      nowMs: NOW,
    });
    expect(result.coverage.reasons).toContain("aborted");
    expect(result.atoms).toEqual([]);
    expect(reads).not.toHaveBeenCalled();
    expect(saveSnapshot).not.toHaveBeenCalled();
  });

  it("keeps encrypted current-version warm reuse and corruption fallback", async () => {
    const { scope, fs, reads } = fixture();
    const runtimeDir = mkdtempSync(join(tmpdir(), "keiko-decoder-upgrade-index-"));
    roots.push(runtimeDir);
    const index = (): ReturnType<typeof createWorkspaceIndex> =>
      createWorkspaceIndex(
        createFileWorkspaceIndexStore({
          runtimeDir,
          encryptionKey: Buffer.alloc(32, 31),
        }),
      );
    const cold = await searchText(scope, QUERY, LIMITS, {
      fs,
      workspaceIndex: index(),
      nowMs: NOW,
    });
    reads.mockClear();
    const warm = await searchText(scope, QUERY, LIMITS, {
      fs,
      workspaceIndex: index(),
      nowMs: NOW,
    });
    expect(warm.atoms).toEqual(cold.atoms);
    expect(reads).not.toHaveBeenCalled();
    const entries = readdirSync(runtimeDir).filter((entry) => entry.endsWith(".json"));
    expect(entries).toHaveLength(1);
    for (const entry of entries) {
      const path = join(runtimeDir, entry);
      expect(readFileSync(path, "utf8")).not.toContain("Ölwechsel");
      writeFileSync(path, "corrupt");
    }
    const fallback = await searchText(scope, QUERY, LIMITS, {
      fs,
      workspaceIndex: index(),
      nowMs: NOW,
    });
    expect(fallback.atoms).toEqual(cold.atoms);
    expect(reads).toHaveBeenCalledOnce();
  });
});
