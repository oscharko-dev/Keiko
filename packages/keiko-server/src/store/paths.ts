// ADR-0013 D4 — resolveUiDbPath precedence (mirrors resolveEvidenceDir):
// explicit option → KEIKO_UI_DATA_DIR/keiko-ui.db → homedir()/.keiko/keiko-ui.db.

import { homedir } from "node:os";
import { existsSync, lstatSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, normalize, parse, resolve, sep } from "node:path";
import { invalidRequest } from "./errors.js";

export const UI_DB_FILENAME = "keiko-ui.db";
export const UI_DB_DIRNAME = ".keiko";

function isInsideCurrentWorkingDirectory(path: string): boolean {
  const cwd = resolve(process.cwd());
  const resolved = resolve(path);
  return resolved === cwd || resolved.startsWith(`${cwd}${sep}`);
}

function isInsideRuntimeStateRoot(path: string, workspaceRoot: string): boolean {
  const runtimeRoot = resolve(workspaceRoot, UI_DB_DIRNAME);
  const resolved = resolve(path);
  return resolved === runtimeRoot || resolved.startsWith(`${runtimeRoot}${sep}`);
}

// Walk every ancestor from dirname(path) up to the filesystem root and return true as soon as ANY
// existing ancestor is a symlink. Do NOT short-circuit at the first existing directory: a real
// subdirectory pre-created inside a symlinked target would otherwise defeat the guard, because the
// walk would see the real subdirectory (not a symlink) at the first-existing position and never
// inspect the shallower symlinked ancestor. Audit KEIKO-0478; parity fix with
// packages/keiko-memory-vault/src/paths.ts.
function hasSymlinkAncestor(path: string): boolean {
  let current = dirname(path);
  const root = parse(current).root;
  while (current !== root) {
    // PR-review follow-up (Codex thread 3771256639): lstat directly. Only ENOENT means the
    // segment truly does not exist; EACCES/EIO propagate so a symlinked ancestor whose
    // target is temporarily inaccessible cannot slip past by looking absent to existsSync.
    const stat = lstatOrNull(current);
    if (stat?.isSymbolicLink()) return true;
    current = dirname(current);
  }
  return false;
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function resolveConfiguredPath(path: string, label: string): string {
  // NUL bypass (CWE-22): path.normalize() leaves NUL bytes intact, so a string like
  // "/safe/path\0/etc/passwd" satisfies the CWD-containment check but open(2) truncates
  // at the NUL and lands on a completely different file. Reject NUL bytes first so the
  // downstream guards reason about the same string the kernel will syscall on. Parity
  // with the fix landed in packages/keiko-memory-vault/src/paths.ts (commit fbb90a88).
  if (path.includes("\0")) {
    throw invalidRequest(`${label} must not contain NUL bytes.`);
  }
  if (!isAbsolute(path)) {
    throw invalidRequest(`${label} must be absolute.`);
  }
  const resolved = normalize(path);
  if (
    isInsideCurrentWorkingDirectory(resolved) &&
    !isInsideRuntimeStateRoot(resolved, process.cwd())
  ) {
    throw invalidRequest(`${label} must not be inside the current workspace.`);
  }
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
    throw invalidRequest(`${label} must not be a symlink.`);
  }
  if (hasSymlinkAncestor(resolved)) {
    throw invalidRequest(`${label} must not be inside a symlinked directory.`);
  }
  return resolved;
}

function containsPath(parent: string, child: string): boolean {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(child);
  return resolvedChild === resolvedParent || resolvedChild.startsWith(`${resolvedParent}${sep}`);
}

export function resolveUiDbPath(
  explicit: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (explicit !== undefined && explicit.length > 0) {
    return resolveConfiguredPath(explicit, "UI database path");
  }
  const dir = env.KEIKO_UI_DATA_DIR;
  if (dir !== undefined && dir.length > 0) {
    return join(resolveConfiguredPath(dir, "KEIKO_UI_DATA_DIR"), UI_DB_FILENAME);
  }
  return join(homedir(), UI_DB_DIRNAME, UI_DB_FILENAME);
}

export function assertUiDbOutsideProject(uiDbPath: string | undefined, projectPath: string): void {
  if (uiDbPath === undefined || uiDbPath.length === 0) {
    return;
  }
  const resolvedDbPath = resolve(uiDbPath);
  const resolvedDbDir = dirname(resolvedDbPath);
  const resolvedProject = resolve(projectPath);
  if (
    containsPath(resolvedProject, resolvedDbPath) &&
    !isInsideRuntimeStateRoot(resolvedDbPath, resolvedProject)
  ) {
    throw invalidRequest("UI database path must not be inside a selected project.");
  }
  if (containsPath(resolvedDbDir, resolvedProject)) {
    throw invalidRequest("Selected projects must not be inside the UI database directory.");
  }
}
