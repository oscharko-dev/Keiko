// The single boundary for reads and enumeration of caller-controlled workspace content
// (ADR-0005 D1). Consumers depend on `WorkspaceFs`, so discovery/detection are testable with an
// in-memory fake and production content reads remain auditable here. Keiko-owned persistence uses
// its own store adapters. The core metadata surface stays synchronous for deterministic fakes.

import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  opendirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  type BigIntStats,
} from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";

export interface WorkspaceStat {
  readonly size: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  readonly hardLinkCount?: number | undefined;
  readonly mtimeMs?: number | undefined;
  readonly ctimeMs?: number | undefined;
  readonly fileIdentity?: string | undefined;
  readonly mtimeNs?: string | undefined;
  readonly ctimeNs?: string | undefined;
  /**
   * Creation time in nanoseconds, where the platform reports one; absent otherwise.
   *
   * `fileIdentity` is a `device:inode` pair, and an inode number is a slot that gets REUSED:
   * deleting a path and recreating it hands the new object the old number (measured 50/50 on Linux
   * ext4/overlayfs). Creation time is what separates the two generations. Unlike `ctimeNs` it also
   * survives an in-place rewrite of the same file, so a caller can tell "this file was replaced"
   * apart from "this file was edited".
   */
  readonly birthtimeNs?: string | undefined;
}

export type WorkspaceDescriptorReadFailureReason =
  "changed" | "hard-link" | "not-regular" | "outside-root" | "symbolic-link" | "too-large";

export class WorkspaceDescriptorReadError extends Error {
  public constructor(
    public readonly reason: WorkspaceDescriptorReadFailureReason,
    public readonly sizeBytes?: number | undefined,
  ) {
    super(`workspace-descriptor-read-${reason}`);
    this.name = "WorkspaceDescriptorReadError";
  }
}

export interface WorkspaceDescriptorUtf8Read {
  readonly rawText: string;
  readonly sizeBytes: number;
  readonly stat: WorkspaceStat;
}

/** The owning read lane must declare whether a stable hard link is within its authority. */
export type WorkspaceHardLinkPolicy = "allow" | "reject";

/** Whether a bounded descriptor read must consume the complete file or may return a prefix. */
export type WorkspaceDescriptorReadCompleteness = "complete" | "prefix";

export interface WorkspaceDirEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
}

export interface WorkspaceFileReader {
  readonly close: () => Promise<void>;
  readonly readRange: (startByte: number, length: number) => Promise<Uint8Array>;
}

export interface WorkspaceFs {
  readonly readFileUtf8: (absolutePath: string) => string;
  // Optional for compatibility with in-memory/test ports. The production Node port always provides
  // it: the bounded bytes and identity checks all use one no-follow descriptor, closing the
  // pathname check/open race at the workspace read boundary.
  readonly readFileUtf8SameDescriptor?: (
    absolutePath: string,
    maxBytes: number,
    hardLinkPolicy: WorkspaceHardLinkPolicy,
    expected: WorkspaceStat,
  ) => WorkspaceDescriptorUtf8Read;
  // Privileged metadata readers use this lane so canonical containment, every parent-directory
  // identity, and the opened file descriptor form one fail-closed operation.
  readonly readFileUtf8WithinRootSameDescriptor?: (
    canonicalRoot: string,
    absolutePath: string,
    maxBytes: number,
    hardLinkPolicy: WorkspaceHardLinkPolicy,
    completeness: WorkspaceDescriptorReadCompleteness,
  ) => WorkspaceDescriptorUtf8Read;
  readonly stat: (absolutePath: string) => WorkspaceStat;
  readonly readDir: (absolutePath: string, maxEntries?: number) => readonly WorkspaceDirEntry[];
  readonly realPath: (absolutePath: string) => string;
  // Optional request-scoped canonical-root resolver. Containment may reuse this value for the
  // comparison base, while target paths must always continue through `realPath` so a replacement
  // cannot hide behind the cached root identity.
  readonly canonicalWorkspaceRoot?: (absoluteRoot: string) => string;
  readonly exists: (absolutePath: string) => boolean;
  // Optional: raw-byte read capped at `maxBytes`. Added in issue #179 for the repo-search
  // facade's binary-detection probe. Optional so existing in-memory test fakes that only
  // implement the synchronous surface keep compiling; callers must handle `undefined`.
  readonly readFileBytes?: (
    absolutePath: string,
    maxBytes: number,
    hardLinkPolicy: WorkspaceHardLinkPolicy,
    expected: WorkspaceStat,
  ) => Promise<Uint8Array>;
  // Optional synchronous bounded UTF-8 prefix read for synchronous indexers. This must never be used
  // before the caller has applied the normal workspace containment and deny gates.
  readonly readFileUtf8Prefix?: (
    absolutePath: string,
    maxBytes: number,
    hardLinkPolicy: WorkspaceHardLinkPolicy,
    expected: WorkspaceStat,
  ) => string;
  // Optional bounded range read over [startByte, startByte + length). Large-document parsers use
  // this instead of materializing the full raw file at the workspace boundary.
  readonly readFileRange?: (
    absolutePath: string,
    startByte: number,
    length: number,
    hardLinkPolicy: WorkspaceHardLinkPolicy,
    expected: WorkspaceStat,
  ) => Promise<Uint8Array>;
  // Optional reusable raw-byte reader. Streaming callers use this when a single response should
  // hold one file descriptor instead of re-opening the file for every bounded range read.
  readonly openFileReader?: (
    absolutePath: string,
    hardLinkPolicy: WorkspaceHardLinkPolicy,
    expected: WorkspaceStat,
  ) => Promise<WorkspaceFileReader>;
}

