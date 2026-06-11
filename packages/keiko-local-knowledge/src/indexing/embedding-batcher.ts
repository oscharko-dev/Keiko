// Embedding batcher (Epic #189, Issue #196). Given a batch of chunks already projected to
// their excerpt text, this module:
//
//   1. Issues N concurrent requests through the injected `OpenAIEmbeddingAdapter`, bounded
//      by `EmbedBatchOptions.concurrency` (hard-capped to 4 by the orchestrator).
//   2. For EACH successful response, computes the adapter's reported identity and runs
//      `assertCompatibleEmbeddingIdentity` against the capsule's pinned identity. The first
//      structural mismatch aborts the batch with `INCOMPATIBLE_EMBEDDING_IDENTITY` and the
//      orchestrator marks the job as failed — NO vectors from the batch are persisted.
//   3. Persists the surviving chunks' embeddings inside a single transaction so a partial
//      batch failure cannot leave vectors and chunks out of sync.
//
// The identity check is the load-bearing invariant from #192. Removing it would let a
// capsule pinned to dim=1536 silently accept dim=768 rows — see test #5.

import type {
  EmbeddingModelIdentity,
  IndexingJobError,
  VectorRecord,
} from "@oscharko-dev/keiko-contracts";
import { assertCompatibleEmbeddingIdentity } from "@oscharko-dev/keiko-model-gateway";
import type {
  OpenAIEmbeddingAdapter,
  OpenAIEmbeddingErrorKind,
  OpenAIEmbeddingOutcome,
  OpenAIEmbeddingSuccess,
} from "@oscharko-dev/keiko-model-gateway";

import { composeVectorRecord, insertVectorRow } from "./vector-persist.js";
import {
  IndexingError,
  type ChunkToEmbed,
  type EmbedBatchOptions,
  type EmbedBatchResult,
} from "./types.js";
import type { KnowledgeStore } from "../store.js";
import { chunkDedupeKey } from "../chunking/chunker.js";

// ─── Concurrency primitive ───────────────────────────────────────────────────
// Hand-rolled bounded-concurrency runner. Avoids pulling in `p-limit` (the local-knowledge
// package's runtime-deps surface stays narrow per ADR-0019-3e). Order of `inputs` is
// preserved in `outputs` even though completion order may differ.
async function runBounded<T, R>(
  inputs: readonly T[],
  concurrency: number,
  work: (input: T, index: number) => Promise<R>,
): Promise<readonly R[]> {
  const limit = Math.max(1, Math.floor(concurrency));
  const outputs: R[] = new Array<R>(inputs.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < inputs.length) {
      const i = nextIndex;
      nextIndex += 1;
      const input = inputs[i] as T;
      outputs[i] = await work(input, i);
    }
  }
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, inputs.length); i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return outputs;
}

// ─── Adapter → outcome plumbing ──────────────────────────────────────────────
// `modelId` is required by the OpenAIEmbeddingRequest contract; the batcher fills it from
// the capsule's pinned identity so a single batch never queries multiple models. The
// adapter's `signal`, `apiKeyHeaderName`, and timeout defaults are honoured via the
// optional-spread pattern (the strict `exactOptionalPropertyTypes` mode forbids passing
// `undefined` for an optional property).
async function embedSingleChunkWithModel(
  adapter: OpenAIEmbeddingAdapter,
  chunk: ChunkToEmbed,
  pinnedIdentity: EmbeddingModelIdentity,
  signal: AbortSignal | undefined,
): Promise<OpenAIEmbeddingOutcome> {
  return adapter.request({
    endpoint: adapter.endpoint,
    apiKey: adapter.apiKey,
    ...(adapter.apiKeyHeaderName !== undefined
      ? { apiKeyHeaderName: adapter.apiKeyHeaderName }
      : {}),
    modelId: pinnedIdentity.modelId,
    input: chunk.text,
    ...(signal !== undefined ? { signal } : {}),
  });
}

// ─── Transient-failure retry ─────────────────────────────────────────────────
// Only network-flavoured failures are worth retrying. Auth (`wrong-header`),
// `unsupported-model`, and `invalid-response` are deterministic — retrying them burns
// the budget without any chance of recovery. `cancelled` is the caller's own abort.
const TRANSIENT_EMBED_KINDS: ReadonlySet<OpenAIEmbeddingErrorKind> =
  new Set<OpenAIEmbeddingErrorKind>(["rate-limited", "timeout", "transport"]);

const DEFAULT_EMBED_MAX_RETRIES = 2;
const DEFAULT_EMBED_BASE_DELAY_MS = 200;
const MAX_EMBED_BACKOFF_MS = 5_000;

function isTransientOutcome(outcome: OpenAIEmbeddingOutcome): boolean {
  return !outcome.ok && TRANSIENT_EMBED_KINDS.has(outcome.kind);
}

function backoffMs(attempt: number, base: number): number {
  return Math.min(base * 2 ** (attempt - 1), MAX_EMBED_BACKOFF_MS);
}

