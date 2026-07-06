// In-memory WorkspaceFs over a crawled manual's page set (Epic #1853, Issue #1874).
//
// The crawler captures every accepted page's bytes in memory (both local and http manuals). Rather
// than add a second ingestion/parser path, those bytes are exposed through the SAME `WorkspaceFs`
// port the discovery/extraction pipeline already reads, under a synthetic absolute root. A `files`
// scope over the reachable relative paths then flows through `runIndexingJob` unchanged: existing
// walker containment gate, HTML parser, chunker, lexical + vector indexing, and lifecycle. Pure and
// egress-free — it serves bytes from a map, never from disk or the network.

import type { WorkspaceDirEntry, WorkspaceFs, WorkspaceStat } from "@oscharko-dev/keiko-workspace";
import type { CrawledManualPage } from "./types.js";

function joinRoot(root: string, relativePath: string): string {
  return `${root}/${relativePath}`.replace(/\/+/gu, "/");
}

function dirEntry(name: string, isDirectory: boolean): WorkspaceDirEntry {
  return { name, isDirectory, isFile: !isDirectory, isSymbolicLink: false };
}

function childrenUnder(
  root: string,
  byPath: ReadonlyMap<string, Uint8Array>,
  dirAbs: string,
): readonly WorkspaceDirEntry[] {
  const prefix = dirAbs === root ? `${root}/` : `${dirAbs}/`;
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const absolute of byPath.keys()) {
    if (!absolute.startsWith(prefix)) continue;
    const rest = absolute.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) files.add(rest);
    else dirs.add(rest.slice(0, slash));
  }
  return [...[...dirs].map((n) => dirEntry(n, true)), ...[...files].map((n) => dirEntry(n, false))];
}

// Build an in-memory `WorkspaceFs` for the crawled page set rooted at `rootAbsolutePath`. Every page
// is addressable at `${rootAbsolutePath}/${relativePath}`; directories are implied by path prefixes.
// There are no symlinks, so `realPath` is the identity — the walker's containment gate holds because
// every synthetic path is literally under the root.
export function createManualPageWorkspaceFs(
  rootAbsolutePath: string,
  pages: readonly CrawledManualPage[],
): WorkspaceFs {
  const byPath = new Map<string, Uint8Array>();
  for (const page of pages) {
    byPath.set(joinRoot(rootAbsolutePath, page.relativePath), page.bytes);
  }
  const decode = (bytes: Uint8Array): string =>
    new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return {
    readFileUtf8: (absolutePath: string): string => {
      const bytes = byPath.get(absolutePath);
      if (bytes === undefined) throw new Error(`ENOENT: ${absolutePath}`);
      return decode(bytes);
    },
    stat: (absolutePath: string): WorkspaceStat => {
      const bytes = byPath.get(absolutePath);
      if (bytes === undefined) {
        return { size: 0, isFile: false, isDirectory: true, isSymbolicLink: false };
      }
      return { size: bytes.length, isFile: true, isDirectory: false, isSymbolicLink: false };
    },
    readDir: (absolutePath: string): readonly WorkspaceDirEntry[] =>
      childrenUnder(rootAbsolutePath, byPath, absolutePath),
    realPath: (absolutePath: string): string => absolutePath,
    exists: (absolutePath: string): boolean =>
      byPath.has(absolutePath) || absolutePath === rootAbsolutePath,
    readFileBytes: (absolutePath: string, maxBytes: number): Promise<Uint8Array> => {
      const bytes = byPath.get(absolutePath);
      if (bytes === undefined) return Promise.reject(new Error(`ENOENT: ${absolutePath}`));
      const cap = Math.max(0, Math.floor(maxBytes));
      return Promise.resolve(bytes.length > cap ? bytes.subarray(0, cap) : bytes);
    },
    readFileUtf8Prefix: (absolutePath: string, maxBytes: number): string => {
      const bytes = byPath.get(absolutePath);
      if (bytes === undefined) throw new Error(`ENOENT: ${absolutePath}`);
      const cap = Math.max(0, Math.floor(maxBytes));
      return decode(bytes.subarray(0, cap));
    },
  };
}