function forwardedSynchronousReads(fs: WorkspaceFs): Partial<WorkspaceFs> {
  const descriptorRead = fs.readFileUtf8SameDescriptor;
  const containedDescriptorRead = fs.readFileUtf8WithinRootSameDescriptor;
  const prefixRead = fs.readFileUtf8Prefix;
  return {
    ...(descriptorRead === undefined
      ? {}
      : {
          readFileUtf8SameDescriptor: (
            path: string,
            maxBytes: number,
            policy: WorkspaceHardLinkPolicy,
            expected: WorkspaceStat,
          ): WorkspaceDescriptorUtf8Read =>
            descriptorRead.call(fs, path, maxBytes, policy, expected),
        }),
    ...(containedDescriptorRead === undefined
      ? {}
      : {
          readFileUtf8WithinRootSameDescriptor: (
            root: string,
            path: string,
            maxBytes: number,
            policy: WorkspaceHardLinkPolicy,
            completeness: WorkspaceDescriptorReadCompleteness,
          ): WorkspaceDescriptorUtf8Read =>
            containedDescriptorRead.call(fs, root, path, maxBytes, policy, completeness),
        }),
    ...(prefixRead === undefined
      ? {}
      : {
          readFileUtf8Prefix: (
            path: string,
            maxBytes: number,
            policy: WorkspaceHardLinkPolicy,
            expected: WorkspaceStat,
          ): string => prefixRead.call(fs, path, maxBytes, policy, expected),
        }),
  };
}

function forwardedAsynchronousReads(fs: WorkspaceFs): Partial<WorkspaceFs> {
  const byteRead = fs.readFileBytes;
  const rangeRead = fs.readFileRange;
  return {
    ...(byteRead === undefined
      ? {}
      : {
          readFileBytes: (
            path: string,
            maxBytes: number,
            policy: WorkspaceHardLinkPolicy,
            expected: WorkspaceStat,
          ): Promise<Uint8Array> => byteRead.call(fs, path, maxBytes, policy, expected),
        }),
    ...(rangeRead === undefined
      ? {}
      : {
          readFileRange: (
            path: string,
            startByte: number,
            length: number,
            policy: WorkspaceHardLinkPolicy,
            expected: WorkspaceStat,
          ): Promise<Uint8Array> => rangeRead.call(fs, path, startByte, length, policy, expected),
        }),
  };
}

function forwardedOptionalOperations(
  fs: WorkspaceFs,
  canonicalRoot: WorkspaceFs["canonicalWorkspaceRoot"],
): Partial<WorkspaceFs> {
  const openReader = fs.openFileReader;
  return {
    ...(canonicalRoot === undefined
      ? {}
      : {
          canonicalWorkspaceRoot: (root: string): string => canonicalRoot.call(fs, root),
        }),
    ...(openReader === undefined
      ? {}
      : {
          openFileReader: (
            path: string,
            policy: WorkspaceHardLinkPolicy,
            expected: WorkspaceStat,
          ): Promise<WorkspaceFileReader> => openReader.call(fs, path, policy, expected),
        }),
  };
}

/**
 * Builds a plain method-complete port without losing a class/prototype adapter's receiver: every
 * forwarder invokes the method through `fs.<method>(...)`, and that property access already binds
 * `fs` as the receiver, so a prototype adapter's `this` survives the copy.
 */
export function forwardWorkspaceFs(
  fs: WorkspaceFs,
  canonicalRoot: WorkspaceFs["canonicalWorkspaceRoot"] = fs.canonicalWorkspaceRoot,
): WorkspaceFs {
  return {
    readFileUtf8: (path): string => fs.readFileUtf8(path),
    stat: (path): WorkspaceStat => fs.stat(path),
    readDir: (path, maxEntries): readonly WorkspaceDirEntry[] => fs.readDir(path, maxEntries),
    realPath: (path): string => fs.realPath(path),
    exists: (path): boolean => fs.exists(path),
    ...forwardedSynchronousReads(fs),
    ...forwardedAsynchronousReads(fs),
    ...forwardedOptionalOperations(fs, canonicalRoot),
  };
}

