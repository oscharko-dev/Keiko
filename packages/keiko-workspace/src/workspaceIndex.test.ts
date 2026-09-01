import { createHash, createHmac, hkdfSync } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { openString, sealString } from "@oscharko-dev/keiko-security";
import { describe, expect, it } from "vitest";
import { memFs } from "./_memfs.js";
import { PathDeniedError } from "./errors.js";
import {
  nodeWorkspaceFs,
  type WorkspaceDescriptorUtf8Read,
  type WorkspaceDirEntry,
  type WorkspaceFs,
  type WorkspaceStat,
} from "./fs.js";
import { DEFAULT_SEARCH_LIMITS, searchText, type SearchScope } from "./repoSearch.js";
import { resolveSearchPolicy } from "./repoSearchPolicy.js";
import type { WorkspaceInfo } from "./types.js";
import { workspaceDirectoryFingerprint } from "./workspaceDirectorySnapshot.js";
import {
  buildWorkspaceIndexSnapshot,
  buildWorkspaceIndexScopeKey,
  buildWorkspaceIndexLexicalRecord,
  WORKSPACE_INDEX_SNAPSHOT_VERSION,
  createFileWorkspaceIndexStore as createEncryptedFileWorkspaceIndexStore,
  createInMemoryWorkspaceIndexStore,
  createWorkspaceIndex,
  inspectWorkspaceIndexDirectories,
  isWorkspaceIndexSnapshotFresh,
  prepareWorkspaceIndexSnapshot,
  prepareCachedWorkspaceIndexSnapshot,
  stripTrailingNonWordChars,
  type WorkspaceIndex,
  type FileWorkspaceIndexStoreOptions,
  type WorkspaceIndexStore,
  type WorkspaceIndexSnapshot,
  workspaceIndexCandidateSet,
  workspaceIndexFileMetadata,
} from "./workspaceIndex.js";

const MEM_ROOT = "/ws";
const FIXED_NOW: () => number = () => 1_700_000_000_000;
const FILE_INDEX_TEST_KEY = Buffer.alloc(32, 23);

function fileIndexStorageGenerationId(): string {
  const info = "keiko-workspace-index:key-generation:v2";
  const generationKey = Buffer.from(
    hkdfSync("sha256", FILE_INDEX_TEST_KEY, "keiko-workspace-index:file-locator-salt:v2", info, 32),
  );
  return createHmac("sha256", generationKey).update(info).digest("hex");
}

function createFileWorkspaceIndexStore(
  options: Omit<FileWorkspaceIndexStoreOptions, "encryptionKey">,
): WorkspaceIndexStore {
  return createEncryptedFileWorkspaceIndexStore({
    ...options,
    encryptionKey: FILE_INDEX_TEST_KEY,
  });
}

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
  readonly replaceFilePreservingMtime: (scopePath: string, content: string) => void;
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

function rxq(text: string): RetrievalQuery {
  return {
    kind: "regex",
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
  const parts = parentDirectory(scopePath)
    .split("/")
    .filter((part) => part.length > 0);
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
  let nextFileIdentity = 1;
  let nextCtimeNs = 1_000_000_000;
  const files = new Map<
    string,
    { content: string; mtimeMs: number; ctimeNs: string; fileIdentity: string }
  >();
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
    files.set(scopePath, {
      content,
      mtimeMs: nextMtimeMs,
      ctimeNs: String(nextCtimeNs),
      fileIdentity: `tracked:${String(nextFileIdentity)}`,
    });
    nextMtimeMs += 1;
    nextFileIdentity += 1;
    nextCtimeNs += 1;
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
  const fileAt = (
    absolutePath: string,
  ):
    | {
        readonly scopePath: string;
        readonly content: string;
        readonly mtimeMs: number;
        readonly ctimeNs: string;
        readonly fileIdentity: string;
      }
    | undefined => {
    const scopePath = absoluteToRelative(absolutePath);
    if (scopePath === undefined) {
      return undefined;
    }
    const file = files.get(scopePath);
    return file === undefined
      ? undefined
      : {
          scopePath,
          content: file.content,
          mtimeMs: file.mtimeMs,
          ctimeNs: file.ctimeNs,
          fileIdentity: file.fileIdentity,
        };
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
  // Shared by `stat` and `readFileUtf8SameDescriptor` so the descriptor-read lane observes exactly
  // the same identity `stat` reports — mirrors production's same-descriptor read, which derives
  // both from one open file handle.
  const statOrThrow = (absolutePath: string): WorkspaceStat => {
    const file = fileAt(absolutePath);
    if (file !== undefined) {
      return {
        size: Buffer.byteLength(file.content, "utf8"),
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        hardLinkCount: 1,
        mtimeMs: file.mtimeMs,
        ctimeMs: Number(file.ctimeNs) / 1_000_000,
        fileIdentity: file.fileIdentity,
        mtimeNs: String(Math.trunc(file.mtimeMs * 1_000_000)),
        ctimeNs: file.ctimeNs,
      };
    }
    if (directoryExists(absolutePath)) {
      return statDir(absoluteToRelative(absolutePath) ?? "");
    }
    throw makeErrnoError("ENOENT", absolutePath);
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
      // Bounded same-descriptor read: the sole primitive `readWorkspaceFileTextForInternalUse`
      // uses for a complete text read. Counted under the SAME `readFileUtf8` counter every
      // existing assertion in this file already keys on — this fake has no unbounded-fallback
      // branch left to invoke, so this is now the only text-read path production code reaches.
      readFileUtf8SameDescriptor: (
        absolutePath: string,
        maxBytes: number,
      ): WorkspaceDescriptorUtf8Read => {
        counters.readFileUtf8 += 1;
        const file = fileAt(absolutePath);
        if (file === undefined) {
          throw makeErrnoError("ENOENT", absolutePath);
        }
        const encoded = new TextEncoder().encode(file.content);
        const cap = Math.max(0, Math.trunc(maxBytes));
        const bytes = encoded.subarray(0, Math.min(encoded.length, cap));
        return {
          rawText: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
          sizeBytes: bytes.length,
          stat: statOrThrow(absolutePath),
        };
      },
      stat: (absolutePath: string): WorkspaceStat => {
        counters.stat += 1;
        return statOrThrow(absolutePath);
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
          new TextEncoder().encode(file.content).subarray(0, Math.max(0, Math.trunc(maxBytes))),
        );
      },
    },
    deleteFile: (scopePath: string): void => {
      if (files.delete(scopePath)) {
        bumpDirectory(parentDirectory(scopePath));
      }
    },
    replaceFilePreservingMtime: (scopePath: string, content: string): void => {
      const previous = files.get(scopePath);
      if (previous === undefined) {
        throw new Error(`cannot replace missing tracked file: ${scopePath}`);
      }
      files.set(scopePath, {
        content,
        mtimeMs: previous.mtimeMs,
        ctimeNs: String(nextCtimeNs),
        fileIdentity: `tracked:${String(nextFileIdentity)}`,
      });
      nextCtimeNs += 1;
      nextFileIdentity += 1;
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
      const previous = files.get(scopePath);
      files.set(scopePath, {
        content,
        mtimeMs: nextMtimeMs,
        ctimeNs: String(nextCtimeNs),
        fileIdentity: previous?.fileIdentity ?? `tracked:${String(nextFileIdentity)}`,
      });
      nextMtimeMs += 1;
      nextCtimeNs += 1;
      if (previous === undefined) {
        nextFileIdentity += 1;
        bumpNewFileDirectories(scopePath);
      }
    },
  };
}

