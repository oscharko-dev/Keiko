import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  type Stats,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { parentPort, workerData } from "node:worker_threads";

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

function sha256Descriptor(descriptor: number, size: number): string {
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

function sameRuntimeFile(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function trustedPosixOwnerAndMode(entry: Stats): boolean {
  if (process.platform === "win32" || process.getuid === undefined) return true;
  const currentUid = process.getuid();
  const trustedOwner = entry.uid === currentUid || entry.uid === 0;
  return trustedOwner && (entry.mode & 0o022) === 0;
}

// This boundary excludes path substitution by other POSIX users: the file and its immediate parent
// must be owned by this uid/root and not group/world writable, and the opened descriptor stays live
// across require. It does not claim protection from a hostile same-uid process, which can chmod or
// rename owner-controlled paths. Windows ACL semantics are not represented by Node's POSIX mode
// bits; Windows retains the symlink, regular-file, descriptor-identity and digest checks here, plus
// the portable signing and isolated-smoke gates at artifact qualification.
function trustedRuntimePath(path: string): boolean {
  const binary = lstatSync(path);
  const parent = lstatSync(dirname(path));
  return (
    binary.isFile() &&
    !binary.isSymbolicLink() &&
    parent.isDirectory() &&
    !parent.isSymbolicLink() &&
    trustedPosixOwnerAndMode(binary) &&
    trustedPosixOwnerAndMode(parent)
  );
}

function openVerifiedRuntime(
  data: UsearchWorkerData,
): { readonly descriptor: number; readonly identity: Stats } | undefined {
  let descriptor: number | undefined;
  try {
    if (!trustedRuntimePath(data.binaryPath)) return undefined;
    const pathIdentity = lstatSync(data.binaryPath);
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    descriptor = openSync(data.binaryPath, constants.O_RDONLY | noFollow);
    const identity = fstatSync(descriptor);
    if (
      !identity.isFile() ||
      !sameRuntimeFile(pathIdentity, identity) ||
      !trustedPosixOwnerAndMode(identity) ||
      sha256Descriptor(descriptor, identity.size) !== data.binarySha256
    ) {
      closeSync(descriptor);
      return undefined;
    }
    return { descriptor, identity };
  } catch {
    if (descriptor !== undefined) closeSync(descriptor);
    return undefined;
  }
}

function runtimeUnchanged(data: UsearchWorkerData, identity: Stats, descriptor: number): boolean {
  const pathIdentity = lstatSync(data.binaryPath);
  const descriptorIdentity = fstatSync(descriptor);
  return (
    sha256Descriptor(descriptor, descriptorIdentity.size) === data.binarySha256 &&
    trustedRuntimePath(data.binaryPath) &&
    sameRuntimeFile(identity, pathIdentity) &&
    sameRuntimeFile(identity, descriptorIdentity) &&
    sha256(data.binaryPath) === data.binarySha256
  );
}

function loadRuntime(data: UsearchWorkerData): NativeUsearchModule | undefined {
  const opened = openVerifiedRuntime(data);
  if (opened === undefined) return undefined;
  try {
    const loaded: unknown = createRequire(import.meta.url)(data.binaryPath);
    if (
      !runtimeUnchanged(data, opened.identity, opened.descriptor) ||
      !isNativeUsearchModule(loaded) ||
      (loaded.version !== undefined && loaded.version() !== data.expectedVersion)
    ) {
      return undefined;
    }
    return loaded;
  } catch {
    return undefined;
  } finally {
    closeSync(opened.descriptor);
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
