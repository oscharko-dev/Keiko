import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Worker } from "node:worker_threads";

import {
  embeddingIdentityKey,
  type EmbeddingModelIdentity,
  type EmbeddingVectorMetric,
} from "@oscharko-dev/keiko-contracts";

import {
  USEARCH_RUNTIME_MANIFEST,
  type UsearchRuntimeApproval,
  usearchRuntimeApproval,
  usearchRuntimeTargetKey,
} from "./usearch-runtime-manifest.js";
import {
  USEARCH_COMMAND,
  USEARCH_CONTROL,
  USEARCH_ERROR,
  USEARCH_STATE,
  type UsearchWorkerData,
  type UsearchWorkerMessage,
} from "./usearch-worker-protocol.js";

export interface UsearchVectorEntry {
  readonly id: string;
  readonly vector: Float32Array;
}

export interface UsearchAnnPartition {
  readonly cacheKey: string;
  readonly cacheGroupKey: string;
  readonly revision: string;
  readonly identity: EmbeddingModelIdentity;
  readonly rowCount: number;
  readonly loadEntries: () => readonly UsearchVectorEntry[];
}

export interface UsearchAnnSearchRequest {
  readonly partition: UsearchAnnPartition;
  readonly queryVector: Float32Array;
  readonly candidateLimit: number;
  readonly binaryPath?: string;
  readonly exactScanThreshold?: number;
  readonly maxIndexBytes?: number;
}

export interface UsearchAnnCandidate {
  readonly id: string;
  readonly score: number;
}

export type UsearchAnnSearchResult =
  | {
      readonly ok: true;
      readonly mode: "exact" | "ann";
      readonly candidates: readonly UsearchAnnCandidate[];
      readonly examinedCandidates: number;
      readonly estimatedIndexBytes: number;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "invalid-query"
        | "query-dimension-mismatch"
        | "invalid-partition"
        | "invalid-partition-entry"
        | "unsupported-metric"
        | "index-bytes-over-bound"
        | "partition-load-failed"
        | "runtime-unavailable"
        | "runtime-integrity-failed"
        | "index-build-failed"
        | "index-query-failed";
    };

interface IndexedEntry {
  readonly id: string;
  readonly norm: number;
}

interface SharedVectors {
  readonly entries: readonly IndexedEntry[];
  readonly buffer: SharedArrayBuffer;
  readonly byteSize: number;
}

interface ExactIndex {
  readonly mode: "exact";
  readonly vectors: SharedVectors;
  readonly byteSize: number;
}

interface AnnWorkerBuffers {
  readonly control: Int32Array;
  readonly query: Float32Array;
  readonly resultKeys: BigUint64Array;
  readonly resultDistances: Float32Array;
}

interface AnnWorkerAllocation {
  readonly buffers: AnnWorkerBuffers;
  readonly controlBuffer: SharedArrayBuffer;
  readonly keysBuffer: SharedArrayBuffer;
  readonly queryBuffer: SharedArrayBuffer;
  readonly resultKeysBuffer: SharedArrayBuffer;
  readonly resultDistancesBuffer: SharedArrayBuffer;
}

interface AnnIndex {
  readonly mode: "ann";
  readonly vectors: SharedVectors;
  readonly worker: Worker;
  readonly buffers: AnnWorkerBuffers;
  readonly byteSize: number;
  available: boolean;
  queryQueue: Promise<void>;
}

type SearchIndex = ExactIndex | AnnIndex;

interface CachedIndex {
  readonly baseKey: string;
  readonly groupKey: string;
  readonly index: SearchIndex;
}

interface QueuedOperation<T> {
  readonly result: Promise<T>;
  readonly tail: Promise<void>;
}

