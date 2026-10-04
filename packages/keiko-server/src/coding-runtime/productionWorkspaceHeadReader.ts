import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

const HEAD_BYTES = 4_096;
const PACKED_REFS_BYTES = 1_048_576;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const INVALID_REF_CHARACTER = /[~^:?*[\\]/u;

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
    return readProductionWorkspaceGitState(workspaceRoot, repositoryRoot, fileSystem)?.head;
  } catch {
    return undefined;
  }
}

export interface ProductionWorkspaceGitState {
  readonly head: string;
  readonly branch: string | undefined;
  readonly gitDir: string;
}

/** Shares the same bounded, handle-verified Git reads with Local binding validation. */
export function readProductionWorkspaceGitState(
  workspaceRoot: string,
  repositoryRoot: string,
  fileSystem: ProductionWorkspaceHeadFileSystem = NODE_FS,
): ProductionWorkspaceGitState | undefined {
  const workspace = canonicalDirectory(workspaceRoot, fileSystem);
  const commonRoot = resolveCommonRoot(repositoryRoot, fileSystem);
  const gitDir = resolveGitDir(workspace, commonRoot, fileSystem);
  if (gitDir === undefined) return undefined;
  const head = boundedText(join(gitDir, "HEAD"), HEAD_BYTES, fileSystem)?.trim();
  if (head === undefined) return undefined;
  if (SHA.test(head)) return { head, branch: undefined, gitDir };
  const reference = head.startsWith("ref: ") ? head.slice(5) : "";
  const resolved = safeRef(reference)
    ? readReference(gitDir, commonRoot, reference, fileSystem)
    : undefined;
  return resolved === undefined
    ? undefined
    : { head: resolved, branch: localBranch(reference), gitDir };
}

function localBranch(reference: string): string | undefined {
  return reference.startsWith("refs/heads/") ? reference.slice("refs/heads/".length) : undefined;
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
  const gitDir = canonicalDirectory(resolve(repository, pointer), fileSystem);
  const commonPointer = boundedText(join(gitDir, "commondir"), HEAD_BYTES, fileSystem)?.trim();
  if (commonPointer === undefined) return gitDir;
  const commonDir = canonicalDirectory(resolve(gitDir, commonPointer), fileSystem);
  if (
    !containsCanonicalPath(join(commonDir, "worktrees"), gitDir) ||
    !commonDir.endsWith(`${sep}.git`)
  ) {
    throw new Error("repository-git-dir-invalid");
  }
  return commonDir;
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
      !hasNoSymbolicLinkComponents(candidate, fileSystem)
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
  // On Windows, lstat can report dev=0 while fstat on the opened handle reports the NTFS volume
  // serial. The stable file ID is still `ino`; compare device IDs whenever both APIs provide one.
  return left.ino === right.ino && (left.dev === right.dev || left.dev === 0 || right.dev === 0);
}

function canonicalDirectory(path: string, fileSystem: ProductionWorkspaceHeadFileSystem): string {
  if (!hasNoSymbolicLinkComponents(path, fileSystem)) throw new Error("directory-invalid");
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

function hasNoSymbolicLinkComponents(
  path: string,
  fileSystem: ProductionWorkspaceHeadFileSystem,
): boolean {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  try {
    for (const segment of relative(root, absolute).split(sep).filter(Boolean)) {
      current = join(current, segment);
      if (fileSystem.lstat(current).isSymbolicLink()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function parseGitPointer(value: string | undefined): string | undefined {
  const pointer = value?.trim();
  if (!pointer?.startsWith("gitdir: ")) return undefined;
  const path = pointer.slice(8);
  return path.length > 0 && !path.includes("\0") ? path : undefined;
}

function hasControlOrSpace(reference: string): boolean {
  for (const character of reference) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

function safeRef(reference: string): boolean {
  if (
    !reference.startsWith("refs/") ||
    INVALID_REF_CHARACTER.test(reference) ||
    hasControlOrSpace(reference)
  )
    return false;
  if (reference.includes("..") || reference.includes("@{") || reference.endsWith(".")) return false;
  return reference
    .split("/")
    .every(
      (component) =>
        component.length > 0 && !component.startsWith(".") && !component.endsWith(".lock"),
    );
}
