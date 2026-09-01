// Scope walker (Epic #189, Issue #194). Given a KnowledgeSourceScope and a WorkspaceFs port,
// yields each in-scope file as a `DiscoveredFile`. Boundary guarantees, in order of check:
//
//   1. The scope's rootPath is rejected when it fails the contract validator's safe-path
//      gate (NUL, `..`, root markers, tilde, Windows drive prefix).
//   2. Every yielded file's `relativePath` joined to the scope root resolves via
//      `WorkspaceFs.realPath` to a path STILL UNDER the scope root. A symlink whose
//      realpath escapes the root is dropped and reported via `walkSource`'s second yield
//      channel (an InvalidEntry record) rather than thrown — that lets the caller log a
//      `PATH_ESCAPE` diagnostic against the file instead of aborting the whole walk.
//   3. The workspace deny list is enforced on every discovered descendant, including explicit
//      `files` scopes. Hidden/generated-directory opt-in never relaxes the security deny list.
//   4. Include/exclude globs are applied on the workspace-relative POSIX path; exclude
//      wins on overlap.
//   5. AbortSignal is checked at every directory boundary.
//
// Returns an async iterable of `WalkYield` values. The walker is otherwise PURE — no
// clock reads, no randomness — and the WorkspaceFs port is the only IO surface.

import type { KnowledgeSourceScope } from "@oscharko-dev/keiko-contracts";
import {
  isSafeScopePath,
  isSafeStorageReference,
} from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-paths";
import type { IgnoreMatcher, WorkspaceFs, WorkspaceStat } from "@oscharko-dev/keiko-workspace";
import {
  compileIgnore,
  isDenied,
  isIgnored,
  PathDeniedError,
  resolveExistingAllowedWorkspaceRealRoot,
} from "@oscharko-dev/keiko-workspace";
import { isWorkspacePathSnapshotCurrent } from "@oscharko-dev/keiko-workspace/internal/fs";

import { compileGlobList, matchesAny, type CompiledGlob } from "./glob.js";
import {
  DEFAULT_DISCOVERY_OPTIONS,
  type DiscoveredFile,
  type DiscoveryError,
  type DiscoveryOptions,
} from "./types.js";

// Each yield is either a discovered file or a per-entry rejection diagnostic. We split the
// two so the runner can persist a `documents.status = "failed"` row for the rejection
// without aborting the walk — the user gets to see "this one file escaped the boundary"
// rather than a silent black hole.
export type WalkYield =
  | { readonly kind: "file"; readonly file: DiscoveredFile }
  | { readonly kind: "error"; readonly error: DiscoveryError };

interface ScopeBounds {
  readonly rootPath: string;
  readonly recursive: boolean;
  readonly includeGlobs: readonly CompiledGlob[];
  readonly excludeGlobs: readonly CompiledGlob[];
}

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/u;

// WorkspaceFs fakes can model Windows roots while tests run on another platform. Detect the path
// syntax itself rather than normalising every backslash: on POSIX a backslash is a legal literal
// filename character and must never become an authority separator.
function normaliseSep(p: string): string {
  return WINDOWS_DRIVE_PATH.test(p) || p.startsWith("\\\\") ? p.replaceAll("\\", "/") : p;
}

function toPosixRelative(absoluteRoot: string, absolutePath: string): string {
  const normRoot = normaliseSep(absoluteRoot);
  const normPath = normaliseSep(absolutePath);
  if (normPath === normRoot) {
    return "";
  }
  const prefix = normRoot.endsWith("/") ? normRoot : `${normRoot}/`;
  if (normPath.startsWith(prefix)) {
    return normPath.slice(prefix.length);
  }
  return normPath;
}

// Exported for reuse by other realpath-containment checks in the package (e.g. the manual
// crawler's local fetcher, `crawl/fetchers.ts`) so the trailing-separator-safe comparison is not
// re-implemented as a bare `startsWith`.
export function isContained(absoluteRoot: string, absolutePath: string): boolean {
  const normRoot = normaliseSep(absoluteRoot);
  const normPath = normaliseSep(absolutePath);
  if (normPath === normRoot) {
    return true;
  }
  const prefix = normRoot.endsWith("/") ? normRoot : `${normRoot}/`;
  return normPath.startsWith(prefix);
}

function joinAbs(root: string, name: string): string {
  if (root.endsWith("/")) {
    return `${root}${name}`;
  }
  return `${root}/${name}`;
}

