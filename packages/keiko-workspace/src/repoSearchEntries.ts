import { isValidScopePath } from "@oscharko-dev/keiko-contracts/connected-context";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import type { WorkspaceDirEntry, WorkspaceFs } from "./fs.js";
import { isDenied } from "./ignore.js";
import { resolveWithinWorkspace } from "./paths.js";
import {
  containedRealPathInfo,
  isAllowedContainedPathParent,
  isCanonicalAllowedContainedPath,
  resolveExistingAllowedWorkspaceRealRoot,
  workspaceFsBoundToCanonicalRoot,
} from "./realpath.js";
import { DEFAULT_DISCOVERY_OPTIONS, type DiscoveredFile, type WorkspaceInfo } from "./types.js";
import {
  PathDeniedError,
  PathEscapeError,
  RepoSearchInvalidQueryError,
  WorkspaceReadError,
} from "./errors.js";
import {
  StructuralExecutionStoppedError,
  structuralExecutionStopped,
  type StructuralExecutionControl,
} from "./structuralExecution.js";
import {
  workspaceDirectoryFingerprint,
  type WorkspaceDirectorySnapshot,
} from "./workspaceDirectorySnapshot.js";

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
  readonly realRoot: string;
  readonly executionControl?: StructuralExecutionControl | undefined;
  readonly traversalEntryBudget: number;
  readonly files: DiscoveredFile[];
  readonly directories: string[];
  readonly directorySnapshots: Map<string, WorkspaceDirectorySnapshot>;
  depthPruned: number;
  maxFilesPruned: number;
  truncated: boolean;
  entriesVisited: number;
}

const EXPLICIT_SCOPE_MAX_DEPTH = DEFAULT_DISCOVERY_OPTIONS.maxDepth;
const EXPLICIT_SCOPE_TRAVERSAL_ENTRY_FLOOR = 1_024;
const EXPLICIT_SCOPE_TRAVERSAL_ENTRY_CEILING = 100_000;
const EXPLICIT_SCOPE_TRAVERSAL_ENTRY_MULTIPLIER = 25;

function normalizeScopePath(scopePath: string): string {
  return scopePath.replaceAll("\\", "/");
}

export function validateSearchScopeRelativePaths(relativePaths: readonly string[]): void {
  for (const entry of relativePaths) {
    if (!isValidScopePath(entry, { mustBeRelative: true })) {
      throw new RepoSearchInvalidQueryError(`invalid scope.relativePaths entry: ${entry}`);
    }
  }
}

export function canonicalSearchScopeRelativePaths(
  relativePaths: readonly string[],
): readonly string[] {
  return [...new Set(relativePaths.map(normalizeScopePath))].sort(compareStrings);
}

function readDirSorted(
  walk: EntryWalk,
  absoluteDir: string,
  scopePath: string,
): readonly WorkspaceDirEntry[] {
  try {
    const remainingEntries = Math.max(0, walk.traversalEntryBudget - walk.entriesVisited);
    const entries = walk.fs.readDir(absoluteDir, remainingEntries + 1);
    if (entries.length > remainingEntries) {
      // Do not consume an arbitrary filesystem-order prefix. The explicit scope is deterministically
      // truncated as a whole when its physical directory enumeration exceeds the request budget.
      walk.maxFilesPruned += entries.length;
      walk.truncated = true;
      return [];
    }
    // Deliberately the shared code-unit comparator (epic #2719 W4, issue #2723), never
    // `localeCompare`: traversal order must stay byte-stable and locale-independent.
    return [...entries].sort((a, b) => compareStrings(a.name, b.name));
  } catch (error) {
    if (error instanceof StructuralExecutionStoppedError) throw error;
    const message = error instanceof Error ? error.message : "unknown error";
    throw new WorkspaceReadError(`cannot read directory: ${scopePath} (${message})`, scopePath);
  }
}

function isCurrentEntryDirectory(walk: EntryWalk, dirRel: string, absoluteDir: string): boolean {
  const root = walk.realRoot;
  const lexical = resolveWithinWorkspace(root, dirRel);
  const contained = containedRealPathInfo(walk.fs, root, lexical);
  if (
    contained.realBase !== walk.realRoot ||
    contained.path !== absoluteDir ||
    !isCanonicalAllowedContainedPath(contained, root, dirRel)
  ) {
    return false;
  }
  const stat = walk.fs.stat(contained.path);
  return stat.isDirectory && !stat.isSymbolicLink;
}

