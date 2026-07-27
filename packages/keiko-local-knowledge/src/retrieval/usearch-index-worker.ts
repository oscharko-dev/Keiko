import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
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
  readonly version: () => string;
}

function isNativeUsearchModule(value: unknown): value is NativeUsearchModule {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.CompiledIndex === "function" && typeof record.version === "function";
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function loadRuntime(data: UsearchWorkerData): NativeUsearchModule | undefined {
  const before = statSync(data.binaryPath);
  if (!before.isFile() || sha256(data.binaryPath) !== data.binarySha256) return undefined;
  const loaded: unknown = createRequire(import.meta.url)(data.binaryPath);
  const after = statSync(data.binaryPath);
  if (
    !isNativeUsearchModule(loaded) ||
    loaded.version() !== data.expectedVersion ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    return undefined;
  }
  return loaded;
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
