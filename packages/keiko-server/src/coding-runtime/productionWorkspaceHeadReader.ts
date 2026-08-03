import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const HEAD_BYTES = 4_096;
const PACKED_REFS_BYTES = 1_048_576;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const REF = /^refs\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;

export interface ProductionWorkspaceHeadFileSystem {
  readonly close: (descriptor: number) => void;
  readonly fstat: (descriptor: number) => Stats;
  readonly lstat: (path: string) => Stats;
  readonly open: (path: string) => number;
  readonly read: (
    descriptor: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => number;
  readonly realpath: (path: string) => string;
}

const NODE_FS: ProductionWorkspaceHeadFileSystem = {
  close: closeSync,
  fstat: fstatSync,
  lstat: lstatSync,
  open: (path) => openSync(path, "r"),
  read: readSync,
  realpath: realpathSync,
};

/** Reads a live Git HEAD without a shell or ambient executable lookup. */
export function readProductionWorkspaceHead(
  workspaceRoot: string,
  repositoryRoot: string,
  fileSystem: ProductionWorkspaceHeadFileSystem = NODE_FS,
): string | undefined {
  try {
    const workspace = canonicalDirectory(workspaceRoot, fileSystem);
    const commonRoot = resolveCommonRoot(repositoryRoot, fileSystem);
    const gitDir = resolveGitDir(workspace, commonRoot, fileSystem);
    if (gitDir === undefined) return undefined;
    const head = boundedText(join(gitDir, "HEAD"), HEAD_BYTES, fileSystem)?.trim();
    if (head === undefined) return undefined;
    if (SHA.test(head)) return head;
    const reference = head.startsWith("ref: ") ? head.slice(5) : "";
    return safeRef(reference)
      ? readReference(gitDir, commonRoot, reference, fileSystem)
      : undefined;
  } catch {
    return undefined;
  }
}

function resolveCommonRoot(
  repositoryRoot: string,
  fileSystem: ProductionWorkspaceHeadFileSystem,
): string {
  const repository = canonicalDirectory(repositoryRoot, fileSystem);
  const dotGit = join(repository, ".git");
  const dotGitStat = fileSystem.lstat(dotGit);
  if (dotGitStat.isSymbolicLink()) throw new Error("repository-git-dir-invalid");
  if (dotGitStat.isDirectory()) return canonicalDirectory(dotGit, fileSystem);
  const pointer = parseGitPointer(boundedText(dotGit, HEAD_BYTES, fileSystem));
  if (pointer === undefined) throw new Error("repository-git-dir-invalid");
  return canonicalDirectory(resolve(repository, pointer), fileSystem);
}

function resolveGitDir(
  workspaceRoot: string,
  commonRoot: string,
  fileSystem: ProductionWorkspaceHeadFileSystem,
): string | undefined {
  const dotGit = join(workspaceRoot, ".git");
  const dotGitStat = fileSystem.lstat(dotGit);
  if (dotGitStat.isSymbolicLink()) return undefined;
  if (dotGitStat.isDirectory()) return canonicalDirectory(dotGit, fileSystem);
  const pointer = parseGitPointer(boundedText(dotGit, HEAD_BYTES, fileSystem));
  if (pointer === undefined) return undefined;
  const pointed = resolve(workspaceRoot, pointer);
  const gitDir = canonicalDirectory(pointed, fileSystem);
  return containsCanonicalPath(commonRoot, gitDir) ? gitDir : undefined;
}

function readReference(
  gitDir: string,
  commonRoot: string,
  reference: string,
  fileSystem: ProductionWorkspaceHeadFileSystem,
): string | undefined {
  const commonDir = resolveCommonDir(gitDir, commonRoot, fileSystem);
  return (
    readLooseReference(gitDir, reference, fileSystem) ??
    readLooseReference(commonDir, reference, fileSystem) ??
    readPackedReference(commonDir, reference, fileSystem)
  );
}

function resolveCommonDir(
  gitDir: string,
  commonRoot: string,
  fileSystem: ProductionWorkspaceHeadFileSystem,
): string {
  const pointer = boundedText(join(gitDir, "commondir"), HEAD_BYTES, fileSystem)?.trim();
  if (pointer === undefined || pointer.length === 0) return commonRoot;
  const pointed = resolve(gitDir, pointer);
  const candidate = canonicalDirectory(pointed, fileSystem);
  if (!containsCanonicalPath(commonRoot, candidate)) {
    throw new Error("git-common-dir-invalid");
  }
  return candidate;
}

function readLooseReference(
  root: string,
  reference: string,
  fileSystem: ProductionWorkspaceHeadFileSystem,
): string | undefined {
  try {
    const candidate = resolve(root, reference);
    if (
      !containsCanonicalPath(root, dirname(candidate)) ||
      fileSystem.realpath(candidate) !== candidate
    ) {
      return undefined;
    }
    const value = boundedText(candidate, HEAD_BYTES, fileSystem)?.trim();
    return value !== undefined && SHA.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function containsCanonicalPath(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (!isAbsolute(relation) && relation.split(sep)[0] !== "..");
}

function readPackedReference(
  root: string,
  reference: string,
  fileSystem: ProductionWorkspaceHeadFileSystem,
): string | undefined {
  const packed = boundedText(join(root, "packed-refs"), PACKED_REFS_BYTES, fileSystem);
  if (packed === undefined) return undefined;
  for (const line of packed.split(/\r?\n/u)) {
    if (line.startsWith("#") || line.startsWith("^") || line.length === 0) continue;
    const separator = line.indexOf(" ");
    if (separator < 0 || line.slice(separator + 1) !== reference) continue;
    const value = line.slice(0, separator);
    return SHA.test(value) ? value : undefined;
  }
  return undefined;
}

// eslint-disable-next-line complexity -- Every branch is a fail-closed handle/path identity check.
function boundedText(
  path: string,
  maxBytes: number,
  fileSystem: ProductionWorkspaceHeadFileSystem,
): string | undefined {
  let descriptor: number | undefined;
  try {
    const before = fileSystem.lstat(path);
    if (!qualifiedRegularFile(before, maxBytes)) return undefined;
    descriptor = fileSystem.open(path);
    const opened = fileSystem.fstat(descriptor);
    const pathAfterOpen = fileSystem.lstat(path);
    if (
      !sameQualifiedFile(before, opened, maxBytes) ||
      !sameQualifiedFile(opened, pathAfterOpen, maxBytes)
    ) {
      return undefined;
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    const bytesRead = readBounded(descriptor, buffer, fileSystem);
    const after = fileSystem.fstat(descriptor);
    const pathAfterRead = fileSystem.lstat(path);
    if (
      bytesRead > maxBytes ||
      !stableFile(opened, after) ||
      !sameQualifiedFile(after, pathAfterRead, maxBytes) ||
      bytesRead !== after.size
    ) {
      return undefined;
    }
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try {
        fileSystem.close(descriptor);
      } catch {
        // Closing a raced/invalid descriptor must not make a failed metadata read productive.
      }
    }
  }
}

function readBounded(
  descriptor: number,
  buffer: Buffer,
  fileSystem: ProductionWorkspaceHeadFileSystem,
): number {
  let offset = 0;
  while (offset < buffer.length) {
    const count = fileSystem.read(descriptor, buffer, offset, buffer.length - offset, offset);
    if (count === 0) break;
    offset += count;
  }
  return offset;
}

function qualifiedRegularFile(stat: Stats, maxBytes: number): boolean {
  return !stat.isSymbolicLink() && stat.isFile() && stat.size <= maxBytes;
}

function sameQualifiedFile(left: Stats, right: Stats, maxBytes: number): boolean {
  return qualifiedRegularFile(right, maxBytes) && sameIdentity(left, right);
}

function stableFile(left: Stats, right: Stats): boolean {
  return (
    sameIdentity(left, right) &&
    right.isFile() &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function canonicalDirectory(path: string, fileSystem: ProductionWorkspaceHeadFileSystem): string {
  const before = fileSystem.lstat(path);
  if (before.isSymbolicLink() || !before.isDirectory()) throw new Error("directory-invalid");
  const canonical = fileSystem.realpath(path);
  const pathAfter = fileSystem.lstat(path);
  const canonicalStat = fileSystem.lstat(canonical);
  if (
    pathAfter.isSymbolicLink() ||
    canonicalStat.isSymbolicLink() ||
    !pathAfter.isDirectory() ||
    !canonicalStat.isDirectory() ||
    !sameIdentity(before, pathAfter) ||
    !sameIdentity(pathAfter, canonicalStat)
  ) {
    throw new Error("directory-invalid");
  }
  return canonical;
}

function parseGitPointer(value: string | undefined): string | undefined {
  const pointer = value?.trim();
  if (!pointer?.startsWith("gitdir: ")) return undefined;
  const path = pointer.slice(8);
  return path.length > 0 && !path.includes("\0") ? path : undefined;
}

function safeRef(reference: string): boolean {
  return REF.test(reference) && !reference.includes("..") && !reference.includes("//");
}
