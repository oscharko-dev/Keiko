import type { WorkspaceDirEntry, WorkspaceFs } from "./fs.js";
import { compileIgnore, isDenied, isIgnored, type IgnoreMatcher } from "./ignore.js";
import { resolveWithinWorkspace } from "./paths.js";
import { containedRealPathInfo } from "./realpath.js";
import type { DiscoveredFile, WorkspaceInfo } from "./types.js";
import { RepoSearchInvalidQueryError } from "./errors.js";

interface ScopeShape {
  readonly workspace: WorkspaceInfo;
  readonly relativePaths: readonly string[];
}

interface LimitsShape {
  readonly maxFilesScanned: number;
}

interface EntryWalk {
  readonly scope: ScopeShape;
  readonly limits: LimitsShape;
  readonly fs: WorkspaceFs;
  readonly ignoreMatcher: IgnoreMatcher;
  readonly files: DiscoveredFile[];
  truncated: boolean;
}

function normalizeScopePath(scopePath: string): string {
  return scopePath.split("\\").join("/");
}

function readDirSorted(fs: WorkspaceFs, absoluteDir: string): readonly WorkspaceDirEntry[] {
  try {
    return [...fs.readDir(absoluteDir)].sort((a, b) => (a.name < b.name ? -1 : 1));
  } catch {
    return [];
  }
}

function pushAllowedFile(walk: EntryWalk, relPath: string, absPath: string): void {
  if (walk.files.length > walk.limits.maxFilesScanned) {
    return;
  }
  const stat = walk.fs.stat(absPath);
  if (!stat.isFile) {
    return;
  }
  walk.files.push({ relativePath: relPath, sizeBytes: stat.size });
  if (walk.files.length > walk.limits.maxFilesScanned) {
    walk.truncated = true;
  }
}

function allowedByFilters(walk: EntryWalk, relPath: string, isDirectory: boolean): boolean {
  return !isDenied(relPath) && !isIgnored(walk.ignoreMatcher, relPath, isDirectory);
}

function handleDirectoryEntry(
  walk: EntryWalk,
  absoluteDir: string,
  dirRel: string,
  entry: WorkspaceDirEntry,
  depth: number,
): void {
  if (entry.isSymbolicLink) {
    return;
  }
  const root = walk.scope.workspace.root;
  const childRel = dirRel.length === 0 ? entry.name : `${dirRel}/${entry.name}`;
  if (!allowedByFilters(walk, childRel, entry.isDirectory)) {
    return;
  }
  const childAbs = resolveWithinWorkspace(root, childRel);
  const contained = containedRealPathInfo(walk.fs, root, childAbs);
  const realRel = normalizeScopePath(contained.realRelative);
  if (!allowedByFilters(walk, realRel, entry.isDirectory)) {
    return;
  }
  if (entry.isDirectory) {
    walkEntryDirectory(walk, contained.path, realRel, depth + 1);
    return;
  }
  pushAllowedFile(walk, realRel, contained.path);
}

function walkEntryDirectory(
  walk: EntryWalk,
  absoluteDir: string,
  dirRel: string,
  depth: number,
): void {
  if (depth > 12 || walk.truncated) {
    return;
  }
  for (const entry of readDirSorted(walk.fs, absoluteDir)) {
    if (walk.files.length > walk.limits.maxFilesScanned) {
      walk.truncated = true;
      return;
    }
    handleDirectoryEntry(walk, absoluteDir, dirRel, entry, depth);
  }
}

function handleScopeEntry(walk: EntryWalk, entry: string): void {
  const root = walk.scope.workspace.root;
  const abs = resolveWithinWorkspace(root, entry);
  const contained = containedRealPathInfo(walk.fs, root, abs);
  const entryRel = normalizeScopePath(entry);
  const realRel = normalizeScopePath(contained.realRelative);
  if (isDenied(entryRel) || isDenied(realRel)) {
    return;
  }
  let stat: ReturnType<WorkspaceFs["stat"]>;
  try {
    stat = walk.fs.stat(contained.path);
  } catch {
    throw new RepoSearchInvalidQueryError(
      "Connected scope path is not accessible from the selected project.",
    );
  }
  if (
    !allowedByFilters(walk, entryRel, stat.isDirectory) ||
    !allowedByFilters(walk, realRel, stat.isDirectory)
  ) {
    return;
  }
  if (stat.isDirectory) {
    walkEntryDirectory(walk, contained.path, realRel, 1);
    return;
  }
  pushAllowedFile(walk, realRel, contained.path);
}

export function collectFromEntries(
  scope: ScopeShape,
  limits: LimitsShape,
  fs: WorkspaceFs,
): { files: readonly DiscoveredFile[]; truncated: boolean } {
  const out: DiscoveredFile[] = [];
  const walk: EntryWalk = {
    scope,
    limits,
    fs,
    ignoreMatcher: compileIgnore(scope.workspace.ignoreLines),
    files: out,
    truncated: false,
  };
  for (const entry of scope.relativePaths) {
    if (walk.truncated) {
      break;
    }
    handleScopeEntry(walk, entry);
  }
  return { files: out.slice(0, limits.maxFilesScanned), truncated: walk.truncated };
}
