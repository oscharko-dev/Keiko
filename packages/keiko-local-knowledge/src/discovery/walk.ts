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
import { isSafeScopePath } from "@oscharko-dev/keiko-contracts";
import type { WorkspaceFs, WorkspaceStat } from "@oscharko-dev/keiko-workspace";
import { isDenied } from "@oscharko-dev/keiko-workspace";

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
  return p.replace(/\\/g, "/");
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

function isContained(absoluteRoot: string, absolutePath: string): boolean {
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
    if (!isSafeScopePath(entry)) {
      return {
        code: "INVALID_SCOPE",
        message: `scope.files entry failed the safe-path gate: ${entry}`,
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

function safeStatFile(
  fs: WorkspaceFs,
  absolutePath: string,
  realPath: string,
  relativePath: string,
): WorkspaceStat | DiscoveryError | undefined {
  try {
    const requestedStats = fs.stat(absolutePath);
    if (requestedStats.hardLinkCount !== undefined && requestedStats.hardLinkCount > 1) {
      return {
        code: "READ_FAILED",
        message: "selected file is not eligible for extraction",
        relativePath,
      };
    }
  } catch {
    // Some WorkspaceFs fakes only stat the canonical realPath shape (not the mixed-separator
    // requested path). Fall through to stat the resolved path below.
  }
  try {
    const realStats = fs.stat(realPath);
    if (!realStats.isFile) {
      return undefined;
    }
    if (realStats.hardLinkCount !== undefined && realStats.hardLinkCount > 1) {
      return {
        code: "READ_FAILED",
        message: "selected file is not eligible for extraction",
        relativePath,
      };
    }
    return realStats;
  } catch {
    return undefined;
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
  readonly options: DiscoveryOptions;
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

function* yieldFileIfAllowed(
  ctx: WalkContext,
  absolutePath: string,
  relativePath: string,
): Generator<WalkYield> {
  if (isDeniedRelativePath(relativePath)) {
    return;
  }
  // realpath containment gate (boundary). Skip the entry entirely on failure rather than
  // yielding a misleading diagnostic — the entry might be a transient broken symlink.
  const real = safeRealPath(ctx.fs, absolutePath);
  if (real === undefined) {
    return;
  }
  if (!isContained(ctx.bounds.rootPath, real)) {
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
  const realRel = toPosixRelative(ctx.bounds.rootPath, real);
  if (isDeniedRelativePath(realRel)) {
    return;
  }
  if (!isGlobMatched(ctx.bounds, relativePath)) {
    return;
  }
  const stat = safeStatFile(ctx.fs, absolutePath, real, relativePath);
  if (stat === undefined) {
    return;
  }
  if ("code" in stat) {
    yield { kind: "error", error: stat };
    return;
  }
  ctx.filesYielded += 1;
  yield { kind: "file", file: { relativePath, sizeBytes: stat.size } };
}

interface WalkDirEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
}

function safeReadDir(fs: WorkspaceFs, absolutePath: string): readonly WalkDirEntry[] {
  try {
    return fs.readDir(absolutePath);
  } catch {
    return [];
  }
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
    if (shouldSkipDirectoryEntry(ctx, entry.name)) return;
    yield* descend(ctx, childAbs, depth + 1);
    return;
  }
  if (entry.isFile) {
    yield* yieldFileIfAllowed(ctx, childAbs, childRel);
  }
}

function* descend(ctx: WalkContext, absoluteDir: string, depth: number): Generator<WalkYield> {
  if (isAborted(ctx)) {
    yield abortYield();
    return;
  }
  if (ctx.filesYielded >= ctx.options.maxFiles) {
    return;
  }
  if (depth > ctx.options.maxDepth) {
    return;
  }
  const entries = [...safeReadDir(ctx.fs, absoluteDir)].sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    if (ctx.filesYielded >= ctx.options.maxFiles) {
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
      return;
    }
    const abs = joinAbs(ctx.bounds.rootPath, rel);
    yield* yieldFileIfAllowed(ctx, abs, rel);
  }
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
  const ctx: WalkContext = { fs, bounds, options, filesYielded: 0 };
  if (scope.kind === "files") {
    yield* walkFilesScope(ctx, scope.files);
    return;
  }
  yield* descend(ctx, bounds.rootPath, 0);
}
