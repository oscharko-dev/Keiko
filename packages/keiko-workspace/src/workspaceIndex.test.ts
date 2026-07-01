import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkspaceDirEntry, WorkspaceFs, WorkspaceStat } from "./fs.js";
import {
  DEFAULT_SEARCH_LIMITS,
  searchText,
  type SearchScope,
} from "./repoSearch.js";
import { resolveSearchPolicy } from "./repoSearchPolicy.js";
import type { WorkspaceInfo } from "./types.js";
import {
  buildWorkspaceIndexSnapshot,
  buildWorkspaceIndexScopeKey,
  createFileWorkspaceIndexStore,
  createWorkspaceIndex,
  prepareWorkspaceIndexSnapshot,
  type WorkspaceIndex,
  type WorkspaceIndexStore,
  type WorkspaceIndexSnapshot,
} from "./workspaceIndex.js";

const MEM_ROOT = "/ws";
const FIXED_NOW: () => number = () => 1_700_000_000_000;

interface MutableTrackedFs {
  readonly counters: {
    readDir: number;
    readFileUtf8: number;
    readFileBytes: number;
    stat: number;
    exists: number;
    realPath: number;
  };
  readonly fs: WorkspaceFs;
  readonly deleteFile: (scopePath: string) => void;
  readonly resetCounters: () => void;
  readonly writeFile: (scopePath: string, content: string) => void;
}

function workspace(): WorkspaceInfo {
  return {
    root: MEM_ROOT,
    name: "demo",
    version: "1.0.0",
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: ["tests"],
    languages: ["typescript", "javascript"],
    ignoreLines: [],
  };
}

function scope(): SearchScope {
  return {
    workspace: workspace(),
    scopeId: "scope-1",
    relativePaths: [],
  };
}

function nlq(text: string): {
  readonly kind: "natural-language";
  readonly text: string;
  readonly caseSensitive: false;
  readonly maxResults: number;
  readonly emittedAtMs: number;
} {
  return {
    kind: "natural-language" as const,
    text,
    caseSensitive: false,
    maxResults: 100,
    emittedAtMs: 0,
  };
}

function makeErrnoError(code: string, path: string): Error & { code: string } {
  const err = new Error(`${code}: ${path}`) as Error & { code: string };
  err.code = code;
  return err;
}

function absoluteToRelative(absolutePath: string): string | undefined {
  if (absolutePath === MEM_ROOT) {
    return "";
  }
  if (!absolutePath.startsWith(`${MEM_ROOT}/`)) {
    return undefined;
  }
  return absolutePath.slice(MEM_ROOT.length + 1);
}

function directoryEntries(files: ReadonlyMap<string, { content: string }>, dirRel: string): readonly WorkspaceDirEntry[] {
  const prefix = dirRel.length === 0 ? "" : `${dirRel}/`;
  const dirs = new Set<string>();
  const plainFiles = new Set<string>();
  for (const key of files.keys()) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    const rest = key.slice(prefix.length);
    if (rest.length === 0) {
      continue;
    }
    const slash = rest.indexOf("/");
    if (slash === -1) {
      plainFiles.add(rest);
      continue;
    }
    dirs.add(rest.slice(0, slash));
  }
  return [...dirs, ...plainFiles]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((name) => ({
      name,
      isDirectory: dirs.has(name),
      isFile: plainFiles.has(name),
      isSymbolicLink: false,
    }));
}

