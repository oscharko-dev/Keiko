// The single controlled filesystem-WRITE boundary (ADR-0006 D2). WorkspaceFs stays read-only
// (ADR-0005); all mutation goes through this port so the apply phase is auditable and testable
// with an in-memory fake. The default patch path uses createContainedNodeWorkspaceWriter so the
// effect edge repeats containment/no-symlink checks immediately before mutation.

import {
  closeSync,
  constants,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface WorkspaceWriter {
  readonly writeFileUtf8: (absolutePath: string, content: string) => void;
  readonly mkdirp: (absoluteDir: string) => void;
  readonly remove: (absolutePath: string) => void;
  readonly rename: (fromAbsolute: string, toAbsolute: string) => void;
}

const NOFOLLOW_WRITE_FLAG =
  typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

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
  const fd = openSync(
    absolutePath,
    constants.O_WRONLY | constants.O_CREAT | NOFOLLOW_WRITE_FLAG,
    0o666,
  );
  try {
    ftruncateSync(fd, 0);
    writeFileSync(fd, content, "utf8");
  } finally {
    closeSync(fd);
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

// eslint-disable-next-line max-lines-per-function -- writer authority checks stay local to the contained writer closure.
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

  // eslint-disable-next-line complexity -- mkdirp must re-check every segment for symlink and containment races.
  function mkdirpContained(absoluteDir: string): void {
    const resolvedDir = resolveWorkspacePath(absoluteDir);
    assertContained(root, resolvedDir);
    const rel = relative(root, resolvedDir);
    if (rel === "") return;
    let current = root;
    for (const segment of rel.split(/[\\/]+/u).filter(Boolean)) {
      current = join(current, segment);
      assertContained(root, current);
      try {
        const stats = lstatSync(current);
        if (stats.isSymbolicLink() || !stats.isDirectory()) {
          throw new Error("workspace writer refused a non-directory path segment");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        try {
          mkdirSync(current);
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
        }
        const created = lstatSync(current);
        if (created.isSymbolicLink() || !created.isDirectory()) {
          throw new Error("workspace writer refused a non-directory path segment", { cause: error });
        }
      }
      assertContained(root, realpathSync(current));
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
