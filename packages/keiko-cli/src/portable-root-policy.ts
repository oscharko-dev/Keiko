import { existsSync, lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, win32 } from "node:path";
import type { SecurityLogSink } from "@oscharko-dev/keiko-security";
import { isSystemManagedPortableRoot } from "@oscharko-dev/keiko-security/portable-root-policy";
import { assertWindowsLocalVolume } from "@oscharko-dev/keiko-security/windows-local-volume";
import type { PortableTarget } from "./portable-shared.js";

function normalizedPath(path: string): string {
  return path.replaceAll("\\", "/").toLowerCase();
}

function pathTouchesRuntimeState(normalized: string): boolean {
  return normalized.includes("/.keiko/") || normalized.endsWith("/.keiko");
}

function pathInsideTemp(normalized: string): boolean {
  const tmp = normalizedPath(resolve(tmpdir()));
  return normalized === tmp || normalized.startsWith(`${tmp}/`);
}

function pathInsideRepository(root: string, normalized: string): boolean {
  let cursor = resolve(root);
  for (;;) {
    if (existsSync(join(cursor, ".git"))) {
      const repo = normalizedPath(cursor);
      return normalized === repo || normalized.startsWith(`${repo}/`);
    }
    const parent = dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
}

function withoutTrailingSeparators(path: string): string {
  let end = path.length;
  while (end > 0 && (path[end - 1] === "\\" || path[end - 1] === "/")) end -= 1;
  return path.slice(0, end);
}

// An install root is a directory below a volume or share root, never the root itself: the uninstall
// removes the root's whole tree, and a drive (`C:\`) or a bare share (`\\server\share`, whose
// resolved form has no trailing separator) must never be one (#4358). Windows spellings are read
// with the Windows path rules whatever the host is.
function isVolumeRoot(path: string, target: PortableTarget): boolean {
  if (target === "windows-x64") {
    const full = win32.resolve(path);
    return withoutTrailingSeparators(full) === withoutTrailingSeparators(win32.parse(full).root);
  }
  const full = resolve(path);
  return dirname(full) === full;
}

function assertPathAllowed(path: string, target: PortableTarget): void {
  if (isVolumeRoot(path, target)) {
    throw new Error("managed install root must be a directory below a drive or share root");
  }
  const normalized = normalizedPath(path);
  if (pathTouchesRuntimeState(normalized)) {
    throw new Error("managed install root must be separate from .keiko runtime state");
  }
  if (pathInsideTemp(normalized)) {
    throw new Error("managed install root must not be inside a temporary directory");
  }
  if (isSystemManagedPortableRoot(resolve(path), target)) {
    throw new Error("managed install root must be user-local or the canonical Keiko macOS app");
  }
  if (pathInsideRepository(path, normalized)) {
    throw new Error("managed install root must be outside customer repositories");
  }
}

function nearestExistingAncestor(path: string): string {
  let cursor = resolve(path);
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return cursor;
    cursor = parent;
  }
  return cursor;
}

function assertNoSymlinkedAncestor(path: string): void {
  let cursor = resolve(path);
  for (;;) {
    try {
      if (lstatSync(cursor).isSymbolicLink()) {
        throw new Error("managed install root must not use symlinked ancestors");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

function resolvedCandidatePath(path: string): string {
  const absolute = resolve(path);
  const ancestor = nearestExistingAncestor(absolute);
  const suffix = relative(ancestor, absolute);
  return resolve(realpathSync(ancestor), suffix);
}

export function assertManagedRootAllowed(
  path: string,
  stateDir: string,
  target: PortableTarget,
  securityLogSink?: SecurityLogSink,
): void {
  assertPathAllowed(path, target);
  assertNoSymlinkedAncestor(path);
  // Check the lexical/original path before realpath can erase a mapped-share or reparse boundary.
  if (target === "windows-x64") {
    assertWindowsLocalVolume(nearestExistingAncestor(path), { securityLogSink });
  }
  const resolvedPath = resolvedCandidatePath(path);
  assertPathAllowed(resolvedPath, target);
  const resolvedState = resolvedCandidatePath(stateDir);
  const normalizedRoot = normalizedPath(resolvedPath);
  const normalizedState = normalizedPath(resolvedState);
  if (
    normalizedRoot === normalizedState ||
    normalizedRoot.startsWith(`${normalizedState}/`) ||
    normalizedState.startsWith(`${normalizedRoot}/`)
  ) {
    throw new Error("managed install root must be separate from .keiko runtime state");
  }
}