function deriveScopeBounds(scope: KnowledgeSourceScope): ScopeBounds | DiscoveryError {
  if (scope.kind === "folder") {
    if (!isSafeScopePath(scope.rootPath)) {
      return { code: "INVALID_SCOPE", message: "scope.rootPath failed the safe-path gate" };
    }
    return {
      rootPath: scope.rootPath,
      recursive: scope.recursive,
      includeGlobs: compileGlobList(scope.includeGlobs),
      excludeGlobs: compileGlobList(scope.excludeGlobs),
    };
  }
  if (scope.kind === "repository") {
    if (!isSafeScopePath(scope.repositoryRoot)) {
      return {
        code: "INVALID_SCOPE",
        message: "scope.repositoryRoot failed the safe-path gate",
      };
    }
    return {
      rootPath: scope.repositoryRoot,
      recursive: true,
      includeGlobs: compileGlobList(scope.includeGlobs),
      excludeGlobs: compileGlobList(scope.excludeGlobs),
    };
  }
  if (!isSafeScopePath(scope.rootPath)) {
    return { code: "INVALID_SCOPE", message: "scope.rootPath failed the safe-path gate" };
  }
  for (const entry of scope.files) {
    if (!isSafeStorageReference(entry)) {
      return {
        code: "INVALID_SCOPE",
        message: `scope.files entry failed the storage-reference gate: ${entry}`,
      };
    }
  }
  // `files` scope has no glob support — every entry is explicit. We still respect the
  // realpath containment gate inside walkSource so a malicious symlink is rejected.
  return {
    rootPath: scope.rootPath,
    recursive: false,
    includeGlobs: [],
    excludeGlobs: [],
  };
}

function abortYield(): WalkYield {
  return {
    kind: "error",
    error: { code: "CANCELLED", message: "walk cancelled by caller" },
  };
}

function safeStatFile(fs: WorkspaceFs, realPath: string): WorkspaceStat | DiscoveryError {
  try {
    const realStats = fs.stat(realPath);
    return realStats;
  } catch {
    return { code: "STAT_FAILED", message: "entry stat failed" };
  }
}

function safeRealPath(fs: WorkspaceFs, absolutePath: string): string | undefined {
  try {
    return fs.realPath(absolutePath);
  } catch {
    return undefined;
  }
}

// Admits the scope's own root through the SAME deny-root policy the workspace package already
// enforces for its own walk (workspaceFsBoundToCanonicalRoot's resolveWalkRoot in discovery.ts).
// A plain `fs.realPath` on the root only follows symlinks — it never asks whether the resolved
// target is itself a denied locus (e.g. a source lexically admitted as safe, then retargeted via
// symlink to `~/.ssh` before this call runs). Only the root needs this: every descendant is
// already re-checked against `ctx.realRootPath` and the deny list on every subsequent snapshot.
function resolveAdmittedRealRoot(fs: WorkspaceFs, rootPath: string): string | DiscoveryError {
  try {
    return resolveExistingAllowedWorkspaceRealRoot(fs, rootPath);
  } catch (error) {
    if (error instanceof PathDeniedError) {
      return {
        code: "PATH_ESCAPE",
        message: "selected source root is a denied workspace root",
      };
    }
    return { code: "READ_FAILED", message: "realPath failed for selected source root" };
  }
}

interface WalkContext {
  readonly fs: WorkspaceFs;
  readonly bounds: ScopeBounds;
  readonly realRootPath: string;
  readonly rootStat: WorkspaceStat;
  readonly options: DiscoveryOptions;
  readonly gitIgnore: IgnoreMatcher | undefined;
  filesYielded: number;
}

const HIDDEN_OR_GENERATED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".turbo",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "out",
]);

function isGlobMatched(bounds: ScopeBounds, relativePath: string): boolean {
  // Exclude wins over include. An empty includeGlobs means "include everything"; an empty
  // excludeGlobs means "exclude nothing".
  if (matchesAny(bounds.excludeGlobs, relativePath, false)) {
    return false;
  }
  return matchesAny(bounds.includeGlobs, relativePath, true);
}

function shouldDescendIntoDirectory(entryName: string): boolean {
  return !entryName.startsWith(".") && !HIDDEN_OR_GENERATED_DIRS.has(entryName);
}

function shouldSkipDirectoryEntry(ctx: WalkContext, entryName: string): boolean {
  return !ctx.bounds.recursive || !shouldDescendIntoDirectory(entryName);
}

function isDeniedRelativePath(relativePath: string): boolean {
  return isDenied(relativePath);
}

function isGitIgnored(ctx: WalkContext, relativePath: string, isDirectory: boolean): boolean {
  return ctx.gitIgnore === undefined ? false : isIgnored(ctx.gitIgnore, relativePath, isDirectory);
}