function workspaceStat(stats: BigIntStats, isSymbolicLink: boolean): WorkspaceStat {
  return {
    size: Number(stats.size),
    isFile: stats.isFile(),
    isDirectory: stats.isDirectory(),
    isSymbolicLink,
    hardLinkCount: Number(stats.nlink),
    mtimeMs: Number(stats.mtimeNs) / 1_000_000,
    ctimeMs: Number(stats.ctimeNs) / 1_000_000,
    fileIdentity: `${String(stats.dev)}:${String(stats.ino)}`,
    mtimeNs: String(stats.mtimeNs),
    ctimeNs: String(stats.ctimeNs),
    // Reported as 0 where the platform has no creation time — an ext4 volume formatted with 128-byte
    // inodes is one real example — and never legitimately negative; both are surfaced as absent, the
    // same rule workspace-root-identity applies, so a caller sees "unavailable" instead of a constant
    // that compares equal for every object on the volume. Node also documents that a platform may
    // report ctime in place of an unavailable birthtime; that cannot be told apart per stat (a fresh
    // object legitimately has equal ctime and birthtime), which is one reason the managed-root
    // identity built on this field is defence in depth rather than a proof.
    ...(stats.birthtimeNs <= 0n ? {} : { birthtimeNs: String(stats.birthtimeNs) }),
  };
}

function sameWorkspaceStat(left: WorkspaceStat, right: WorkspaceStat): boolean {
  return [
    left.size === right.size,
    left.isFile === right.isFile,
    left.isDirectory === right.isDirectory,
    left.isSymbolicLink === right.isSymbolicLink,
    left.hardLinkCount === right.hardLinkCount,
    left.fileIdentity === right.fileIdentity,
    (left.mtimeNs ?? left.mtimeMs) === (right.mtimeNs ?? right.mtimeMs),
    (left.ctimeNs ?? left.ctimeMs) === (right.ctimeNs ?? right.ctimeMs),
  ].every(Boolean);
}

// Matches a drive-letter path (`C:\` / `C:/`), a UNC path (`\\server\share`), or any other
// path rooted at a bare backslash (`\srv\docs\...`, e.g. a drive-relative-root path a
// WorkspaceFs.realPath() implementation may return on Windows). A POSIX absolute path can
// never start with `\` — it is always `/`-rooted — so matching a leading backslash here
// cannot misclassify a real POSIX path; it only widens detection to cover Windows-style
// absolute paths that lack a drive letter, which the drive-letter/UNC-only pattern missed.
const WINDOWS_ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\)/u;

function normalizedWorkspacePath(path: string): string {
  return process.platform === "win32" || WINDOWS_ABSOLUTE_PATH.test(path)
    ? path.replaceAll("\\", "/")
    : path;
}

/** Revalidates the pathname, canonical identity, and metadata snapshot after a guarded read. */
export function isWorkspacePathSnapshotCurrent(
  fs: WorkspaceFs,
  requestedPath: string,
  canonicalPath: string,
  expected: WorkspaceStat,
): boolean {
  try {
    return (
      normalizedWorkspacePath(fs.realPath(requestedPath)) ===
        normalizedWorkspacePath(canonicalPath) &&
      sameWorkspaceStat(expected, fs.stat(canonicalPath))
    );
  } catch {
    return false;
  }
}

function sameKnownSnapshotValue(left: unknown, right: unknown): boolean {
  return left === undefined || right === undefined || left === right;
}

function expectedDescriptorSnapshotMatches(expected: WorkspaceStat, actual: BigIntStats): boolean {
  const observed = workspaceStat(actual, actual.isSymbolicLink());
  return [
    expected.isFile === observed.isFile,
    expected.isDirectory === observed.isDirectory,
    expected.isSymbolicLink === observed.isSymbolicLink,
    expected.size === observed.size,
    expected.fileIdentity !== undefined,
    expected.fileIdentity === observed.fileIdentity,
    sameKnownSnapshotValue(expected.hardLinkCount, observed.hardLinkCount),
    sameKnownSnapshotValue(
      expected.mtimeNs ?? expected.mtimeMs,
      expected.mtimeNs === undefined ? observed.mtimeMs : observed.mtimeNs,
    ),
    sameKnownSnapshotValue(
      expected.ctimeNs ?? expected.ctimeMs,
      expected.ctimeNs === undefined ? observed.ctimeMs : observed.ctimeNs,
    ),
  ].every(Boolean);
}

function assertExpectedDescriptorSnapshot(expected: WorkspaceStat, actual: BigIntStats): void {
  if (!expectedDescriptorSnapshotMatches(expected, actual)) {
    throw new WorkspaceDescriptorReadError("changed");
  }
}

function sameDescriptorSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

interface DescriptorPathSnapshot {
  readonly path: string;
  readonly stat: BigIntStats;
}

interface DescriptorLineageSnapshot {
  readonly entries: readonly DescriptorPathSnapshot[];
  readonly root: string;
  readonly target: string;
}

