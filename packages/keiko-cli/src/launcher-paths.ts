// Shared realpath-containment helpers for the launcher. Extracted from `launcher.ts`
// so `launcher-state.ts` can apply the same boundary at state-file parse time without
// each call site repeating the check (defense-in-depth against state-file tampering;
// see ADR-0024 §9 / #125 security audit findings F1/F2).
//
// The helpers operate on textual paths AND the filesystem. They realpath the deepest
// existing ancestor of both the approved dir and the target, so:
//
//   - `/tmp/foo` ⇄ `/private/tmp/foo` (macOS symlink-redirected tmp) compare EQUAL;
//   - a symlink at the still-textual tail is NOT silently followed (we stop walking at
//     the first existing component and append the tail verbatim);
//   - the walk is bounded by 64 path components to guarantee termination.
//
// `assertRealpathContained` is the PRIMARY symlink defense; `assertApprovedDirNotSymlink`
// / `assertTargetNotSymlink` in `launcher.ts` are leaf-only defense-in-depth (see header
// comments there).

import { lstatSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { LauncherError } from "./launcher-platforms.js";

function realpathOrResolve(p: string): string {
  // PR-review follow-up (Codex thread 3771387240 + 3771468992): every errno from realpath
  // propagates. The caller only calls realpathOrResolve on an ALREADY-EXISTING segment
  // (segmentExists ran first in resolveWithExistingAncestor), so ENOENT here means
  // realpathSync could not resolve the path — the segment exists (per lstat) but its
  // symlink target is missing. That is a dangling symlink pointing outside the validated
  // boundary; approving the unresolved textual path would let a later mkdir-then-open
  // follow the symlink outside home. Fail loud instead.
  return realpathSync(p);
}

// Walks up `p`'s ancestry until it finds an existing one; returns the realpath of that
// existing ancestor concatenated with the not-yet-existing tail. This lets us compare
// paths consistently even when leaves don't exist (mkdir not yet called), without
// silently following a symlinked ancestor: the realpath is taken of the FIRST existing
// segment in the chain, so symlinks along the still-textual tail are not resolved.
function resolveWithExistingAncestor(p: string): string {
  const absolute = resolve(p);
  const tail: string[] = [];
  let current = absolute;
  for (let i = 0; i < 64; i += 1) {
    // PR-review follow-up (Codex thread 3771128753): use lstatSync directly so an
    // EACCES/EIO on the current segment propagates instead of being collapsed to
    // "absent" by existsSync — the latter would treat an inaccessible symlinked
    // ancestor as a still-textual tail and reconstruct the path without resolving
    // through the symlink, defeating the containment check.
    const existsHere = segmentExists(current);
    if (existsHere) {
      if (tail.length === 0) return realpathOrResolve(current);
      tail.reverse();
      return join(realpathOrResolve(current), ...tail);
    }
    tail.push(current.split(sep).pop() ?? "");
    const parent = dirname(current);
    if (parent === current) return absolute;
    current = parent;
  }
  return absolute;
}

function segmentExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

// Asserts that `target` is contained within `approvedDir` AFTER both have been resolved
// against the real filesystem. We realpath the deepest-existing ancestor of BOTH sides
// so `/tmp` ⇄ `/private/tmp` (macOS) and other symlinked-ancestor cases compare equal,
// while symlinks at the still-textual tail are NOT silently followed.
export function assertRealpathContained(approvedDir: string, target: string): void {
  const realApproved = resolveWithExistingAncestor(approvedDir);
  const realTarget = resolveWithExistingAncestor(target);
  if (realTarget !== realApproved && !realTarget.startsWith(realApproved + sep)) {
    throw new LauncherError(
      "PATH_ESCAPE",
      `keiko launcher: refusing to write outside the approved directory.\n  approved: ${realApproved}\n  target:   ${realTarget}`,
    );
  }
}

// Predicate form of `assertRealpathContained` — does not throw. Used by parse-time
// filtering where we want to silently drop tampered entries (and emit a stderr warning)
// rather than abort the entire `loadState` call.
export function isRealpathContained(approvedDir: string, target: string): boolean {
  const realApproved = resolveWithExistingAncestor(approvedDir);
  const realTarget = resolveWithExistingAncestor(target);
  return realTarget === realApproved || realTarget.startsWith(realApproved + sep);
}
