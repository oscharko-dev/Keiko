// Path resolution for the local memory vault. The precedence ladder mirrors ADR-0013 D4 (UI DB):
//   1. explicit `memoryDir` factory option
//   2. $KEIKO_MEMORY_DIR
//   3. $KEIKO_STATE_DIR/memory/                 (shared keiko local-state convention)
//   4. homedir()/.keiko/memory/                  (fallback)
//
// Every configured path is forced to be absolute, outside the current working directory except for
// the gitignored .keiko/ runtime root, not a symlink, and not under a symlinked ancestor. These
// guards prevent a stray relative path from silently storing a customer's enterprise memory inside
// their project tree (where it would be committed by accident) or being aimed at a symlink that
// points back into a sensitive location.

import { homedir } from "node:os";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, parse, resolve, sep } from "node:path";
import { MemoryStorageError } from "./errors.js";

export const MEMORY_DB_FILENAME = "keiko-memory.db";
export const MEMORY_DIR_NAME = "memory";
export const DEFAULT_STATE_DIR = ".keiko";

function invalidPath(message: string): MemoryStorageError {
  return new MemoryStorageError("invalid-path", message);
}

function isInsideCwd(candidate: string): boolean {
  const cwd = resolve(process.cwd());
  const r = resolve(candidate);
  return r === cwd || r.startsWith(`${cwd}${sep}`);
}

function isInsideRuntimeStateRoot(candidate: string): boolean {
  const runtimeRoot = resolve(process.cwd(), DEFAULT_STATE_DIR);
  const r = resolve(candidate);
  return r === runtimeRoot || r.startsWith(`${runtimeRoot}${sep}`);
}

function hasSymlinkAncestor(path: string): boolean {
  let current = dirname(path);
  const root = parse(current).root;
  while (current !== root) {
    if (existsSync(current)) {
      return lstatSync(current).isSymbolicLink();
    }
    current = dirname(current);
  }
  return false;
}

function guard(path: string, label: string): string {
  // NUL bypass (CWE-22): path.normalize() leaves NUL bytes intact, so a string like
  // "/safe/path\0/etc/passwd" satisfies the CWD-containment check but open(2) truncates
  // at the NUL and lands on a completely different file. Reject NUL bytes first so the
  // downstream guards reason about the same string the kernel will syscall on.
  if (path.includes("\0")) {
    throw invalidPath(`${label} must not contain NUL bytes.`);
  }
  if (!isAbsolute(path)) {
    throw invalidPath(`${label} must be absolute.`);
  }
  const normalized = normalize(path);
  if (isInsideCwd(normalized) && !isInsideRuntimeStateRoot(normalized)) {
    throw invalidPath(`${label} must not be inside the current workspace.`);
  }
  if (existsSync(normalized) && lstatSync(normalized).isSymbolicLink()) {
    throw invalidPath(`${label} must not be a symlink.`);
  }
  if (hasSymlinkAncestor(normalized)) {
    throw invalidPath(`${label} must not be inside a symlinked directory.`);
  }
  return normalized;
}

export function resolveMemoryDir(
  explicit: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (explicit !== undefined && explicit.length > 0) {
    return guard(explicit, "Memory vault directory");
  }
  const fromEnv = env.KEIKO_MEMORY_DIR;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return guard(fromEnv, "KEIKO_MEMORY_DIR");
  }
  const stateDir = env.KEIKO_STATE_DIR;
  if (stateDir !== undefined && stateDir.length > 0) {
    return guard(
      join(guard(stateDir, "KEIKO_STATE_DIR"), MEMORY_DIR_NAME),
      "KEIKO_STATE_DIR/memory",
    );
  }
  // The default branch is guarded exactly like the three configured branches above: it is the one
  // every install without explicit configuration takes, and it is where the encrypted DB — plus,
  // on the keyfile tier, the plaintext vault key — lands. A ~/.keiko planted as a symlink would
  // otherwise redirect both silently. The CWD-containment check inside guard() is a no-op for a
  // homedir path unless the process is started from $HOME, where .keiko is the gitignored runtime
  // state root guard() already allows.
  return guard(defaultMemoryDirCandidate(), "Default memory vault directory");
}

// The home directory itself may legitimately BE a symlink — a relocated or mounted home is an
// ordinary setup, not the planted redirect this module defends against. hasSymlinkAncestor stops
// at the first EXISTING ancestor, so before ~/.keiko is created (i.e. on first run) that ancestor
// IS the home directory, and guarding the unresolved path rejected those installs outright.
// Resolving the home to its real location keeps every guard aimed at what the threat model is
// about: a symlinked .keiko, or a symlinked memory/ inside it, are both still rejected because the
// resolved path is checked in full.
function defaultMemoryDirCandidate(): string {
  const home = homedir();
  try {
    return join(realpathSync(home), DEFAULT_STATE_DIR, MEMORY_DIR_NAME);
  } catch {
    // A home that cannot be resolved (missing, or unreadable) is not decided here: the unresolved
    // path still goes through guard(), which rejects it with the same typed error as any other
    // invalid path rather than letting it through unchecked.
    return join(home, DEFAULT_STATE_DIR, MEMORY_DIR_NAME);
  }
}

export function resolveMemoryDbPath(
  explicit: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return join(resolveMemoryDir(explicit, env), MEMORY_DB_FILENAME);
}