const HNSW_CONNECTIVITY = 32;
const HNSW_EXPANSION_ADD = 256;
const HNSW_EXPANSION_SEARCH = 768;
const HNSW_OVERFETCH_MULTIPLIER = 8;
const HNSW_OVERFETCH_EXTRA = 128;
const HNSW_MAX_RESULTS = 10_000;
const DEFAULT_EXACT_SCAN_THRESHOLD = 20_000;
const DEFAULT_MAX_INDEX_BYTES = 256 * 1024 * 1024;
// The qualified 50k×384 HNSW index consumes roughly twice its structural estimate in RSS once
// native allocator/worker overhead is included. Capping the cache's aggregate estimate at the
// per-index 256 MiB ceiling prevents two individually valid large graphs from coexisting and
// exceeding the separately qualified 512 MiB RSS envelope.
const MAX_CACHED_ESTIMATED_INDEX_BYTES = 256 * 1024 * 1024;
const HNSW_NODE_OVERHEAD_BYTES = 256;
const HNSW_EDGE_BYTES = 8;
const WORKER_FIXED_BYTES = 8 * 1024 * 1024;
const BUILD_TIMEOUT_MS = 120_000;
const QUERY_TIMEOUT_MS = 30_000;

const INDEX_CACHE = new Map<string, CachedIndex>();
let cachedIndexBytes = 0;
let indexBuildQueue = Promise.resolve();

function queuedOperation<T>(tail: Promise<void>, operation: () => Promise<T>): QueuedOperation<T> {
  let releaseTail: (() => void) | undefined;
  const nextTail = new Promise<void>((resolveTail) => {
    releaseTail = resolveTail;
  });
  const release = releaseTail;
  if (release === undefined) throw new TypeError("queue tail was not initialized");
  const result = tail.then(async () => {
    try {
      return await operation();
    } finally {
      release();
    }
  });
  return { result, tail: nextTail };
}

function compareIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function finiteVector(vector: Float32Array): boolean {
  for (const value of vector) {
    if (!Number.isFinite(value)) return false;
  }
  return true;
}

function vectorNorm(vector: Float32Array): number {
  let squared = 0;
  for (const value of vector) squared += value * value;
  return Math.sqrt(squared);
}

