import { createHash, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  type BigIntStats,
  type Dir,
  type Dirent,
} from "node:fs";
import { lstat, open, opendir, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { emitSecurityLogEvent, securityErrorKind, type SecurityLogSink } from "./log-port.js";

const TREE_HASH_SCHEMA = "KHT1";
const MAX_TREE_ENTRIES = 60_000;
const MAX_TREE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TREE_PATH_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const BUFFER_BYTES = 64 * 1024;
const ASYNC_READS_PER_YIELD = 64;
const ASYNC_IO_STEPS_PER_YIELD = 256;
const SHA256 = /^[a-f0-9]{64}$/u;

export interface PortableTreeKht1Operation {
  readonly signal?: AbortSignal | undefined;
  readonly deadline: number;
  readonly now: () => number;
  readonly yieldControl: () => Promise<void>;
  readonly securityLogSink?: SecurityLogSink | undefined;
}

export class PortableTreeAttestationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PortableTreeAttestationError";
  }
}

function fail(message: string): never {
  throw new PortableTreeAttestationError(message);
}

function assertDeadline(deadline: number): void {
  if (!Number.isSafeInteger(deadline) || deadline < 1) {
    fail("portable handoff operation deadline is invalid");
  }
}

function assertAsyncOperation(operation: PortableTreeKht1Operation): void {
  if (operation.signal?.aborted === true) fail("portable handoff preparation was cancelled");
  if (operation.now() > operation.deadline) fail("portable handoff preparation timed out");
}

function assertSyncOperation(deadline: number): void {
  if (Date.now() > deadline) fail("portable handoff preparation timed out");
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

type IoRequest =
  | { readonly kind: "lstat"; readonly path: string }
  | {
      readonly kind: "open-directory";
      readonly id: number;
      readonly path: string;
      readonly expected: BigIntStats;
    }
  | { readonly kind: "read-directory"; readonly id: number }
  | { readonly kind: "close-directory"; readonly id: number }
  | { readonly kind: "open-file"; readonly id: number; readonly path: string }
  | { readonly kind: "fstat-file"; readonly id: number }
  | { readonly kind: "read-file"; readonly id: number }
  | { readonly kind: "close-file"; readonly id: number };

type TreeMachine = Generator<IoRequest, string, unknown>;

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

function portablePath(root: string, name: string): string {
  return name === "" ? root : join(root, ...name.split("/"));
}

interface SnapshotTraversal {
  readonly root: string;
  readonly handles: { next: number };
  readonly files: TreeEntrySnapshot[];
  readonly directorySnapshots: TreeEntrySnapshot[];
  readonly directories: TreeEntrySnapshot[];
  readonly budget: TreeBudget;
}

function* readSnapshotDirectory(
  traversal: SnapshotTraversal,
  directory: TreeEntrySnapshot,
): Generator<IoRequest, void, unknown> {
  const relativeDirectory = directory.name;
  const id = traversal.handles.next;
  traversal.handles.next += 1;
  yield {
    kind: "open-directory",
    id,
    path: portablePath(traversal.root, relativeDirectory),
    expected: directory.stat,
  };
  try {
    for (;;) {
      const entry = (yield { kind: "read-directory", id }) as Dirent | null;
      if (entry === null) return;
      const name = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      recordTreeEntry(traversal.budget, name);
      const stat = (yield {
        kind: "lstat",
        path: portablePath(traversal.root, name),
      }) as BigIntStats;
      if (treeEntryKind(entry, stat) === "directory") {
        const snapshot = { name, stat };
        traversal.directories.push(snapshot);
        traversal.directorySnapshots.push(snapshot);
      } else {
        traversal.files.push({ name, stat });
      }
    }
  } finally {
    yield { kind: "close-directory", id };
  }
}

function* snapshotTree(
  root: string,
  handles: { next: number },
): Generator<IoRequest, TreeSnapshot, unknown> {
  const rootStat = (yield { kind: "lstat", path: root }) as BigIntStats;
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail("portable handoff tree root is unsafe");
  }

  const files: TreeEntrySnapshot[] = [];
  const directorySnapshots: TreeEntrySnapshot[] = [{ name: "", stat: rootStat }];
  const directories: TreeEntrySnapshot[] = [{ name: "", stat: rootStat }];
  const budget: TreeBudget = { entries: 0, pathBytes: 0 };
  const traversal = { root, handles, files, directorySnapshots, directories, budget };
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory === undefined) break;
    yield* readSnapshotDirectory(traversal, directory);
  }
  return { directories: directorySnapshots, files };
}

function comparePortablePaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sortTreeEntries(entries: readonly TreeEntrySnapshot[]): readonly TreeEntrySnapshot[] {
  return [...entries].sort((left, right) => comparePortablePaths(left.name, right.name));
}

function* portableTreeSnapshot(
  root: string,
  handles: { next: number },
): Generator<IoRequest, TreeSnapshot, unknown> {
  const snapshot = yield* snapshotTree(root, handles);
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

function assertOpenedFile(before: BigIntStats, opened: BigIntStats): void {
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    !opened.isFile() ||
    opened.nlink !== 1n ||
    before.dev !== opened.dev ||
    before.ino !== opened.ino ||
    opened.size > BigInt(MAX_FILE_BYTES)
  ) {
    fail("portable handoff artifact is unsafe");
  }
}

function assertOpenedDirectory(expected: BigIntStats, current: BigIntStats): void {
  if (
    !expected.isDirectory() ||
    expected.isSymbolicLink() ||
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    expected.dev !== current.dev ||
    expected.ino !== current.ino
  ) {
    fail("portable handoff directory changed before traversal");
  }
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

function assertStableFile(
  opened: BigIntStats,
  after: BigIntStats,
  current: BigIntStats,
  bytes: number,
): void {
  if (
    BigInt(bytes) !== opened.size ||
    !sameFileIdentity(after, opened) ||
    current.dev !== opened.dev ||
    current.ino !== opened.ino
  ) {
    fail("portable handoff artifact changed");
  }
}

function* digestFile(
  path: string,
  handles: { next: number },
): Generator<IoRequest, Buffer, unknown> {
  const id = handles.next;
  handles.next += 1;
  yield { kind: "open-file", id, path };
  try {
    const before = (yield { kind: "lstat", path }) as BigIntStats;
    const opened = (yield { kind: "fstat-file", id }) as BigIntStats;
    assertOpenedFile(before, opened);
    const hash = createHash("sha256");
    let bytes = 0;
    for (;;) {
      const content = (yield { kind: "read-file", id }) as Buffer;
      if (content.byteLength === 0) break;
      bytes += content.byteLength;
      if (BigInt(bytes) > opened.size || bytes > MAX_FILE_BYTES) {
        fail("portable handoff artifact changed");
      }
      hash.update(content);
    }
    const after = (yield { kind: "fstat-file", id }) as BigIntStats;
    const current = (yield { kind: "lstat", path }) as BigIntStats;
    assertStableFile(opened, after, current, bytes);
    return hash.digest();
  } finally {
    yield { kind: "close-file", id };
  }
}

function* portableTreeMachine(root: string): TreeMachine {
  const handles = { next: 1 };
  const snapshot = yield* portableTreeSnapshot(root, handles);
  const hash = createHash("sha256");
  hash.update(TREE_HASH_SCHEMA, "ascii");
  hash.update(uint32(snapshot.files.length));
  let totalBytes = 0n;
  for (const file of snapshot.files) {
    const path = portablePath(root, file.name);
    const current = (yield { kind: "lstat", path }) as BigIntStats;
    totalBytes += current.size;
    if (totalBytes > BigInt(MAX_TREE_BYTES)) fail("portable handoff tree is too large");
    const nameBytes = Buffer.from(file.name, "utf8");
    hash.update(uint32(nameBytes.byteLength));
    hash.update(nameBytes);
    hash.update(yield* digestFile(path, handles));
  }
  assertSameTreeSnapshot(snapshot, yield* portableTreeSnapshot(root, handles));
  return hash.digest("hex");
}

interface SyncFileResource {
  readonly kind: "file";
  readonly descriptor: number;
  readonly buffer: Buffer;
}

interface SyncDirectoryResource {
  readonly kind: "directory";
  readonly handle: Dir;
}

type SyncResource = SyncFileResource | SyncDirectoryResource;

class SyncIo {
  readonly #resources = new Map<number, SyncResource>();

  public execute(request: IoRequest): unknown {
    switch (request.kind) {
      case "lstat":
        return lstatSync(request.path, { bigint: true });
      case "open-directory":
        this.#openDirectory(request);
        return undefined;
      case "read-directory":
        return this.#directory(request.id).handle.readSync();
      case "close-directory":
        this.#directory(request.id).handle.closeSync();
        this.#resources.delete(request.id);
        return undefined;
      case "open-file":
        this.#resources.set(request.id, {
          kind: "file",
          descriptor: openSync(request.path, constants.O_RDONLY | constants.O_NOFOLLOW),
          buffer: Buffer.allocUnsafe(BUFFER_BYTES),
        });
        return undefined;
      case "fstat-file":
        return fstatSync(this.#file(request.id).descriptor, { bigint: true });
      case "read-file": {
        const file = this.#file(request.id);
        const bytes = readSync(file.descriptor, file.buffer, 0, file.buffer.length, null);
        return file.buffer.subarray(0, bytes);
      }
      case "close-file":
        closeSync(this.#file(request.id).descriptor);
        this.#resources.delete(request.id);
        return undefined;
    }
  }

  public closeAll(): void {
    for (const resource of this.#resources.values()) {
      try {
        if (resource.kind === "file") closeSync(resource.descriptor);
        else resource.handle.closeSync();
      } catch {
        // Preserve the primary attestation failure while still attempting every close.
      }
    }
    this.#resources.clear();
  }

  #file(id: number): SyncFileResource {
    const resource = this.#resources.get(id);
    if (resource?.kind !== "file") throw new Error("portable tree file handle is unavailable");
    return resource;
  }

  #directory(id: number): SyncDirectoryResource {
    const resource = this.#resources.get(id);
    if (resource?.kind !== "directory") {
      throw new Error("portable tree directory handle is unavailable");
    }
    return resource;
  }

  #openDirectory(request: Extract<IoRequest, { readonly kind: "open-directory" }>): void {
    const handle = opendirSync(request.path);
    try {
      assertOpenedDirectory(request.expected, lstatSync(request.path, { bigint: true }));
      this.#resources.set(request.id, { kind: "directory", handle });
    } catch (error) {
      try {
        handle.closeSync();
      } catch {
        // Preserve the directory-identity failure.
      }
      throw error;
    }
  }
}

