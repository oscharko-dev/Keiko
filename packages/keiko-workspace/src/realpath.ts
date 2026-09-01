// PURE-at-the-port symlink containment. After lexical resolveWithinWorkspace has proven a path is
// lexically inside the root, this gate defends against the symlink class of escape: a path whose
// real (symlink-followed) location is outside the root, or a not-yet-existing create target whose
// nearest existing parent escapes via a symlink. Every filesystem touch goes through the injected
// WorkspaceFs port (realPath only) so the logic stays testable with an in-memory fake and all real
// IO is auditable in one place (ADR-0005 D2, ADR-0006 D2). The read path (discovery.ts) and the
// write/cwd paths (tools/patch.ts, tools/exec.ts) share this single primitive — no duplicated logic.

import { dirname } from "node:path";
import type { WorkspaceFs } from "./fs.js";
import { isDenied } from "./ignore.js";
import { isWithinWorkspace } from "./paths.js";
import { PathEscapeError } from "./errors.js";
import { StructuralExecutionStoppedError } from "./structuralExecution.js";

// Resolves `root` through any platform symlinks (e.g. macOS /var -> /private/var) so the
// containment comparison is symlink-consistent on both sides. Falls back to the lexical root.
function realRoot(fs: WorkspaceFs, root: string): string {
  try {
    return fs.canonicalWorkspaceRoot?.(root) ?? fs.realPath(root);
  } catch (error) {
    if (error instanceof StructuralExecutionStoppedError) throw error;
    return root;
  }
}

// Walks up from `absolutePath` to the nearest ancestor that exists on disk and returns its real
// path. A create target does not exist yet, so we must realpath the deepest existing parent to
// catch a symlinked parent directory (e.g. `link/evil` where `link` -> /outside). Bounded by the
// path depth; terminates at the filesystem root where dirname is a fixpoint.
function realNearestExisting(fs: WorkspaceFs, absolutePath: string): string {
  let current = absolutePath;
  for (;;) {
    try {
      return fs.realPath(current);
    } catch (error) {
      if (error instanceof StructuralExecutionStoppedError) throw error;
      const parent = dirname(current);
      if (parent === current) {
        return absolutePath; // reached the root with nothing resolvable; lexical check stands
      }
      current = parent;
    }
  }
}

function toRelative(root: string, absolutePath: string): string {
  return absolutePath.slice(root.length).replace(/^[/\\]/, "");
}

function deniedLocusSuffixes(path: string): ReadonlySet<string> {
  const segments = path
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0);
  const normalized = segments.map((segment) => segment.normalize("NFC").toLowerCase());
  const loci = new Set<string>();
  for (const [index, segment] of segments.entries()) {
    if (isDenied(segment)) loci.add(normalized.slice(index).join("/"));
  }
  return loci;
}

function normalizedAbsolutePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").normalize("NFC").replace(/\/$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isKnownPlatformRootAlias(realRoot: string, lexicalRoot: string): boolean {
  if (process.platform !== "darwin") return false;
  const real = normalizedAbsolutePath(realRoot);
  const lexical = normalizedAbsolutePath(lexicalRoot);
  return ["/etc", "/tmp", "/var"].some(
    (prefix) =>
      (lexical === prefix || lexical.startsWith(`${prefix}/`)) && real === `/private${lexical}`,
  );
}

// A workspace root can hide a protected location when only paths below the root are checked (for
// example, "docs" -> ".aws"). Preserve relative-only deny semantics for a root already nested below
// `.codex` or another denied ancestor, including benign platform prefix aliases, but refuse every
// denied locus introduced or relocated by the symlink. Comparing only the denied segment identity
// is insufficient: one `.codex` worktree could otherwise redirect to a separate `.codex` store.
export function realRootIsDeniedViaSymlink(realRoot: string, lexicalRoot: string): boolean {
  const lexicalDeniedLoci = deniedLocusSuffixes(lexicalRoot);
  const realDeniedLoci = deniedLocusSuffixes(realRoot);
  for (const realDeniedLocus of realDeniedLoci) {
    if (!lexicalDeniedLoci.has(realDeniedLocus)) return true;
  }
  if (lexicalDeniedLoci.size === 0 && realDeniedLoci.size === 0) return false;
  return (
    normalizedAbsolutePath(realRoot) !== normalizedAbsolutePath(lexicalRoot) &&
    !isKnownPlatformRootAlias(realRoot, lexicalRoot)
  );
}

