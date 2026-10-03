// ADR-0013 D4 — resolveUiDbPath precedence (mirrors resolveEvidenceDir):
// explicit option → KEIKO_UI_DATA_DIR/keiko-ui.db → homedir()/.keiko/keiko-ui.db.

import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { assertSqliteStatePath } from "@oscharko-dev/keiko-security/fs-hardening";
import type { ServerLogSink } from "../observability/index.js";
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
  sink?: ServerLogSink,
): string {
  if (explicit !== undefined && explicit.length > 0) {
    return checkedUiDbPath(resolveConfiguredPath(explicit, "UI database path"), sink);
  }
  const dir = env.KEIKO_UI_DATA_DIR;
  if (dir !== undefined && dir.length > 0) {
    return checkedUiDbPath(
      join(resolveConfiguredPath(dir, "KEIKO_UI_DATA_DIR"), UI_DB_FILENAME),
      sink,
    );
  }
  return checkedUiDbPath(
    resolveConfiguredPath(defaultUiDbPath(), "Default UI database path"),
    sink,
  );
}

function defaultUiDbPath(): string {
  let home = homedir();
  try {
    home = realpathSync(home);
  } catch {
    throw invalidRequest("Default UI database home is unavailable.");
  }
  return join(home, UI_DB_DIRNAME, UI_DB_FILENAME);
}

function checkedUiDbPath(path: string, sink?: ServerLogSink): string {
  try {
    assertSqliteStatePath(path, { store: "ui", sink });
  } catch {
    throw invalidRequest("UI database state path is unsafe or unavailable.");
  }
  return path;
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