// Cancellable default sleep. Rejects on abort so the retry loop can bail out of its backoff
// the moment the caller cancels rather than waiting out the full delay.
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) {
    return Promise.reject(new DOMException("aborted", "AbortError"));
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface ResolvedRetry {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function resolveRetry(retry: EmbedBatchOptions["retry"]): ResolvedRetry {
  return {
    maxRetries: retry?.maxRetries ?? DEFAULT_EMBED_MAX_RETRIES,
    baseDelayMs: retry?.baseDelayMs ?? DEFAULT_EMBED_BASE_DELAY_MS,
    sleep: retry?.sleep ?? defaultSleep,
  };
}

async function embedChunkWithRetry(
  options: EmbedBatchOptions,
  chunk: ChunkToEmbed,
): Promise<OpenAIEmbeddingOutcome> {
  const retry = resolveRetry(options.retry);
  let outcome = await embedSingleChunkWithModel(
    options.adapter,
    chunk,
    options.pinnedIdentity,
    options.signal,
  );
  for (let attempt = 1; attempt <= retry.maxRetries; attempt += 1) {
    if (!isTransientOutcome(outcome) || options.signal?.aborted === true) {
      return outcome;
    }
    try {
      await retry.sleep(backoffMs(attempt, retry.baseDelayMs), options.signal);
    } catch {
      return outcome; // aborted mid-backoff; the abort gate converts this to CANCELLED
    }
    outcome = await embedSingleChunkWithModel(
      options.adapter,
      chunk,
      options.pinnedIdentity,
      options.signal,
    );
  }
  return outcome;
}

// ─── Identity verification ───────────────────────────────────────────────────
function identityFromAdapter(
  pinned: EmbeddingModelIdentity,
  success: OpenAIEmbeddingSuccess,
): EmbeddingModelIdentity {
  // `provider` and `vectorMetric` are not echoed by the OpenAI API response — they come from
  // the operator's pinned identity. Only `modelId`, `modelRevision`, and `vectorDimensions`
  // are observed from the adapter's outcome. Identity-compatibility checks the structural
  // tuple (provider+modelId+dims+metric), so the constructed identity only loses fidelity
  // on `modelRevision` (which the compatibility check treats as a warning, not a failure).
  return {
    provider: pinned.provider,
    modelId: success.modelId,
    vectorDimensions: success.vector.length,
    vectorMetric: pinned.vectorMetric,
    ...(success.modelRevision !== undefined ? { modelRevision: success.modelRevision } : {}),
  };
}

// ─── Float32 → byte serialisation ────────────────────────────────────────────
// The schema column is BLOB; SQLite expects a Uint8Array. We copy the underlying
// ArrayBuffer rather than aliasing it (Float32Array views can share buffers) so the
// persisted row is a stable copy not affected by any later vector reuse.
function floatToBytes(vector: Float32Array): Uint8Array {
  return new Uint8Array(
    vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength),
  );
}

// ─── Per-chunk outcome envelope ──────────────────────────────────────────────
type ChunkOutcome =
  | { readonly ok: true; readonly chunk: ChunkToEmbed; readonly success: OpenAIEmbeddingSuccess }
  | { readonly ok: false; readonly chunk: ChunkToEmbed; readonly error: IndexingJobError };

interface UniqueChunkRequest {
  readonly key: string;
  readonly representative: ChunkToEmbed;
  readonly chunks: readonly ChunkToEmbed[];
}

function dedupeEmbeddingRequests(chunks: readonly ChunkToEmbed[]): readonly UniqueChunkRequest[] {
  const byKey = new Map<string, { representative: ChunkToEmbed; chunks: ChunkToEmbed[] }>();
  for (const chunk of chunks) {
    const key = chunkDedupeKey(chunk.text) ?? `chunk:${String(chunk.id)}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, { representative: chunk, chunks: [chunk] });
    } else {
      existing.chunks.push(chunk);
    }
  }
  return [...byKey.entries()].map(([key, value]) => ({ key, ...value }));
}

function outcomeForChunk(outcome: ChunkOutcome, chunk: ChunkToEmbed): ChunkOutcome {
  if (outcome.ok) {
    return { ok: true, chunk, success: outcome.success };
  }
  return { ok: false, chunk, error: outcome.error };
}

function errorFromOutcome(
  outcome: Extract<OpenAIEmbeddingOutcome, { ok: false }>,
): IndexingJobError {
  return {
    code: "EMBEDDING_ADAPTER_FAILED",
    message: `embedding adapter returned ${outcome.kind}`,
  };
}

function checkAbort(signal: AbortSignal | undefined): IndexingJobError | undefined {
  if (signal?.aborted === true) {
    return { code: "CANCELLED", message: "indexing aborted via AbortSignal" };
  }
  return undefined;
}

interface BuildOutcomesState {
  identityFailure: IndexingJobError | undefined;
}

async function buildUniqueChunkOutcome(
  request: UniqueChunkRequest,
  options: EmbedBatchOptions,
  state: BuildOutcomesState,
): Promise<ChunkOutcome> {
  if (state.identityFailure !== undefined) {
    return { ok: false, chunk: request.representative, error: state.identityFailure };
  }
  const abortError = checkAbort(options.signal);
  if (abortError !== undefined) {
    return { ok: false, chunk: request.representative, error: abortError };
  }
  const outcome = await embedChunkWithRetry(options, request.representative);
  if (!outcome.ok) {
    return { ok: false, chunk: request.representative, error: errorFromOutcome(outcome) };
  }
  const observed = identityFromAdapter(options.pinnedIdentity, outcome.value);
  const compat = assertCompatibleEmbeddingIdentity(options.pinnedIdentity, observed);
  if (!compat.ok) {
    state.identityFailure = {
      code: "INCOMPATIBLE_EMBEDDING_IDENTITY",
      message: compat.safeMessage,
    };
    return { ok: false, chunk: request.representative, error: state.identityFailure };
  }
  return { ok: true, chunk: request.representative, success: outcome.value };
}

function expandUniqueOutcomes(
  uniqueRequests: readonly UniqueChunkRequest[],
  uniqueOutcomes: readonly ChunkOutcome[],
): readonly ChunkOutcome[] {
  const outcomes: ChunkOutcome[] = [];
  for (let i = 0; i < uniqueRequests.length; i += 1) {
    const request = uniqueRequests[i];
    const outcome = uniqueOutcomes[i];
    if (request === undefined || outcome === undefined) continue;
    for (const chunk of request.chunks) {
      outcomes.push(outcomeForChunk(outcome, chunk));
    }
  }
  return outcomes;
}

// Build all per-chunk outcomes BEFORE we open a write transaction. The identity gate runs
// after every successful response so we fail fast on dimension mismatch.
async function buildChunkOutcomes(
  chunks: readonly ChunkToEmbed[],
  options: EmbedBatchOptions,
): Promise<{
  readonly outcomes: readonly ChunkOutcome[];
  readonly identityFailure?: IndexingJobError;
}> {
  const state: BuildOutcomesState = { identityFailure: undefined };
  const uniqueRequests = dedupeEmbeddingRequests(chunks);
  const uniqueOutcomes = await runBounded(uniqueRequests, options.concurrency, async (request) => {
    return buildUniqueChunkOutcome(request, options, state);
  });
  const outcomes = expandUniqueOutcomes(uniqueRequests, uniqueOutcomes);
  return state.identityFailure === undefined
    ? { outcomes }
    : { outcomes, identityFailure: state.identityFailure };
}

// ─── Persistence boundary ─────────────────────────────────────────────────────
// Wraps the row inserts in a single transaction so a partial INSERT failure rolls back the
// whole batch. The orchestrator marks the document as failed; subsequent runs can retry.
function persistOutcomes(
  store: KnowledgeStore,
  outcomes: readonly ChunkOutcome[],
  pinnedIdentity: EmbeddingModelIdentity,
  idSource: () => string,
  now: () => number,
): readonly VectorRecord[] {
  const db = store._internal.db;
  const persisted: VectorRecord[] = [];
  db.exec("BEGIN");
  try {
    for (const out of outcomes) {
      if (!out.ok) continue;
      const observed = identityFromAdapter(pinnedIdentity, out.success);
      const row = {
        id: `vec:${String(out.chunk.id)}` as VectorRecord["id"],
        capsuleId: out.chunk.capsuleId,
        sourceId: out.chunk.sourceId,
        documentId: out.chunk.documentId,
        chunkId: out.chunk.id,
        embedding: floatToBytes(out.success.vector),
        identity: observed,
        storageReference: idSource(),
        createdAt: now(),
      };
      insertVectorRow(db, row);
      persisted.push(composeVectorRecord(row));
    }
    db.exec("COMMIT");
  } catch (cause) {
    db.exec("ROLLBACK");
    throw new IndexingError(
      "PERSISTENCE_FAILED",
      "vector persistence failed mid-batch",
      cause === undefined ? undefined : { cause },
    );
  }
  return persisted;
}

// ─── Public entrypoint ───────────────────────────────────────────────────────
export async function embedChunkBatch(
  chunks: readonly ChunkToEmbed[],
  options: EmbedBatchOptions,
): Promise<EmbedBatchResult> {
  if (chunks.length === 0) {
    return { vectors: [], errors: [] };
  }
  const { outcomes, identityFailure } = await buildChunkOutcomes(chunks, options);
  const errors = outcomes
    .filter((o): o is Extract<ChunkOutcome, { ok: false }> => !o.ok)
    .map((o) => o.error);

  // Identity drift OR cancellation: refuse to persist ANY row from this batch.
  if (identityFailure !== undefined) {
    return { vectors: [], errors };
  }
  const abortError = checkAbort(options.signal);
  if (abortError !== undefined) {
    return { vectors: [], errors: [...errors, abortError] };
  }

  const vectors = persistOutcomes(
    options.store,
    outcomes,
    options.pinnedIdentity,
    options.idSource,
    options.now,
  );
  return { vectors, errors };
}
