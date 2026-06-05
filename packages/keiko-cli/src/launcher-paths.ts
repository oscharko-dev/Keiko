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

import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { LauncherError } from "./launcher-platforms.js";

function realpathOrResolve(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

// Walks up `p`'s ancestry until it finds an existing one; returns the realpath of that
// existing ancestor concatenated with the not-yet-existing tail. This lets us compare
// paths consistently even when leaves don't exist (mkdir not yet called), without
// silently following a symlinked ancestor: the realpath is taken of the FIRST existing
// segment in the chain, so symlinks along the still-textual tail are not resolved.
export function resolveWithExistingAncestor(p: string): string {
  const absolute = resolve(p);
  const tail: string[] = [];
  let current = absolute;
  for (let i = 0; i < 64; i += 1) {
    if (existsSync(current)) {
      return tail.length === 0
        ? realpathOrResolve(current)
        : join(realpathOrResolve(current), ...tail.reverse());
    }
    tail.push(current.split(sep).pop() ?? "");
    const parent = dirname(current);
    if (parent === current) return absolute;
    current = parent;
  }
  return absolute;
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
