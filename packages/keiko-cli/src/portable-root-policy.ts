import { existsSync, lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { PortableTarget } from "./portable-shared.js";

const SYSTEM_MANAGED_PREFIXES = [
  "//",
  "/applications/",
  "/library/",
  "/system/",
  "/usr/",
  "/bin/",
  "/sbin/",
  "/etc/",
  "c:/program files/",
  "c:/programdata/",
  "c:/windows/",
] as const;

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

function pathLooksSystemManaged(normalized: string): boolean {
  return SYSTEM_MANAGED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function isCanonicalMacosManagedRoot(path: string, target: PortableTarget): boolean {
  return (
    target !== "windows-x64" &&
    normalizedPath(resolve(path)) === normalizedPath("/Applications/Keiko.app")
  );
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

function assertPathAllowed(path: string, target: PortableTarget): void {
  const normalized = normalizedPath(path);
  if (pathTouchesRuntimeState(normalized)) {
    throw new Error("managed install root must be separate from .keiko runtime state");
  }
  if (pathInsideTemp(normalized)) {
    throw new Error("managed install root must not be inside a temporary directory");
  }
  if (pathLooksSystemManaged(normalized) && !isCanonicalMacosManagedRoot(path, target)) {
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
): void {
  assertPathAllowed(path, target);
  assertNoSymlinkedAncestor(path);
  const resolvedPath = resolvedCandidatePath(path);
  assertPathAllowed(resolvedPath, target);
  const resolvedState = resolvedCandidatePath(stateDir);
  if (
    normalizedPath(resolvedPath) === normalizedPath(resolvedState) ||
    normalizedPath(resolvedPath).startsWith(`${normalizedPath(resolvedState)}/`)
  ) {
    throw new Error("managed install root must be separate from .keiko runtime state");
  }
}