function dotProduct(left: Float32Array, right: Float32Array): number {
  let score = 0;
  for (let index = 0; index < left.length; index += 1) {
    score += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return score;
}

function cosineScore(
  query: Float32Array,
  queryNorm: number,
  vector: Float32Array,
  vectorNormValue: number,
): number {
  return dotProduct(query, vector) / (queryNorm * vectorNormValue);
}

function euclideanScore(query: Float32Array, vector: Float32Array): number {
  let squared = 0;
  for (let index = 0; index < query.length; index += 1) {
    const delta = (query[index] ?? 0) - (vector[index] ?? 0);
    squared += delta * delta;
  }
  return -Math.sqrt(squared);
}

function scoreVector(
  metric: EmbeddingVectorMetric,
  query: Float32Array,
  queryNorm: number,
  vector: Float32Array,
  vectorNormValue: number,
): number {
  if (metric === "cosine") return cosineScore(query, queryNorm, vector, vectorNormValue);
  if (metric === "dot") return dotProduct(query, vector);
  return euclideanScore(query, vector);
}

function vectorAt(vectors: SharedVectors, dimensions: number, index: number): Float32Array {
  return new Float32Array(
    vectors.buffer,
    index * dimensions * Float32Array.BYTES_PER_ELEMENT,
    dimensions,
  );
}

function scoreIndexes(
  index: SearchIndex,
  identity: EmbeddingModelIdentity,
  query: Float32Array,
  rowIndexes: readonly number[],
  limit: number,
): readonly UsearchAnnCandidate[] {
  const queryNorm = vectorNorm(query);
  const candidates: UsearchAnnCandidate[] = [];
  for (const rowIndex of rowIndexes) {
    const entry = index.vectors.entries[rowIndex];
    if (entry === undefined) continue;
    const vector = vectorAt(index.vectors, identity.vectorDimensions, rowIndex);
    const score = scoreVector(identity.vectorMetric, query, queryNorm, vector, entry.norm);
    if (Number.isFinite(score)) candidates.push({ id: entry.id, score });
  }
  candidates.sort((left, right) => right.score - left.score || compareIds(left.id, right.id));
  return candidates.slice(0, limit);
}

function estimatedIndexBytes(rowCount: number, dimensions: number, ann: boolean): number {
  const vectors = rowCount * dimensions * Float32Array.BYTES_PER_ELEMENT;
  const idsAndNorms = rowCount * 64;
  if (!ann) return vectors + idsAndNorms;
  const nativeVectors = vectors;
  const graph = rowCount * (HNSW_NODE_OVERHEAD_BYTES + HNSW_CONNECTIVITY * 2 * HNSW_EDGE_BYTES);
  return vectors + idsAndNorms + nativeVectors + graph + WORKER_FIXED_BYTES;
}

function invalidLoadedEntry(
  entry: UsearchVectorEntry | undefined,
  ids: ReadonlySet<string>,
  dimensions: number,
): boolean {
  return (
    entry === undefined ||
    entry.id.length === 0 ||
    ids.has(entry.id) ||
    entry.vector.length !== dimensions ||
    !finiteVector(entry.vector)
  );
}

function loadSharedVectors(
  partition: UsearchAnnPartition,
): SharedVectors | "load-failed" | "invalid" {
  let loaded: readonly UsearchVectorEntry[];
  try {
    loaded = partition.loadEntries();
  } catch {
    return "load-failed";
  }
  if (loaded.length !== partition.rowCount) return "invalid";
  const sorted = [...loaded].sort((left, right) => compareIds(left.id, right.id));
  const dimensions = partition.identity.vectorDimensions;
  const buffer = new SharedArrayBuffer(sorted.length * dimensions * Float32Array.BYTES_PER_ELEMENT);
  const target = new Float32Array(buffer);
  const entries: IndexedEntry[] = [];
  const ids = new Set<string>();
  for (let row = 0; row < sorted.length; row += 1) {
    const entry = sorted[row];
    if (invalidLoadedEntry(entry, ids, dimensions)) return "invalid";
    if (entry === undefined) return "invalid";
    const norm = vectorNorm(entry.vector);
    if (!Number.isFinite(norm) || norm === 0) return "invalid";
    ids.add(entry.id);
    target.set(entry.vector, row * dimensions);
    entries.push({ id: entry.id, norm });
  }
  return { entries, buffer, byteSize: buffer.byteLength + entries.length * 64 };
}

function approvedRuntimeFor(targetKey: string): Readonly<UsearchRuntimeApproval> {
  const approval = usearchRuntimeApproval(targetKey);
  if (approval === undefined) throw new Error("USearch runtime approval invariant failed");
  return approval;
}

type TargetRuntimeResult =
  | { readonly path: string; readonly sha256: string; readonly expectedVersion: string }
  | "unavailable"
  | "invalid";

interface CachedTargetRuntime {
  readonly result: TargetRuntimeResult;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly ino: number;
  readonly size: number;
}

// KEIKO-0409: memoize targetRuntime per resolved (path, mtimeMs, size) so a warm search
// call does not re-read + SHA-256 the multi-MB native addon on the Node.js event loop for
// every request. The runtime-availability check STAYS BEFORE the in-memory index cache
// (a swapped-out binary must never be masked by a stale cache hit), and the SHA-256 still
// runs whenever a fresh binary lands or the file changes on disk.
const TARGET_RUNTIME_CACHE = new Map<string, CachedTargetRuntime>();

// Test-only: clear the memoization so a fresh test can observe the cold-path hashing without
// depending on previous tests' cache state. Production code never calls this.
export function __resetTargetRuntimeCacheForTests(): void {
  TARGET_RUNTIME_CACHE.clear();
}

function resolvedRuntimePath(binaryPath: string | undefined, targetKey: string): string {
  const approval = approvedRuntimeFor(targetKey);
  const portablePath =
    process.platform === "darwin"
      ? resolve(dirname(process.execPath), "..", "..", "native", "usearch.node")
      : resolve(dirname(process.execPath), "..", "native", "usearch.node");
  const defaultPath = existsSync(portablePath)
    ? portablePath
    : resolve(process.cwd(), ".usearch", approval.version, targetKey, "usearch.node");
  return binaryPath ?? process.env.KEIKO_USEARCH_BINARY_PATH ?? defaultPath;
}

function verifyRuntimeAt(path: string): TargetRuntimeResult {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return "invalid";
    const targetKey = usearchRuntimeTargetKey(process.platform, process.arch);
    if (targetKey === undefined) return "unavailable";
    const approval = approvedRuntimeFor(targetKey);
    const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
    return digest === approval.binarySha256
      ? { path, sha256: digest, expectedVersion: approval.version }
      : "invalid";
  } catch {
    return "invalid";
  }
}