function rootSnapshotIsCurrent(ctx: WalkContext): boolean {
  return isWorkspacePathSnapshotCurrent(
    ctx.fs,
    ctx.bounds.rootPath,
    ctx.realRootPath,
    ctx.rootStat,
  );
}

type FileSnapshotResolution =
  | { readonly kind: "ready"; readonly realPath: string; readonly stat: WorkspaceStat }
  | { readonly kind: "skip" }
  | { readonly kind: "error"; readonly error: DiscoveryError };

function resolveFileSnapshot(
  ctx: WalkContext,
  absolutePath: string,
  relativePath: string,
): FileSnapshotResolution {
  if (!rootSnapshotIsCurrent(ctx)) {
    return {
      kind: "error",
      error: { code: "READ_FAILED", message: "selected source root changed during discovery" },
    };
  }
  const realPath = safeRealPath(ctx.fs, absolutePath);
  if (realPath === undefined) {
    return {
      kind: "error",
      error: { code: "READ_FAILED", message: "entry realpath failed", relativePath },
    };
  }
  if (!isContained(ctx.realRootPath, realPath)) {
    return {
      kind: "error",
      error: {
        code: "PATH_ESCAPE",
        message: `entry escapes the scope root via realpath: ${relativePath}`,
        relativePath,
      },
    };
  }
  if (isDeniedRelativePath(toPosixRelative(ctx.realRootPath, realPath))) return { kind: "skip" };
  const stat = safeStatFile(ctx.fs, realPath);
  if ("code" in stat) return { kind: "error", error: { ...stat, relativePath } };
  return stat.isFile ? { kind: "ready", realPath, stat } : { kind: "skip" };
}

function* yieldFileIfAllowed(
  ctx: WalkContext,
  absolutePath: string,
  relativePath: string,
): Generator<WalkYield> {
  if (isDeniedRelativePath(relativePath)) return;
  const resolved = resolveFileSnapshot(ctx, absolutePath, relativePath);
  if (resolved.kind === "error") {
    yield { kind: "error", error: resolved.error };
    return;
  }
  if (resolved.kind === "skip") return;
  if (isGitIgnored(ctx, relativePath, false) || !isGlobMatched(ctx.bounds, relativePath)) return;
  if (
    !rootSnapshotIsCurrent(ctx) ||
    !isWorkspacePathSnapshotCurrent(ctx.fs, absolutePath, resolved.realPath, resolved.stat)
  ) {
    yield {
      kind: "error",
      error: { code: "READ_FAILED", message: "entry changed during discovery" },
    };
    return;
  }
  ctx.filesYielded += 1;
  yield { kind: "file", file: { relativePath, sizeBytes: resolved.stat.size } };
}

interface WalkDirEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
}

type DirectoryRead =
  | { readonly ok: true; readonly entries: readonly WalkDirEntry[] }
  | { readonly ok: false; readonly error: DiscoveryError };

// #3347 (owner P1): a single directory must never be fully materialized (and then sorted) before
// `maxFiles`, abort or the elapsed budget can stop the walk -- one adversarially large directory
// would otherwise allocate every entry first. ADR-0005 D1 gives the port a bounded
// `readDir(path, maxEntries)` exactly for this, so the walker now always passes a finite cap.
//
// This is a MEMORY bound per directory, deliberately independent of `maxFiles`: a directory holds
// subdirectories too, and those do not consume the file budget, so deriving the cap from the
// remaining file budget would abort a legitimate walk whose root merely has more children than the
// caller wants files (the `maxFiles: 2` pin below is exactly that case). The `+ 1` is a sentinel:
// reading one more entry than the budget proves the directory overflows, without enumerating the
// rest of it.
const MAX_DIRECTORY_ENTRIES = 10_000;

function directoryEntryCap(): number {
  return MAX_DIRECTORY_ENTRIES + 1;
}

interface DirectorySnapshot {
  readonly realPath: string;
  readonly stat: WorkspaceStat;
}

function directorySnapshot(ctx: WalkContext, absolutePath: string): DirectorySnapshot | undefined {
  if (!rootSnapshotIsCurrent(ctx)) return undefined;
  const realPath = safeRealPath(ctx.fs, absolutePath);
  if (realPath === undefined || !isContained(ctx.realRootPath, realPath)) return undefined;
  const requestedRelative = toPosixRelative(ctx.bounds.rootPath, absolutePath);
  const canonicalRelative = toPosixRelative(ctx.realRootPath, realPath);
  if (requestedRelative !== canonicalRelative) return undefined;
  const stat = safeStatFile(ctx.fs, realPath);
  if ("code" in stat || !stat.isDirectory || stat.isSymbolicLink) return undefined;
  return { realPath, stat };
}