interface AsyncFileResource {
  readonly kind: "file";
  readonly handle: FileHandle;
  readonly buffer: Buffer;
}

interface AsyncDirectoryResource {
  readonly kind: "directory";
  readonly handle: Dir;
}

type AsyncResource = AsyncFileResource | AsyncDirectoryResource;

class AsyncIo {
  readonly #resources = new Map<number, AsyncResource>();

  public async execute(request: IoRequest): Promise<unknown> {
    switch (request.kind) {
      case "lstat":
        return await lstat(request.path, { bigint: true });
      case "open-directory":
        await this.#openDirectory(request);
        return undefined;
      case "read-directory":
        return await this.#resource(request.id, "directory").handle.read();
      case "close-directory":
        await this.#resource(request.id, "directory").handle.close();
        this.#resources.delete(request.id);
        return undefined;
      case "open-file":
        this.#resources.set(request.id, {
          kind: "file",
          handle: await open(request.path, constants.O_RDONLY | constants.O_NOFOLLOW),
          buffer: Buffer.allocUnsafe(BUFFER_BYTES),
        });
        return undefined;
      case "fstat-file":
        return await this.#resource(request.id, "file").handle.stat({ bigint: true });
      case "read-file": {
        const file = this.#resource(request.id, "file");
        const result = await file.handle.read(file.buffer, 0, file.buffer.length, null);
        return file.buffer.subarray(0, result.bytesRead);
      }
      case "close-file":
        await this.#resource(request.id, "file").handle.close();
        this.#resources.delete(request.id);
        return undefined;
    }
  }

  public async closeAll(): Promise<void> {
    const resources = [...this.#resources.values()];
    this.#resources.clear();
    await Promise.allSettled(
      resources.map(async (resource) => {
        await resource.handle.close();
      }),
    );
  }

  #resource(id: number, kind: "file"): AsyncFileResource;
  #resource(id: number, kind: "directory"): AsyncDirectoryResource;
  #resource(id: number, kind: AsyncResource["kind"]): AsyncResource {
    const resource = this.#resources.get(id);
    if (resource?.kind !== kind) {
      throw new Error(`portable tree ${kind} handle is unavailable`);
    }
    return resource;
  }

  async #openDirectory(
    request: Extract<IoRequest, { readonly kind: "open-directory" }>,
  ): Promise<void> {
    const handle = await opendir(request.path);
    try {
      assertOpenedDirectory(request.expected, await lstat(request.path, { bigint: true }));
      this.#resources.set(request.id, { kind: "directory", handle });
    } catch (error) {
      try {
        await handle.close();
      } catch {
        // Preserve the directory-identity failure.
      }
      throw error;
    }
  }
}