function targetRuntime(binaryPath: string | undefined): TargetRuntimeResult {
  const targetKey = usearchRuntimeTargetKey(process.platform, process.arch);
  if (targetKey === undefined) return "unavailable";
  const path = resolvedRuntimePath(binaryPath, targetKey);
  if (!existsSync(path)) return "unavailable";
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return "invalid";
  }
  const cached = TARGET_RUNTIME_CACHE.get(path);
  if (
    cached?.mtimeMs === stat.mtimeMs &&
    cached.ctimeMs === stat.ctimeMs &&
    cached.ino === stat.ino &&
    cached.size === stat.size
  ) {
    return cached.result;
  }
  const result = verifyRuntimeAt(path);
  // PR-review follow-up: only memoize SUCCESSFUL verifications. A transient failure
  // (EMFILE, EIO, temporarily-tightened permissions) that later heals must NOT be cached
  // against the same tuple — otherwise a recovered runtime is permanently invisible to every
  // subsequent ANN request until process restart.
  //
  // Second PR-review follow-up: include ctimeMs and inode in the cache key. mtime alone can
  // be restored by an attacker with write permission via `utimes`, allowing an in-place
  // same-size mutation to bypass the SHA-256 verification. ctime is updated on any inode
  // change and cannot be set from user space, and inode change (`mv` + fresh write) is
  // detected too. On Windows ctime is birthtime-like; the fallback is the mtime+size pair
  // that would otherwise apply, so behaviour is not worse than before.
  if (typeof result !== "string") {
    TARGET_RUNTIME_CACHE.set(path, {
      result,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      ino: stat.ino,
      size: stat.size,
    });
  }
  return result;
}

function isUsearchWorkerMessage(value: unknown): value is UsearchWorkerMessage {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  const kind = value.kind;
  if (kind === "build-complete") return true;
  return (
    kind === "search-complete" &&
    "sequence" in value &&
    typeof value.sequence === "number" &&
    Number.isSafeInteger(value.sequence)
  );
}

function waitForWorkerMessage(
  worker: Worker,
  matches: (message: UsearchWorkerMessage) => boolean,
  timeout: number,
): Promise<boolean> {
  return new Promise((resolveMessage) => {
    const finish = (matched: boolean): void => {
      clearTimeout(timer);
      worker.off("message", onMessage);
      worker.off("error", onFailure);
      worker.off("exit", onExit);
      resolveMessage(matched);
    };
    const onMessage = (message: unknown): void => {
      if (isUsearchWorkerMessage(message) && matches(message)) finish(true);
    };
    const onFailure = (): void => {
      finish(false);
    };
    const onExit = (): void => {
      finish(false);
    };
    const timer = setTimeout(() => {
      finish(false);
    }, timeout);
    worker.on("message", onMessage);
    worker.on("error", onFailure);
    worker.on("exit", onExit);
  });
}

function markUnavailableOnWorkerStop(index: AnnIndex): void {
  const markUnavailable = (): void => {
    index.available = false;
  };
  index.worker.once("error", markUnavailable);
  index.worker.once("exit", markUnavailable);
}