function directoryReadFailure(): DirectoryRead {
  return {
    ok: false,
    error: { code: "READ_FAILED", message: "directory read failed" },
  };
}

function safeReadDir(ctx: WalkContext, absolutePath: string): DirectoryRead {
  try {
    const before = directorySnapshot(ctx, absolutePath);
    if (before === undefined) return directoryReadFailure();
    const cap = directoryEntryCap();
    const entries = ctx.fs.readDir(before.realPath, cap);
    if (
      !rootSnapshotIsCurrent(ctx) ||
      !isWorkspacePathSnapshotCurrent(ctx.fs, absolutePath, before.realPath, before.stat)
    ) {
      return directoryReadFailure();
    }
    // The sentinel came back: this directory holds more entries than the walk could ever yield,
    // so stop here instead of silently discovering an arbitrary filesystem-order subset.
    if (entries.length >= cap) {
      return {
        ok: false,
        error: { code: "LIMIT_REACHED", message: "directory entry limit reached" },
      };
    }
    return { ok: true, entries };
  } catch {
    return directoryReadFailure();
  }
}

function limitYield(message: string): WalkYield {
  return { kind: "error", error: { code: "LIMIT_REACHED", message } };
}

// Read `signal?.aborted` through a function call so TypeScript control-flow analysis
// does NOT narrow the optional chain after the first false branch — a long iteration may
// observe abort between any two checks.
function isAborted(ctx: WalkContext): boolean {
  return ctx.options.signal?.aborted === true;
}

function* yieldDirectoryEntry(
  ctx: WalkContext,
  absoluteDir: string,
  entry: WalkDirEntry,
  depth: number,
): Generator<WalkYield> {
  const childAbs = joinAbs(absoluteDir, entry.name);
  const childRel = toPosixRelative(ctx.bounds.rootPath, childAbs);
  if (entry.isDirectory) {
    if (isDeniedRelativePath(childRel)) return;
    if (isGitIgnored(ctx, childRel, true)) return;
    if (shouldSkipDirectoryEntry(ctx, entry.name)) return;
    yield* descend(ctx, childAbs, depth + 1);
    return;
  }
  if (entry.isFile || entry.isSymbolicLink) {
    yield* yieldFileIfAllowed(ctx, childAbs, childRel);
  }
}

function* descend(ctx: WalkContext, absoluteDir: string, depth: number): Generator<WalkYield> {
  if (isAborted(ctx)) {
    yield abortYield();
    return;
  }
  if (ctx.filesYielded >= ctx.options.maxFiles) {
    yield limitYield("file discovery limit reached");
    return;
  }
  if (depth > ctx.options.maxDepth) {
    yield limitYield("directory depth limit reached");
    return;
  }
  const read = safeReadDir(ctx, absoluteDir);
  if (!read.ok) {
    yield { kind: "error", error: read.error };
    return;
  }
  const entries = [...read.entries].sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    if (ctx.filesYielded >= ctx.options.maxFiles) {
      yield limitYield("file discovery limit reached");
      return;
    }
    if (isAborted(ctx)) {
      yield abortYield();
      return;
    }
    yield* yieldDirectoryEntry(ctx, absoluteDir, entry, depth);
  }
}

function* walkFilesScope(ctx: WalkContext, files: readonly string[]): Generator<WalkYield> {
  for (const rel of files) {
    if (isAborted(ctx)) {
      yield abortYield();
      return;
    }
    if (ctx.filesYielded >= ctx.options.maxFiles) {
      yield limitYield("file discovery limit reached");
      return;
    }
    const abs = joinAbs(ctx.bounds.rootPath, rel);
    if (!rootSnapshotIsCurrent(ctx)) {
      yield {
        kind: "error",
        error: { code: "READ_FAILED", message: "selected source root changed during discovery" },
      };
      return;
    }
    const exists = pathExists(ctx.fs, abs, "explicit entry presence check failed");
    if (typeof exists !== "boolean") {
      yield { kind: "error", error: { ...exists, relativePath: rel } };
      continue;
    }
    if (!rootSnapshotIsCurrent(ctx)) {
      yield {
        kind: "error",
        error: { code: "READ_FAILED", message: "selected source root changed during discovery" },
      };
      return;
    }
    // An explicitly selected path that no longer exists is a complete, authoritative absence.
    // This lets the indexing owner prune a genuinely deleted document without mistaking a
    // transient realpath/stat failure for deletion.
    if (!exists) continue;
    yield* yieldFileIfAllowed(ctx, abs, rel);
  }
}

const MAX_GITIGNORE_BYTES = 1024 * 1024;