function createTrackedFs(initialFiles: Readonly<Record<string, string>>): MutableTrackedFs {
  let nextMtimeMs = 1_000;
  const files = new Map<string, { content: string; mtimeMs: number }>();
  for (const [scopePath, content] of Object.entries(initialFiles)) {
    files.set(scopePath, { content, mtimeMs: nextMtimeMs });
    nextMtimeMs += 1;
  }
  const counters = {
    readDir: 0,
    readFileUtf8: 0,
    readFileBytes: 0,
    stat: 0,
    exists: 0,
    realPath: 0,
  };
  const statDir = (): WorkspaceStat => ({
    size: 0,
    isFile: false,
    isDirectory: true,
    isSymbolicLink: false,
  });
  const fileAt = (absolutePath: string): { readonly scopePath: string; readonly content: string; readonly mtimeMs: number } | undefined => {
    const scopePath = absoluteToRelative(absolutePath);
    if (scopePath === undefined) {
      return undefined;
    }
    const file = files.get(scopePath);
    return file === undefined ? undefined : { scopePath, content: file.content, mtimeMs: file.mtimeMs };
  };
  const directoryExists = (absolutePath: string): boolean => {
    const scopePath = absoluteToRelative(absolutePath);
    if (scopePath === undefined) {
      return false;
    }
    if (scopePath.length === 0) {
      return true;
    }
    for (const key of files.keys()) {
      if (key === scopePath || key.startsWith(`${scopePath}/`)) {
        return true;
      }
    }
    return false;
  };
  return {
    counters,
    fs: {
      readFileUtf8: (absolutePath: string): string => {
        counters.readFileUtf8 += 1;
        const file = fileAt(absolutePath);
        if (file === undefined) {
          throw makeErrnoError("ENOENT", absolutePath);
        }
        return file.content;
      },
      stat: (absolutePath: string): WorkspaceStat => {
        counters.stat += 1;
        const file = fileAt(absolutePath);
        if (file !== undefined) {
          return {
            size: Buffer.byteLength(file.content, "utf8"),
            isFile: true,
            isDirectory: false,
            isSymbolicLink: false,
            mtimeMs: file.mtimeMs,
          };
        }
        if (directoryExists(absolutePath)) {
          return statDir();
        }
        throw makeErrnoError("ENOENT", absolutePath);
      },
      readDir: (absolutePath: string): readonly WorkspaceDirEntry[] => {
        counters.readDir += 1;
        if (!directoryExists(absolutePath)) {
          throw makeErrnoError("ENOENT", absolutePath);
        }
        const dirRel = absoluteToRelative(absolutePath);
        if (dirRel === undefined) {
          throw makeErrnoError("ENOENT", absolutePath);
        }
        return directoryEntries(files, dirRel);
      },
      realPath: (absolutePath: string): string => {
        counters.realPath += 1;
        return absolutePath;
      },
      exists: (absolutePath: string): boolean => {
        counters.exists += 1;
        return fileAt(absolutePath) !== undefined || directoryExists(absolutePath);
      },
      readFileBytes: (absolutePath: string, maxBytes: number): Promise<Uint8Array> => {
        counters.readFileBytes += 1;
        const file = fileAt(absolutePath);
        if (file === undefined) {
          throw makeErrnoError("ENOENT", absolutePath);
        }
        return Promise.resolve(
          new TextEncoder()
            .encode(file.content)
            .subarray(0, Math.max(0, Math.trunc(maxBytes))),
        );
      },
    },
    deleteFile: (scopePath: string): void => {
      files.delete(scopePath);
    },
    resetCounters: (): void => {
      counters.readDir = 0;
      counters.readFileUtf8 = 0;
      counters.readFileBytes = 0;
      counters.stat = 0;
      counters.exists = 0;
      counters.realPath = 0;
    },
    writeFile: (scopePath: string, content: string): void => {
      files.set(scopePath, { content, mtimeMs: nextMtimeMs });
      nextMtimeMs += 1;
    },
  };
}

async function snapshotFor(index: WorkspaceIndex, currentScope: SearchScope): Promise<WorkspaceIndexSnapshot | undefined> {
  const policy = resolveSearchPolicy(currentScope.relativePaths.length > 0, undefined);
  return await index.loadSnapshot(
    buildWorkspaceIndexScopeKey(
      currentScope,
      {
        policyMode: policy.mode,
        applyGitignore: policy.applyGitignore,
        omitLowValueWorkspaceFiles: policy.omitLowValueWorkspaceFiles,
      },
      DEFAULT_SEARCH_LIMITS.maxBytesPerFileScanned,
    ),
  );
}

function tempRuntimeDir(): string {
  return mkdtempSync(join(tmpdir(), "keiko-workspace-index-"));
}

function removeRuntimeDir(runtimeDir: string): void {
  rmSync(runtimeDir, { force: true, recursive: true });
}