function allocateAnnWorkerBuffers(
  partition: UsearchAnnPartition,
  resultCapacity: number,
): AnnWorkerAllocation {
  const controlBuffer = new SharedArrayBuffer(
    USEARCH_CONTROL.length * Int32Array.BYTES_PER_ELEMENT,
  );
  const keysBuffer = new SharedArrayBuffer(partition.rowCount * BigUint64Array.BYTES_PER_ELEMENT);
  const keys = new BigUint64Array(keysBuffer);
  for (let index = 0; index < keys.length; index += 1) keys[index] = BigInt(index);
  const queryBuffer = new SharedArrayBuffer(
    partition.identity.vectorDimensions * Float32Array.BYTES_PER_ELEMENT,
  );
  const resultKeysBuffer = new SharedArrayBuffer(resultCapacity * BigUint64Array.BYTES_PER_ELEMENT);
  const resultDistancesBuffer = new SharedArrayBuffer(
    resultCapacity * Float32Array.BYTES_PER_ELEMENT,
  );
  return {
    controlBuffer,
    keysBuffer,
    queryBuffer,
    resultKeysBuffer,
    resultDistancesBuffer,
    buffers: {
      control: new Int32Array(controlBuffer),
      query: new Float32Array(queryBuffer),
      resultKeys: new BigUint64Array(resultKeysBuffer),
      resultDistances: new Float32Array(resultDistancesBuffer),
    },
  };
}

function workerDataFor(
  partition: UsearchAnnPartition,
  vectors: SharedVectors,
  runtime: { readonly path: string; readonly sha256: string; readonly expectedVersion: string },
  allocation: AnnWorkerAllocation,
): UsearchWorkerData {
  return {
    binaryPath: runtime.path,
    binarySha256: runtime.sha256,
    expectedVersion: runtime.expectedVersion,
    dimensions: partition.identity.vectorDimensions,
    rowCount: partition.rowCount,
    connectivity: HNSW_CONNECTIVITY,
    expansionAdd: HNSW_EXPANSION_ADD,
    expansionSearch: HNSW_EXPANSION_SEARCH,
    controlBuffer: allocation.controlBuffer,
    keysBuffer: allocation.keysBuffer,
    vectorsBuffer: vectors.buffer,
    queryBuffer: allocation.queryBuffer,
    resultKeysBuffer: allocation.resultKeysBuffer,
    resultDistancesBuffer: allocation.resultDistancesBuffer,
  };
}

async function startWorker(
  partition: UsearchAnnPartition,
  vectors: SharedVectors,
  runtime: { readonly path: string; readonly sha256: string; readonly expectedVersion: string },
  resultCapacity: number,
): Promise<AnnIndex | undefined> {
  const allocation = allocateAnnWorkerBuffers(partition, resultCapacity);
  const data = workerDataFor(partition, vectors, runtime, allocation);
  const workerUrl = import.meta.url.endsWith(".ts")
    ? new URL("../../dist/retrieval/usearch-index-worker.js", import.meta.url)
    : new URL("./usearch-index-worker.js", import.meta.url);
  const worker = new Worker(workerUrl, {
    execArgv: process.execArgv.filter((argument) => !argument.startsWith("--input-type")),
    workerData: data,
  });
  worker.unref();
  const { buffers } = allocation;
  if (
    !(await waitForWorkerMessage(
      worker,
      (message) => message.kind === "build-complete",
      BUILD_TIMEOUT_MS,
    ))
  ) {
    void worker.terminate();
    return undefined;
  }
  if (Atomics.load(buffers.control, USEARCH_CONTROL.state) !== USEARCH_STATE.ready) {
    void worker.terminate();
    return undefined;
  }
  const index: AnnIndex = {
    mode: "ann",
    vectors,
    worker,
    buffers,
    byteSize: estimatedIndexBytes(partition.rowCount, partition.identity.vectorDimensions, true),
    available: true,
    queryQueue: Promise.resolve(),
  };
  markUnavailableOnWorkerStop(index);
  return index;
}

function stopIndex(index: SearchIndex): void {
  if (index.mode !== "ann") return;
  index.available = false;
  Atomics.store(index.buffers.control, USEARCH_CONTROL.command, USEARCH_COMMAND.close);
  Atomics.notify(index.buffers.control, USEARCH_CONTROL.command);
  void index.worker.terminate();
}

function baseCacheKey(partition: UsearchAnnPartition): string {
  return `keiko-usearch-base-v2:${createHash("sha256")
    .update(
      JSON.stringify([
        partition.cacheGroupKey,
        partition.cacheKey,
        embeddingIdentityKey(partition.identity),
      ]),
      "utf8",
    )
    .digest("hex")}`;
}

