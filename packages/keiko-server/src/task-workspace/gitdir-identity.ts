import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import {
  nodeWorkspaceFs,
  type WorkspaceDescriptorUtf8Read,
  type WorkspaceFs,
  type WorkspaceStat,
} from "@oscharko-dev/keiko-workspace/internal/fs";

const MAX_GIT_METADATA_BYTES = 64 * 1024;
const IDENTITY_SCHEMA = "managed-linked-worktree-v2";

interface StableContainedRead {
  readonly rawText: string;
  readonly rootIdentity: string;
  readonly fileIdentity: string;
}

interface LinkedWorktreePointer {
  readonly canonicalAdminDirectory: string;
  readonly worktreeIdentity: string;
  readonly pointerIdentity: string;
  readonly adminDirectoryIdentity: string;
  readonly backpointerIdentity: string;
}

interface GitCommonDirectory {
  readonly path: string;
  readonly identity: string;
}

export interface ManagedGitdirIdentityInspection {
  readonly identity: string;
}

function directoryIdentity(stat: WorkspaceStat): string | undefined {
  if (!stat.isDirectory || stat.isSymbolicLink) return undefined;
  return stat.fileIdentity === undefined || stat.fileIdentity.length === 0
    ? undefined
    : stat.fileIdentity;
}

function fileIdentity(read: WorkspaceDescriptorUtf8Read): string | undefined {
  if (!read.stat.isFile || read.stat.isSymbolicLink) return undefined;
  return read.stat.fileIdentity === undefined || read.stat.fileIdentity.length === 0
    ? undefined
    : read.stat.fileIdentity;
}

function readStableContainedFile(
  fs: WorkspaceFs,
  canonicalRoot: string,
  absolutePath: string,
): StableContainedRead | undefined {
  const read = fs.readFileUtf8WithinRootSameDescriptor;
  if (read === undefined) return undefined;
  const before = directoryIdentity(fs.stat(canonicalRoot));
  if (before === undefined) return undefined;
  const result = read.call(
    fs,
    canonicalRoot,
    absolutePath,
    MAX_GIT_METADATA_BYTES,
    "reject",
    "complete",
  );
  const after = directoryIdentity(fs.stat(canonicalRoot));
  const targetIdentity = fileIdentity(result);
  if (after !== before || targetIdentity === undefined) return undefined;
  return { rawText: result.rawText, rootIdentity: before, fileIdentity: targetIdentity };
}

function parseAbsoluteSingleLine(raw: string): string | undefined {
  const value = raw.trim();
  if (value.length === 0 || value.includes("\0") || /[\r\n]/u.test(value)) return undefined;
  return isAbsolute(value) ? normalize(value) : undefined;
}

