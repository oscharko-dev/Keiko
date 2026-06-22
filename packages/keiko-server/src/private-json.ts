// Atomic, private-permission JSON writer for local runtime files (keiko.config.json and siblings).
//
// Extracted from gateway-setup so the first-run setup writer and the one-time credential migration
// share ONE crash-safe write path (Issue #1320): a fresh temp file in the same directory is written
// with 0600, then renamed over the target so a reader never observes a partially written file. Every
// path segment is checked for symlinks first so a hostile symlink cannot redirect the write outside
// the intended private directory.

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export function savePrivateJson(path: string, raw: Record<string, unknown>): void {
  const resolvedPath = resolve(path);
  const dir = dirname(resolvedPath);
  assertNoSymlinkedPathSegments(resolvedPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertNoSymlinkedPathSegments(resolvedPath);
  if (process.platform !== "win32") {
    chmodSync(dir, 0o700);
  }
  const tempPath = join(
    dir,
    `.keiko-config.${String(process.pid)}.${Date.now().toString(36)}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(tempPath, `${JSON.stringify(raw, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    if (process.platform !== "win32") {
      chmodSync(tempPath, 0o600);
    }
    renameSync(tempPath, resolvedPath);
  } finally {
    if (existsSync(tempPath)) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
}

export function assertNoSymlinkedPathSegments(resolvedPath: string): void {
  let current = resolvedPath;
  while (current !== dirname(current)) {
    if (isSymlink(current)) {
      throw new Error("refusing to write gateway config through a symlinked path");
    }
    current = dirname(current);
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
