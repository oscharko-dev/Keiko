import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  type BigIntStats,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { parentPort, workerData } from "node:worker_threads";

import { fileDescriptorOwnerUid } from "@oscharko-dev/keiko-security/process-scope";
import { bindWorkerProcessScope } from "@oscharko-dev/keiko-security/process-scope-worker";

import {
  USEARCH_COMMAND,
  USEARCH_CONTROL,
  USEARCH_ERROR,
  USEARCH_STATE,
  type UsearchWorkerData,
  type UsearchWorkerMessage,
} from "./usearch-worker-protocol.js";

type NativeSearchResult = readonly [BigUint64Array, Float32Array, BigUint64Array];

interface NativeCompiledIndex {
  readonly add: (keys: BigUint64Array, vectors: Float32Array, threads: number) => void;
  readonly search: (
    vectors: Float32Array,
    candidateLimit: number,
    threads: number,
  ) => NativeSearchResult;
  readonly size: () => number;
}

interface NativeUsearchModule {
  readonly CompiledIndex: new (
    dimensions: number,
    metric: "cos",
    quantization: "f32",
    connectivity: number,
    expansionAdd: number,
    expansionSearch: number,
    multi: false,
  ) => NativeCompiledIndex;
  readonly version?: () => string;
}

function isNativeUsearchModule(value: unknown): value is NativeUsearchModule {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.CompiledIndex === "function" &&
    (record.version === undefined || typeof record.version === "function")
  );
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Descriptor(descriptor: number, length: bigint): string {
  if (length < 0n || length > BigInt(Number.MAX_SAFE_INTEGER)) return "";
  const size = Number(length);
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(Math.max(size, 1), 64 * 1_024));
  let offset = 0;
  while (offset < size) {
    const bytesRead = readSync(
      descriptor,
      buffer,
      0,
      Math.min(buffer.length, size - offset),
      offset,
    );
    if (bytesRead === 0) return "";
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return hash.digest("hex");
}

interface RuntimeEntry {
  readonly descriptor: number;
  readonly identity: BigIntStats;
}

interface VerifiedRuntime extends RuntimeEntry {
  readonly parent: RuntimeEntry;
}

function sameRuntimeObject(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameRuntimeFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameRuntimeObject(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs
  );
}

function trustedPosixOwnerAndMode(descriptor: number, entry: BigIntStats): boolean {
  if (process.platform === "win32" || process.getuid === undefined) return true;
  const uid = fileDescriptorOwnerUid(descriptor, entry);
  return (
    uid !== undefined &&
    (uid === BigInt(process.getuid()) || uid === 0n) &&
    (entry.mode & 0o022n) === 0n
  );
}

// Hold both objects across require. Owner observations use their exact descriptor metadata in the
// selected process coordinate; projected stat UIDs never stand in for unavailable native proof.
// Same-uid hostile replacement and Windows ACL semantics remain outside this POSIX boundary.
function runtimeOpenFlags(directory: boolean): number {
  if (process.platform === "win32") return constants.O_RDONLY;
  return constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0);
}

function openRuntimeEntry(path: string, directory: boolean): RuntimeEntry | undefined {
  let descriptor: number | undefined;
  let admitted = false;
  try {
    const pathIdentity = lstatSync(path, { bigint: true });
    const expectedPathType = directory ? pathIdentity.isDirectory() : pathIdentity.isFile();
    if (pathIdentity.isSymbolicLink() || !expectedPathType) return undefined;
    descriptor = openSync(path, runtimeOpenFlags(directory));
    const identity = fstatSync(descriptor, { bigint: true });
    const expectedType = directory ? identity.isDirectory() : identity.isFile();
    if (
      expectedType &&
      sameRuntimeObject(pathIdentity, identity) &&
      trustedPosixOwnerAndMode(descriptor, identity)
    ) {
      admitted = true;
      return { descriptor, identity };
    }
    return undefined;
  } finally {
    if (!admitted && descriptor !== undefined) closeSync(descriptor);
  }
}

function openVerifiedRuntime(data: UsearchWorkerData): VerifiedRuntime | undefined {
  const parent = openRuntimeEntry(dirname(data.binaryPath), true);
  if (parent === undefined) return undefined;
  let binary: RuntimeEntry | undefined;
  let admitted = false;
  try {
    binary = openRuntimeEntry(data.binaryPath, false);
    if (
      binary === undefined ||
      sha256Descriptor(binary.descriptor, binary.identity.size) !== data.binarySha256
    ) {
      return undefined;
    }
    admitted = true;
    return { ...binary, parent };
  } finally {
    if (!admitted) {
      if (binary !== undefined) closeSync(binary.descriptor);
      closeSync(parent.descriptor);
    }
  }
}

function runtimeEntryUnchanged(path: string, entry: RuntimeEntry): boolean {
  const pathIdentity = lstatSync(path, { bigint: true });
  const identity = fstatSync(entry.descriptor, { bigint: true });
  return (
    !pathIdentity.isSymbolicLink() &&
    sameRuntimeObject(entry.identity, pathIdentity) &&
    sameRuntimeObject(entry.identity, identity) &&
    trustedPosixOwnerAndMode(entry.descriptor, identity)
  );
}