export interface ContainedRealPathInfo {
  readonly path: string;
  readonly realRelative: string;
  // The symlink-resolved workspace root (`fs.realPath(root)`, lexical root on failure). Exposed so the
  // read path can deny a benign-named root symlink that resolves into a protected location — a denied
  // segment that lives in the realpath'd ROOT is invisible to the root-relative deny checks.
  readonly realBase: string;
}

function normalizeRelativePath(path: string): string {
  return path.replaceAll("\\", "/");
}

/**
 * One positive trust-boundary predicate for consumers that intend to access an existing path.
 * Containment alone is insufficient: a canonical target can still differ from the requested path,
 * resolve below a denied segment, or sit below a benign lexical root symlinked into protected state.
 */
export function isCanonicalAllowedContainedPath(
  info: ContainedRealPathInfo,
  lexicalRoot: string,
  requestedRelativePath: string,
): boolean {
  const requested = normalizeRelativePath(requestedRelativePath);
  const realRelative = normalizeRelativePath(info.realRelative);
  return (
    requested === realRelative &&
    !isDenied(requested) &&
    !isDenied(realRelative) &&
    !realRootIsDeniedViaSymlink(info.realBase, lexicalRoot)
  );
}

/**
 * Positive classification for a missing target whose nearest existing parent was contained.
 * This authorizes an existence probe only; callers must still require the exact predicate above
 * before enumerating or reading. Segment-aware prefix matching rejects in-workspace parent aliases.
 */
export function isAllowedContainedPathParent(
  info: ContainedRealPathInfo,
  lexicalRoot: string,
  requestedRelativePath: string,
): boolean {
  const requested = normalizeRelativePath(requestedRelativePath);
  const realRelative = normalizeRelativePath(info.realRelative);
  const parentMatches =
    realRelative.length === 0 ||
    requested === realRelative ||
    requested.startsWith(`${realRelative}/`);
  return (
    parentMatches &&
    !isDenied(requested) &&
    !isDenied(realRelative) &&
    !realRootIsDeniedViaSymlink(info.realBase, lexicalRoot)
  );
}

export function containedRealPathInfo(
  fs: WorkspaceFs,
  root: string,
  absolutePath: string,
): ContainedRealPathInfo {
  const realBase = realRoot(fs, root);
  try {
    const target = fs.realPath(absolutePath);
    if (!isWithinWorkspace(realBase, target)) {
      throw new PathEscapeError(
        `path escapes the workspace boundary via symlink: ${absolutePath}`,
        absolutePath,
      );
    }
    return { path: target, realRelative: toRelative(realBase, target), realBase };
  } catch (error) {
    if (error instanceof PathEscapeError || error instanceof StructuralExecutionStoppedError) {
      throw error;
    }
    const parentReal = realNearestExisting(fs, absolutePath);
    if (!isWithinWorkspace(realBase, parentReal)) {
      throw new PathEscapeError(
        `path escapes the workspace boundary via symlink: ${absolutePath}`,
        absolutePath,
      );
    }
    return { path: absolutePath, realRelative: toRelative(realBase, parentReal), realBase };
  }
}

// Asserts that `absolutePath` (already lexically contained) does not escape `root` via a symlink.
// For an existing target, the target's own realpath must stay within the real root. For a
// not-yet-existing target (create), the nearest existing ancestor's realpath must stay within it,
// which blocks `create through a symlinked directory` (the S-H1 .git/hooks escalation).
// Returns the canonical real path to hand to IO (existing case) or the lexically-resolved path
// (pure-create case where the target itself has no realpath yet).
export function assertContainedRealPath(
  fs: WorkspaceFs,
  root: string,
  absolutePath: string,
  _label: string,
): string {
  const info = containedRealPathInfo(fs, root, absolutePath);
  return info.path;
}
