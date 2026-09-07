import { createHash } from "node:crypto";
import { constants, type BigIntStats, type Dirent, type Stats } from "node:fs";
import { lstat, open, opendir, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

const MAX_TREE_ENTRIES = 60_000;
const MAX_TREE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TREE_PATH_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const BUFFER_BYTES = 64 * 1024;

export const PORTABLE_HANDOFF_TREE_HASH_SCHEMA = "KHT1";

export interface PortableHandoffOperationOptions {
  readonly signal?: AbortSignal | undefined;
  readonly deadline: number;
  readonly now?: (() => number) | undefined;
  readonly yieldControl?: (() => Promise<void>) | undefined;
}

export interface PortableHandoffOperation {
  readonly signal: AbortSignal | undefined;
  readonly deadline: number;
  readonly now: () => number;
  readonly yieldControl: () => Promise<void>;
}

export class PortableHandoffBuilderError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PortableHandoffBuilderError";
  }
}

function fail(message: string): never {
  throw new PortableHandoffBuilderError(message);
}

function defaultYieldControl(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

export function portableHandoffOperationFrom(
  options: PortableHandoffOperationOptions,
): PortableHandoffOperation {
  if (!Number.isSafeInteger(options.deadline) || options.deadline < 1) {
    fail("portable handoff operation deadline is invalid");
  }
  return {
    signal: options.signal,
    deadline: options.deadline,
    now: options.now ?? Date.now,
    yieldControl: options.yieldControl ?? defaultYieldControl,
  };
}

export function assertPortableHandoffOperation(operation: PortableHandoffOperation): void {
  if (operation.signal?.aborted === true) fail("portable handoff preparation was cancelled");
  if (operation.now() > operation.deadline) fail("portable handoff preparation timed out");
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function assertOpenedFile(before: Stats, opened: Stats): void {
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    !opened.isFile() ||
    opened.nlink !== 1 ||
    before.dev !== opened.dev ||
    before.ino !== opened.ino ||
    opened.size > MAX_FILE_BYTES
  ) {
    fail("portable handoff artifact is unsafe");
  }
}

async function readFileDigest(
  handle: FileHandle,
  expectedSize: number,
  operation: PortableHandoffOperation,
): Promise<{ readonly bytes: number; readonly digest: Buffer }> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(BUFFER_BYTES);
  let bytes = 0;
  let reads = 0;
  for (;;) {
    assertPortableHandoffOperation(operation);
    const result = await handle.read(buffer, 0, buffer.length, null);
    if (result.bytesRead === 0) return { bytes, digest: hash.digest() };
    bytes += result.bytesRead;
    if (bytes > expectedSize || bytes > MAX_FILE_BYTES) fail("portable handoff artifact changed");
    hash.update(buffer.subarray(0, result.bytesRead));
    reads += 1;
    if (reads % 64 === 0) await operation.yieldControl();
  }
}

function assertStableFile(opened: Stats, after: Stats, current: Stats, bytes: number): void {
  if (
    bytes !== opened.size ||
    !sameFileIdentity(after, opened) ||
    current.dev !== opened.dev ||
    current.ino !== opened.ino
  ) {
    fail("portable handoff artifact changed");
  }
}

export async function digestPortableHandoffFile(
  path: string,
  operation: PortableHandoffOperation,
): Promise<Buffer> {
  assertPortableHandoffOperation(operation);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await lstat(path);
    const opened = await handle.stat();
    assertOpenedFile(before, opened);
    const result = await readFileDigest(handle, opened.size, operation);
    assertStableFile(opened, await handle.stat(), await lstat(path), result.bytes);
    return result.digest;
  } finally {
    await handle.close();
  }
}

interface TreeBudget {
  entries: number;
  pathBytes: number;
}

interface TreeEntrySnapshot {
  readonly name: string;
  readonly stat: BigIntStats;
}

interface TreeSnapshot {
  readonly directories: readonly TreeEntrySnapshot[];
  readonly files: readonly TreeEntrySnapshot[];
}

function recordTreeEntry(budget: TreeBudget, name: string): void {
  budget.entries += 1;
  budget.pathBytes += Buffer.byteLength(name, "utf8");
  if (budget.entries > MAX_TREE_ENTRIES) fail("portable handoff tree has too many entries");
  if (budget.pathBytes > MAX_TREE_PATH_BYTES) fail("portable handoff tree paths are too large");
}