function runtimeUnchanged(data: UsearchWorkerData, opened: VerifiedRuntime): boolean {
  const pathIdentity = lstatSync(data.binaryPath, { bigint: true });
  const descriptorIdentity = fstatSync(opened.descriptor, { bigint: true });
  return (
    sha256Descriptor(opened.descriptor, descriptorIdentity.size) === data.binarySha256 &&
    runtimeEntryUnchanged(data.binaryPath, opened) &&
    runtimeEntryUnchanged(dirname(data.binaryPath), opened.parent) &&
    sameRuntimeFile(opened.identity, pathIdentity) &&
    sameRuntimeFile(opened.identity, descriptorIdentity) &&
    sha256(data.binaryPath) === data.binarySha256
  );
}

function loadRuntime(data: UsearchWorkerData): NativeUsearchModule | undefined {
  let opened: VerifiedRuntime | undefined;
  try {
    opened = openVerifiedRuntime(data);
    if (opened === undefined) return undefined;
    const loaded: unknown = createRequire(import.meta.url)(data.binaryPath);
    if (
      !runtimeUnchanged(data, opened) ||
      !isNativeUsearchModule(loaded) ||
      (loaded.version !== undefined && loaded.version() !== data.expectedVersion)
    ) {
      return undefined;
    }
    return loaded;
  } catch {
    return undefined;
  } finally {
    if (opened !== undefined) {
      closeSync(opened.descriptor);
      closeSync(opened.parent.descriptor);
    }
  }
}

function publishFailure(control: Int32Array, error: number): void {
  Atomics.store(control, USEARCH_CONTROL.error, error);
  Atomics.store(control, USEARCH_CONTROL.state, USEARCH_STATE.failed);
  Atomics.notify(control, USEARCH_CONTROL.state);
  postMessage({ kind: "build-complete" });
}

function postMessage(message: UsearchWorkerMessage): void {
  parentPort?.postMessage(message);
}

function buildIndex(data: UsearchWorkerData): NativeCompiledIndex | undefined {
  const control = new Int32Array(data.controlBuffer);
  try {
    bindWorkerProcessScope(data.processScope);
    const runtime = loadRuntime(data);
    if (runtime === undefined) {
      publishFailure(control, USEARCH_ERROR.runtimeInvalid);
      return undefined;
    }
    const index = new runtime.CompiledIndex(
      data.dimensions,
      "cos",
      "f32",
      data.connectivity,
      data.expansionAdd,
      data.expansionSearch,
      false,
    );
    index.add(new BigUint64Array(data.keysBuffer), new Float32Array(data.vectorsBuffer), 1);
    if (index.size() !== data.rowCount) {
      publishFailure(control, USEARCH_ERROR.buildFailed);
      return undefined;
    }
    Atomics.store(control, USEARCH_CONTROL.state, USEARCH_STATE.ready);
    Atomics.notify(control, USEARCH_CONTROL.state);
    postMessage({ kind: "build-complete" });
    return index;
  } catch {
    publishFailure(control, USEARCH_ERROR.buildFailed);
    return undefined;
  }
}

function answerSearch(
  index: NativeCompiledIndex,
  data: UsearchWorkerData,
  control: Int32Array,
): void {
  try {
    const limit = Atomics.load(control, USEARCH_CONTROL.candidateLimit);
    const [keys, distances, counts] = index.search(new Float32Array(data.queryBuffer), limit, 1);
    const count = Math.min(Number(counts[0] ?? 0n), limit);
    new BigUint64Array(data.resultKeysBuffer).set(keys.subarray(0, count), 0);
    new Float32Array(data.resultDistancesBuffer).set(distances.subarray(0, count), 0);
    Atomics.store(control, USEARCH_CONTROL.resultCount, count);
    Atomics.store(control, USEARCH_CONTROL.error, USEARCH_ERROR.none);
  } catch {
    Atomics.store(control, USEARCH_CONTROL.resultCount, 0);
    Atomics.store(control, USEARCH_CONTROL.error, USEARCH_ERROR.searchFailed);
  }
  Atomics.store(
    control,
    USEARCH_CONTROL.responseSequence,
    Atomics.load(control, USEARCH_CONTROL.requestSequence),
  );
  Atomics.store(control, USEARCH_CONTROL.command, USEARCH_COMMAND.idle);
  Atomics.notify(control, USEARCH_CONTROL.responseSequence);
  postMessage({
    kind: "search-complete",
    sequence: Atomics.load(control, USEARCH_CONTROL.responseSequence),
  });
}

function serve(index: NativeCompiledIndex, data: UsearchWorkerData): void {
  const control = new Int32Array(data.controlBuffer);
  for (;;) {
    Atomics.wait(control, USEARCH_CONTROL.command, USEARCH_COMMAND.idle);
    const command = Atomics.load(control, USEARCH_CONTROL.command);
    if (command === USEARCH_COMMAND.close) break;
    if (command === USEARCH_COMMAND.search) answerSearch(index, data, control);
  }
  Atomics.store(control, USEARCH_CONTROL.state, USEARCH_STATE.closed);
  Atomics.notify(control, USEARCH_CONTROL.state);
}

const data = workerData as UsearchWorkerData;
const index = buildIndex(data);
if (index !== undefined) serve(index, data);
