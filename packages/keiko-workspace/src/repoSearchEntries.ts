import type { WorkspaceDirEntry, WorkspaceFs } from "./fs.js";
import { isDenied } from "./ignore.js";
import { resolveWithinWorkspace } from "./paths.js";
import { containedRealPathInfo } from "./realpath.js";
import { DEFAULT_DISCOVERY_OPTIONS, type DiscoveredFile, type WorkspaceInfo } from "./types.js";
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
  readonly files: DiscoveredFile[];
  depthPruned: number;
  maxFilesPruned: number;
  truncated: boolean;
}

const EXPLICIT_SCOPE_MAX_DEPTH = DEFAULT_DISCOVERY_OPTIONS.maxDepth;

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
  if (walk.files.length >= walk.limits.maxFilesScanned) {
    walk.maxFilesPruned += 1;
    walk.truncated = true;
    return;
  }
  const stat = walk.fs.stat(absPath);
  if (!stat.isFile) {
    return;
  }
  walk.files.push({ relativePath: relPath, sizeBytes: stat.size });
}

function allowedByFilters(relPath: string): boolean {
  return !isDenied(relPath);
}

function handleDirectoryEntry(
  walk: EntryWalk,
  dirRel: string,
  entry: WorkspaceDirEntry,
  depth: number,
): void {
  if (entry.isSymbolicLink) {
    return;
  }
  const root = walk.scope.workspace.root;
  const childRel = dirRel.length === 0 ? entry.name : `${dirRel}/${entry.name}`;
  if (!allowedByFilters(childRel)) {
    return;
  }
  const childAbs = resolveWithinWorkspace(root, childRel);
  const contained = containedRealPathInfo(walk.fs, root, childAbs);
  const realRel = normalizeScopePath(contained.realRelative);
  if (!allowedByFilters(realRel)) {
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
  if (walk.truncated) {
    return;
  }
  if (depth > EXPLICIT_SCOPE_MAX_DEPTH) {
    walk.depthPruned += 1;
    walk.truncated = true;
    return;
  }
  for (const entry of readDirSorted(walk.fs, absoluteDir)) {
    if (walk.files.length >= walk.limits.maxFilesScanned) {
      walk.maxFilesPruned += 1;
      walk.truncated = true;
      return;
    }
    handleDirectoryEntry(walk, dirRel, entry, depth);
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
  if (!allowedByFilters(entryRel) || !allowedByFilters(realRel)) {
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
): {
  files: readonly DiscoveredFile[];
  truncated: boolean;
  depthPruned: number;
  maxFilesPruned: number;
} {
  const out: DiscoveredFile[] = [];
  const walk: EntryWalk = {
    scope,
    limits,
    fs,
    files: out,
    depthPruned: 0,
    maxFilesPruned: 0,
    truncated: false,
  };
  for (const entry of scope.relativePaths) {
    if (walk.truncated) {
      break;
    }
    handleScopeEntry(walk, entry);
  }
  return {
    files: out.slice(0, limits.maxFilesScanned),
    truncated: walk.truncated,
    depthPruned: walk.depthPruned,
    maxFilesPruned: walk.maxFilesPruned,
  };
}