function treeEntryKind(entry: Dirent, stat: BigIntStats): "directory" | "file" {
  if (entry.isDirectory() && stat.isDirectory() && !stat.isSymbolicLink()) return "directory";
  if (entry.isFile() && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n) return "file";
  fail("portable handoff tree contains an unsupported entry");
}

async function snapshotTree(
  root: string,
  operation: PortableHandoffOperation,
): Promise<TreeSnapshot> {
  assertPortableHandoffOperation(operation);
  const rootStat = await lstat(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail("portable handoff tree root is unsafe");
  }
  const files: TreeEntrySnapshot[] = [];
  const directorySnapshots: TreeEntrySnapshot[] = [{ name: "", stat: rootStat }];
  const directories = [""];
  const budget: TreeBudget = { entries: 0, pathBytes: 0 };
  while (directories.length > 0) {
    assertPortableHandoffOperation(operation);
    const relativeDirectory = directories.pop();
    if (relativeDirectory === undefined) break;
    const directory = await opendir(
      relativeDirectory === "" ? root : join(root, ...relativeDirectory.split("/")),
    );
    for await (const entry of directory) {
      assertPortableHandoffOperation(operation);
      const name = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      recordTreeEntry(budget, name);
      const path = join(root, ...name.split("/"));
      const stat = await lstat(path, { bigint: true });
      if (treeEntryKind(entry, stat) === "directory") {
        directories.push(name);
        directorySnapshots.push({ name, stat });
      } else {
        files.push({ name, stat });
      }
      if (budget.entries % 256 === 0) await operation.yieldControl();
    }
  }
  return { directories: directorySnapshots, files };
}

function comparePortablePaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sortTreeEntries(entries: readonly TreeEntrySnapshot[]): readonly TreeEntrySnapshot[] {
  return [...entries].sort((left, right) => comparePortablePaths(left.name, right.name));
}

async function portableTreeSnapshot(
  root: string,
  operation: PortableHandoffOperation,
): Promise<TreeSnapshot> {
  const snapshot = await snapshotTree(root, operation);
  return {
    directories: sortTreeEntries(snapshot.directories),
    files: sortTreeEntries(snapshot.files),
  };
}

function sameTreeEntry(left: TreeEntrySnapshot, right: TreeEntrySnapshot): boolean {
  return (
    left.name === right.name &&
    left.stat.dev === right.stat.dev &&
    left.stat.ino === right.stat.ino &&
    left.stat.mode === right.stat.mode &&
    left.stat.nlink === right.stat.nlink &&
    left.stat.size === right.stat.size &&
    left.stat.mtimeNs === right.stat.mtimeNs &&
    left.stat.ctimeNs === right.stat.ctimeNs &&
    left.stat.birthtimeNs === right.stat.birthtimeNs
  );
}

function sameTreeEntries(
  left: readonly TreeEntrySnapshot[],
  right: readonly TreeEntrySnapshot[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const current = right[index];
      return current !== undefined && sameTreeEntry(entry, current);
    })
  );
}

function assertSameTreeSnapshot(before: TreeSnapshot, after: TreeSnapshot): void {
  if (
    !sameTreeEntries(before.directories, after.directories) ||
    !sameTreeEntries(before.files, after.files)
  ) {
    fail("portable handoff tree changed during attestation");
  }
}

function uint32(value: number): Buffer {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

export async function hashPortableHandoffTree(
  root: string,
  options: PortableHandoffOperationOptions,
): Promise<string> {
  const operation = portableHandoffOperationFrom(options);
  const snapshot = await portableTreeSnapshot(root, operation);
  const hash = createHash("sha256");
  hash.update(PORTABLE_HANDOFF_TREE_HASH_SCHEMA, "ascii");
  hash.update(uint32(snapshot.files.length));
  let totalBytes = 0n;
  for (const file of snapshot.files) {
    assertPortableHandoffOperation(operation);
    const path = join(root, ...file.name.split("/"));
    totalBytes += (await lstat(path, { bigint: true })).size;
    if (totalBytes > BigInt(MAX_TREE_BYTES)) fail("portable handoff tree is too large");
    const nameBytes = Buffer.from(file.name, "utf8");
    hash.update(uint32(nameBytes.byteLength));
    hash.update(nameBytes);
    hash.update(await digestPortableHandoffFile(path, operation));
  }
  assertSameTreeSnapshot(snapshot, await portableTreeSnapshot(root, operation));
  return hash.digest("hex");
}