function pathExists(
  fs: WorkspaceFs,
  absolutePath: string,
  failureMessage: string,
): boolean | DiscoveryError {
  try {
    return fs.exists(absolutePath);
  } catch {
    return { code: "READ_FAILED", message: failureMessage };
  }
}

interface GitIgnoreSnapshot {
  readonly realPath: string;
  readonly stat: WorkspaceStat;
}

function gitIgnoreSnapshot(
  fs: WorkspaceFs,
  absolutePath: string,
  realRootPath: string,
): GitIgnoreSnapshot | undefined {
  const realPath = safeRealPath(fs, absolutePath);
  if (realPath === undefined || !isContained(realRootPath, realPath)) return undefined;
  const canonicalRelative = toPosixRelative(realRootPath, realPath);
  if (canonicalRelative !== ".gitignore" || isDeniedRelativePath(canonicalRelative)) {
    return undefined;
  }
  const stat = safeStatFile(fs, realPath);
  if ("code" in stat || !stat.isFile || stat.isSymbolicLink || stat.size > MAX_GITIGNORE_BYTES) {
    return undefined;
  }
  return { realPath, stat };
}

// Bounded primitive present -> use it; absent -> ignore metadata is unavailable. Never fall back
// to an unbounded `readFileUtf8`, which would materialize the whole file before any cap applies.
function readGitIgnoreText(fs: WorkspaceFs, snapshot: GitIgnoreSnapshot): string | undefined {
  if (fs.readFileUtf8Prefix === undefined) return undefined;
  try {
    return fs.readFileUtf8Prefix(snapshot.realPath, MAX_GITIGNORE_BYTES, "allow", snapshot.stat);
  } catch {
    return undefined;
  }
}

function readRootGitIgnore(
  fs: WorkspaceFs,
  rootPath: string,
  realRootPath: string,
  rootStat: WorkspaceStat,
  options: DiscoveryOptions,
): IgnoreMatcher | DiscoveryError | undefined {
  if (options.respectGitIgnore !== true) return undefined;
  const absolutePath = joinAbs(rootPath, ".gitignore");
  const exists = pathExists(fs, absolutePath, "repository ignore presence check failed");
  if (typeof exists !== "boolean") return exists;
  if (!exists) return compileIgnore([]);
  if (!isWorkspacePathSnapshotCurrent(fs, rootPath, realRootPath, rootStat)) {
    return { code: "READ_FAILED", message: "repository ignore file failed containment" };
  }
  const before = gitIgnoreSnapshot(fs, absolutePath, realRootPath);
  if (before === undefined) {
    return { code: "READ_FAILED", message: "repository ignore file failed containment" };
  }
  const text = readGitIgnoreText(fs, before);
  if (
    text === undefined ||
    !isWorkspacePathSnapshotCurrent(fs, rootPath, realRootPath, rootStat) ||
    !isWorkspacePathSnapshotCurrent(fs, absolutePath, before.realPath, before.stat)
  ) {
    return { code: "READ_FAILED", message: "repository ignore file could not be read safely" };
  }
  return compileIgnore(text.split(/\r?\n/u));
}

export function* walkSource(
  fs: WorkspaceFs,
  scope: KnowledgeSourceScope,
  options: DiscoveryOptions = DEFAULT_DISCOVERY_OPTIONS,
): Generator<WalkYield> {
  const bounds = deriveScopeBounds(scope);
  if ("code" in bounds) {
    yield { kind: "error", error: bounds };
    return;
  }
  const admittedRoot = resolveAdmittedRealRoot(fs, bounds.rootPath);
  if (typeof admittedRoot !== "string") {
    yield { kind: "error", error: admittedRoot };
    return;
  }
  const realRootPath = admittedRoot;
  const rootStat = safeStatFile(fs, realRootPath);
  if ("code" in rootStat || !rootStat.isDirectory || rootStat.isSymbolicLink) {
    yield {
      kind: "error",
      error: { code: "READ_FAILED", message: "selected source root is not a stable directory" },
    };
    return;
  }
  const gitIgnore = readRootGitIgnore(fs, bounds.rootPath, realRootPath, rootStat, options);
  if (gitIgnore !== undefined && "code" in gitIgnore) {
    yield { kind: "error", error: gitIgnore };
    return;
  }
  const ctx: WalkContext = {
    fs,
    bounds,
    realRootPath,
    rootStat,
    options,
    gitIgnore,
    filesYielded: 0,
  };
  if (scope.kind === "files") {
    yield* walkFilesScope(ctx, scope.files);
    return;
  }
  yield* descend(ctx, bounds.rootPath, 0);
}
