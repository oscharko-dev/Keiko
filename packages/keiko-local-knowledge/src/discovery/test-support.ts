// Test-only helpers for the discovery layer. Not exported from the package barrel —
// trust-8 (test-support naming) keeps production code from importing this module.

import type { KnowledgeSourceScope } from "@oscharko-dev/keiko-contracts";
import type { WorkspaceDirEntry, WorkspaceFs, WorkspaceStat } from "@oscharko-dev/keiko-workspace";

interface MemFsEntry {
  readonly content: Uint8Array;
  readonly realPathOverride?: string;
  readonly hardLinkCount?: number;
  readonly isSymbolicLink?: boolean;
}

function toAbs(root: string, rel: string): string {
  if (rel === "") return root;
  return root.endsWith("/") ? `${root}${rel}` : `${root}/${rel}`;
}

function entriesByPrefix(
  root: string,
  files: ReadonlyMap<string, MemFsEntry>,
  dirAbs: string,
): readonly WorkspaceDirEntry[] {
  const prefix = dirAbs === root ? `${root}/` : `${dirAbs}/`;
  const dirNames = new Set<string>();
  const fileNames = new Set<string>();
  for (const relPath of files.keys()) {
    const full = toAbs(root, relPath);
    if (!full.startsWith(prefix)) continue;
    const rest = full.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      fileNames.add(rest);
    } else {
      dirNames.add(rest.slice(0, slash));
    }
  }
  const dirs: WorkspaceDirEntry[] = [...dirNames].map((name) => ({
    name,
    isDirectory: true,
    isFile: false,
    isSymbolicLink: false,
  }));
  const filesArr: WorkspaceDirEntry[] = [...fileNames].map((name) => ({
    name,
    isDirectory: false,
    isFile: true,
    isSymbolicLink: false,
  }));
  return [...dirs, ...filesArr];
}

// Lightweight in-memory WorkspaceFs. Keys are POSIX-relative to `root`. A
// `realPathOverride` per file lets a test simulate a symlink whose real path escapes the
// scope root (used by the PATH_ESCAPE adversarial test).
export interface MemoryFsFile {
  readonly relativePath: string;
  readonly content: string | Uint8Array;
  readonly realPathOverride?: string;
  readonly hardLinkCount?: number;
  readonly isSymbolicLink?: boolean;
}

function buildMap(files: readonly MemoryFsFile[]): Map<string, MemFsEntry> {
  const encoder = new TextEncoder();
  const map = new Map<string, MemFsEntry>();
  for (const f of files) {
    const bytes = typeof f.content === "string" ? encoder.encode(f.content) : f.content;
    const entry: MemFsEntry = {
      content: bytes,
      ...(f.realPathOverride !== undefined ? { realPathOverride: f.realPathOverride } : {}),
      ...(f.hardLinkCount !== undefined ? { hardLinkCount: f.hardLinkCount } : {}),
      ...(f.isSymbolicLink !== undefined ? { isSymbolicLink: f.isSymbolicLink } : {}),
    };
    map.set(f.relativePath, entry);
  }
  return map;
}

function memoryStat(
  root: string,
  map: ReadonlyMap<string, MemFsEntry>,
  findKey: (absolutePath: string) => string | undefined,
): (absolutePath: string) => WorkspaceStat {
  return (absolutePath: string): WorkspaceStat => {
    const key = findKey(absolutePath);
    if (key === undefined) {
      const hasChildren = [...map.keys()].some((k) =>
        toAbs(root, k).startsWith(`${absolutePath}/`),
      );
      if (hasChildren || absolutePath === root) {
        return { size: 0, isFile: false, isDirectory: true, isSymbolicLink: false };
      }
      throw new Error(`ENOENT: ${absolutePath}`);
    }
    return {
      size: map.get(key)?.content.byteLength ?? 0,
      isFile: true,
      isDirectory: false,
      isSymbolicLink: map.get(key)?.isSymbolicLink ?? false,
      hardLinkCount: map.get(key)?.hardLinkCount,
    };
  };
}

export function memoryFs(root: string, files: readonly MemoryFsFile[]): WorkspaceFs {
  const map = buildMap(files);
  const findKey = (absolutePath: string): string | undefined => {
    for (const key of map.keys()) {
      if (toAbs(root, key) === absolutePath) return key;
    }
    return undefined;
  };
  return {
    readFileUtf8: (absolutePath: string): string => {
      const key = findKey(absolutePath);
      if (key === undefined) throw new Error(`ENOENT: ${absolutePath}`);
      return new TextDecoder("utf-8").decode(map.get(key)?.content ?? new Uint8Array());
    },
    stat: memoryStat(root, map, findKey),
    readDir: (absolutePath: string): readonly WorkspaceDirEntry[] =>
      entriesByPrefix(root, map, absolutePath),
    realPath: (absolutePath: string): string => {
      const key = findKey(absolutePath);
      const override = key === undefined ? undefined : map.get(key)?.realPathOverride;
      return override ?? absolutePath;
    },
    exists: (absolutePath: string): boolean =>
      findKey(absolutePath) !== undefined || absolutePath === root,
    readFileBytes: (absolutePath: string, maxBytes: number): Promise<Uint8Array> => {
      const key = findKey(absolutePath);
      if (key === undefined) return Promise.reject(new Error(`ENOENT: ${absolutePath}`));
      const buf = map.get(key)?.content ?? new Uint8Array();
      const cap = Math.max(0, Math.floor(maxBytes));
      return Promise.resolve(buf.subarray(0, Math.min(buf.length, cap)));
    },
  };
}

export function folderScope(
  rootPath: string,
  options: {
    readonly recursive?: boolean;
    readonly includeGlobs?: readonly string[];
    readonly excludeGlobs?: readonly string[];
  } = {},
): KnowledgeSourceScope {
  const base: KnowledgeSourceScope & { kind: "folder" } = {
    kind: "folder",
    rootPath,
    recursive: options.recursive ?? true,
  };
  return {
    ...base,
    ...(options.includeGlobs !== undefined ? { includeGlobs: options.includeGlobs } : {}),
    ...(options.excludeGlobs !== undefined ? { excludeGlobs: options.excludeGlobs } : {}),
  };
}