function containedLineagePaths(canonicalRoot: string, absolutePath: string): readonly string[] {
  const root = resolve(canonicalRoot);
  const target = resolve(absolutePath);
  const relativePath = relative(root, target);
  if (
    relativePath.length === 0 ||
    isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`)
  ) {
    throw new WorkspaceDescriptorReadError("outside-root");
  }
  const paths = [root];
  let current = root;
  for (const segment of relativePath.split(sep)) {
    current = join(current, segment);
    paths.push(current);
  }
  return paths;
}

function assertLineageEntry(
  stats: BigIntStats,
  isTarget: boolean,
  hardLinkPolicy: WorkspaceHardLinkPolicy,
): void {
  if (stats.isSymbolicLink()) throw new WorkspaceDescriptorReadError("symbolic-link");
  if (isTarget) {
    assertReadableDescriptor(stats, hardLinkPolicy);
  } else if (!stats.isDirectory()) {
    throw new WorkspaceDescriptorReadError("not-regular");
  }
}

function captureDescriptorLineage(
  canonicalRoot: string,
  absolutePath: string,
  hardLinkPolicy: WorkspaceHardLinkPolicy,
): DescriptorLineageSnapshot {
  const paths = containedLineagePaths(canonicalRoot, absolutePath);
  const entries = paths.map((path, index): DescriptorPathSnapshot => {
    const stat = lstatSync(path, { bigint: true, throwIfNoEntry: true });
    assertLineageEntry(stat, index === paths.length - 1, hardLinkPolicy);
    return { path, stat };
  });
  return { entries, root: paths[0] ?? canonicalRoot, target: paths.at(-1) ?? absolutePath };
}

function sameDescriptorLineage(
  reference: DescriptorLineageSnapshot,
  candidate: DescriptorLineageSnapshot,
): boolean {
  return (
    reference.root === candidate.root &&
    reference.target === candidate.target &&
    reference.entries.length === candidate.entries.length &&
    reference.entries.every((entry, index) => {
      const other = candidate.entries[index];
      if (other === undefined) return false;
      return entry.path === other.path && sameDescriptorSnapshot(entry.stat, other.stat);
    })
  );
}

function assertCanonicalDescriptorLineage(lineage: DescriptorLineageSnapshot): void {
  if (
    realpathSync.native(lineage.root) !== lineage.root ||
    realpathSync.native(lineage.target) !== lineage.target
  ) {
    throw new WorkspaceDescriptorReadError("changed");
  }
}

function authorizeDescriptorLineage(
  canonicalRoot: string,
  absolutePath: string,
  hardLinkPolicy: WorkspaceHardLinkPolicy,
): DescriptorLineageSnapshot {
  const before = captureDescriptorLineage(canonicalRoot, absolutePath, hardLinkPolicy);
  assertCanonicalDescriptorLineage(before);
  const after = captureDescriptorLineage(canonicalRoot, absolutePath, hardLinkPolicy);
  if (!sameDescriptorLineage(before, after)) throw new WorkspaceDescriptorReadError("changed");
  return after;
}

function boundedReadCap(maxBytes: number): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("workspace descriptor read cap must be a non-negative safe integer");
  }
  return maxBytes;
}

function readDescriptorBytes(fd: number, byteCount: number): Buffer {
  const buffer = Buffer.allocUnsafe(byteCount);
  let total = 0;
  while (total < buffer.length) {
    const bytesRead = readSync(fd, buffer, total, buffer.length - total, null);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return buffer.subarray(0, total);
}

function assertReadableDescriptor(
  stats: BigIntStats,
  hardLinkPolicy: WorkspaceHardLinkPolicy,
): void {
  if (!stats.isFile()) throw new WorkspaceDescriptorReadError("not-regular");
  if (hardLinkPolicy === "reject" && stats.nlink > 1n) {
    throw new WorkspaceDescriptorReadError("hard-link");
  }
}

interface DescriptorByteRead {
  readonly bytes: Buffer;
  readonly stat: WorkspaceStat;
}

interface ValidatedFileDescriptor {
  readonly handle: FileHandle;
  readonly hardLinkPolicy: WorkspaceHardLinkPolicy;
  readonly snapshot: BigIntStats;
}

function descriptorReadLength(size: bigint, cap: number): number {
  return size > BigInt(cap) ? cap : Number(size);
}

function isSymbolicLinkLoop(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ELOOP"
  );
}

function openNoFollow(absolutePath: string): number {
  try {
    return openSync(absolutePath, noFollowReadFlags());
  } catch (error) {
    if (isSymbolicLinkLoop(error)) {
      throw new WorkspaceDescriptorReadError("symbolic-link");
    }
    throw error;
  }
}

function noFollowReadFlags(): number {
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  const nonBlocking = process.platform === "win32" ? 0 : fsConstants.O_NONBLOCK;
  return fsConstants.O_RDONLY | noFollow | nonBlocking;
}

async function openNoFollowAsync(absolutePath: string): Promise<FileHandle> {
  try {
    return await open(absolutePath, noFollowReadFlags());
  } catch (error) {
    if (isSymbolicLinkLoop(error)) throw new WorkspaceDescriptorReadError("symbolic-link");
    throw error;
  }
}

async function readDescriptorBytesAsync(handle: FileHandle, byteCount: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(byteCount);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return buffer.subarray(0, total);
}

function readFileBytesSameDescriptor(
  absolutePath: string,
  maxBytes: number,
  requireComplete: boolean,
  hardLinkPolicy: WorkspaceHardLinkPolicy,
  expected: WorkspaceStat,
): DescriptorByteRead {
  const pathBefore = lstatSync(absolutePath, { bigint: true, throwIfNoEntry: true });
  if (pathBefore.isSymbolicLink()) throw new WorkspaceDescriptorReadError("symbolic-link");
  assertReadableDescriptor(pathBefore, hardLinkPolicy);
  assertExpectedDescriptorSnapshot(expected, pathBefore);
  return readFileBytesFromExpectedDescriptor(
    absolutePath,
    maxBytes,
    requireComplete,
    hardLinkPolicy,
    pathBefore,
  );
}

function readFileBytesFromExpectedDescriptor(
  absolutePath: string,
  maxBytes: number,
  requireComplete: boolean,
  hardLinkPolicy: WorkspaceHardLinkPolicy,
  pathBefore: BigIntStats,
  assertLineageAfter?: () => void,
): DescriptorByteRead {
  const cap = boundedReadCap(maxBytes);
  const fd = openNoFollow(absolutePath);
  try {
    const before = fstatSync(fd, { bigint: true });
    assertReadableDescriptor(before, hardLinkPolicy);
    if (!sameDescriptorSnapshot(pathBefore, before)) {
      throw new WorkspaceDescriptorReadError("changed");
    }
    if (requireComplete && before.size > BigInt(cap)) {
      throw new WorkspaceDescriptorReadError("too-large", Number(before.size));
    }
    const expectedBytes = descriptorReadLength(before.size, cap);
    const bytes = readDescriptorBytes(fd, expectedBytes);
    const after = fstatSync(fd, { bigint: true });
    const pathAfter = lstatSync(absolutePath, { bigint: true, throwIfNoEntry: true });
    assertReadableDescriptor(after, hardLinkPolicy);
    assertReadableDescriptor(pathAfter, hardLinkPolicy);
    if (
      bytes.length !== expectedBytes ||
      !sameDescriptorSnapshot(before, after) ||
      !sameDescriptorSnapshot(after, pathAfter)
    ) {
      throw new WorkspaceDescriptorReadError("changed");
    }
    assertLineageAfter?.();
    return { bytes, stat: workspaceStat(after, false) };
  } finally {
    closeSync(fd);
  }
}

function readFileUtf8WithinRootSameDescriptor(
  canonicalRoot: string,
  absolutePath: string,
  maxBytes: number,
  hardLinkPolicy: WorkspaceHardLinkPolicy,
  completeness: WorkspaceDescriptorReadCompleteness,
): WorkspaceDescriptorUtf8Read {
  const lineage = authorizeDescriptorLineage(canonicalRoot, absolutePath, hardLinkPolicy);
  const target = lineage.entries.at(-1);
  if (target === undefined) throw new WorkspaceDescriptorReadError("outside-root");
  const read = readFileBytesFromExpectedDescriptor(
    lineage.target,
    maxBytes,
    completeness === "complete",
    hardLinkPolicy,
    target.stat,
    (): void => {
      const after = captureDescriptorLineage(canonicalRoot, absolutePath, hardLinkPolicy);
      if (!sameDescriptorLineage(lineage, after)) {
        throw new WorkspaceDescriptorReadError("changed");
      }
    },
  );
  return { rawText: read.bytes.toString("utf8"), sizeBytes: read.bytes.length, stat: read.stat };
}

async function readFileBytesSameDescriptorAsync(
  absolutePath: string,
  maxBytes: number,
  hardLinkPolicy: WorkspaceHardLinkPolicy,
  expected: WorkspaceStat,
): Promise<DescriptorByteRead> {
  const cap = boundedReadCap(maxBytes);
  const descriptor = await openValidatedFileDescriptor(absolutePath, hardLinkPolicy, expected);
  try {
    const expectedBytes = descriptorReadLength(descriptor.snapshot.size, cap);
    const bytes = await readDescriptorBytesAsync(descriptor.handle, expectedBytes);
    const after = await assertCurrentFileDescriptor(absolutePath, descriptor);
    if (bytes.length !== expectedBytes) throw new WorkspaceDescriptorReadError("changed");
    return { bytes, stat: workspaceStat(after, false) };
  } finally {
    await descriptor.handle.close();
  }
}

async function openValidatedFileDescriptor(
  absolutePath: string,
  hardLinkPolicy: WorkspaceHardLinkPolicy,
  expected: WorkspaceStat,
): Promise<ValidatedFileDescriptor> {
  const pathBefore = await lstat(absolutePath, { bigint: true });
  if (pathBefore.isSymbolicLink()) throw new WorkspaceDescriptorReadError("symbolic-link");
  assertReadableDescriptor(pathBefore, hardLinkPolicy);
  assertExpectedDescriptorSnapshot(expected, pathBefore);
  const handle = await openNoFollowAsync(absolutePath);
  try {
    const before = await handle.stat({ bigint: true });
    assertReadableDescriptor(before, hardLinkPolicy);
    if (!sameDescriptorSnapshot(pathBefore, before)) {
      throw new WorkspaceDescriptorReadError("changed");
    }
    return { handle, hardLinkPolicy, snapshot: before };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function currentPathSnapshot(absolutePath: string): Promise<BigIntStats> {
  try {
    return await lstat(absolutePath, { bigint: true });
  } catch {
    throw new WorkspaceDescriptorReadError("changed");
  }
}

async function assertCurrentFileDescriptor(
  absolutePath: string,
  descriptor: ValidatedFileDescriptor,
): Promise<BigIntStats> {
  const currentDescriptor = await descriptor.handle.stat({ bigint: true });
  const currentPath = await currentPathSnapshot(absolutePath);
  assertReadableDescriptor(currentDescriptor, descriptor.hardLinkPolicy);
  if (
    !sameDescriptorSnapshot(descriptor.snapshot, currentDescriptor) ||
    !sameDescriptorSnapshot(currentDescriptor, currentPath)
  ) {
    throw new WorkspaceDescriptorReadError("changed");
  }
  assertReadableDescriptor(currentPath, descriptor.hardLinkPolicy);
  return currentDescriptor;
}

function normalizedRangeValue(value: number): number {
  return Math.max(0, Math.floor(value));
}

async function readValidatedRange(
  absolutePath: string,
  descriptor: ValidatedFileDescriptor,
  startByte: number,
  length: number,
): Promise<Uint8Array> {
  await assertCurrentFileDescriptor(absolutePath, descriptor);
  const offset = normalizedRangeValue(startByte);
  const cap = normalizedRangeValue(length);
  const buffer = new Uint8Array(cap);
  if (cap === 0) return buffer;
  const { bytesRead } = await descriptor.handle.read(buffer, 0, cap, offset);
  await assertCurrentFileDescriptor(absolutePath, descriptor);
  return buffer.subarray(0, bytesRead);
}

async function readFileRangeSameDescriptor(
  absolutePath: string,
  startByte: number,
  length: number,
  hardLinkPolicy: WorkspaceHardLinkPolicy,
  expected: WorkspaceStat,
): Promise<Uint8Array> {
  const descriptor = await openValidatedFileDescriptor(absolutePath, hardLinkPolicy, expected);
  try {
    return await readValidatedRange(absolutePath, descriptor, startByte, length);
  } finally {
    await descriptor.handle.close();
  }
}

async function openValidatedFileReader(
  absolutePath: string,
  hardLinkPolicy: WorkspaceHardLinkPolicy,
  expected: WorkspaceStat,
): Promise<WorkspaceFileReader> {
  const descriptor = await openValidatedFileDescriptor(absolutePath, hardLinkPolicy, expected);
  let closed = false;
  return {
    readRange: (startByte: number, length: number): Promise<Uint8Array> =>
      readValidatedRange(absolutePath, descriptor, startByte, length),
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await descriptor.handle.close();
    },
  };
}

function readFileUtf8SameDescriptor(
  absolutePath: string,
  maxBytes: number,
  hardLinkPolicy: WorkspaceHardLinkPolicy,
  expected: WorkspaceStat,
): WorkspaceDescriptorUtf8Read {
  const read = readFileBytesSameDescriptor(absolutePath, maxBytes, true, hardLinkPolicy, expected);
  return { rawText: read.bytes.toString("utf8"), sizeBytes: read.bytes.length, stat: read.stat };
}

function assertDirectorySnapshot(reference: BigIntStats, candidate: BigIntStats): void {
  if (!candidate.isDirectory() || !sameDescriptorSnapshot(reference, candidate)) {
    throw new WorkspaceDescriptorReadError("changed");
  }
}

function collectDirectoryEntries(
  absolutePath: string,
  cap: number | undefined,
): readonly WorkspaceDirEntry[] {
  if (cap !== undefined) {
    const entries: WorkspaceDirEntry[] = [];
    const directory = opendirSync(absolutePath);
    try {
      while (entries.length < cap) {
        const entry = directory.readSync();
        if (entry === null) break;
        entries.push({
          name: entry.name,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
          isSymbolicLink: entry.isSymbolicLink(),
        });
      }
    } finally {
      directory.closeSync();
    }
    return entries;
  }
  const entries = readdirSync(absolutePath, { withFileTypes: true })
    .map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
      isSymbolicLink: entry.isSymbolicLink(),
    }))
    // The shared code-unit comparator (issue #2723), not `localeCompare`: enumeration order must
    // stay locale-independent so a directory fingerprint is identical on every machine.
    .sort((left, right) => compareStrings(left.name, right.name));
  return entries;
}

function readDirectoryEntries(
  absolutePath: string,
  maxEntries?: number,
): readonly WorkspaceDirEntry[] {
  const cap = maxEntries === undefined ? undefined : boundedReadCap(maxEntries);
  const pathBefore = lstatSync(absolutePath, { bigint: true, throwIfNoEntry: true });
  if (pathBefore.isSymbolicLink()) throw new WorkspaceDescriptorReadError("symbolic-link");
  if (!pathBefore.isDirectory()) throw new WorkspaceDescriptorReadError("not-regular");
  // Node has no supported cross-platform synchronous API for enumerating an already-open
  // directory descriptor. Capped callers request one sentinel entry and treat overflow as
  // incomplete rather than accepting an arbitrary filesystem-order subset; uncapped candidate
  // discovery enumerates and sorts the complete directory. Detect persistent pathname replacement
  // around either single enumeration.
  const beforeRead = lstatSync(absolutePath, { bigint: true, throwIfNoEntry: true });
  assertDirectorySnapshot(pathBefore, beforeRead);
  const entries = collectDirectoryEntries(absolutePath, cap);
  const pathAfter = lstatSync(absolutePath, { bigint: true, throwIfNoEntry: true });
  assertDirectorySnapshot(pathBefore, pathAfter);
  return entries;
}

export const nodeWorkspaceFs: WorkspaceFs = {
  readFileUtf8: (absolutePath: string): string => readFileSync(absolutePath, "utf8"),
  readFileUtf8SameDescriptor,
  readFileUtf8WithinRootSameDescriptor,
  stat: (absolutePath: string): WorkspaceStat => {
    const stats = lstatSync(absolutePath, { bigint: true, throwIfNoEntry: true });
    return workspaceStat(stats, stats.isSymbolicLink());
  },
  readDir: (absolutePath: string, maxEntries?: number): readonly WorkspaceDirEntry[] =>
    readDirectoryEntries(absolutePath, maxEntries),
  // Use the native implementation as the single canonical-identity source. On
  // case-insensitive filesystems it returns the on-disk spelling, so callers do not need a
  // second, independently mutable realpath pass merely to stabilize casing.
  realPath: (absolutePath: string): string => realpathSync.native(absolutePath),
  exists: (absolutePath: string): boolean => {
    try {
      return lstatSync(absolutePath, { throwIfNoEntry: false }) !== undefined;
    } catch {
      return false;
    }
  },
  readFileBytes: async (
    absolutePath: string,
    maxBytes: number,
    hardLinkPolicy: WorkspaceHardLinkPolicy,
    expected: WorkspaceStat,
  ): Promise<Uint8Array> =>
    Uint8Array.from(
      (await readFileBytesSameDescriptorAsync(absolutePath, maxBytes, hardLinkPolicy, expected))
        .bytes,
    ),
  readFileUtf8Prefix: (
    absolutePath: string,
    maxBytes: number,
    hardLinkPolicy: WorkspaceHardLinkPolicy,
    expected: WorkspaceStat,
  ): string => {
    const read = readFileBytesSameDescriptor(
      absolutePath,
      boundedReadCap(maxBytes),
      false,
      hardLinkPolicy,
      expected,
    );
    return read.bytes.toString("utf8").replace(/\uFFFD$/u, "");
  },
  readFileRange: async (
    absolutePath: string,
    startByte: number,
    length: number,
    hardLinkPolicy: WorkspaceHardLinkPolicy,
    expected: WorkspaceStat,
  ): Promise<Uint8Array> =>
    readFileRangeSameDescriptor(absolutePath, startByte, length, hardLinkPolicy, expected),
  openFileReader: openValidatedFileReader,
};

// ─── creation-time durability ───────────────────────────────────────────────────────────────────
//
// A nonzero `birthtimeNs` is not proof that the filesystem keeps a creation time. Node documents that
// where creation time is unavailable the field may hold the ctime instead (libuv's non-statx stat
// fallback copies it), and a ctime-backed "creation time" mutates on every directory-entry write —
// an identity minted from it would then read as a replaced worktree after the first ordinary change
// (#3376 review). The probe below settles the question per directory with one metadata write: on an
// aliasing filesystem the parent's birthtime follows its ctime, on a durable one it stays put.
export type CreationTimeSupport = "durable" | "aliased" | "absent" | "inconclusive";

export interface CreationTimeObservation {
  readonly birthtimeNs: bigint;
  readonly ctimeNs: bigint;
}

/**
 * Pure classification of two observations of one directory, taken before and after an entry was
 * created inside it (which moves the directory's ctime):
 *   absent       — no creation time at all (epoch or negative), before or after.
 *   durable      — the creation time stayed exactly while the ctime moved: a real, kept creation time.
 *   aliased      — the "creation time" moved across the metadata write: whatever it tracks, it is
 *                  not a creation time (the ctime under another name, or something equally unstable).
 *   inconclusive — the ctime did not move (the directory was created within the same timestamp
 *                  granule as the probe), so the two cannot be told apart yet.
 */
export function classifyCreationTimeProbe(
  before: CreationTimeObservation,
  after: CreationTimeObservation,
): CreationTimeSupport {
  if (before.birthtimeNs <= 0n || after.birthtimeNs <= 0n) return "absent";
  if (after.ctimeNs === before.ctimeNs) return "inconclusive";
  return after.birthtimeNs === before.birthtimeNs ? "durable" : "aliased";
}

interface CreationTimeWitness extends CreationTimeObservation {
  readonly dev: bigint;
}

function observeCreationTime(directory: string): CreationTimeWitness {
  const stats = lstatSync(directory, { bigint: true });
  return { birthtimeNs: stats.birthtimeNs, ctimeNs: stats.ctimeNs, dev: stats.dev };
}

/**
 * Settles a same-granule probe from an OLDER entry on the same volume. On an aliasing filesystem every
 * entry reports birthtime === ctime, so one entry whose creation time differs from its ctime disproves
 * aliasing for that volume; the directory's parent is that entry whenever it shares the device —
 * creating the directory inside it moved the parent's ctime while the parent's creation time stayed.
 * A parent on another device, without a creation time, or itself same-granule settles nothing, and
 * the caller fails closed on `inconclusive` (#3376 review).
 */
export function corroborateCreationTimeSupport(
  child: { readonly dev: bigint },
  parent: CreationTimeObservation & { readonly dev: bigint },
): CreationTimeSupport {
  if (parent.dev !== child.dev || parent.birthtimeNs <= 0n) return "inconclusive";
  return parent.birthtimeNs !== parent.ctimeNs ? "durable" : "inconclusive";
}

/**
 * Probes whether `directory` sits on a filesystem that keeps a durable creation time, by creating
 * and removing one empty probe directory inside it. Only call it on a directory Keiko owns.
 */
export function probeCreationTimeSupport(directory: string): CreationTimeSupport {
  const before = observeCreationTime(directory);
  const probe = mkdtempSync(join(directory, ".keiko-creation-time-probe-"));
  let verdict: CreationTimeSupport;
  try {
    verdict = classifyCreationTimeProbe(before, observeCreationTime(directory));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
  if (verdict !== "inconclusive") return verdict;
  const parent = dirname(directory);
  if (parent === directory) return verdict;
  return corroborateCreationTimeSupport(before, observeCreationTime(parent));
}

// ─── every volume an identity hashes ────────────────────────────────────────────────────────────
//
// A managed worktree identity binds creation times on TWO volumes: the worktree root and its `.git`
// pointer under the managed root, and the repository's common and admin directories with the
// backpointer under the repository. Proving the managed root alone would mint from a repository
// volume that aliases its "creation time" to the ctime (#3376 review). The repository volume is a
// user's data: nothing is written into it, so it is corroborated read-only from entries that are
// older than one timestamp granule — the repository root and its `.git` — with the same rule the
// parent corroboration uses: on an aliasing volume every entry reports birthtime === ctime, so one
// entry whose creation time differs from its ctime disproves aliasing for the volume.
export type RepositoryCreationTimeSupport = CreationTimeSupport | "same-volume";

export interface ProvenCreationTimeSupport {
  readonly managedRoot: CreationTimeSupport;
  readonly repository: RepositoryCreationTimeSupport;
}

/** Pure: the volume verdict from read-only observations of long-lived entries on it. */
export function classifyVolumeCorroboration(
  entries: readonly CreationTimeObservation[],
): CreationTimeSupport {
  if (entries.some((entry) => entry.birthtimeNs <= 0n)) return "absent";
  return entries.some((entry) => entry.birthtimeNs !== entry.ctimeNs) ? "durable" : "inconclusive";
}

function repositoryCommonDirectory(repositoryRoot: string): string {
  const candidate = join(repositoryRoot, ".git");
  return existsSync(candidate) ? candidate : repositoryRoot;
}

/**
 * Proves every volume a managed identity would hash: the managed root by probe (Keiko owns it), the
 * repository read-only, or `same-volume` when both share one device and the probe already covers it.
 * Anything but `durable` / `same-volume` must refuse to mint.
 */
export function proveCreationTimeSupport(
  managedRoot: string,
  repositoryRoot: string,
): ProvenCreationTimeSupport {
  const managed = probeCreationTimeSupport(managedRoot);
  const common = repositoryCommonDirectory(repositoryRoot);
  const commonStats = observeCreationTime(common);
  if (commonStats.dev === observeCreationTime(managedRoot).dev) {
    return { managedRoot: managed, repository: "same-volume" };
  }
  const entries = [
    commonStats,
    ...(common === repositoryRoot ? [] : [observeCreationTime(repositoryRoot)]),
  ];
  return { managedRoot: managed, repository: classifyVolumeCorroboration(entries) };
}