function runtimeFiles(runtimeDir: string): readonly string[] {
  return readdirSync(runtimeDir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function sampleSnapshot(content: string): WorkspaceIndexSnapshot {
  return buildWorkspaceIndexSnapshot({
    scope: { relativePaths: [] },
    policy: {
      policyMode: "workspace-root-default",
      applyGitignore: true,
      omitLowValueWorkspaceFiles: true,
    },
    maxBytesPerFileScanned: DEFAULT_SEARCH_LIMITS.maxBytesPerFileScanned,
    discovery: {
      files: [{ scopePath: "src/app.ts", sizeBytes: Buffer.byteLength(content, "utf8") }],
      filesDiscovered: 1,
      ignoredByDiscovery: 0,
      deniedByDiscovery: 0,
      depthPrunedByDiscovery: 0,
      truncated: false,
    },
    records: [
      {
        scopePath: "src/app.ts",
        sizeBytes: Buffer.byteLength(content, "utf8"),
        kind: "text",
        content,
      },
    ],
  });
}

describe("workspaceIndex", () => {
  it("reuses unchanged indexed files without rewalking or rereading", async () => {
    const tracked = createTrackedFs({
      "README.md": "needle in docs\n",
      "src/a.ts": "export const alpha = 'needle';\n",
      "src/b.ts": "export const beta = 'other';\n",
    });
    const currentScope = scope();
    const index = createWorkspaceIndex();

    const first = await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });
    expect(first.atoms.map((atom) => atom.scopePath)).toEqual(["README.md", "src/a.ts"]);

    tracked.resetCounters();
    const second = await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });

    expect(second.atoms.map((atom) => atom.scopePath)).toEqual(["README.md", "src/a.ts"]);
    expect(tracked.counters.readDir).toBe(0);
    expect(tracked.counters.readFileUtf8).toBe(0);
    expect(tracked.counters.readFileBytes).toBe(0);
  });

  it("rebuilds only stale changed records on a warm query", async () => {
    const tracked = createTrackedFs({
      "src/a.ts": "export const alpha = 'needle';\n",
      "src/b.ts": "export const beta = 'other';\n",
    });
    const currentScope = scope();
    const index = createWorkspaceIndex();

    await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });

    tracked.writeFile("src/b.ts", "export const beta = 'needle';\n");
    tracked.resetCounters();

    const result = await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });

    expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(tracked.counters.readDir).toBe(0);
    expect(tracked.counters.readFileUtf8).toBe(1);
    expect(tracked.counters.readFileBytes).toBe(1);
  });

  it("reports retained, reused, stale, deleted, skipped, and dropped counts without exposing paths", async () => {
    const tracked = createTrackedFs({
      "src/a.ts": "export const alpha = 'needle';\n",
      "src/b.ts": "export const beta = 'other';\n",
    });
    const currentScope = scope();
    const index = createWorkspaceIndex();

    await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });
    tracked.writeFile("src/b.ts", "export const beta = 'needle';\n");
    tracked.deleteFile("src/a.ts");

    const snapshot = await snapshotFor(index, currentScope);
    if (snapshot === undefined) {
      throw new Error("expected snapshot to exist");
    }
    const prepared = prepareWorkspaceIndexSnapshot(snapshot, currentScope.workspace, tracked.fs);

    expect(prepared.entries.map((entry) => entry.scopePath)).toEqual(["src/b.ts"]);
    expect(prepared.report).toEqual({
      discoveredEntries: 2,
      retainedEntries: 1,
      indexedRecords: 1,
      reusedRecords: 0,
      staleRecords: 1,
      skippedEntries: 0,
      deletedEntries: 1,
      droppedRecords: 1,
    });
    expect(JSON.stringify(prepared.report)).not.toContain(MEM_ROOT);
  });

  it("drops deleted files from the persisted snapshot and warm candidate set", async () => {
    const tracked = createTrackedFs({
      "src/a.ts": "export const alpha = 'needle';\n",
      "src/b.ts": "export const beta = 'needle';\n",
    });
    const currentScope = scope();
    const index = createWorkspaceIndex();

    await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });

    tracked.deleteFile("src/a.ts");
    tracked.resetCounters();

    const result = await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });
    const snapshot = await snapshotFor(index, currentScope);

    expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["src/b.ts"]);
    expect(snapshot?.discovery.files.map((file) => file.scopePath)).toEqual(["src/b.ts"]);
    expect(snapshot?.records.map((record) => record.scopePath)).toEqual(["src/b.ts"]);
    expect(tracked.counters.readDir).toBe(0);
    expect(tracked.counters.readFileUtf8).toBe(0);
    expect(tracked.counters.readFileBytes).toBe(0);
  });

  it("never persists denied runtime paths and stores only relative POSIX scope paths", async () => {
    const tracked = createTrackedFs({
      ".claude/config.json": "needle\n",
      ".codex/prompt.md": "needle\n",
      ".env": "SECRET=needle\n",
      ".keiko/session.log": "needle\n",
      "src/app.ts": "export const app = 'needle';\n",
    });
    const currentScope = scope();
    const index = createWorkspaceIndex();

    await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });
    const snapshot = await snapshotFor(index, currentScope);
    const allScopePaths = [
      ...(snapshot?.discovery.files.map((file) => file.scopePath) ?? []),
      ...(snapshot?.records.map((record) => record.scopePath) ?? []),
    ];

    expect(allScopePaths).toEqual(["src/app.ts", "src/app.ts"]);
    for (const scopePath of allScopePaths) {
      expect(scopePath.startsWith("/")).toBe(false);
      expect(scopePath.includes("\\")).toBe(false);
      expect(scopePath.startsWith(".env")).toBe(false);
      expect(scopePath.startsWith(".keiko")).toBe(false);
      expect(scopePath.startsWith(".codex")).toBe(false);
      expect(scopePath.startsWith(".claude")).toBe(false);
    }
  });

  it("redacts secret-shaped text before it is persisted in cached records", async () => {
    const secret = ["sk-", "abcdef0123456789ABCDEF"].join("");
    const tracked = createTrackedFs({
      "src/app.ts": `export const token = "${secret}";\n`,
    });
    const currentScope = scope();
    const index = createWorkspaceIndex();

    await searchText(currentScope, nlq("token"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });
    const snapshot = await snapshotFor(index, currentScope);
    const persisted = JSON.stringify(snapshot);

    expect(persisted).not.toContain(secret);
  });

  it("persists a file-backed snapshot across index instances and reuses warm data", async () => {
    const runtimeDir = tempRuntimeDir();
    try {
      const tracked = createTrackedFs({
        "README.md": "needle in docs\n",
        "src/a.ts": "export const alpha = 'needle';\n",
      });
      const currentScope = scope();
      const firstIndex = createWorkspaceIndex(
        createFileWorkspaceIndexStore({ runtimeDir }),
      );

      await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
        fs: tracked.fs,
        nowMs: FIXED_NOW,
        workspaceIndex: firstIndex,
      });

      tracked.resetCounters();
      const secondIndex = createWorkspaceIndex(
        createFileWorkspaceIndexStore({ runtimeDir }),
      );
      const result = await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
        fs: tracked.fs,
        nowMs: FIXED_NOW,
        workspaceIndex: secondIndex,
      });

      expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["README.md", "src/a.ts"]);
      expect(tracked.counters.readDir).toBe(0);
      expect(tracked.counters.readFileUtf8).toBe(0);
      expect(tracked.counters.readFileBytes).toBe(0);
      expect(runtimeFiles(runtimeDir)).toHaveLength(1);
    } finally {
      removeRuntimeDir(runtimeDir);
    }
  });

  it("writes file-backed snapshots with hashed filenames and redacted path-free JSON", async () => {
    const runtimeDir = tempRuntimeDir();
    const secret = ["sk-", "abcdef0123456789ABCDEF"].join("");
    try {
      const tracked = createTrackedFs({
        "src/app.ts": `export const token = "${secret}";\n`,
      });
      const currentScope = scope();
      const index = createWorkspaceIndex(createFileWorkspaceIndexStore({ runtimeDir }));

      await searchText(currentScope, nlq("token"), DEFAULT_SEARCH_LIMITS, {
        fs: tracked.fs,
        nowMs: FIXED_NOW,
        workspaceIndex: index,
      });

      const [fileName] = runtimeFiles(runtimeDir);
      if (fileName === undefined) {
        throw new Error("expected persisted snapshot file");
      }
      const raw = readFileSync(join(runtimeDir, fileName), "utf8");

      expect(fileName).toMatch(/^workspace-index-[0-9a-f]{64}\.json$/u);
      expect(fileName).not.toContain(MEM_ROOT);
      expect(raw).not.toContain(MEM_ROOT);
      expect(raw).not.toContain(secret);
    } finally {
      removeRuntimeDir(runtimeDir);
    }
  });

  it("refuses oversize file-backed snapshots and falls back to a live scan", async () => {
    const runtimeDir = tempRuntimeDir();
    try {
      const tracked = createTrackedFs({
        "src/app.ts": "export const token = 'needle';\n",
      });
      const currentScope = scope();
      const tinyStore = createFileWorkspaceIndexStore({
        runtimeDir,
        maxSnapshotBytes: 64,
      });
      const firstIndex = createWorkspaceIndex(tinyStore);

      await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
        fs: tracked.fs,
        nowMs: FIXED_NOW,
        workspaceIndex: firstIndex,
      });

      expect(runtimeFiles(runtimeDir)).toEqual([]);
      tracked.resetCounters();

      const secondIndex = createWorkspaceIndex(
        createFileWorkspaceIndexStore({ runtimeDir, maxSnapshotBytes: 64 }),
      );
      await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
        fs: tracked.fs,
        nowMs: FIXED_NOW,
        workspaceIndex: secondIndex,
      });

      expect(tracked.counters.readDir).toBeGreaterThan(0);
      expect(tracked.counters.readFileUtf8).toBeGreaterThan(0);
    } finally {
      removeRuntimeDir(runtimeDir);
    }
  });

  it("does not write or load an oversize file-backed snapshot at the store layer", async () => {
    const runtimeDir = tempRuntimeDir();
    try {
      const store = createFileWorkspaceIndexStore({
        runtimeDir,
        maxSnapshotBytes: 64,
      });
      await store.saveSnapshot("oversize-key", sampleSnapshot("needle ".repeat(64)));

      expect(runtimeFiles(runtimeDir)).toEqual([]);
      await expect(store.loadSnapshot("oversize-key")).resolves.toBeUndefined();
    } finally {
      removeRuntimeDir(runtimeDir);
    }
  });

  it("treats a corrupt file-backed snapshot as missing and falls back safely", async () => {
    const runtimeDir = tempRuntimeDir();
    try {
      const tracked = createTrackedFs({
        "src/app.ts": "export const token = 'needle';\n",
      });
      const currentScope = scope();
      const firstIndex = createWorkspaceIndex(createFileWorkspaceIndexStore({ runtimeDir }));

      await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
        fs: tracked.fs,
        nowMs: FIXED_NOW,
        workspaceIndex: firstIndex,
      });

      const [fileName] = runtimeFiles(runtimeDir);
      if (fileName === undefined) {
        throw new Error("expected persisted snapshot file");
      }
      writeFileSync(join(runtimeDir, fileName), "{broken", "utf8");
      tracked.resetCounters();

      const secondIndex = createWorkspaceIndex(createFileWorkspaceIndexStore({ runtimeDir }));
      await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
        fs: tracked.fs,
        nowMs: FIXED_NOW,
        workspaceIndex: secondIndex,
      });

      expect(tracked.counters.readDir).toBeGreaterThan(0);
      expect(tracked.counters.readFileUtf8).toBeGreaterThan(0);
    } finally {
      removeRuntimeDir(runtimeDir);
    }
  });

  it("loads a corrupt file-backed snapshot as undefined", async () => {
    const runtimeDir = tempRuntimeDir();
    try {
      const store = createFileWorkspaceIndexStore({ runtimeDir });
      await store.saveSnapshot("corrupt-key", sampleSnapshot("needle"));

      const [fileName] = runtimeFiles(runtimeDir);
      if (fileName === undefined) {
        throw new Error("expected persisted snapshot file");
      }
      writeFileSync(join(runtimeDir, fileName), "{broken", "utf8");

      await expect(store.loadSnapshot("corrupt-key")).resolves.toBeUndefined();
    } finally {
      removeRuntimeDir(runtimeDir);
    }
  });

  it("custom store keys and saved snapshots do not expose the absolute workspace root", async () => {
    const tracked = createTrackedFs({
      "src/app.ts": "export const token = 'needle';\n",
    });
    const currentScope = scope();
    const seenKeys: string[] = [];
    const seenSnapshots: WorkspaceIndexSnapshot[] = [];
    const store: WorkspaceIndexStore = {
      loadSnapshot: (key: string): WorkspaceIndexSnapshot | undefined => {
        seenKeys.push(key);
        return undefined;
      },
      saveSnapshot: (key: string, snapshot: WorkspaceIndexSnapshot): void => {
        seenKeys.push(key);
        seenSnapshots.push(snapshot);
      },
    };
    const index = createWorkspaceIndex(store);

    await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });

    expect(seenKeys.length).toBeGreaterThan(0);
    expect(seenKeys.every((key) => !key.includes(MEM_ROOT))).toBe(true);
    expect(seenSnapshots).toHaveLength(1);
    expect(JSON.stringify(seenSnapshots[0])).not.toContain(MEM_ROOT);
  });
});