function revisionCacheKey(partition: UsearchAnnPartition): string {
  return `keiko-usearch-revision-v2:${createHash("sha256")
    .update(
      JSON.stringify([
        partition.cacheGroupKey,
        baseCacheKey(partition),
        partition.revision,
        partition.rowCount,
      ]),
      "utf8",
    )
    .digest("hex")}`;
}

function removeCached(key: string): void {
  const cached = INDEX_CACHE.get(key);
  if (cached === undefined) return;
  INDEX_CACHE.delete(key);
  cachedIndexBytes -= cached.index.byteSize;
  stopIndex(cached.index);
}

function evictBaseAndCapacity(baseKey: string, requiredBytes: number): void {
  for (const [key, cached] of INDEX_CACHE) {
    if (cached.baseKey === baseKey) removeCached(key);
  }
  while (
    cachedIndexBytes + requiredBytes > MAX_CACHED_ESTIMATED_INDEX_BYTES &&
    INDEX_CACHE.size > 0
  ) {
    const oldestKey = INDEX_CACHE.keys().next().value;
    if (oldestKey === undefined) break;
    removeCached(oldestKey);
  }
}

function cacheIndex(partition: UsearchAnnPartition, index: SearchIndex): SearchIndex {
  const key = revisionCacheKey(partition);
  INDEX_CACHE.set(key, {
    baseKey: baseCacheKey(partition),
    groupKey: partition.cacheGroupKey,
    index,
  });
  cachedIndexBytes += index.byteSize;
  return index;
}

async function buildSearchIndex(
  request: UsearchAnnSearchRequest,
  exact: boolean,
  maxBytes: number,
): Promise<SearchIndex | UsearchAnnSearchResult> {
  const estimate = estimatedIndexBytes(
    request.partition.rowCount,
    request.partition.identity.vectorDimensions,
    !exact,
  );
  if (estimate > maxBytes || estimate > MAX_CACHED_ESTIMATED_INDEX_BYTES) {
    return { ok: false, reason: "index-bytes-over-bound" };
  }
  evictBaseAndCapacity(baseCacheKey(request.partition), estimate);
  const vectors = loadSharedVectors(request.partition);
  if (vectors === "load-failed") return { ok: false, reason: "partition-load-failed" };
  if (vectors === "invalid") return { ok: false, reason: "invalid-partition-entry" };
  if (exact) {
    return cacheIndex(request.partition, {
      mode: "exact",
      vectors,
      byteSize: estimate,
    });
  }
  const runtime = targetRuntime(request.binaryPath);
  if (runtime === "unavailable") return { ok: false, reason: "runtime-unavailable" };
  if (runtime === "invalid") return { ok: false, reason: "runtime-integrity-failed" };
  const worker = await startWorker(request.partition, vectors, runtime, HNSW_MAX_RESULTS);
  return worker === undefined
    ? { ok: false, reason: "index-build-failed" }
    : cacheIndex(request.partition, worker);
}

function cachedIndex(
  request: UsearchAnnSearchRequest,
  maxBytes: number,
): SearchIndex | UsearchAnnSearchResult | undefined {
  const key = revisionCacheKey(request.partition);
  const cached = INDEX_CACHE.get(key);
  if (cached === undefined) return undefined;
  if (cached.index.byteSize > maxBytes) return { ok: false, reason: "index-bytes-over-bound" };
  INDEX_CACHE.delete(key);
  INDEX_CACHE.set(key, cached);
  return cached.index;
}

function enqueueIndexBuild(
  request: UsearchAnnSearchRequest,
  exact: boolean,
  maxBytes: number,
): Promise<SearchIndex | UsearchAnnSearchResult> {
  const queued = queuedOperation(indexBuildQueue, async () => {
    const existing = cachedIndex(request, maxBytes);
    return existing ?? (await buildSearchIndex(request, exact, maxBytes));
  });
  indexBuildQueue = queued.tail;
  return queued.result;
}

