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
import { isSafeScopePath, isSafeStorageReference } from "@oscharko-dev/keiko-contracts";
import type { IgnoreMatcher, WorkspaceFs, WorkspaceStat } from "@oscharko-dev/keiko-workspace";
import { compileIgnore, isDenied, isIgnored } from "@oscharko-dev/keiko-workspace";

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

// On Windows, WorkspaceFs.realPath() may return backslash-separated paths
// (e.g. C:\Users\workspace\file). Normalise both sides to forward slashes so
// containment checks and relative-path derivation work cross-platform.
function normaliseSep(p: string): string {
  return p.replaceAll("\\", "/");
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

interface WalkContext {
  readonly fs: WorkspaceFs;
  readonly bounds: ScopeBounds;
  readonly realRootPath: string;
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

function* yieldFileIfAllowed(
  ctx: WalkContext,
  absolutePath: string,
  relativePath: string,
): Generator<WalkYield> {
  if (isDeniedRelativePath(relativePath)) {
    return;
  }
  // realpath containment gate (boundary). Skip the entry entirely on failure rather than
  // treating a transient broken symlink as a complete enumeration.
  const real = safeRealPath(ctx.fs, absolutePath);
  if (real === undefined) {
    yield {
      kind: "error",
      error: { code: "READ_FAILED", message: "entry realpath failed", relativePath },
    };
    return;
  }
  if (!isContained(ctx.realRootPath, real)) {
    yield {
      kind: "error",
      error: {
        code: "PATH_ESCAPE",
        message: `entry escapes the scope root via realpath: ${relativePath}`,
        relativePath,
      },
    };
    return;
  }
  const realRel = toPosixRelative(ctx.realRootPath, real);
  if (isDeniedRelativePath(realRel)) {
    return;
  }
  if (isGitIgnored(ctx, relativePath, false)) {
    return;
  }
  if (!isGlobMatched(ctx.bounds, relativePath)) {
    return;
  }
  const stat = safeStatFile(ctx.fs, real);
  if ("code" in stat) {
    yield { kind: "error", error: { ...stat, relativePath } };
    return;
  }
  if (!stat.isFile) return;
  ctx.filesYielded += 1;
  yield { kind: "file", file: { relativePath, sizeBytes: stat.size } };
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

function safeReadDir(fs: WorkspaceFs, absolutePath: string): DirectoryRead {
  try {
    return { ok: true, entries: fs.readDir(absolutePath) };
  } catch {
    return {
      ok: false,
      error: { code: "READ_FAILED", message: "directory read failed" },
    };
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
  const read = safeReadDir(ctx.fs, absoluteDir);
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
    const exists = pathExists(ctx.fs, abs, "explicit entry presence check failed");
    if (typeof exists !== "boolean") {
      yield { kind: "error", error: { ...exists, relativePath: rel } };
      continue;
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

function readGitIgnoreText(fs: WorkspaceFs, absolutePath: string): string | undefined {
  try {
    const stat = fs.stat(absolutePath);
    if (!stat.isFile || stat.size > MAX_GITIGNORE_BYTES) return undefined;
    return (
      fs.readFileUtf8Prefix?.(absolutePath, MAX_GITIGNORE_BYTES) ?? fs.readFileUtf8(absolutePath)
    );
  } catch {
    return undefined;
  }
}

function readRootGitIgnore(
  fs: WorkspaceFs,
  rootPath: string,
  realRootPath: string,
  options: DiscoveryOptions,
): IgnoreMatcher | DiscoveryError | undefined {
  if (options.respectGitIgnore !== true) return undefined;
  const absolutePath = joinAbs(rootPath, ".gitignore");
  const exists = pathExists(fs, absolutePath, "repository ignore presence check failed");
  if (typeof exists !== "boolean") return exists;
  if (!exists) return compileIgnore([]);
  const realPath = safeRealPath(fs, absolutePath);
  if (realPath === undefined || !isContained(realRootPath, realPath)) {
    return { code: "READ_FAILED", message: "repository ignore file failed containment" };
  }
  const text = readGitIgnoreText(fs, absolutePath);
  if (text === undefined) {
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
  const realRootPath = safeRealPath(fs, bounds.rootPath);
  if (realRootPath === undefined) {
    yield {
      kind: "error",
      error: { code: "READ_FAILED", message: "realPath failed for selected source root" },
    };
    return;
  }
  const gitIgnore = readRootGitIgnore(fs, bounds.rootPath, realRootPath, options);
  if (gitIgnore !== undefined && "code" in gitIgnore) {
    yield { kind: "error", error: gitIgnore };
    return;
  }
  const ctx: WalkContext = {
    fs,
    bounds,
    realRootPath,
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
