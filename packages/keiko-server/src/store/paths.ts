// ADR-0013 D4 — resolveUiDbPath precedence (mirrors resolveEvidenceDir):
// explicit option → KEIKO_UI_DATA_DIR/keiko-ui.db → homedir()/.keiko/keiko-ui.db.

import { homedir } from "node:os";
import { existsSync, lstatSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, parse, resolve, sep } from "node:path";
import { invalidRequest } from "./errors.js";

export const UI_DB_FILENAME = "keiko-ui.db";
export const UI_DB_DIRNAME = ".keiko";

function isInsideCurrentWorkingDirectory(path: string): boolean {
  const cwd = resolve(process.cwd());
  const resolved = resolve(path);
  return resolved === cwd || resolved.startsWith(`${cwd}${sep}`);
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

function resolveConfiguredPath(path: string, label: string): string {
  if (!isAbsolute(path)) {
    throw invalidRequest(`${label} must be absolute.`);
  }
  const resolved = normalize(path);
  if (isInsideCurrentWorkingDirectory(resolved)) {
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

export function assertUiDbOutsideProject(
  uiDbPath: string | undefined,
  projectPath: string,
): void {
  if (uiDbPath === undefined || uiDbPath.length === 0) {
    return;
  }
  const resolvedDbPath = resolve(uiDbPath);
  const resolvedDbDir = dirname(resolvedDbPath);
  const resolvedProject = resolve(projectPath);
  if (containsPath(resolvedProject, resolvedDbPath)) {
    throw invalidRequest("UI database path must not be inside a selected project.");
  }
  if (containsPath(resolvedDbDir, resolvedProject)) {
    throw invalidRequest("Selected projects must not be inside the UI database directory.");
  }
}