function pushAllowedFile(
  walk: EntryWalk,
  relPath: string,
  stat: ReturnType<WorkspaceFs["stat"]>,
): void {
  if (walk.files.length >= walk.limits.maxFilesScanned) {
    walk.maxFilesPruned += 1;
    walk.truncated = true;
    return;
  }
  if (!stat.isFile) {
    return;
  }
  walk.files.push({ relativePath: relPath, sizeBytes: stat.size });
}

function allowedByFilters(relPath: string): boolean {
  return !isDenied(relPath);
}

function inaccessibleScopeEntry(): never {
  throw new RepoSearchInvalidQueryError(
    "Connected scope path is not accessible from the selected project.",
  );
}

function readContainedScopeEntryStat(
  fs: WorkspaceFs,
  absolutePath: string,
): ReturnType<WorkspaceFs["stat"]> {
  try {
    const stat = fs.stat(absolutePath);
    if (stat.isFile || (stat.isDirectory && fs.exists(absolutePath))) return stat;
    // In-memory ports model directories implicitly from their children. This compatibility probe
    // is safe here because realpath containment has already succeeded for `absolutePath`.
    if (stat.isDirectory && fs.readDir(absolutePath, 1).length > 0) return stat;
  } catch (error) {
    if (
      error instanceof PathEscapeError ||
      error instanceof PathDeniedError ||
      error instanceof StructuralExecutionStoppedError
    ) {
      throw error;
    }
    inaccessibleScopeEntry();
  }
  return inaccessibleScopeEntry();
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
  const root = walk.realRoot;
  const childRel = dirRel.length === 0 ? entry.name : `${dirRel}/${entry.name}`;
  if (!allowedByFilters(childRel)) {
    return;
  }
  const childAbs = resolveWithinWorkspace(root, childRel);
  const contained = containedRealPathInfo(walk.fs, root, childAbs);
  const realRel = normalizeScopePath(contained.realRelative);
  if (
    contained.realBase !== walk.realRoot ||
    !isCanonicalAllowedContainedPath(contained, root, childRel)
  ) {
    return;
  }
  const stat = walk.fs.stat(contained.path);
  if (stat.isSymbolicLink) return;
  if (stat.isDirectory) {
    walkEntryDirectory(walk, contained.path, realRel, depth + 1);
    return;
  }
  pushAllowedFile(walk, realRel, stat);
}

function entryWalkStopped(walk: EntryWalk): boolean {
  return (
    walk.truncated ||
    walk.files.length >= walk.limits.maxFilesScanned ||
    walk.entriesVisited >= walk.traversalEntryBudget ||
    (walk.executionControl !== undefined && structuralExecutionStopped(walk.executionControl))
  );
}

function walkEntryDirectory(
  walk: EntryWalk,
  absoluteDir: string,
  dirRel: string,
  depth: number,
): void {
  if (entryWalkStopped(walk)) {
    return;
  }
  if (depth > EXPLICIT_SCOPE_MAX_DEPTH) {
    walk.depthPruned += 1;
    walk.truncated = true;
    return;
  }
  if (!isCurrentEntryDirectory(walk, dirRel, absoluteDir)) return;
  walk.directories.push(dirRel);
  const entries = readDirSorted(walk, absoluteDir, dirRel);
  if (entryWalkStopped(walk) || !isCurrentEntryDirectory(walk, dirRel, absoluteDir)) return;
  walk.directorySnapshots.set(dirRel, {
    scopePath: dirRel,
    fingerprint: workspaceDirectoryFingerprint(entries),
  });
  for (const [index, entry] of entries.entries()) {
    if (entryWalkStopped(walk)) {
      walk.maxFilesPruned += entries.length - index;
      walk.truncated = true;
      return;
    }
    walk.entriesVisited += 1;
    handleDirectoryEntry(walk, dirRel, entry, depth);
  }
}