async function resolvedIndex(
  request: UsearchAnnSearchRequest,
): Promise<SearchIndex | UsearchAnnSearchResult> {
  const threshold = request.exactScanThreshold ?? DEFAULT_EXACT_SCAN_THRESHOLD;
  const maxBytes = Math.min(
    request.maxIndexBytes ?? DEFAULT_MAX_INDEX_BYTES,
    DEFAULT_MAX_INDEX_BYTES,
  );
  if (request.partition.rowCount > threshold) {
    // KEIKO-0409: the runtime-availability check runs first so a swapped-out or missing
    // native addon can never be masked by a stale in-memory index cache. The SHA-256
    // cost that motivated the finding is neutralised by memoization inside targetRuntime()
    // (keyed on the resolved (path, mtimeMs, size)), so a warm hit no longer re-reads the
    // multi-MB addon on the Node.js event loop.
    const runtime = targetRuntime(request.binaryPath);
    if (runtime === "unavailable") return { ok: false, reason: "runtime-unavailable" };
    if (runtime === "invalid") return { ok: false, reason: "runtime-integrity-failed" };
  }
  const cached = cachedIndex(request, maxBytes);
  if (cached !== undefined) return cached;
  return await enqueueIndexBuild(request, request.partition.rowCount <= threshold, maxBytes);
}

function allIndexes(rowCount: number): readonly number[] {
  return Array.from({ length: rowCount }, (_, index) => index);
}

function exactSearch(request: UsearchAnnSearchRequest, index: ExactIndex): UsearchAnnSearchResult {
  return {
    ok: true,
    mode: "exact",
    candidates: scoreIndexes(
      index,
      request.partition.identity,
      request.queryVector,
      allIndexes(request.partition.rowCount),
      request.candidateLimit,
    ),
    examinedCandidates: request.partition.rowCount,
    estimatedIndexBytes: index.byteSize,
  };
}

function annCandidateCount(request: UsearchAnnSearchRequest): number {
  return Math.min(
    request.partition.rowCount,
    HNSW_MAX_RESULTS,
    Math.max(
      request.candidateLimit * HNSW_OVERFETCH_MULTIPLIER,
      request.candidateLimit + HNSW_OVERFETCH_EXTRA,
    ),
  );
}

function discardAnnIndex(index: AnnIndex): UsearchAnnSearchResult {
  index.available = false;
  for (const [key, cached] of INDEX_CACHE) {
    if (cached.index !== index) continue;
    INDEX_CACHE.delete(key);
    cachedIndexBytes -= cached.index.byteSize;
    break;
  }
  void index.worker.terminate();
  return { ok: false, reason: "index-query-failed" };
}

function validAnnRowIndexes(rowIndexes: readonly number[], rowCount: number): boolean {
  const seen = new Set<number>();
  for (const rowIndex of rowIndexes) {
    if (!Number.isSafeInteger(rowIndex) || rowIndex < 0 || rowIndex >= rowCount) return false;
    if (seen.has(rowIndex)) return false;
    seen.add(rowIndex);
  }
  return true;
}

async function waitForResponse(index: AnnIndex, sequence: number): Promise<boolean> {
  return await waitForWorkerMessage(
    index.worker,
    (message) => message.kind === "search-complete" && message.sequence === sequence,
    QUERY_TIMEOUT_MS,
  );
}

async function annSearchExclusive(
  request: UsearchAnnSearchRequest,
  index: AnnIndex,
): Promise<UsearchAnnSearchResult> {
  if (!index.available) return { ok: false, reason: "index-query-failed" };
  const { control, query, resultKeys } = index.buffers;
  const candidateCount = annCandidateCount(request);
  query.set(request.queryVector);
  Atomics.add(control, USEARCH_CONTROL.requestSequence, 1);
  const sequence = Atomics.load(control, USEARCH_CONTROL.requestSequence);
  const response = waitForResponse(index, sequence);
  Atomics.store(control, USEARCH_CONTROL.candidateLimit, candidateCount);
  Atomics.store(control, USEARCH_CONTROL.error, USEARCH_ERROR.none);
  Atomics.store(control, USEARCH_CONTROL.command, USEARCH_COMMAND.search);
  Atomics.notify(control, USEARCH_CONTROL.command);
  if (!(await response)) return discardAnnIndex(index);
  if (Atomics.load(control, USEARCH_CONTROL.error) !== USEARCH_ERROR.none) {
    return discardAnnIndex(index);
  }
  const count = Atomics.load(control, USEARCH_CONTROL.resultCount);
  if (count < 0 || count > candidateCount) return discardAnnIndex(index);
  const rowIndexes = Array.from(resultKeys.subarray(0, count), Number);
  if (!validAnnRowIndexes(rowIndexes, request.partition.rowCount)) return discardAnnIndex(index);
  return {
    ok: true,
    mode: "ann",
    candidates: scoreIndexes(
      index,
      request.partition.identity,
      request.queryVector,
      rowIndexes,
      request.candidateLimit,
    ),
    examinedCandidates: count,
    estimatedIndexBytes: index.byteSize,
  };
}

