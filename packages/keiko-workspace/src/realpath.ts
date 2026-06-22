// PURE-at-the-port symlink containment. After lexical resolveWithinWorkspace has proven a path is
// lexically inside the root, this gate defends against the symlink class of escape: a path whose
// real (symlink-followed) location is outside the root, or a not-yet-existing create target whose
// nearest existing parent escapes via a symlink. Every filesystem touch goes through the injected
// WorkspaceFs port (realPath only) so the logic stays testable with an in-memory fake and all real
// IO is auditable in one place (ADR-0005 D2, ADR-0006 D2). The read path (discovery.ts) and the
// write/cwd paths (tools/patch.ts, tools/exec.ts) share this single primitive — no duplicated logic.

import { dirname } from "node:path";
import type { WorkspaceFs } from "./fs.js";
import { isWithinWorkspace } from "./paths.js";
import { PathEscapeError } from "./errors.js";

// Resolves `root` through any platform symlinks (e.g. macOS /var -> /private/var) so the
// containment comparison is symlink-consistent on both sides. Falls back to the lexical root.
function realRoot(fs: WorkspaceFs, root: string): string {
  try {
    return fs.realPath(root);
  } catch {
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
    } catch {
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

export interface ContainedRealPathInfo {
  readonly path: string;
  readonly realRelative: string;
  // The symlink-resolved workspace root (`fs.realPath(root)`, lexical root on failure). Exposed so the
  // read path can deny a benign-named root symlink that resolves into a protected location — a denied
  // segment that lives in the realpath'd ROOT is invisible to the root-relative deny checks.
  readonly realBase: string;
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
    if (error instanceof PathEscapeError) {
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
