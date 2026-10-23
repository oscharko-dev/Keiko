import { realpathSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, relative } from "node:path";

// The read-only support roots of the project's toolchains for the native profile (#3897). The
// launcher's `PATH` names where `node`, `npm`, `python`, `cargo` and friends live; their install
// prefixes (and, for Homebrew, the shared prefix whose Cellar holds the sibling libraries) are the
// only directories outside the system, the workspace and the run-private state that the kernel
// boundary opens for reading. The user's home itself, or anything above it, is never a root.

const ROOTS_MAX = 64;
// Already readable through the system roots of both native backends.
const SYSTEM_PREFIXES = ["/usr", "/bin", "/sbin"] as const;
const BIN_DIRECTORIES: ReadonlySet<string> = new Set(["bin", "sbin"]);
const HOMEBREW_CELLAR = /^(\/opt\/homebrew|\/usr\/local)\/Cellar\//u;

function insideOrEqual(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith("../") && !isAbsolute(path));
}

function installPrefix(directory: string): string {
  const cellar = HOMEBREW_CELLAR.exec(directory);
  if (cellar?.[1] !== undefined) return cellar[1];
  return BIN_DIRECTORIES.has(basename(directory)) ? dirname(directory) : directory;
}

function admissible(root: string, home: string): boolean {
  return (
    root.split("/").length > 2 &&
    !/[\0\r\n]/u.test(root) &&
    !insideOrEqual(root, home) &&
    !SYSTEM_PREFIXES.some((system) => insideOrEqual(system, root))
  );
}

/** A `PATH` entry that does not exist or cannot be resolved is simply not a toolchain root. */
const UNRESOLVABLE_PATH_ENTRY_CODES = new Set(["ENOENT", "ENOTDIR", "EACCES", "ELOOP"]);

function resolvedDirectory(entry: string): string | undefined {
  if (!isAbsolute(entry)) return undefined;
  try {
    return realpathSync(entry);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      UNRESOLVABLE_PATH_ENTRY_CODES.has(String(error.code))
    )
      return undefined;
    throw error;
  }
}

function rootFor(entry: string, home: string): string | undefined {
  const directory = resolvedDirectory(entry);
  if (directory === undefined) return undefined;
  // A prefix that would open the user's home (`~/bin` -> `~`) falls back to the directory itself.
  return [installPrefix(directory), directory].find((root) => admissible(root, home));
}

/** Deterministic, bounded and free of nested duplicates; empty when nothing qualifies. */
export function nativeToolchainReadRoots(
  pathValue: string | undefined,
  home: string,
): readonly string[] {
  const roots = [
    ...new Set(
      (pathValue ?? "")
        .split(delimiter)
        .map((entry) => rootFor(entry, home))
        .filter((root): root is string => root !== undefined),
    ),
  ].sort();
  return roots
    .filter((root) => !roots.some((other) => other !== root && insideOrEqual(other, root)))
    .slice(0, ROOTS_MAX);
}