function annSearch(
  request: UsearchAnnSearchRequest,
  index: AnnIndex,
): Promise<UsearchAnnSearchResult> {
  const queued = queuedOperation(
    index.queryQueue,
    async () => await annSearchExclusive(request, index),
  );
  index.queryQueue = queued.tail;
  return queued.result;
}

function validPartitionKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096;
}

function validPartitionDimensions(dimensions: number): boolean {
  return Number.isSafeInteger(dimensions) && dimensions > 0 && dimensions <= 65_536;
}

function validPartition(partition: UsearchAnnPartition): boolean {
  return (
    validPartitionKey(partition.cacheKey) &&
    validPartitionKey(partition.cacheGroupKey) &&
    validPartitionKey(partition.revision) &&
    Number.isSafeInteger(partition.rowCount) &&
    partition.rowCount >= 0 &&
    validPartitionDimensions(partition.identity.vectorDimensions)
  );
}

function validOptionalBound(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= 0);
}

function invalidRequestReason(
  request: UsearchAnnSearchRequest,
): UsearchAnnSearchResult | undefined {
  if (
    !Number.isSafeInteger(request.candidateLimit) ||
    request.candidateLimit <= 0 ||
    request.candidateLimit > HNSW_MAX_RESULTS ||
    !validOptionalBound(request.exactScanThreshold) ||
    !validOptionalBound(request.maxIndexBytes) ||
    !finiteVector(request.queryVector) ||
    vectorNorm(request.queryVector) === 0
  ) {
    return { ok: false, reason: "invalid-query" };
  }
  if (!validPartition(request.partition)) return { ok: false, reason: "invalid-partition" };
  if (request.queryVector.length !== request.partition.identity.vectorDimensions) {
    return { ok: false, reason: "query-dimension-mismatch" };
  }
  return undefined;
}

export async function searchUsearchAnnIndex(
  request: UsearchAnnSearchRequest,
): Promise<UsearchAnnSearchResult> {
  const invalid = invalidRequestReason(request);
  if (invalid !== undefined) return invalid;
  const threshold = request.exactScanThreshold ?? DEFAULT_EXACT_SCAN_THRESHOLD;
  if (
    request.partition.rowCount > threshold &&
    request.partition.identity.vectorMetric !== "cosine"
  ) {
    return { ok: false, reason: "unsupported-metric" };
  }
  const index = await resolvedIndex(request);
  if ("ok" in index) return index;
  return index.mode === "exact" ? exactSearch(request, index) : await annSearch(request, index);
}

export function clearUsearchAnnCacheForTests(): void {
  for (const key of Array.from(INDEX_CACHE.keys())) removeCached(key);
  cachedIndexBytes = 0;
}

export function clearUsearchAnnCacheForGroup(groupKey: string): void {
  for (const [key, cached] of INDEX_CACHE) {
    if (cached.groupKey === groupKey) removeCached(key);
  }
}

export const USEARCH_ANN_PROFILE = Object.freeze({
  provider: "usearch",
  version:
    usearchRuntimeApproval(usearchRuntimeTargetKey(process.platform, process.arch))?.version ??
    USEARCH_RUNTIME_MANIFEST.version,
  algorithm: "hnsw",
  connectivity: HNSW_CONNECTIVITY,
  expansionAdd: HNSW_EXPANSION_ADD,
  expansionSearch: HNSW_EXPANSION_SEARCH,
  exactScanThreshold: DEFAULT_EXACT_SCAN_THRESHOLD,
});