/** Parses the complete contents of a linked-worktree `.git` pointer. */
export function parseGitdirPointerTarget(raw: string): string | undefined {
  const value = raw.trim();
  if (!value.startsWith("gitdir:")) return undefined;
  return parseAbsoluteSingleLine(value.slice("gitdir:".length));
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function validBackpointer(
  raw: string,
  requestedWorktree: string,
  canonicalWorktree: string,
): boolean {
  const target = parseAbsoluteSingleLine(raw);
  if (target === undefined) return false;
  return (
    samePath(target, join(requestedWorktree, ".git")) ||
    samePath(target, join(canonicalWorktree, ".git"))
  );
}

function validAdminDirectoryShape(path: string): boolean {
  const worktreesDirectory = dirname(path);
  return basename(path).length > 0 && basename(worktreesDirectory) === "worktrees";
}

function resolveAdminDirectory(
  fs: WorkspaceFs,
  rawPointer: string,
  expectedParent: string | undefined,
): string | undefined {
  const target = parseGitdirPointerTarget(rawPointer);
  if (target === undefined || !validAdminDirectoryShape(target)) return undefined;
  if (expectedParent !== undefined && !samePath(dirname(target), expectedParent)) return undefined;
  const canonical = fs.realPath(target);
  if (!validAdminDirectoryShape(canonical)) return undefined;
  if (expectedParent !== undefined && !samePath(dirname(canonical), expectedParent))
    return undefined;
  return canonical;
}

function inspectLinkedWorktreePointer(
  fs: WorkspaceFs,
  requestedWorktree: string,
  expectedAdminParent?: string,
): LinkedWorktreePointer | undefined {
  const canonicalWorktree = fs.realPath(requestedWorktree);
  const pointer = readStableContainedFile(fs, canonicalWorktree, join(canonicalWorktree, ".git"));
  if (pointer === undefined) return undefined;
  const canonicalAdminDirectory = resolveAdminDirectory(fs, pointer.rawText, expectedAdminParent);
  if (canonicalAdminDirectory === undefined) return undefined;
  const backpointer = readStableContainedFile(
    fs,
    canonicalAdminDirectory,
    join(canonicalAdminDirectory, "gitdir"),
  );
  if (
    backpointer === undefined ||
    !validBackpointer(backpointer.rawText, requestedWorktree, canonicalWorktree)
  ) {
    return undefined;
  }
  return {
    canonicalAdminDirectory,
    worktreeIdentity: pointer.rootIdentity,
    pointerIdentity: pointer.fileIdentity,
    adminDirectoryIdentity: backpointer.rootIdentity,
    backpointerIdentity: backpointer.fileIdentity,
  };
}

function commonDirectoryAt(fs: WorkspaceFs, path: string): GitCommonDirectory | undefined {
  const identity = directoryIdentity(fs.stat(path));
  return identity === undefined ? undefined : { path, identity };
}

function repositoryCommonDirectory(
  fs: WorkspaceFs,
  repositoryRoot: string,
): GitCommonDirectory | undefined {
  const canonicalRepository = fs.realPath(repositoryRoot);
  const dotGit = join(canonicalRepository, ".git");
  const dotGitStat = fs.stat(dotGit);
  if (dotGitStat.isDirectory && !dotGitStat.isSymbolicLink) {
    return commonDirectoryAt(fs, fs.realPath(dotGit));
  }
  const pointer = inspectLinkedWorktreePointer(fs, repositoryRoot);
  if (pointer === undefined) return undefined;
  return commonDirectoryAt(fs, dirname(dirname(pointer.canonicalAdminDirectory)));
}

function underCommonWorktrees(adminDirectory: string, commonDirectory: string): boolean {
  return samePath(dirname(adminDirectory), join(commonDirectory, "worktrees"));
}

function identityFor(pointer: LinkedWorktreePointer, commonDirectory: GitCommonDirectory): string {
  const fields = [
    IDENTITY_SCHEMA,
    pointer.canonicalAdminDirectory,
    commonDirectory.path,
    commonDirectory.identity,
    pointer.worktreeIdentity,
    pointer.pointerIdentity,
    pointer.adminDirectoryIdentity,
    pointer.backpointerIdentity,
  ];
  return createHash("sha256").update(JSON.stringify(fields), "utf8").digest("hex").slice(0, 32);
}

/**
 * Re-proves a real Git linked worktree and returns a body-free identity bound to its stable on-disk
 * directory and pointer descriptors. Any unavailable safe lane, malformed pointer, replacement, or
 * non-reciprocal Git admin directory fails closed.
 */
export function inspectManagedGitdirIdentity(
  worktreePath: string,
  repositoryRoot: string,
  fs: WorkspaceFs = nodeWorkspaceFs,
): ManagedGitdirIdentityInspection | undefined {
  try {
    const commonDirectory = repositoryCommonDirectory(fs, repositoryRoot);
    const pointer =
      commonDirectory === undefined
        ? undefined
        : inspectLinkedWorktreePointer(fs, worktreePath, join(commonDirectory.path, "worktrees"));
    const commonIdentityAfter =
      commonDirectory === undefined ? undefined : directoryIdentity(fs.stat(commonDirectory.path));
    if (
      commonDirectory === undefined ||
      pointer === undefined ||
      commonIdentityAfter !== commonDirectory.identity ||
      !underCommonWorktrees(pointer.canonicalAdminDirectory, commonDirectory.path)
    ) {
      return undefined;
    }
    return { identity: identityFor(pointer, commonDirectory) };
  } catch {
    return undefined;
  }
}
