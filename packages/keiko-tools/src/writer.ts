// The single controlled filesystem-WRITE boundary (ADR-0006 D2). WorkspaceFs stays read-only
// (ADR-0005); all mutation goes through this port so the apply phase is auditable and testable
// with an in-memory fake. The default patch path uses createContainedNodeWorkspaceWriter so the
// effect edge repeats containment/no-symlink checks immediately before mutation.

import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export interface WorkspaceWriter {
  readonly writeFileUtf8: (absolutePath: string, content: string) => void;
  readonly mkdirp: (absoluteDir: string) => void;
  readonly remove: (absolutePath: string) => void;
  readonly rename: (fromAbsolute: string, toAbsolute: string) => void;
}

const NOFOLLOW_WRITE_FLAG = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

function sameNativePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isContained(root: string, target: string): boolean {
  const rootCmp = process.platform === "win32" ? root.toLowerCase() : root;
  const targetCmp = process.platform === "win32" ? target.toLowerCase() : target;
  const rel = relative(rootCmp, targetCmp);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertContained(root: string, target: string): void {
  if (!isContained(root, target)) {
    throw new Error("workspace writer path escaped the workspace root");
  }
}

function assertNoSymlink(pathValue: string): void {
  const stats = lstatSync(pathValue);
  if (stats.isSymbolicLink()) {
    throw new Error("workspace writer refused a symbolic link");
  }
}

function assertContainedParent(root: string, absolutePath: string): void {
  assertContained(root, absolutePath);
  const parent = dirname(absolutePath);
  const realParent = realpathSync(parent);
  if (!sameNativePath(parent, realParent)) {
    throw new Error("workspace writer refused a redirected parent directory");
  }
  assertContained(root, realParent);
}

function writeFileNoFollow(absolutePath: string, content: string): void {
  const dir = dirname(absolutePath);
  const existingMode = existingFileMode(absolutePath);
  const tempPath = join(
    dir,
    `.${basename(absolutePath)}.keiko-write.${String(process.pid)}.${randomUUID()}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW_WRITE_FLAG,
      existingMode,
    );
    writeSync(fd, content, 0, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (existsSync(absolutePath)) assertNoSymlink(absolutePath);
    renameSync(tempPath, absolutePath);
    fsyncDirectory(dir);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Best-effort close only.
      }
    }
    if (existsSync(tempPath)) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
}

function existingFileMode(absolutePath: string): number {
  try {
    const stats = lstatSync(absolutePath);
    if (stats.isSymbolicLink()) {
      throw new Error("workspace writer refused a symbolic link");
    }
    return stats.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0o666;
    }
    throw error;
  }
}

function fsyncDirectory(dir: string): void {
  if (process.platform === "win32") return;
  let fd: number | undefined;
  try {
    fd = openSync(dir, constants.O_RDONLY);
    fsyncSync(fd);
  } catch {
    // Not all filesystems allow directory fsync; the temp file itself is flushed above.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Best-effort close only.
      }
    }
  }
}

export const nodeWorkspaceWriter: WorkspaceWriter = {
  writeFileUtf8: (absolutePath: string, content: string): void => {
    writeFileNoFollow(absolutePath, content);
  },
  mkdirp: (absoluteDir: string): void => {
    mkdirSync(absoluteDir, { recursive: true });
  },
  remove: (absolutePath: string): void => {
    rmSync(absolutePath, { force: true });
  },
  rename: (fromAbsolute: string, toAbsolute: string): void => {
    renameSync(fromAbsolute, toAbsolute);
  },
};

// Creates a missing directory segment, re-validating it is a real directory (not a symlink)
// both before and after creation to close the TOCTOU window against a concurrent replace.
function createMissingContainedDirectorySegment(current: string, causeError: unknown): void {
  try {
    mkdirSync(current);
  } catch (mkdirError) {
    if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
  }
  const created = lstatSync(current);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new Error("workspace writer refused a non-directory path segment", {
      cause: causeError,
    });
  }
}

// Ensures a single path segment under `root` exists as a real, contained directory, creating it
// if absent. Re-checked per segment because each `join` step is a fresh symlink/containment race.
function ensureContainedDirectorySegment(root: string, current: string): void {
  assertContained(root, current);
  try {
    const stats = lstatSync(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("workspace writer refused a non-directory path segment");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    createMissingContainedDirectorySegment(current, error);
  }
  assertContained(root, realpathSync(current));
}

export function createContainedNodeWorkspaceWriter(workspaceRoot: string): WorkspaceWriter {
  const lexicalRoot = resolve(workspaceRoot);
  const root = realpathSync(workspaceRoot);

  function resolveWorkspacePath(absolutePath: string): string {
    const resolvedPath = resolve(absolutePath);
    if (isContained(root, resolvedPath)) {
      return resolvedPath;
    }
    if (!isContained(lexicalRoot, resolvedPath)) {
      throw new Error("workspace writer path escaped the workspace root");
    }
    return join(root, relative(lexicalRoot, resolvedPath));
  }

  function mkdirpContained(absoluteDir: string): void {
    const resolvedDir = resolveWorkspacePath(absoluteDir);
    assertContained(root, resolvedDir);
    const rel = relative(root, resolvedDir);
    if (rel === "") return;
    let current = root;
    for (const segment of rel.split(/[\\/]+/u).filter(Boolean)) {
      current = join(current, segment);
      ensureContainedDirectorySegment(root, current);
    }
  }

  return {
    writeFileUtf8: (absolutePath: string, content: string): void => {
      const resolvedPath = resolveWorkspacePath(absolutePath);
      assertContainedParent(root, resolvedPath);
      writeFileNoFollow(resolvedPath, content);
    },
    mkdirp: (absoluteDir: string): void => {
      mkdirpContained(absoluteDir);
    },
    remove: (absolutePath: string): void => {
      const resolvedPath = resolveWorkspacePath(absolutePath);
      assertContained(root, resolvedPath);
      assertNoSymlink(resolvedPath);
      rmSync(resolvedPath, { force: true });
    },
    rename: (fromAbsolute: string, toAbsolute: string): void => {
      const from = resolveWorkspacePath(fromAbsolute);
      const to = resolveWorkspacePath(toAbsolute);
      assertContainedParent(root, from);
      assertContainedParent(root, to);
      assertNoSymlink(from);
      renameSync(from, to);
    },
  };
}