function runTreeMachineSync(root: string, deadline: number): string {
  assertDeadline(deadline);
  const machine = portableTreeMachine(root);
  const io = new SyncIo();
  let response: unknown;
  try {
    for (;;) {
      assertSyncOperation(deadline);
      const step = machine.next(response);
      if (step.done) return step.value;
      response = io.execute(step.value);
    }
  } finally {
    io.closeAll();
  }
}

async function hashPortableTreeKht1Inner(
  root: string,
  operation: PortableTreeKht1Operation,
): Promise<string> {
  assertDeadline(operation.deadline);
  const machine = portableTreeMachine(root);
  const io = new AsyncIo();
  let response: unknown;
  let readSteps = 0;
  let ioSteps = 0;
  try {
    for (;;) {
      assertAsyncOperation(operation);
      const step = machine.next(response);
      if (step.done) return step.value;
      response = await io.execute(step.value);
      if (step.value.kind === "read-file") readSteps += 1;
      ioSteps += 1;
      if (readSteps >= ASYNC_READS_PER_YIELD || ioSteps >= ASYNC_IO_STEPS_PER_YIELD) {
        readSteps = 0;
        ioSteps = 0;
        await operation.yieldControl();
      }
    }
  } finally {
    await io.closeAll();
  }
}

function logAttestationFailure(
  sink: SecurityLogSink | undefined,
  driver: "async" | "sync",
  error: unknown,
): void {
  emitSecurityLogEvent(sink, {
    level: "error",
    category: "security",
    op: "security.portable-tree-attestation.failed",
    errorKind: securityErrorKind(error),
    extra: { driver },
  });
}

export async function hashPortableTreeKht1(
  root: string,
  operation: PortableTreeKht1Operation,
): Promise<string> {
  try {
    return await hashPortableTreeKht1Inner(root, operation);
  } catch (error) {
    logAttestationFailure(operation.securityLogSink, "async", error);
    throw error;
  }
}

export function attestPortableTreeKht1Sync(
  root: string,
  expectedSha256: string,
  deadline: number,
  securityLogSink?: SecurityLogSink,
): void {
  try {
    if (!SHA256.test(expectedSha256)) fail("portable handoff tree digest is invalid");
    const actual = Buffer.from(runTreeMachineSync(root, deadline), "hex");
    const expected = Buffer.from(expectedSha256, "hex");
    if (!timingSafeEqual(actual, expected)) fail("portable handoff tree digest mismatch");
  } catch (error) {
    logAttestationFailure(securityLogSink, "sync", error);
    throw error;
  }
}
