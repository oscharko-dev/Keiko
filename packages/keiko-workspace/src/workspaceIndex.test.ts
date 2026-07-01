import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
  buildWorkspaceIndexLexicalRecord,
  createFileWorkspaceIndexStore,
  createInMemoryWorkspaceIndexStore,
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

function directoryEntries(
  files: ReadonlyMap<string, { content: string }>,
  explicitDirectories: ReadonlySet<string>,
  dirRel: string,
): readonly WorkspaceDirEntry[] {
  const prefix = dirRel.length === 0 ? "" : `${dirRel}/`;
  const dirs = new Set<string>();
  const plainFiles = new Set<string>();
  for (const directory of explicitDirectories) {
    if (!directory.startsWith(prefix) || directory === dirRel) {
      continue;
    }
    const rest = directory.slice(prefix.length);
    const slash = rest.indexOf("/");
    dirs.add(slash === -1 ? rest : rest.slice(0, slash));
  }
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

function parentDirectory(scopePath: string): string {
  const slash = scopePath.lastIndexOf("/");
  return slash === -1 ? "" : scopePath.slice(0, slash);
}

function fileAncestorDirectories(scopePath: string): readonly string[] {
  const ancestors = [""];
  const parts = parentDirectory(scopePath).split("/").filter((part) => part.length > 0);
  let current = "";
  for (const part of parts) {
    current = current.length === 0 ? part : `${current}/${part}`;
    ancestors.push(current);
  }
  return ancestors;
}

function createTrackedFs(
  initialFiles: Readonly<Record<string, string>>,
  initialDirectories: readonly string[] = [],
): MutableTrackedFs {
  let nextMtimeMs = 1_000;
  const files = new Map<string, { content: string; mtimeMs: number }>();
  const explicitDirectories = new Set(initialDirectories);
  const directoryMtimes = new Map<string, number>();
  const bumpDirectory = (scopePath: string): void => {
    directoryMtimes.set(scopePath, nextMtimeMs);
    nextMtimeMs += 1;
  };
  const bumpInitialDirectories = (scopePath: string): void => {
    for (const directory of fileAncestorDirectories(scopePath)) {
      if (!directoryMtimes.has(directory)) {
        bumpDirectory(directory);
      }
    }
  };
  const bumpNewFileDirectories = (scopePath: string): void => {
    for (const directory of fileAncestorDirectories(scopePath)) {
      if (directoryMtimes.has(directory)) {
        continue;
      }
      bumpDirectory(parentDirectory(directory));
      bumpDirectory(directory);
    }
    bumpDirectory(parentDirectory(scopePath));
  };
  for (const [scopePath, content] of Object.entries(initialFiles)) {
    files.set(scopePath, { content, mtimeMs: nextMtimeMs });
    nextMtimeMs += 1;
    bumpInitialDirectories(scopePath);
  }
  for (const directory of initialDirectories) {
    bumpInitialDirectories(`${directory}/.placeholder`);
  }
  const counters = {
    readDir: 0,
    readFileUtf8: 0,
    readFileBytes: 0,
    stat: 0,
    exists: 0,
    realPath: 0,
  };
  const statDir = (scopePath: string): WorkspaceStat => ({
    size: 0,
    isFile: false,
    isDirectory: true,
    isSymbolicLink: false,
    mtimeMs: directoryMtimes.get(scopePath) ?? 0,
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
    for (const directory of explicitDirectories) {
      if (directory === scopePath || directory.startsWith(`${scopePath}/`)) {
        return true;
      }
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
          return statDir(absoluteToRelative(absolutePath) ?? "");
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
        return directoryEntries(files, explicitDirectories, dirRel);
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
      if (files.delete(scopePath)) {
        bumpDirectory(parentDirectory(scopePath));
      }
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
      const existed = files.has(scopePath);
      files.set(scopePath, { content, mtimeMs: nextMtimeMs });
      nextMtimeMs += 1;
      if (!existed) {
        bumpNewFileDirectories(scopePath);
      }
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
      DEFAULT_SEARCH_LIMITS.maxFilesScanned,
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
    maxFilesScanned: DEFAULT_SEARCH_LIMITS.maxFilesScanned,
    discovery: {
      files: [{ scopePath: "src/app.ts", sizeBytes: Buffer.byteLength(content, "utf8") }],
      directories: [],
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
        lexical: buildWorkspaceIndexLexicalRecord(content),
      },
    ],
  });
}

describe("workspaceIndex", () => {
  it("reuses unchanged indexed files without rereading file contents", async () => {
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
    expect(result.workspaceIndex).toMatchObject({
      reusedRecords: 1,
      staleRecords: 1,
    });
    expect(tracked.counters.readDir).toBeGreaterThan(0);
    expect(tracked.counters.readFileUtf8).toBe(1);
    expect(tracked.counters.readFileBytes).toBe(1);
  });

  it("detects newly added files on warm searches before reusing cached candidates", async () => {
    const tracked = createTrackedFs({
      "src/a.ts": "export const alpha = 'needle';\n",
    });
    const currentScope = scope();
    const index = createWorkspaceIndex();

    await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });

    tracked.writeFile("src/c.ts", "export const gamma = 'needle';\n");
    tracked.resetCounters();

    const result = await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });
    const snapshot = await snapshotFor(index, currentScope);

    expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["src/a.ts", "src/c.ts"]);
    expect(snapshot?.discovery.files.map((file) => file.scopePath)).toEqual(["src/a.ts", "src/c.ts"]);
    expect(tracked.counters.readDir).toBeGreaterThan(0);
    expect(tracked.counters.readFileUtf8).toBe(1);
    expect(tracked.counters.readFileBytes).toBe(1);
  });

  it("discovers files added after an empty workspace snapshot", async () => {
    const tracked = createTrackedFs({});
    const currentScope = scope();
    const index = createWorkspaceIndex();

    const empty = await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });
    expect(empty.atoms).toEqual([]);
    expect((await snapshotFor(index, currentScope))?.discovery.directories.map((dir) => dir.scopePath)).toEqual([""]);

    tracked.writeFile("src/app.ts", "export const app = 'needle';\n");
    tracked.resetCounters();

    const result = await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });

    expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["src/app.ts"]);
    expect(tracked.counters.readFileUtf8).toBe(1);
    expect(tracked.counters.readFileBytes).toBe(1);
  });

  it("discovers files added inside an existing empty tracked directory", async () => {
    const tracked = createTrackedFs(
      {
        "src/a.ts": "export const alpha = 'needle';\n",
      },
      ["docs"],
    );
    const currentScope = scope();
    const index = createWorkspaceIndex();

    await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });
    expect((await snapshotFor(index, currentScope))?.discovery.directories.map((dir) => dir.scopePath)).toContain("docs");

    tracked.writeFile("docs/readme.md", "needle in docs\n");
    tracked.resetCounters();

    const result = await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });

    expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["docs/readme.md", "src/a.ts"]);
    expect(tracked.counters.readFileUtf8).toBe(1);
    expect(tracked.counters.readFileBytes).toBe(1);
  });

  it("rebuilds same-size changed records when precise metadata changes", async () => {
    const tracked = createTrackedFs({
      "src/app.ts": "needle alpha\n",
    });
    const currentScope = scope();
    const index = createWorkspaceIndex();

    await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });

    tracked.writeFile("src/app.ts", "magnet alpha\n");
    tracked.resetCounters();

    const result = await searchText(currentScope, nlq("magnet"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });

    expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["src/app.ts"]);
    expect(tracked.counters.readDir).toBeGreaterThan(0);
    expect(tracked.counters.readFileUtf8).toBe(1);
    expect(tracked.counters.readFileBytes).toBe(1);
  });

  it("keys snapshots by maxFilesScanned so narrow scans cannot poison broader queries", async () => {
    const tracked = createTrackedFs({
      "src/a.ts": "export const alpha = 'needle';\n",
      "src/b.ts": "export const beta = 'needle';\n",
    });
    const currentScope = scope();
    const index = createWorkspaceIndex();
    const narrowLimits = { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: 1 };

    const first = await searchText(currentScope, nlq("needle"), narrowLimits, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });
    expect(first.atoms.map((atom) => atom.scopePath)).toEqual(["src/a.ts"]);

    tracked.resetCounters();
    const second = await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });

    expect(second.atoms.map((atom) => atom.scopePath)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(tracked.counters.readFileUtf8).toBe(2);
    expect(tracked.counters.readFileBytes).toBe(2);
  });

  it("surfaces path-free workspace index diagnostics on cold and warm results", async () => {
    const tracked = createTrackedFs({
      "src/a.ts": "export const alpha = 'needle';\n",
      "src/b.ts": "export const beta = 'other';\n",
    });
    const currentScope = scope();
    const index = createWorkspaceIndex();

    const cold = await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });
    expect(cold.workspaceIndex).toEqual({
      discoveredEntries: 2,
      retainedEntries: 2,
      indexedRecords: 2,
      reusedRecords: 0,
      staleRecords: 0,
      skippedEntries: 0,
      deletedEntries: 0,
      droppedRecords: 0,
    });
    expect(JSON.stringify(cold.workspaceIndex)).not.toContain(MEM_ROOT);

    const warm = await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });
    expect(warm.workspaceIndex).toEqual({
      discoveredEntries: 2,
      retainedEntries: 2,
      indexedRecords: 2,
      reusedRecords: 2,
      staleRecords: 0,
      skippedEntries: 0,
      deletedEntries: 0,
      droppedRecords: 0,
    });
    expect(JSON.stringify(warm.workspaceIndex)).not.toContain(MEM_ROOT);
  });

  it("does not rewrite an unchanged warm snapshot", async () => {
    const tracked = createTrackedFs({
      "src/a.ts": "export const alpha = 'needle';\n",
      "src/b.ts": "export const beta = 'other';\n",
    });
    const currentScope = scope();
    let savedSnapshot: WorkspaceIndexSnapshot | undefined;
    let saves = 0;
    const store: WorkspaceIndexStore = {
      loadSnapshot: (): WorkspaceIndexSnapshot | undefined => savedSnapshot,
      saveSnapshot: (_key: string, snapshot: WorkspaceIndexSnapshot): void => {
        saves += 1;
        savedSnapshot = snapshot;
      },
    };
    const index = createWorkspaceIndex(store);

    await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });
    expect(saves).toBe(1);

    await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });
    expect(saves).toBe(1);
  });

  it("continues uncached when workspace index load fails", async () => {
    const tracked = createTrackedFs({
      "src/app.ts": "export const app = 'needle';\n",
    });
    const currentScope = scope();
    const index = createWorkspaceIndex({
      loadSnapshot: () => {
        throw new Error("cache unavailable");
      },
      saveSnapshot: () => undefined,
    });

    const result = await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });

    expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["src/app.ts"]);
  });

  it("returns search results when workspace index save fails", async () => {
    const tracked = createTrackedFs({
      "src/app.ts": "export const app = 'needle';\n",
    });
    const currentScope = scope();
    const index = createWorkspaceIndex({
      loadSnapshot: () => undefined,
      saveSnapshot: () => {
        throw new Error("cache read-only");
      },
    });

    const result = await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });

    expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["src/app.ts"]);
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
    expect(tracked.counters.readDir).toBeGreaterThan(0);
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

  it("stores non-reconstructive lexical chunks instead of secret-bearing source text", async () => {
    const secret = ["sk-", "abcdef0123456789ABCDEF"].join("");
    const unsupportedSecret = "hf_abcdefghijklmnopqrstuvwxyz123456";
    const tracked = createTrackedFs({
      "src/app.ts": `export const token = "${secret}";\nexport const modelToken = "${unsupportedSecret}";\n`,
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
    expect(persisted).not.toContain(unsupportedSecret);
    expect(persisted).not.toContain("export const");
    expect(snapshot?.records[0]?.kind).toBe("text");
    expect(snapshot?.records[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(snapshot?.records[0]).not.toHaveProperty("content");
  });

  it("falls back to live reads when cached lexical chunks are intentionally truncated", async () => {
    const leadingTerms = Array.from({ length: 32 }, (_, index) => `term${index.toString()}`).join(" ");
    const tracked = createTrackedFs({
      "src/app.ts": `${leadingTerms} needle\n`,
    });
    const currentScope = scope();
    const index = createWorkspaceIndex();

    await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });
    const snapshot = await snapshotFor(index, currentScope);
    expect(snapshot?.records[0]?.lexical?.truncated).toBe(true);

    tracked.resetCounters();
    const result = await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });

    expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["src/app.ts"]);
    expect(tracked.counters.readFileUtf8).toBe(1);
    expect(tracked.counters.readFileBytes).toBe(1);
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

  it("persists default-limit snapshots with many directory fingerprints", async () => {
    const runtimeDir = tempRuntimeDir();
    try {
      const fileCount = DEFAULT_SEARCH_LIMITS.maxFilesScanned;
      const files = Array.from({ length: fileCount }, (_, index) => ({
        scopePath: `dir-${index.toString().padStart(4, "0")}/app.ts`,
        sizeBytes: 12,
      }));
      const snapshot = buildWorkspaceIndexSnapshot({
        scope: { relativePaths: [] },
        policy: {
          policyMode: "workspace-root-default",
          applyGitignore: true,
          omitLowValueWorkspaceFiles: true,
        },
        maxBytesPerFileScanned: DEFAULT_SEARCH_LIMITS.maxBytesPerFileScanned,
        maxFilesScanned: DEFAULT_SEARCH_LIMITS.maxFilesScanned,
        discovery: {
          files,
          directories: [
            { scopePath: "", fingerprint: "root" },
            ...files.map((file) => ({
              scopePath: file.scopePath.slice(0, file.scopePath.indexOf("/")),
              fingerprint: "empty",
            })),
          ],
          filesDiscovered: files.length,
          ignoredByDiscovery: 0,
          deniedByDiscovery: 0,
          depthPrunedByDiscovery: 0,
          truncated: false,
        },
        records: files.map((file) => ({ ...file, kind: "binary" as const })),
      });
      const store = createFileWorkspaceIndexStore({ runtimeDir });

      await store.saveSnapshot("default-limit-shape", snapshot);
      const loaded = await store.loadSnapshot("default-limit-shape");

      expect(loaded?.records).toHaveLength(fileCount);
      expect(runtimeFiles(runtimeDir)).toHaveLength(1);
    } finally {
      removeRuntimeDir(runtimeDir);
    }
  });

  it("writes file-backed snapshots with hashed filenames and source-free path-free JSON", async () => {
    const runtimeDir = tempRuntimeDir();
    const secret = ["sk-", "abcdef0123456789ABCDEF"].join("");
    const unsupportedSecret = "hf_abcdefghijklmnopqrstuvwxyz123456";
    try {
      const tracked = createTrackedFs({
        "src/app.ts": `export const token = "${secret}";\nexport const modelToken = "${unsupportedSecret}";\n`,
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
      expect(raw).not.toContain(unsupportedSecret);
      expect(raw).not.toContain("export const");
    } finally {
      removeRuntimeDir(runtimeDir);
    }
  });

  it("writes owner-only file-backed runtime directories and snapshots", async () => {
    if (process.platform === "win32") {
      return;
    }
    const runtimeDir = tempRuntimeDir();
    try {
      const tracked = createTrackedFs({
        "src/app.ts": "export const token = 'needle';\n",
      });
      const currentScope = scope();
      const index = createWorkspaceIndex(createFileWorkspaceIndexStore({ runtimeDir }));

      await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
        fs: tracked.fs,
        nowMs: FIXED_NOW,
        workspaceIndex: index,
      });

      const [fileName] = runtimeFiles(runtimeDir);
      if (fileName === undefined) {
        throw new Error("expected persisted snapshot file");
      }
      expect(statSync(runtimeDir).mode & 0o777).toBe(0o700);
      expect(statSync(join(runtimeDir, fileName)).mode & 0o777).toBe(0o600);
    } finally {
      removeRuntimeDir(runtimeDir);
    }
  });

  it("rejects workspace-local file-backed runtime directories unless explicitly allowed", () => {
    expect(() =>
      createFileWorkspaceIndexStore({
        runtimeDir: join(MEM_ROOT, ".keiko", "workspace-index"),
        workspaceRoot: MEM_ROOT,
      }),
    ).toThrow("workspace index runtimeDir must not be inside the workspace root");
    expect(() =>
      createFileWorkspaceIndexStore({
        runtimeDir: join(MEM_ROOT, ".keiko", "workspace-index"),
        workspaceRoot: MEM_ROOT,
        allowWorkspaceLocalRuntimeDir: true,
      }),
    ).not.toThrow();
  });

  it("rejects file-backed runtime directories that resolve into the workspace through symlinks", () => {
    if (process.platform === "win32") {
      return;
    }
    const workspaceRoot = tempRuntimeDir();
    const outsideRoot = tempRuntimeDir();
    try {
      symlinkSync(workspaceRoot, join(outsideRoot, "workspace-link"), "dir");

      expect(() =>
        createFileWorkspaceIndexStore({
          runtimeDir: join(outsideRoot, "workspace-link", "index"),
          workspaceRoot,
        }),
      ).toThrow("workspace index runtimeDir must not be inside the workspace root");
    } finally {
      removeRuntimeDir(outsideRoot);
      removeRuntimeDir(workspaceRoot);
    }
  });

  it("does not load symlinked file-backed snapshot paths", async () => {
    if (process.platform === "win32") {
      return;
    }
    const runtimeDir = tempRuntimeDir();
    const targetDir = tempRuntimeDir();
    try {
      const store = createFileWorkspaceIndexStore({ runtimeDir });
      await store.saveSnapshot("safe-key", sampleSnapshot("needle"));
      const [fileName] = runtimeFiles(runtimeDir);
      if (fileName === undefined) {
        throw new Error("expected persisted snapshot file");
      }
      const snapshotPath = join(runtimeDir, fileName);
      const targetPath = join(targetDir, "snapshot.json");
      writeFileSync(targetPath, readFileSync(snapshotPath, "utf8"), "utf8");
      unlinkSync(snapshotPath);
      symlinkSync(targetPath, snapshotPath);

      await expect(Promise.resolve(store.loadSnapshot("safe-key"))).resolves.toBeUndefined();
    } finally {
      removeRuntimeDir(runtimeDir);
      removeRuntimeDir(targetDir);
    }
  });

  it("does not follow a runtime directory replaced by a workspace symlink after store creation", async () => {
    if (process.platform === "win32") {
      return;
    }
    const runtimeDir = tempRuntimeDir();
    const workspaceRoot = tempRuntimeDir();
    try {
      const workspaceStateDir = join(workspaceRoot, ".keiko");
      const store = createFileWorkspaceIndexStore({ runtimeDir, workspaceRoot });
      await store.saveSnapshot("safe-key", sampleSnapshot("needle"));

      removeRuntimeDir(runtimeDir);
      mkdirSync(workspaceStateDir, { recursive: true });
      symlinkSync(workspaceStateDir, runtimeDir, "dir");

      await store.saveSnapshot("poc-key", sampleSnapshot("needle"));

      expect(runtimeFiles(workspaceStateDir)).toEqual([]);
      await expect(Promise.resolve(store.loadSnapshot("safe-key"))).resolves.toBeUndefined();
    } finally {
      removeRuntimeDir(runtimeDir);
      removeRuntimeDir(workspaceRoot);
    }
  });

  it("prunes orphaned temp snapshots under the configured snapshot cap", async () => {
    const runtimeDir = tempRuntimeDir();
    try {
      const tempFileName = `workspace-index-${"a".repeat(64)}.json.${"b".repeat(16)}.tmp`;
      writeFileSync(join(runtimeDir, tempFileName), "{}\n", "utf8");
      const store = createFileWorkspaceIndexStore({ runtimeDir, maxSnapshots: 1 });

      await store.saveSnapshot("fresh-key", sampleSnapshot("needle"));

      const files = runtimeFiles(runtimeDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^workspace-index-[0-9a-f]{64}\.json$/u);
    } finally {
      removeRuntimeDir(runtimeDir);
    }
  });

  it("bounds the default in-memory store with least-recently-used pruning", async () => {
    const store = createInMemoryWorkspaceIndexStore({ maxSnapshots: 1 });

    await store.saveSnapshot("first", sampleSnapshot("first needle"));
    await store.saveSnapshot("second", sampleSnapshot("second needle"));

    await expect(Promise.resolve(store.loadSnapshot("first"))).resolves.toBeUndefined();
    await expect(Promise.resolve(store.loadSnapshot("second"))).resolves.toBeDefined();
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