async function snapshotFor(
  index: WorkspaceIndex,
  currentScope: SearchScope,
): Promise<WorkspaceIndexSnapshot | undefined> {
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

function firstSnapshotRecord(
  snapshot: WorkspaceIndexSnapshot | undefined,
): WorkspaceIndexSnapshot["records"][number] {
  const record = snapshot?.records[0];
  if (record === undefined) {
    throw new Error("expected workspace index record");
  }
  return record;
}

function tempRuntimeDir(): string {
  return mkdtempSync(join(tmpdir(), "keiko-workspace-index-"));
}

function removeRuntimeDir(runtimeDir: string): void {
  rmSync(runtimeDir, { force: true, recursive: true });
}

function runtimeFiles(runtimeDir: string): readonly string[] {
  return readdirSync(runtimeDir)
    .filter((name) => /^workspace-index-v2-[0-9a-f]{64}-[0-9a-f]{64}\.json$/u.test(name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
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
  it("fails closed for snapshots from the previous identity schema", () => {
    const legacy = {
      ...sampleSnapshot("needle"),
      version: WORKSPACE_INDEX_SNAPSHOT_VERSION - 1,
    };

    expect(prepareCachedWorkspaceIndexSnapshot(legacy, workspace())).toMatchObject({
      valid: false,
      entries: [],
    });
  });

  it("rejects a previous-schema snapshot returned by a custom store", async () => {
    const currentScope = scope();
    const policy = resolveSearchPolicy(false, undefined);
    const scopeKey = buildWorkspaceIndexScopeKey(
      currentScope,
      {
        policyMode: policy.mode,
        applyGitignore: policy.applyGitignore,
        omitLowValueWorkspaceFiles: policy.omitLowValueWorkspaceFiles,
      },
      DEFAULT_SEARCH_LIMITS.maxBytesPerFileScanned,
      DEFAULT_SEARCH_LIMITS.maxFilesScanned,
    );
    const legacy = {
      ...sampleSnapshot("needle"),
      version: WORKSPACE_INDEX_SNAPSHOT_VERSION - 1,
    };
    const index = createWorkspaceIndex({
      loadSnapshot: () => legacy,
      saveSnapshot: () => undefined,
    });

    await expect(index.loadSnapshot(scopeKey)).resolves.toBeUndefined();
  });

  it("uses cached lexical evidence to rank a route declaration ahead of path-only decoys", () => {
    const query = nlq(
      "Welche Produktionsdatei registriert POST /api/chats/messages/grounded und welcher Handler wird aufgerufen?",
    );
    const contents = new Map([
      ["src/api/chats/messages/grounded/overview.ts", "export const unrelated = true;\n"],
      [
        "src/routes.ts",
        '{ method: "POST", pattern: "/api/chats/messages/grounded", handler: handleGroundedAsk },\n',
      ],
      ["src/grounded-qa.ts", "export async function handleGroundedAsk(): Promise<void> {}\n"],
    ]);
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
        files: [...contents].map(([scopePath, content]) => ({
          scopePath,
          sizeBytes: Buffer.byteLength(content, "utf8"),
        })),
        directories: [],
        filesDiscovered: contents.size,
        ignoredByDiscovery: 0,
        deniedByDiscovery: 0,
        depthPrunedByDiscovery: 0,
        truncated: false,
      },
      records: [...contents].map(([scopePath, content]) => ({
        scopePath,
        sizeBytes: Buffer.byteLength(content, "utf8"),
        kind: "text" as const,
        lexical: buildWorkspaceIndexLexicalRecord(content),
      })),
    });
    const prepared = prepareCachedWorkspaceIndexSnapshot(snapshot, workspace());
    const policy = resolveSearchPolicy(false, { retrievalIntent: "targeted-code-search" });

    const candidates = workspaceIndexCandidateSet(prepared, query, policy);

    expect(candidates.files[0]?.relativePath).toBe("src/routes.ts");
    const contentSignal = candidates.diagnostics.rankedCandidates[0]?.signals.find(
      (signal) => signal.name === "content-term-score",
    );
    expect(contentSignal?.value).toBeGreaterThan(229);
  });

  it("uses privacy-safe cached hashes to rank an exact-symbol definition ahead of references", () => {
    const exactQuery: RetrievalQuery = {
      kind: "exact-symbol",
      text: "dispatchWorkUnit",
      caseSensitive: false,
      maxResults: 100,
      emittedAtMs: 0,
    };
    const contents = new Map([
      ["src/a-reference.ts", "await dispatchWorkUnit();\n"],
      ["src/service.ts", "export async function dispatchWorkUnit(): Promise<void> {}\n"],
    ]);
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
        files: [...contents].map(([scopePath, content]) => ({
          scopePath,
          sizeBytes: Buffer.byteLength(content, "utf8"),
        })),
        directories: [],
        filesDiscovered: contents.size,
        ignoredByDiscovery: 0,
        deniedByDiscovery: 0,
        depthPrunedByDiscovery: 0,
        truncated: false,
      },
      records: [...contents].map(([scopePath, content]) => ({
        scopePath,
        sizeBytes: Buffer.byteLength(content, "utf8"),
        kind: "text" as const,
        lexical: buildWorkspaceIndexLexicalRecord(content),
      })),
    });
    const prepared = prepareCachedWorkspaceIndexSnapshot(snapshot, workspace());
    const policy = resolveSearchPolicy(false, { retrievalIntent: "targeted-code-search" });

    expect(workspaceIndexCandidateSet(prepared, exactQuery, policy).files[0]?.relativePath).toBe(
      "src/service.ts",
    );
  });

  it("keeps warm exact-symbol evidence on the same enclosing function range as cold search", async () => {
    const tracked = createTrackedFs({
      "src/service.ts":
        "export async function dispatchWorkUnit(): Promise<void> {\n" +
        "  await runPipeline();\n" +
        "}\n",
    });
    const index = createWorkspaceIndex();
    const exactQuery: RetrievalQuery = {
      kind: "exact-symbol",
      text: "dispatchWorkUnit",
      caseSensitive: false,
      maxResults: 100,
      emittedAtMs: 0,
    };
    const options = { fs: tracked.fs, nowMs: FIXED_NOW, workspaceIndex: index };

    const cold = await searchText(scope(), exactQuery, DEFAULT_SEARCH_LIMITS, options);
    const warm = await searchText(scope(), exactQuery, DEFAULT_SEARCH_LIMITS, options);

    expect(cold.atoms.map((atom) => atom.lineRange)).toEqual([{ startLine: 1, endLine: 3 }]);
    expect(warm.atoms.map((atom) => atom.lineRange)).toEqual(
      cold.atoms.map((atom) => atom.lineRange),
    );
  });

  it("content-prescores the first indexed search before applying its scan cap", async () => {
    const tracked = createTrackedFs({
      "src/api/chats/messages/grounded/overview.ts": "export const unrelated = true;\n",
      "src/routes.ts":
        '{ method: "POST", pattern: "/api/chats/messages/grounded", handler: handleGroundedAsk },\n',
    });
    const index = createWorkspaceIndex();
    const limits = { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: 1 };

    const result = await searchText(
      scope(),
      nlq("Welche Datei registriert POST /api/chats/messages/grounded?"),
      limits,
      { fs: tracked.fs, nowMs: FIXED_NOW, workspaceIndex: index },
    );

    expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["src/routes.ts"]);
  });

  it("content-prescores unindexed files in a partial snapshot before applying its scan cap", async () => {
    const files = {
      "src/api/chats/messages/grounded/overview.ts": "export const unrelated = true;\n",
      "src/routes.ts":
        '{ method: "POST", pattern: "/api/chats/messages/grounded", handler: handleGroundedAsk },\n',
    };
    const tracked = createTrackedFs(files);
    const snapshot = buildWorkspaceIndexSnapshot({
      scope: { relativePaths: [] },
      policy: {
        policyMode: "workspace-root-default",
        applyGitignore: true,
        omitLowValueWorkspaceFiles: true,
      },
      maxBytesPerFileScanned: DEFAULT_SEARCH_LIMITS.maxBytesPerFileScanned,
      maxFilesScanned: 1,
      discovery: {
        files: Object.entries(files).map(([scopePath, content]) => ({
          scopePath,
          sizeBytes: Buffer.byteLength(content, "utf8"),
        })),
        directories: [],
        filesDiscovered: 2,
        ignoredByDiscovery: 0,
        deniedByDiscovery: 0,
        depthPrunedByDiscovery: 0,
        truncated: false,
      },
      records: [],
    });
    const index = createWorkspaceIndex({
      loadSnapshot: () => snapshot,
      saveSnapshot: () => undefined,
    });
    const limits = { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: 1 };

    const result = await searchText(
      scope(),
      nlq("Welche Datei registriert POST /api/chats/messages/grounded?"),
      limits,
      {
        fs: tracked.fs,
        nowMs: FIXED_NOW,
        workspaceIndex: index,
        searchHints: { retrievalIntent: "targeted-code-search" },
      },
    );

    expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["src/routes.ts"]);
  });

  it("keeps cached alias selection aligned with live semantic grouping", async () => {
    const tracked = createTrackedFs({
      "src/app.ts": [
        "define defined definition declare declared",
        "function defined alpha",
        "function defined beta",
        "function defined gamma",
      ].join("\n"),
    });
    const currentScope = scope();
    const index = createWorkspaceIndex();
    await searchText(currentScope, nlq("unrelated"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });

    const result = await searchText(currentScope, nlq("function defined"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });
    const cold = await searchText(currentScope, nlq("function defined"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
    });

    expect(result.atoms.map((atom) => atom.lineRange)).toEqual([
      { startLine: 1, endLine: 1 },
      { startLine: 2, endLine: 4 },
    ]);
    expect(result.atoms.map((atom) => atom.score)).toEqual([0.5, 1]);
    expect(result.atoms.map((atom) => atom.lineRange)).toEqual(
      cold.atoms.map((atom) => atom.lineRange),
    );
    expect(result.atoms.map((atom) => atom.score)).toEqual(cold.atoms.map((atom) => atom.score));
  });

  it("live-ranks ambiguous cached substrings before a match cap reserves output", async () => {
    const tracked = createTrackedFs({
      "src/a.ts": "export const alpha = 1;\n",
      "src/z.ts": "export const alpha = 'superbetaxvalue';\n",
    });
    const currentScope = scope();
    const index = createWorkspaceIndex();
    const capped = {
      ...DEFAULT_SEARCH_LIMITS,
      maxFilesScanned: 2,
      maxMatchesReturned: 1,
    };
    const options = {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      searchHints: { retrievalIntent: "targeted-code-search" as const },
    };

    await searchText(currentScope, nlq("absent"), capped, { ...options, workspaceIndex: index });
    const warm = await searchText(currentScope, nlq("alpha betax"), capped, {
      ...options,
      workspaceIndex: index,
    });
    const cold = await searchText(currentScope, nlq("alpha betax"), capped, options);

    expect(warm.atoms.map((atom) => atom.scopePath)).toEqual(["src/z.ts"]);
    expect(warm.atoms).toEqual(cold.atoms);
  });

  it("normalizes noisy snapshot inputs and caps lexical records deterministically", () => {
    const lineCapped = buildWorkspaceIndexLexicalRecord(
      Array.from({ length: 40 }, (_, index) => `Token${String(index)}`).join(" "),
    );
    expect(lineCapped.truncated).toBe(true);
    expect(lineCapped.lines).toHaveLength(1);
    expect(lineCapped.lines[0]?.termHashes.length).toBeLessThanOrEqual(16);

    const fileTermCapped = buildWorkspaceIndexLexicalRecord(
      Array.from({ length: 40 }, (_, line) =>
        Array.from({ length: 16 }, (_, index) => `Line${String(line)}Term${String(index)}`).join(
          " ",
        ),
      ).join("\n"),
    );
    expect(fileTermCapped.truncated).toBe(true);
    expect(fileTermCapped.termHashes.length).toBeLessThanOrEqual(512);

    const lineCountCapped = buildWorkspaceIndexLexicalRecord(
      Array.from({ length: 300 }, (_, index) => `line${String(index)}`).join("\n"),
    );
    expect(lineCountCapped.truncated).toBe(true);
    expect(lineCountCapped.lines.length).toBeLessThanOrEqual(256);

    const snapshot = buildWorkspaceIndexSnapshot({
      scope: {
        relativePaths: ["src\\b.ts", "../escape.ts", ".git/config", "src/a.ts", "src/a.ts"],
      },
      policy: {
        policyMode: "workspace-root-default",
        applyGitignore: true,
        omitLowValueWorkspaceFiles: true,
      },
      maxBytesPerFileScanned: DEFAULT_SEARCH_LIMITS.maxBytesPerFileScanned,
      maxFilesScanned: DEFAULT_SEARCH_LIMITS.maxFilesScanned,
      discovery: {
        files: [
          { scopePath: "src/a.ts", sizeBytes: 10, mtimeMs: 1.5 },
          { scopePath: "../escape.ts", sizeBytes: 10 },
          { scopePath: "src/b.ts", sizeBytes: -1 },
          { scopePath: "src\\c.ts", sizeBytes: 5, mtimeMs: -1 },
        ],
        directories: [
          { scopePath: "", fingerprint: "root", mtimeMs: 1 },
          { scopePath: "../escape", fingerprint: "bad", mtimeMs: 1 },
          { scopePath: "src", fingerprint: "", mtimeMs: 1 },
          { scopePath: "src", fingerprint: "src-fingerprint", mtimeMs: -1 },
        ],
        filesDiscovered: 1,
        ignoredByDiscovery: 0,
        deniedByDiscovery: 0,
        depthPrunedByDiscovery: 0,
        truncated: false,
      },
      records: [
        {
          scopePath: "src/a.ts",
          sizeBytes: 10,
          mtimeMs: 1.5,
          kind: "text",
          fingerprint: "not-a-sha",
          lexical: {
            truncated: false,
            termHashes: ["", "hash-a", "hash-a"],
            lines: [
              { startLine: 0, endLine: 1, termHashes: ["bad"] },
              { startLine: 3, endLine: 2, termHashes: ["bad"] },
              { startLine: 1, endLine: 1, termHashes: ["", "hash-a", "hash-a"] },
            ],
          },
        },
        {
          scopePath: "src/a.ts",
          sizeBytes: 10,
          kind: "binary",
          fingerprint: "0".repeat(64),
        },
        {
          scopePath: "src/missing.ts",
          sizeBytes: 1,
          kind: "binary",
        },
        {
          scopePath: "src/empty.ts",
          sizeBytes: 1,
          kind: "text",
          lexical: { truncated: false, termHashes: [], lines: [] },
        },
      ],
    });

    expect(snapshot.relativePaths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(snapshot.discovery.files.map((file) => file.scopePath)).toEqual([
      "src/a.ts",
      "src/c.ts",
    ]);
    expect(snapshot.discovery.directories.map((directory) => directory.scopePath)).toEqual([
      "",
      "src",
    ]);
    expect(snapshot.records).toHaveLength(1);
    const record = snapshot.records[0];
    expect(record).toBeDefined();
    if (record === undefined) return;
    expect(record).toMatchObject({
      scopePath: "src/a.ts",
      kind: "text",
      lexical: {
        termHashes: ["hash-a"],
        lines: [{ startLine: 1, endLine: 1, termHashes: ["hash-a"] }],
      },
    });
    expect("fingerprint" in record).toBe(false);
  });

  it("tokenizes a supplementary-plane character in an identifier without corrupting it", () => {
    // Regression for the charCodeAt -> codePointAt rename (typescript:S7758) in isAsciiUpper /
    // isAsciiLower / isAsciiDigit, which drive camelCase splitting. "𝐀" (U+1D400 MATHEMATICAL
    // BOLD CAPITAL A) is a real \p{L} letter outside the BMP (2 UTF-16 code units), so it survives
    // the lexical tokenizer's \p{L}\p{N} filter and reaches camelParts, unlike an emoji. Neither
    // of its surrogate halves ever falls in the ASCII upper/lower/digit ranges, so it must not
    // trigger a camelCase split and must not be dropped or corrupted in the resulting term.
    const record = buildWorkspaceIndexLexicalRecord("get𝐀Alpha handled");
    const expectedHashes = [
      createHash("sha256").update("get𝐀alpha").digest("hex"),
      createHash("sha256").update("handled").digest("hex"),
    ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(record.truncated).toBe(false);
    expect(record.lines).toEqual([{ startLine: 1, endLine: 1, termHashes: expectedHashes }]);
    expect(record.termHashes).toEqual(expectedHashes);
  });

  it("stores route declarations only as non-reconstructive hash markers", () => {
    const secretPath = ["/private/orders/", "customer-secret"].join("");
    const source = `#[patch("${secretPath}")] async fn update_order() {}`;
    const record = buildWorkspaceIndexLexicalRecord(source);
    const serialized = JSON.stringify(record);

    expect(record.truncated).toBe(false);
    expect(record.termHashes.every((hash) => /^[0-9a-f]{64}$/u.test(hash))).toBe(true);
    expect(serialized).not.toContain(secretPath);
    expect(serialized).not.toContain("customer-secret");
    expect(serialized).not.toContain("patch");
    expect(serialized).not.toContain("update_order");
    expect(serialized).not.toContain("keiko-internal-route-declaration");
  });

  // SonarCloud S8786: `stripTrailingNonWordChars` replaces the old `/[^\p{L}\p{N}]+$/u` regex,
  // which is unanchored at the start -- a backtracking engine retries every start position looking
  // for a trailing non-letter/non-number run that reaches the true end of the string, which is
  // quadratic whenever that run isn't at the very end (blocked by a trailing letter/number, exactly
  // the shape a real content token can take, e.g. a heavily hyphenated identifier or a line of
  // markdown separator punctuation followed by one more word).
  describe("stripTrailingNonWordChars", () => {
    it.each([
      ["abc", "abc"],
      ["abc---", "abc"],
      ["---", ""],
      ["", ""],
      ["abc.def", "abc.def"],
      ["abc...", "abc"],
      ["日本語", "日本語"],
      ["日本語...", "日本語"],
      ["get𝐀Alpha...", "get𝐀Alpha"],
    ])("strips trailing non-letter/non-number chars from %s -> %s", (input, expected) => {
      expect(stripTrailingNonWordChars(input)).toBe(expected);
    });

    it("completes within a tight budget for a long separator run blocked by one trailing letter", () => {
      // A real-world analogue: a markdown-style separator line ("----...----") immediately
      // followed by a single stray word character, tokenized as one long content token.
      const adversarial = `${"-".repeat(20_000)}a`;
      const start = Date.now();
      const result = stripTrailingNonWordChars(adversarial);
      const elapsedMs = Date.now() - start;
      expect(elapsedMs).toBeLessThan(1000);
      expect(result).toBe(adversarial);
    });
  });

  it("reports directory freshness and changed-directory deltas from cached snapshots", async () => {
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
    const snapshot = await snapshotFor(index, currentScope);
    expect(snapshot).toBeDefined();
    if (snapshot === undefined) return;

    expect(isWorkspaceIndexSnapshotFresh(snapshot, currentScope.workspace, tracked.fs)).toBe(true);

    tracked.writeFile("src/new.ts", "export const beta = 'needle';\n");
    expect(isWorkspaceIndexSnapshotFresh(snapshot, currentScope.workspace, tracked.fs)).toBe(false);

    const inspection = inspectWorkspaceIndexDirectories(
      snapshot,
      currentScope.workspace,
      tracked.fs,
    );
    expect(inspection.valid).toBe(true);
    expect(inspection.deltas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scopePath: "src",
          addedPaths: ["src/new.ts"],
          removedPaths: [],
          rescanDirectory: false,
        }),
      ]),
    );
  });

  it("detects directory membership changes even when the directory mtime is restored", async () => {
    const workspaceRoot = tempRuntimeDir();
    try {
      const sourceDir = join(workspaceRoot, "src");
      mkdirSync(sourceDir, { recursive: true });
      writeFileSync(join(sourceDir, "a.ts"), "export const alpha = 'needle';\n", "utf8");
      const currentScope: SearchScope = {
        ...scope(),
        workspace: { ...workspace(), root: workspaceRoot },
      };
      const index = createWorkspaceIndex();
      await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
        fs: nodeWorkspaceFs,
        nowMs: FIXED_NOW,
        workspaceIndex: index,
      });
      const snapshot = await snapshotFor(index, currentScope);
      expect(snapshot).toBeDefined();
      if (snapshot === undefined) return;

      const originalDirectoryStat = statSync(sourceDir);
      writeFileSync(join(sourceDir, "b.ts"), "export const beta = 'needle';\n", "utf8");
      utimesSync(sourceDir, originalDirectoryStat.atime, originalDirectoryStat.mtime);

      expect(isWorkspaceIndexSnapshotFresh(snapshot, currentScope.workspace, nodeWorkspaceFs)).toBe(
        false,
      );
      expect(
        inspectWorkspaceIndexDirectories(snapshot, currentScope.workspace, nodeWorkspaceFs).deltas,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ scopePath: "src", addedPaths: ["src/b.ts"] }),
        ]),
      );
    } finally {
      removeRuntimeDir(workspaceRoot);
    }
  });

  it.each([
    ["outside the workspace", "/outside/src"],
    ["into a denied directory", `${MEM_ROOT}/.git`],
  ])("rejects a persisted directory whose ancestor is replaced %s", (_label, realPath) => {
    const directoryPath = `${MEM_ROOT}/safe/src`;
    const base = memFs(MEM_ROOT, { "safe/src/a.ts": "export const a = 1;" });
    const snapshot = buildWorkspaceIndexSnapshot({
      scope: { relativePaths: [] },
      policy: {
        policyMode: "workspace-root-default",
        applyGitignore: true,
        omitLowValueWorkspaceFiles: true,
      },
      maxBytesPerFileScanned: 1024,
      maxFilesScanned: 1,
      discovery: {
        files: [{ scopePath: "safe/src/a.ts", sizeBytes: 19 }],
        directories: [
          {
            scopePath: "safe/src",
            fingerprint: workspaceDirectoryFingerprint(base.readDir(directoryPath)),
          },
        ],
        filesDiscovered: 1,
        ignoredByDiscovery: 0,
        deniedByDiscovery: 0,
        depthPrunedByDiscovery: 0,
        truncated: false,
      },
      records: [],
    });
    const touchedPaths: string[] = [];
    const replacedFs: WorkspaceFs = {
      ...base,
      realPath: (absolutePath): string =>
        absolutePath === directoryPath ? realPath : base.realPath(absolutePath),
      stat: (absolutePath): WorkspaceStat => {
        touchedPaths.push(absolutePath);
        return base.stat(absolutePath);
      },
      readDir: (absolutePath, maxEntries): readonly WorkspaceDirEntry[] => {
        touchedPaths.push(absolutePath);
        return base.readDir(absolutePath, maxEntries);
      },
    };

    expect(isWorkspaceIndexSnapshotFresh(snapshot, workspace(), replacedFs)).toBe(false);
    expect(inspectWorkspaceIndexDirectories(snapshot, workspace(), replacedFs).valid).toBe(false);
    expect(touchedPaths).toEqual([]);
  });

  it("does not persist directory snapshots through an ancestor replaced during the scan", async () => {
    const base = memFs(MEM_ROOT, { "safe/src/a.ts": "export const needle = 1;" });
    let ancestorReplaced = false;
    let scanReadComplete = false;
    let scanReads = 0;
    const directoryReads: string[] = [];
    const guardedFs: WorkspaceFs = {
      ...base,
      realPath: (absolutePath): string => {
        if (ancestorReplaced && absolutePath.startsWith(`${MEM_ROOT}/safe`)) {
          return absolutePath.replace(`${MEM_ROOT}/safe`, "/outside");
        }
        const canonical = base.realPath(absolutePath);
        if (scanReadComplete && absolutePath === `${MEM_ROOT}/safe/src/a.ts`) {
          ancestorReplaced = true;
        }
        return canonical;
      },
      readDir: (absolutePath, maxEntries): readonly WorkspaceDirEntry[] => {
        directoryReads.push(absolutePath);
        return base.readDir(absolutePath, maxEntries);
      },
      readFileBytes: async (
        absolutePath,
        maxBytes,
        hardLinkPolicy,
        expected,
      ): Promise<Uint8Array> => {
        const bytes =
          (await base.readFileBytes?.(absolutePath, maxBytes, hardLinkPolicy, expected)) ??
          new Uint8Array();
        scanReads += 1;
        scanReadComplete = scanReads >= 2;
        return bytes;
      },
    };
    let saveCount = 0;
    const index = createWorkspaceIndex({
      loadSnapshot: () => undefined,
      saveSnapshot: () => {
        saveCount += 1;
      },
    });

    const result = await searchText(scope(), nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: guardedFs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });

    expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["safe/src/a.ts"]);
    expect(saveCount).toBe(0);
    expect(directoryReads.some((absolutePath) => absolutePath.startsWith("/outside"))).toBe(false);
  });

  it("bounds directory fingerprint reads and rejects overflow as an invalid snapshot", () => {
    const snapshot = buildWorkspaceIndexSnapshot({
      scope: { relativePaths: [] },
      policy: {
        policyMode: "workspace-root-default",
        applyGitignore: true,
        omitLowValueWorkspaceFiles: true,
      },
      maxBytesPerFileScanned: 1024,
      maxFilesScanned: 1,
      discovery: {
        files: [],
        directories: [{ scopePath: "", fingerprint: "cached" }],
        filesDiscovered: 0,
        ignoredByDiscovery: 0,
        deniedByDiscovery: 0,
        depthPrunedByDiscovery: 0,
        truncated: false,
      },
      records: [],
    });
    const base = memFs(MEM_ROOT, {});
    const requestedBounds: number[] = [];
    const overflowingFs: WorkspaceFs = {
      ...base,
      readDir: (_absolutePath, maxEntries): readonly WorkspaceDirEntry[] => {
        if (maxEntries === undefined) throw new Error("directory read must be bounded");
        requestedBounds.push(maxEntries);
        return Array.from({ length: maxEntries }, (_, index) => ({
          name: `entry-${index.toString()}`,
          isDirectory: false,
          isFile: true,
          isSymbolicLink: false,
        }));
      },
    };

    expect(isWorkspaceIndexSnapshotFresh(snapshot, workspace(), overflowingFs)).toBe(false);
    expect(inspectWorkspaceIndexDirectories(snapshot, workspace(), overflowingFs)).toEqual({
      valid: false,
      deltas: [],
      snapshots: [],
    });
    expect(requestedBounds).toEqual([26, 26]);
  });

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
    expect(tracked.counters.readDir).toBe(2);
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
    // Changed candidates must be content-ranked before the scan cap is applied.
    expect(tracked.counters.readFileUtf8).toBe(2);
    expect(tracked.counters.readFileBytes).toBe(2);
  });

  it("rejects a same-size replacement whose mtime was restored", async () => {
    const tracked = createTrackedFs({
      "src/app.ts": "export const marker = 'cached';\n",
    });
    const currentScope = scope();
    const index = createWorkspaceIndex();

    await searchText(currentScope, nlq("cached"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });
    const before = await snapshotFor(index, currentScope);

    tracked.replaceFilePreservingMtime("src/app.ts", "export const marker = 'fresh!';\n");
    tracked.resetCounters();
    const result = await searchText(currentScope, nlq("fresh"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });
    const after = await snapshotFor(index, currentScope);
    const beforeRecord = firstSnapshotRecord(before);
    const afterRecord = firstSnapshotRecord(after);

    expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["src/app.ts"]);
    expect(result.workspaceIndex).toMatchObject({ reusedRecords: 0, staleRecords: 1 });
    expect(tracked.counters.readFileBytes).toBeGreaterThan(0);
    expect(beforeRecord.sizeBytes).toBe(afterRecord.sizeBytes);
    expect(beforeRecord.mtimeNs).toBe(afterRecord.mtimeNs);
    expect(beforeRecord.fileIdentityHash).not.toBe(afterRecord.fileIdentityHash);
    expect(JSON.stringify(after)).not.toContain("tracked:");
  });

  it("revalidates every cached rank before applying a narrow scan cap", async () => {
    const initialFiles = {
      "src/a.ts": "export const decoy = 'none!';\n",
      "src/b.ts": "export const marker = 'stale';\n",
    };
    const tracked = createTrackedFs(initialFiles);
    const currentScope = scope();
    const limits = { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: 1 };
    const index = createWorkspaceIndex();
    const searchOptions = {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
      searchHints: { retrievalIntent: "targeted-code-search" as const },
    };
    await searchText(currentScope, nlq("none"), limits, searchOptions);
    await searchText(currentScope, nlq("stale"), limits, searchOptions);
    tracked.replaceFilePreservingMtime("src/b.ts", "export const marker = 'fresh';\n");

    const result = await searchText(currentScope, nlq("fresh"), limits, searchOptions);

    expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["src/b.ts"]);
    expect(result.workspaceIndex).toMatchObject({ indexedRecords: 2, staleRecords: 1 });
  });

  it("content-ranks unindexed warm candidates before applying a narrow scan cap", async () => {
    const tracked = createTrackedFs({
      "src/a.ts": "export const alpha = 'first';\n",
      "src/z.ts": "export const target = 'needle';\n",
    });
    const currentScope = scope();
    const narrowLimits = { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: 1 };
    const index = createWorkspaceIndex();
    const options = { fs: tracked.fs, nowMs: FIXED_NOW, workspaceIndex: index };

    const first = await searchText(currentScope, nlq("alpha"), narrowLimits, options);
    const second = await searchText(currentScope, nlq("needle"), narrowLimits, options);

    expect(first.atoms.map((atom) => atom.scopePath)).toEqual(["src/a.ts"]);
    expect(second.atoms.map((atom) => atom.scopePath)).toEqual(["src/z.ts"]);
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
    expect(snapshot?.discovery.files.map((file) => file.scopePath)).toEqual([
      "src/a.ts",
      "src/c.ts",
    ]);
    expect(tracked.counters.readDir).toBeGreaterThan(0);
    expect(tracked.counters.readFileUtf8).toBe(2);
    expect(tracked.counters.readFileBytes).toBe(2);
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
    expect(
      (await snapshotFor(index, currentScope))?.discovery.directories.map((dir) => dir.scopePath),
    ).toEqual([""]);

    tracked.writeFile("src/app.ts", "export const app = 'needle';\n");
    tracked.resetCounters();

    const result = await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });

    expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["src/app.ts"]);
    expect(tracked.counters.readFileUtf8).toBe(1);
    expect(tracked.counters.readFileBytes).toBe(2);
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
    expect(
      (await snapshotFor(index, currentScope))?.discovery.directories.map((dir) => dir.scopePath),
    ).toContain("docs");

    tracked.writeFile("docs/readme.md", "needle in docs\n");
    tracked.resetCounters();

    const result = await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });

    expect(result.atoms.map((atom) => atom.scopePath).sort()).toEqual([
      "docs/readme.md",
      "src/a.ts",
    ]);
    expect(tracked.counters.readFileUtf8).toBe(2);
    expect(tracked.counters.readFileBytes).toBe(2);
  });

  it("distinguishes new records from stale records across multiple directory deltas", async () => {
    const tracked = createTrackedFs({
      "docs/a.md": "needle in docs\n",
      "src/a.ts": "export const alpha = 'needle';\n",
    });
    const currentScope = scope();
    const index = createWorkspaceIndex();

    await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });

    tracked.writeFile("docs/b.md", "needle in new docs\n");
    tracked.writeFile("src/b.ts", "export const beta = 'needle';\n");
    tracked.resetCounters();

    const result = await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });

    expect(result.atoms.map((atom) => atom.scopePath).sort()).toEqual([
      "docs/a.md",
      "docs/b.md",
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(result.workspaceIndex).toMatchObject({
      indexedRecords: 4,
      reusedRecords: 2,
      staleRecords: 0,
    });
    expect(tracked.counters.readFileUtf8).toBe(4);
    expect(tracked.counters.readFileBytes).toBe(4);
  });

  it("does not fingerprint selected directories that resolve to denied real paths", async (ctx) => {
    if (process.platform === "win32") {
      ctx.skip();
    }
    const workspaceRoot = tempRuntimeDir();
    try {
      mkdirSync(join(workspaceRoot, ".keiko"), { recursive: true });
      writeFileSync(join(workspaceRoot, ".keiko", "secret.txt"), "needle\n", "utf8");
      symlinkSync(join(workspaceRoot, ".keiko"), join(workspaceRoot, "safe-link"), "dir");
      const currentScope: SearchScope = {
        workspace: { ...workspace(), root: workspaceRoot },
        scopeId: "scope-1",
        relativePaths: ["safe-link"],
      };
      const index = createWorkspaceIndex();

      const result = await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
        fs: nodeWorkspaceFs,
        nowMs: FIXED_NOW,
        workspaceIndex: index,
      });
      const snapshot = await snapshotFor(index, currentScope);

      expect(result.atoms).toEqual([]);
      expect(snapshot?.discovery.directories.map((dir) => dir.scopePath) ?? []).toEqual([]);
    } finally {
      removeRuntimeDir(workspaceRoot);
    }
  });

  it("rejects cached records whose selected path is an internal symlink alias", (ctx) => {
    if (process.platform === "win32") {
      ctx.skip();
    }
    const workspaceRoot = tempRuntimeDir();
    const content = "export const internalTarget = 'needle';\n";
    try {
      mkdirSync(join(workspaceRoot, "src"), { recursive: true });
      const targetPath = join(workspaceRoot, "src", "target.ts");
      writeFileSync(targetPath, content, "utf8");
      symlinkSync(targetPath, join(workspaceRoot, "alias.ts"), "file");
      const base = sampleSnapshot(content);
      const snapshot: WorkspaceIndexSnapshot = {
        ...base,
        relativePaths: ["alias.ts"],
        discovery: {
          ...base.discovery,
          files: [{ scopePath: "alias.ts", sizeBytes: Buffer.byteLength(content, "utf8") }],
        },
        records: [{ ...firstSnapshotRecord(base), scopePath: "alias.ts" }],
      };

      const prepared = prepareWorkspaceIndexSnapshot(
        snapshot,
        { ...workspace(), root: workspaceRoot },
        nodeWorkspaceFs,
      );

      expect(prepared.entries).toEqual([]);
      expect(prepared.report).toMatchObject({ skippedEntries: 1, droppedRecords: 1 });
    } finally {
      removeRuntimeDir(workspaceRoot);
    }
  });

  it("contains a persisted file before probing whether it still exists", () => {
    const snapshot = sampleSnapshot("export const app = 'needle';\n");
    const base = memFs(MEM_ROOT, {});
    let existsCalls = 0;
    let statCalls = 0;
    const escapingFs: WorkspaceFs = {
      ...base,
      exists: () => {
        existsCalls += 1;
        throw new Error("exists must not run before containment");
      },
      realPath: (absolutePath): string =>
        absolutePath === `${MEM_ROOT}/src/app.ts` ? "/outside/app.ts" : absolutePath,
      stat: (absolutePath): WorkspaceStat => {
        statCalls += 1;
        return base.stat(absolutePath);
      },
    };

    expect(() => prepareWorkspaceIndexSnapshot(snapshot, workspace(), escapingFs)).toThrow(
      "path escapes the workspace boundary via symlink",
    );
    expect(existsCalls).toBe(0);
    expect(statCalls).toBe(0);
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
    expect(tracked.counters.readFileBytes).toBe(2);
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
    expect(tracked.counters.readFileBytes).toBe(4);
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

  it("persists and reuses an explicitly selected directory", async () => {
    const tracked = createTrackedFs({
      "src/a.ts": "export const alpha = 'needle';\n",
      "src/b.ts": "export const beta = 'other';\n",
      "tests/outside.test.ts": "it('stays outside the scope', () => undefined);\n",
    });
    const currentScope = { ...scope(), relativePaths: ["src"] };
    let savedSnapshot: WorkspaceIndexSnapshot | undefined;
    let saves = 0;
    const index = createWorkspaceIndex({
      loadSnapshot: (): WorkspaceIndexSnapshot | undefined => savedSnapshot,
      saveSnapshot: (_key: string, snapshot: WorkspaceIndexSnapshot): void => {
        saves += 1;
        savedSnapshot = snapshot;
      },
    });

    await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });
    expect(saves).toBe(1);
    expect(savedSnapshot?.discovery.directories.map((directory) => directory.scopePath)).toContain(
      "src",
    );

    const warm = await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });

    expect(saves).toBe(1);
    expect(warm.workspaceIndex).toMatchObject({ reusedRecords: 2, staleRecords: 0 });
    expect(warm.atoms.map((atom) => atom.scopePath)).toEqual(["src/a.ts"]);
  });

  it("persists an explicit fixed-file selection without reading unrelated parent membership", async () => {
    const tracked = createTrackedFs({
      "src/app.ts": "export const app = 'needle';\n",
      "src/unrelated.ts": "export const unrelated = true;\n",
    });
    const currentScope = { ...scope(), relativePaths: ["src/app.ts"] };
    let savedSnapshot: WorkspaceIndexSnapshot | undefined;
    const index = createWorkspaceIndex({
      loadSnapshot: (): WorkspaceIndexSnapshot | undefined => savedSnapshot,
      saveSnapshot: (_key: string, snapshot: WorkspaceIndexSnapshot): void => {
        savedSnapshot = snapshot;
      },
    });

    await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });
    expect(savedSnapshot?.discovery.directories).toEqual([]);
    expect(tracked.counters.readDir).toBe(0);

    tracked.resetCounters();
    const warm = await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });

    expect(warm.workspaceIndex).toMatchObject({ reusedRecords: 1, staleRecords: 0 });
    expect(tracked.counters.readDir).toBe(0);
  });

  it.skipIf(process.platform === "win32")(
    "does not serve a warm fixed-file record after its root is retargeted under a denied component",
    async () => {
      const runtimeDir = tempRuntimeDir();
      try {
        const safeRoot = join(runtimeDir, "safe-root");
        const lexicalRoot = join(runtimeDir, "workspace");
        const deniedParent = join(runtimeDir, ".git");
        const deniedRoot = join(deniedParent, "retargeted-root");
        const scopePath = "src/app.ts";
        mkdirSync(join(safeRoot, "src"), { recursive: true });
        writeFileSync(join(safeRoot, scopePath), "export const app = 'needle';\n", "utf8");
        symlinkSync(safeRoot, lexicalRoot, "dir");
        const currentScope: SearchScope = {
          ...scope(),
          workspace: { ...workspace(), root: lexicalRoot },
          relativePaths: [scopePath],
        };
        let savedSnapshot: WorkspaceIndexSnapshot | undefined;
        const store: WorkspaceIndexStore = {
          loadSnapshot: (): WorkspaceIndexSnapshot | undefined => savedSnapshot,
          saveSnapshot: (_key: string, snapshot: WorkspaceIndexSnapshot): void => {
            savedSnapshot = snapshot;
          },
        };

        const cold = await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
          fs: nodeWorkspaceFs,
          nowMs: FIXED_NOW,
          workspaceIndex: createWorkspaceIndex(store),
        });
        expect(cold.atoms.map((atom) => atom.scopePath)).toEqual([scopePath]);
        const cachedSnapshot = savedSnapshot;
        if (cachedSnapshot === undefined) throw new Error("expected persisted fixed-file snapshot");
        const cachedFile = cachedSnapshot.discovery.files[0];
        if (cachedFile === undefined) throw new Error("expected persisted fixed-file metadata");

        mkdirSync(deniedParent);
        renameSync(safeRoot, deniedRoot);
        unlinkSync(lexicalRoot);
        symlinkSync(deniedRoot, lexicalRoot, "dir");
        expect(
          workspaceIndexFileMetadata(scopePath, nodeWorkspaceFs.stat(join(deniedRoot, scopePath))),
        ).toEqual(cachedFile);
        expect(
          isWorkspaceIndexSnapshotFresh(cachedSnapshot, currentScope.workspace, nodeWorkspaceFs),
        ).toBe(false);
        expect(() =>
          prepareWorkspaceIndexSnapshot(cachedSnapshot, currentScope.workspace, nodeWorkspaceFs),
        ).toThrow(PathDeniedError);

        await expect(
          searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
            fs: nodeWorkspaceFs,
            nowMs: FIXED_NOW,
            workspaceIndex: createWorkspaceIndex(store),
          }),
        ).rejects.toBeInstanceOf(PathDeniedError);
      } finally {
        removeRuntimeDir(runtimeDir);
      }
    },
  );

  it("does not persist an explicit directory when membership changes after discovery", async () => {
    const tracked = createTrackedFs({
      "src/app.ts": "export const app = 'needle';\n",
    });
    let firstSourceRead = true;
    const racingFs: WorkspaceFs = {
      ...tracked.fs,
      readDir: (absolutePath, maxEntries): readonly WorkspaceDirEntry[] => {
        const entries = tracked.fs.readDir(absolutePath, maxEntries);
        if (absolutePath === `${MEM_ROOT}/src` && firstSourceRead) {
          firstSourceRead = false;
          tracked.writeFile("src/raced.ts", "export const raced = true;\n");
        }
        return entries;
      },
    };
    let saves = 0;
    const index = createWorkspaceIndex({
      loadSnapshot: (): undefined => undefined,
      saveSnapshot: (): void => {
        saves += 1;
      },
    });

    const result = await searchText(
      { ...scope(), relativePaths: ["src"] },
      nlq("needle"),
      DEFAULT_SEARCH_LIMITS,
      { fs: racingFs, nowMs: FIXED_NOW, workspaceIndex: index },
    );

    expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["src/app.ts"]);
    expect(saves).toBe(0);
  });

  it("does not reuse warm records after workspace ignore policy changes", async () => {
    const tracked = createTrackedFs({
      "ignored-area/leaked.ts": "export const leaked = 'needle';\n",
      "src/app.ts": "export const app = 'needle';\n",
    });
    const originalScope = scope();
    const index = createWorkspaceIndex();

    const cold = await searchText(originalScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });
    expect(cold.atoms.map((atom) => atom.scopePath)).toContain("ignored-area/leaked.ts");

    const ignoredScope: SearchScope = {
      ...originalScope,
      workspace: { ...originalScope.workspace, ignoreLines: ["ignored-area/"] },
    };
    const warm = await searchText(ignoredScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });
    const snapshot = await snapshotFor(index, ignoredScope);

    expect(warm.atoms.map((atom) => atom.scopePath)).toEqual(["src/app.ts"]);
    expect(snapshot?.records.map((record) => record.scopePath)).toEqual(["src/app.ts"]);
    expect(JSON.stringify(snapshot)).not.toContain("ignored-area/");
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
    tracked.resetCounters();
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
    expect(tracked.counters.exists).toBe(0);
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
    expect(result.workspaceIndex).toMatchObject({ deletedEntries: 1, droppedRecords: 1 });
    expect(tracked.counters.readDir).toBeGreaterThan(0);
    expect(tracked.counters.readFileUtf8).toBe(0);
    expect(tracked.counters.readFileBytes).toBe(0);
  });

  it("rescans a changed directory when a file becomes a directory beside an added file", async () => {
    const tracked = createTrackedFs({
      foo: "old file\n",
      "stable.ts": "export const stable = true;\n",
    });
    const currentScope = scope();
    const index = createWorkspaceIndex();

    await searchText(currentScope, rxq("absent"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });
    tracked.deleteFile("foo");
    tracked.writeFile("foo/hit.ts", "export const found = 'needle';\n");
    tracked.writeFile("bar.ts", "export const added = true;\n");

    const warm = await searchText(currentScope, rxq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });
    const cold = await searchText(currentScope, rxq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
    });

    expect(warm.atoms.map((atom) => atom.scopePath)).toEqual(["foo/hit.ts"]);
    expect(warm.atoms).toEqual(cold.atoms);
  });

  it("rescans a changed directory when a directory becomes a file beside an added file", async () => {
    const tracked = createTrackedFs({
      "foo/old.ts": "export const old = true;\n",
      "stable.ts": "export const stable = true;\n",
    });
    const currentScope = scope();
    const index = createWorkspaceIndex();

    await searchText(currentScope, rxq("absent"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });
    tracked.deleteFile("foo/old.ts");
    tracked.writeFile("foo", "needle\n");
    tracked.writeFile("bar.ts", "export const added = true;\n");

    const warm = await searchText(currentScope, rxq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });
    const cold = await searchText(currentScope, rxq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs: tracked.fs,
      nowMs: FIXED_NOW,
    });

    expect(warm.atoms.map((atom) => atom.scopePath)).toEqual(["foo"]);
    expect(warm.atoms).toEqual(cold.atoms);
  });

  it("reports a deletion that races between file preparation and directory inspection", async () => {
    const tracked = createTrackedFs({
      "src/a.ts": "export const alpha = 'needle';\n",
      "src/b.ts": "export const beta = 'other';\n",
    });
    let deleteOnDirectoryInspection = false;
    const fs: WorkspaceFs = {
      ...tracked.fs,
      readDir: (absolutePath, maxEntries): ReturnType<WorkspaceFs["readDir"]> => {
        if (deleteOnDirectoryInspection && absolutePath.replaceAll("\\", "/").endsWith("/src")) {
          deleteOnDirectoryInspection = false;
          tracked.deleteFile("src/a.ts");
        }
        return tracked.fs.readDir(absolutePath, maxEntries);
      },
    };
    const currentScope = scope();
    const index = createWorkspaceIndex();

    await searchText(currentScope, nlq("beta"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });
    deleteOnDirectoryInspection = true;
    const result = await searchText(currentScope, nlq("beta"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
      workspaceIndex: index,
    });

    expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["src/b.ts"]);
    expect(result.workspaceIndex).toMatchObject({ deletedEntries: 1, droppedRecords: 1 });
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
    const leadingTerms = Array.from({ length: 32 }, (_, index) => `term${index.toString()}`).join(
      " ",
    );
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
    // The lexical chunk is intentionally incomplete, so cap-safe ranking performs one bounded
    // live preview before the normal descriptor-backed scan.
    expect(tracked.counters.readFileUtf8).toBe(1);
    expect(tracked.counters.readFileBytes).toBe(2);
  });

  it("persists a file-backed snapshot across index instances and reuses warm data", async () => {
    const runtimeDir = tempRuntimeDir();
    try {
      const tracked = createTrackedFs({
        "README.md": "needle in docs\n",
        "src/a.ts": "export const alpha = 'needle';\n",
      });
      const currentScope = scope();
      const firstIndex = createWorkspaceIndex(createFileWorkspaceIndexStore({ runtimeDir }));

      await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
        fs: tracked.fs,
        nowMs: FIXED_NOW,
        workspaceIndex: firstIndex,
      });

      tracked.resetCounters();
      const secondIndex = createWorkspaceIndex(createFileWorkspaceIndexStore({ runtimeDir }));
      const result = await searchText(currentScope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
        fs: tracked.fs,
        nowMs: FIXED_NOW,
        workspaceIndex: secondIndex,
      });

      expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["README.md", "src/a.ts"]);
      expect(tracked.counters.readDir).toBe(2);
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

  it("seals file-backed snapshots so paths, source, and lexical hashes are not recoverable", async () => {
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
      const tokenHash = createHash("sha256").update("token").digest("hex");

      expect(fileName).toMatch(/^workspace-index-v2-[0-9a-f]{64}-[0-9a-f]{64}\.json$/u);
      expect(fileName).not.toContain(MEM_ROOT);
      expect(raw).toMatch(/^kv1\./u);
      expect(raw).not.toContain(MEM_ROOT);
      expect(raw).not.toContain(secret);
      expect(raw).not.toContain(unsupportedSecret);
      expect(raw).not.toContain("export const");
      expect(raw).not.toContain(tokenHash);
    } finally {
      removeRuntimeDir(runtimeDir);
    }
  });

  it("writes owner-only file-backed runtime directories and snapshots", async (ctx) => {
    if (process.platform === "win32") {
      ctx.skip();
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

  it("rejects file-backed runtime directories that resolve into the workspace through symlinks", (ctx) => {
    if (process.platform === "win32") {
      ctx.skip();
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

  it("does not load symlinked file-backed snapshot paths", async (ctx) => {
    if (process.platform === "win32") {
      ctx.skip();
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

  it("does not follow a runtime directory replaced by a workspace symlink after store creation", async (ctx) => {
    if (process.platform === "win32") {
      ctx.skip();
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

  it("treats a runtime directory recreated at the same path as cache loss", async () => {
    const runtimeDir = tempRuntimeDir();
    try {
      const originalStore = createFileWorkspaceIndexStore({ runtimeDir });
      await originalStore.saveSnapshot("safe-key", sampleSnapshot("needle"));

      removeRuntimeDir(runtimeDir);
      mkdirSync(runtimeDir, { recursive: true });
      const replacementStore = createFileWorkspaceIndexStore({ runtimeDir });
      await replacementStore.saveSnapshot("safe-key", sampleSnapshot("poison"));

      await expect(originalStore.loadSnapshot("safe-key")).resolves.toBeUndefined();
      await expect(replacementStore.loadSnapshot("safe-key")).resolves.toBeDefined();
    } finally {
      removeRuntimeDir(runtimeDir);
    }
  });

  it("prunes orphaned temp snapshots under the configured snapshot cap", async () => {
    const runtimeDir = tempRuntimeDir();
    try {
      const tempFileName = `workspace-index-v2-${fileIndexStorageGenerationId()}-${"a".repeat(64)}.json.${"b".repeat(16)}.tmp`;
      const tempPath = join(runtimeDir, tempFileName);
      writeFileSync(tempPath, "{}\n", "utf8");
      utimesSync(tempPath, 1, 1);
      const store = createFileWorkspaceIndexStore({ runtimeDir, maxSnapshots: 1 });

      await store.saveSnapshot("fresh-key", sampleSnapshot("needle"));

      const files = runtimeFiles(runtimeDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^workspace-index-v2-[0-9a-f]{64}-[0-9a-f]{64}\.json$/u);
      expect(readdirSync(runtimeDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      removeRuntimeDir(runtimeDir);
    }
  });

  it("preserves fresh temp snapshots within the cleanup budget", async () => {
    const runtimeDir = tempRuntimeDir();
    try {
      const tempFileName = `workspace-index-v2-${fileIndexStorageGenerationId()}-${"a".repeat(64)}.json.${"b".repeat(16)}.tmp`;
      writeFileSync(join(runtimeDir, tempFileName), "{}\n", "utf8");
      const store = createFileWorkspaceIndexStore({ runtimeDir, maxSnapshots: 1 });

      await store.saveSnapshot("fresh-key", sampleSnapshot("needle"));

      expect(readdirSync(runtimeDir)).toContain(tempFileName);
    } finally {
      removeRuntimeDir(runtimeDir);
    }
  });

  it("prunes excess temp snapshots after the pressure grace period", async () => {
    const runtimeDir = tempRuntimeDir();
    try {
      const generationId = fileIndexStorageGenerationId();
      const tempNames = Array.from(
        { length: 5 },
        (_, index) =>
          `workspace-index-v2-${generationId}-${index.toString(16).padStart(64, "0")}.json.${"b".repeat(16)}.tmp`,
      );
      for (const tempName of tempNames) {
        const path = join(runtimeDir, tempName);
        writeFileSync(path, "{}\n", "utf8");
        const oldEnoughForPressure = Date.now() / 1000 - 60;
        utimesSync(path, oldEnoughForPressure, oldEnoughForPressure);
      }
      const store = createFileWorkspaceIndexStore({ runtimeDir, maxSnapshots: 1 });

      await store.saveSnapshot("fresh-key", sampleSnapshot("needle"));

      expect(readdirSync(runtimeDir).filter((name) => name.endsWith(".tmp"))).toHaveLength(4);
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
      expect(tracked.counters.readFileUtf8).toBe(1);
      expect(tracked.counters.readFileBytes).toBeGreaterThan(0);
    } finally {
      removeRuntimeDir(runtimeDir);
    }
  });

  it("does not write or load oversize file-backed snapshots at the store layer", async () => {
    const runtimeDir = tempRuntimeDir();
    try {
      const writer = createFileWorkspaceIndexStore({ runtimeDir });
      await writer.saveSnapshot("oversize-key", sampleSnapshot("needle ".repeat(64)));
      expect(runtimeFiles(runtimeDir)).toHaveLength(1);

      const cappedReader = createFileWorkspaceIndexStore({
        runtimeDir,
        maxSnapshotBytes: 64,
      });
      await expect(cappedReader.loadSnapshot("oversize-key")).resolves.toBeUndefined();

      const cappedWriter = createFileWorkspaceIndexStore({
        runtimeDir,
        maxSnapshotBytes: 64,
      });
      await cappedWriter.saveSnapshot("too-large-key", sampleSnapshot("needle ".repeat(64)));
      expect(runtimeFiles(runtimeDir)).toHaveLength(1);
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
      expect(tracked.counters.readFileUtf8).toBe(1);
      expect(tracked.counters.readFileBytes).toBeGreaterThan(0);
    } finally {
      removeRuntimeDir(runtimeDir);
    }
  });

  it("loads a corrupt file-backed snapshot as undefined", async () => {
    const runtimeDir = tempRuntimeDir();
    try {
      const failures: string[] = [];
      const store = createFileWorkspaceIndexStore({
        runtimeDir,
        onLoadFailure: (failure): void => {
          failures.push(failure.reason);
        },
      });
      await store.saveSnapshot("corrupt-key", sampleSnapshot("needle"));

      const [fileName] = runtimeFiles(runtimeDir);
      if (fileName === undefined) {
        throw new Error("expected persisted snapshot file");
      }
      writeFileSync(join(runtimeDir, fileName), "{broken", "utf8");

      await expect(store.loadSnapshot("corrupt-key")).resolves.toBeUndefined();
      expect(failures).toEqual(["authentication-or-corruption"]);
    } finally {
      removeRuntimeDir(runtimeDir);
    }
  });

  it("treats a different encryption-key generation as an isolated cache miss", async () => {
    const runtimeDir = tempRuntimeDir();
    try {
      const writer = createFileWorkspaceIndexStore({ runtimeDir });
      await writer.saveSnapshot("key-rotation", sampleSnapshot("needle"));
      await expect(writer.loadSnapshot("key-rotation")).resolves.toBeDefined();
      const failures: string[] = [];
      const wrongKeyReader = createEncryptedFileWorkspaceIndexStore({
        runtimeDir,
        encryptionKey: Buffer.alloc(32, 31),
        onLoadFailure: (failure): void => {
          failures.push(failure.reason);
        },
      });

      await expect(wrongKeyReader.loadSnapshot("key-rotation")).resolves.toBeUndefined();
      expect(failures).toEqual([]);
    } finally {
      removeRuntimeDir(runtimeDir);
    }
  });

  it("rebuilds an envelope-v2 snapshot from the immediately previous format", async () => {
    const runtimeDir = tempRuntimeDir();
    const storageKey = "previous-snapshot-version";
    const failures: string[] = [];
    try {
      const writer = createFileWorkspaceIndexStore({ runtimeDir });
      await writer.saveSnapshot(storageKey, sampleSnapshot("needle"));
      const [fileName] = runtimeFiles(runtimeDir);
      if (fileName === undefined) {
        throw new Error("expected persisted snapshot file");
      }
      const path = join(runtimeDir, fileName);
      const envelope = JSON.parse(openString(FILE_INDEX_TEST_KEY, readFileSync(path, "utf8"))) as {
        readonly version: number;
        readonly runtimeDirBinding: string;
        readonly storageKeyHash: string;
        readonly snapshot: WorkspaceIndexSnapshot;
      };
      writeFileSync(
        path,
        sealString(
          FILE_INDEX_TEST_KEY,
          JSON.stringify({
            ...envelope,
            snapshot: { ...envelope.snapshot, version: WORKSPACE_INDEX_SNAPSHOT_VERSION - 1 },
          }),
        ),
        "utf8",
      );
      const reader = createFileWorkspaceIndexStore({
        runtimeDir,
        onLoadFailure: (failure): void => {
          failures.push(failure.reason);
        },
      });

      await expect(reader.loadSnapshot(storageKey)).resolves.toBeUndefined();
      expect(failures).toEqual([]);
    } finally {
      removeRuntimeDir(runtimeDir);
    }
  });

  it("reloads a same-fingerprint snapshot after an atomic store replacement", async () => {
    const runtimeDir = tempRuntimeDir();
    try {
      const store = createFileWorkspaceIndexStore({ runtimeDir });
      const storageKey = "same-fingerprint";
      const first = sampleSnapshot("needle");
      const replacement = sampleSnapshot("poison");
      await store.saveSnapshot(storageKey, first);

      const [fileName] = runtimeFiles(runtimeDir);
      if (fileName === undefined) {
        throw new Error("expected persisted snapshot file");
      }
      const path = join(runtimeDir, fileName);
      const fixedTimeSeconds = 1_700_000_000;
      utimesSync(path, fixedTimeSeconds, fixedTimeSeconds);
      await expect(store.loadSnapshot(storageKey)).resolves.toEqual(first);

      await store.saveSnapshot(storageKey, replacement);
      utimesSync(path, fixedTimeSeconds, fixedTimeSeconds);

      await expect(store.loadSnapshot(storageKey)).resolves.toEqual(replacement);
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