function handleScopeEntry(walk: EntryWalk, entry: string): void {
  const root = walk.realRoot;
  const entryRel = normalizeScopePath(entry);
  if (isDenied(entryRel)) {
    return;
  }
  const abs = resolveWithinWorkspace(root, entryRel);
  const contained = containedRealPathInfo(walk.fs, root, abs);
  const realRel = normalizeScopePath(contained.realRelative);
  if (contained.realBase !== walk.realRoot) {
    return;
  }
  if (!isCanonicalAllowedContainedPath(contained, root, entryRel)) {
    if (contained.path === abs && isAllowedContainedPathParent(contained, root, entryRel)) {
      inaccessibleScopeEntry();
    }
    return;
  }
  const stat = readContainedScopeEntryStat(walk.fs, contained.path);
  if (realRel !== entryRel) {
    return;
  }
  if (!allowedByFilters(entryRel) || !allowedByFilters(realRel)) {
    return;
  }
  if (stat.isDirectory) {
    walkEntryDirectory(walk, contained.path, realRel, 1);
    return;
  }
  pushAllowedFile(walk, realRel, stat);
}

function resolveEntryWalkRoot(fs: WorkspaceFs, root: string): string {
  try {
    return resolveExistingAllowedWorkspaceRealRoot(fs, root);
  } catch (error) {
    if (error instanceof PathDeniedError || error instanceof StructuralExecutionStoppedError) {
      throw error;
    }
    return inaccessibleScopeEntry();
  }
}

function createEntryWalk(
  scope: ScopeShape,
  limits: LimitsShape,
  fs: WorkspaceFs,
  executionControl?: StructuralExecutionControl,
): EntryWalk {
  // Resolve the canonical root exactly once, then bind fs to that identity (the same shape as
  // discovery.ts's createWalk): every subsequent containedRealPathInfo call below is made through
  // this bound fs and against realRoot, never the caller's raw port or the lexical
  // scope.workspace.root. Without the bind, each call re-resolves the lexical root's realpath from
  // scratch, so a root symlink repointed after admission (but before the walk actually reads
  // anything) would be re-admitted or re-classified on its own, independent of what was already
  // proven safe. Binding makes the admitted identity structural instead of relying on every call
  // site to compare against it by convention.
  const realRoot = resolveEntryWalkRoot(fs, scope.workspace.root);
  return {
    scope,
    limits,
    fs: workspaceFsBoundToCanonicalRoot(fs, realRoot),
    realRoot,
    ...(executionControl === undefined ? {} : { executionControl }),
    traversalEntryBudget: explicitScopeTraversalEntryBudget(limits.maxFilesScanned),
    files: [],
    directories: [],
    directorySnapshots: new Map<string, WorkspaceDirectorySnapshot>(),
    depthPruned: 0,
    maxFilesPruned: 0,
    truncated: false,
    entriesVisited: 0,
  };
}

function explicitScopeTraversalEntryBudget(maxFilesScanned: number): number {
  return Math.min(
    EXPLICIT_SCOPE_TRAVERSAL_ENTRY_CEILING,
    Math.max(
      EXPLICIT_SCOPE_TRAVERSAL_ENTRY_FLOOR,
      EXPLICIT_SCOPE_MAX_DEPTH + 1,
      maxFilesScanned * EXPLICIT_SCOPE_TRAVERSAL_ENTRY_MULTIPLIER,
    ),
  );
}

export function collectFromEntries(
  scope: ScopeShape,
  limits: LimitsShape,
  fs: WorkspaceFs,
  executionControl?: StructuralExecutionControl,
): {
  files: readonly DiscoveredFile[];
  directories: readonly string[];
  directorySnapshots: readonly WorkspaceDirectorySnapshot[];
  filesDiscovered: number;
  truncated: boolean;
  depthPruned: number;
  maxFilesPruned: number;
} {
  const walk = createEntryWalk(scope, limits, fs, executionControl);
  const relativePaths = canonicalSearchScopeRelativePaths(scope.relativePaths);
  for (const [index, entry] of relativePaths.entries()) {
    if (entryWalkStopped(walk)) {
      walk.maxFilesPruned += relativePaths.length - index;
      walk.truncated = true;
      break;
    }
    walk.entriesVisited += 1;
    handleScopeEntry(walk, entry);
  }
  return {
    files: walk.files.slice(0, limits.maxFilesScanned),
    directories: [...new Set(walk.directories)].sort(compareStrings),
    directorySnapshots: [...walk.directorySnapshots.values()].sort((a, b) =>
      compareStrings(a.scopePath, b.scopePath),
    ),
    filesDiscovered: walk.files.length,
    truncated: walk.truncated,
    depthPruned: walk.depthPruned,
    maxFilesPruned: walk.maxFilesPruned,
  };
}
