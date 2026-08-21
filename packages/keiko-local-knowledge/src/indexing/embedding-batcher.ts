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
  KnowledgeCapsuleId,
  VectorRecord,
} from "@oscharko-dev/keiko-contracts";
import {
  assertCompatibleEmbeddingIdentity,
  EMBEDDING_NORMALIZATION,
  l2NormalizeVector,
} from "@oscharko-dev/keiko-model-gateway";
import type {
  OpenAIEmbeddingAdapter,
  OpenAIEmbeddingBatchOutcome,
  OpenAIEmbeddingBatchRequest,
  OpenAIEmbeddingErrorKind,
  OpenAIEmbeddingOutcome,
  OpenAIEmbeddingSuccess,
} from "@oscharko-dev/keiko-model-gateway";

import {
  composeVectorRecord,
  insertVectorRow,
  invalidateVectorIndexStateForCapsules,
} from "./vector-persist.js";
import {
  IndexingError,
  type ChunkToEmbed,
  type EmbedBatchOptions,
  type EmbedBatchResult,
  type IndexingLogContext,
} from "./types.js";
import type { KnowledgeStore } from "../store.js";
import { chunkDedupeKey } from "../chunking/chunker.js";
import {
  emitKnowledgeLogEvent,
  knowledgeErrorKind,
  startKnowledgeLogTimer,
  type KnowledgeLogEvent,
  type KnowledgeLogLevel,
} from "../knowledge-log.js";
import { conservativeTokenEstimatorTokenizer } from "../chunking/token-estimator.js";

// ─── Activity log ────────────────────────────────────────────────────────────
// Every line this module writes is content-free: counts, byte-free sizes, durations, HTTP
// statuses, error kinds, and vector dimensions. Chunk text and embeddings never appear. The
// sink is optional and defaults to nothing, so an unwired caller pays a single undefined check.

// `scheme://host[:port]` and nothing else — no userinfo, no path, no query, no fragment. The
// endpoint is what separates "the operator pointed the Pod at a gateway that is not there" from
// "the configured gateway is slow", and it is the field an operator reads first next to
// `durationMs`; the path and query are where a provider URL historically carried a deployment
// id, an api-version, or an outright credential, so they are dropped rather than redacted. An
// unparseable endpoint yields `undefined` instead of echoing the raw string back.
//
// This deliberately mirrors `logEndpointHost` in `keiko-model-gateway/src/observability.ts`,
// which is not on that package's public barrel — importing it would mean widening another
// package's exported surface (and its packaged-surface contract) from here.
export function embeddingEndpointHost(endpoint: string | undefined): string | undefined {
  if (endpoint === undefined) return undefined;
  try {
    const parsed = new URL(endpoint);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return undefined;
  }
}

// The correlation fields ride in `extra` rather than replacing `correlationId`, which carries
// the job id alone so an operator can grep one run out of a file interleaving four of them.
function correlationExtra(
  context: IndexingLogContext | undefined,
): Readonly<Record<string, unknown>> {
  if (context === undefined) return {};
  return {
    capsuleIdDigest: context.capsuleIdDigest,
    ...(context.documentIdDigest !== undefined
      ? { documentIdDigest: context.documentIdDigest }
      : {}),
  };
}

function logEmbedding(
  options: EmbedBatchOptions,
  event: Omit<KnowledgeLogEvent, "category" | "correlationId">,
): void {
  const sink = options.logSink;
  if (sink === undefined) return;
  const context = options.logContext;
  const extra = { ...correlationExtra(context), ...event.extra };
  // A throwing sink must not escape into the retry ladder, the pinned-identity gate, or
  // `persistAndReport`: those read their own control flow from what the adapter returned, and a
  // logging failure landing there would be accounted as an embedding failure. `emitKnowledgeLogEvent`
  // also makes a permanently failing sink report itself once — see `knowledge-log.ts`.
  emitKnowledgeLogEvent(sink, {
    ...event,
    category: "embedding",
    ...(context !== undefined ? { correlationId: context.jobId } : {}),
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  });
}

// Omitted rather than written as `undefined` when the endpoint does not parse: a field that is
// present but empty reads as "the gateway has no host", which is a different diagnosis.
function endpointExtra(options: EmbedBatchOptions): Readonly<Record<string, unknown>> {
  const host = embeddingEndpointHost(options.adapter.endpoint);
  return host === undefined ? {} : { endpointHost: host };
}

// One shape for both transports' retry lines. The `ok` guard is what narrows the union down to
// the failure variants that actually carry `kind` and `status`.
//
// `durationMs` and `endpointHost` are on every one of them because without the pair a hang is
// unreadable: "refused instantly" (a gateway that is not listening, ~0 ms) and "burned the full
// provider deadline" (a gateway that accepted the connection and never answered, ~60 s) produce
// the SAME error kind, and telling them apart is the whole diagnosis during the six-minute stall
// this instrumentation exists for.
function logEmbeddingRetry(
  options: EmbedBatchOptions,
  outcome: OpenAIEmbeddingOutcome | OpenAIEmbeddingBatchOutcome,
  op: string,
  durationMs: number,
  extra: Readonly<Record<string, unknown>>,
): void {
  if (outcome.ok) return;
  logEmbedding(options, {
    level: "warn",
    op,
    errorKind: outcome.kind,
    status: outcome.status,
    durationMs,
    extra: { ...extra, ...endpointExtra(options) },
  });
}

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
  logContext: IndexingLogContext | undefined,
): Promise<OpenAIEmbeddingOutcome> {
  return adapter.request({
    endpoint: adapter.endpoint,
    apiKey: adapter.apiKey,
    ...(adapter.apiKeyHeaderName !== undefined
      ? { apiKeyHeaderName: adapter.apiKeyHeaderName }
      : {}),
    modelId: pinnedIdentity.modelId,
    input: chunk.text,
    ...(pinnedIdentity.dimensionsParam !== undefined
      ? { dimensions: pinnedIdentity.dimensionsParam }
      : {}),
    ...(signal !== undefined ? { signal } : {}),
    // Same join key as the batch path above.
    ...(logContext === undefined ? {} : { logContext: { correlationId: logContext.jobId } }),
  });
}

// ─── Transient-failure retry ─────────────────────────────────────────────────
// Only network-flavoured failures are worth retrying. Auth (`wrong-header`),
// `unsupported-model`, and `invalid-response` are deterministic — retrying them burns
// the budget without any chance of recovery. `cancelled` is the caller's own abort.
const TRANSIENT_EMBED_KINDS: ReadonlySet<OpenAIEmbeddingErrorKind> =
  new Set<OpenAIEmbeddingErrorKind>(["rate-limited", "timeout", "transport"]);

const DEFAULT_EMBED_MAX_RETRIES = 6;
const DEFAULT_EMBED_BASE_DELAY_MS = 500;
const MAX_EMBED_BACKOFF_MS = 30_000;

// A 5xx answer — and the two answered-timeout statuses 408/425 — is as transient as a torn
// connection; every other 4xx is a deterministic rejection of this request shape and retrying
// it only burns the budget (under the old everything-is-transport classification a 400 was
// retried through the full backoff schedule).
function isTransientFailure(kind: OpenAIEmbeddingErrorKind, status: number | undefined): boolean {
  if (TRANSIENT_EMBED_KINDS.has(kind)) return true;
  if (kind !== "http-error" || status === undefined) return false;
  return status >= 500 || status === 408 || status === 425;
}

function isTransientOutcome(outcome: OpenAIEmbeddingOutcome): boolean {
  return !outcome.ok && isTransientFailure(outcome.kind, outcome.status);
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

// One timed attempt. The duration measured here is the ADAPTER call alone — backoff is excluded
// so `durationMs` answers "how long did the gateway take to fail?" rather than "how long has
// this loop been running?", which is the number that separates a refusal from a deadline.
interface TimedOutcome<T> {
  readonly outcome: T;
  readonly durationMs: number;
}

async function timedAttempt<T>(call: () => Promise<T>): Promise<TimedOutcome<T>> {
  const elapsed = startKnowledgeLogTimer();
  const outcome = await call();
  return { outcome, durationMs: elapsed() };
}

// `attempt` MEANS THE SAME THING ON BOTH TRANSPORTS: adapter round-trips issued so far. It is a
// field an operator greps across the whole log, so it may not be a loop index here and a count
// there. This path used to log the loop's retry number, and on exhaustion `retry.maxRetries` — the
// BUDGET, which is the exact defect the array-batch counter in `BatchRetryState` was introduced to
// fix, and it read one lower than the round-trips actually spent because the first call is not a
// retry. `maxRetries` remains the separate budget field, so "2 of 3 round-trips, budget 2" stays
// readable on one line.
async function embedChunkWithRetry(
  options: EmbedBatchOptions,
  chunk: ChunkToEmbed,
): Promise<OpenAIEmbeddingOutcome> {
  const retry = resolveRetry(options.retry);
  let attempts = 0;
  const attemptOnce = async (): Promise<TimedOutcome<OpenAIEmbeddingOutcome>> => {
    attempts += 1;
    return timedAttempt(async () =>
      embedSingleChunkWithModel(
        options.adapter,
        chunk,
        options.pinnedIdentity,
        options.signal,
        options.logContext,
      ),
    );
  };
  let attempted = await attemptOnce();
  for (let retryNumber = 1; retryNumber <= retry.maxRetries; retryNumber += 1) {
    if (!isTransientOutcome(attempted.outcome) || options.signal?.aborted === true) {
      return attempted.outcome;
    }
    const delayMs = backoffMs(retryNumber, retry.baseDelayMs);
    logEmbeddingRetry(options, attempted.outcome, "embedding.chunk.retry", attempted.durationMs, {
      attempt: attempts,
      maxRetries: retry.maxRetries,
      delayMs,
      transport: "scalar",
    });
    try {
      await retry.sleep(delayMs, options.signal);
    } catch {
      return attempted.outcome; // aborted mid-backoff; the abort gate converts this to CANCELLED
    }
    attempted = await attemptOnce();
  }
  logEmbeddingRetry(
    options,
    attempted.outcome,
    "embedding.chunk.retry-exhausted",
    attempted.durationMs,
    { attempt: attempts, maxRetries: retry.maxRetries, transport: "scalar" },
  );
  return attempted.outcome;
}

// ─── Array-batch embedding (#189 GRD-004) ────────────────────────────────────
// When the adapter exposes `requestBatch`, embed many unique chunks per HTTP round-trip.
// Items per request are bounded so a single response stays well under the gateway's 10 MB
// JSON cap (96 × 3072 float32 ≈ 4.4 MB) and inside provider per-request token limits.
const BATCH_ITEM_CAP = 96;
const BATCH_CHAR_CAP = 120_000;
const QWEN3_EMBEDDING_INPUT_TOKEN_CAP = 32_000;
const BATCH_TOKEN_CAP = 30_000;

function groupIntoBatches(
  requests: readonly UniqueChunkRequest[],
  options: EmbedBatchOptions,
): readonly (readonly UniqueChunkRequest[])[] {
  const tokenizer = options.tokenizer ?? conservativeTokenEstimatorTokenizer;
  const batches: UniqueChunkRequest[][] = [];
  let current: UniqueChunkRequest[] = [];
  let currentChars = 0;
  let currentTokens = 0;
  for (const request of requests) {
    const len = request.representative.text.length;
    const tokens = tokenizer.countTokens(request.representative.text);
    if (
      current.length > 0 &&
      (current.length >= BATCH_ITEM_CAP ||
        currentChars + len > BATCH_CHAR_CAP ||
        currentTokens + tokens > BATCH_TOKEN_CAP)
    ) {
      batches.push(current);
      current = [];
      currentChars = 0;
      currentTokens = 0;
    }
    current.push(request);
    currentChars += len;
    currentTokens += Math.min(tokens, QWEN3_EMBEDDING_INPUT_TOKEN_CAP);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function tokenBudgetErrorOutcomes(
  requests: readonly UniqueChunkRequest[],
  cause: unknown,
): readonly ChunkOutcome[] {
  const message = cause instanceof Error ? cause.message : "unknown tokenizer error";
  const error: IndexingJobError = {
    code: "CHUNKING_FAILED",
    message: `tokenizer failed during embedding batch budgeting: ${message}`,
  };
  return requests.map((request) => ({ ok: false, chunk: request.representative, error }));
}

function isTransientBatchOutcome(outcome: OpenAIEmbeddingBatchOutcome): boolean {
  return !outcome.ok && isTransientFailure(outcome.kind, outcome.status);
}

// The HTTP status is content-free operator telemetry and the one number that separates "the
// gateway rejected this request shape" (e.g. an oversized batch → 400) from every other
// failure, so it survives into the persisted document/job error exactly like it does in the
// preflight and readiness safe messages.
function errorFromKind(kind: OpenAIEmbeddingErrorKind, status?: number): IndexingJobError {
  const detail = status !== undefined ? `${kind} (HTTP ${String(status)})` : kind;
  return {
    code: "EMBEDDING_ADAPTER_FAILED",
    message: `embedding adapter returned ${detail}`,
    // The same classification the retry loop used: a transient failure that exhausted its
    // retries is gateway-outage evidence the orchestrator's circuit breaker may count; a
    // deterministic rejection is not.
    ...(isTransientFailure(kind, status) ? { transient: true } : {}),
  };
}

function batchRequestFor(
  options: EmbedBatchOptions,
  inputs: readonly string[],
): OpenAIEmbeddingBatchRequest {
  const adapter = options.adapter;
  return {
    endpoint: adapter.endpoint,
    apiKey: adapter.apiKey,
    ...(adapter.apiKeyHeaderName !== undefined
      ? { apiKeyHeaderName: adapter.apiKeyHeaderName }
      : {}),
    modelId: options.pinnedIdentity.modelId,
    inputs,
    ...(options.pinnedIdentity.dimensionsParam !== undefined
      ? { dimensions: options.pinnedIdentity.dimensionsParam }
      : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    // The gateway writes ~150 of the ~168 lines an indexing incident produces. Without this the
    // outbound half of the file carries no correlation id and cannot be joined to the knowledge
    // lines that caused it — two disjoint islands the moment concurrency puts a second document
    // in flight. The job id is a uuid and is safe verbatim.
    ...(options.logContext === undefined
      ? {}
      : { logContext: { correlationId: options.logContext.jobId } }),
  };
}

// A transient failure that carries a completed prefix is PROGRESS: absorb it and retry only the
// remainder. Progress resets the retry budget — only zero-progress attempts may burn it — so the
// loop always terminates (the prefix grows at most inputs.length times) yet never abandons a
// batch that is advancing. Without this, a scalar-ladder deadline expiry was classified
// transient and every retry re-ran the identical full input list, discarding every finished
// embedding each round: non-convergent whenever inputCount x per-item latency exceeds the
// ladder cap (the 0.3.11 endless-indexing shape, one cap higher).
function absorbPartialProgress(
  outcome: OpenAIEmbeddingBatchOutcome,
  completed: OpenAIEmbeddingSuccess[],
  remaining: readonly string[],
): readonly string[] | undefined {
  if (outcome.ok || outcome.partial === undefined || outcome.partial.length === 0) {
    return undefined;
  }
  completed.push(...outcome.partial);
  return remaining.slice(outcome.partial.length);
}

function mergeCompletedPrefix(
  completed: readonly OpenAIEmbeddingSuccess[],
  outcome: OpenAIEmbeddingBatchOutcome,
): OpenAIEmbeddingBatchOutcome {
  if (completed.length === 0 || !outcome.ok) return outcome;
  return { ok: true, value: [...completed, ...outcome.value] };
}

// Mutable bookkeeping for one array-batch retry sequence. Held in a record so the decision
// step below can absorb progress, re-budget, and log in one place — keeping the loop itself
// small enough to read at a glance.
interface BatchRetryState {
  readonly completed: OpenAIEmbeddingSuccess[];
  remaining: readonly string[];
  zeroProgressRetries: number;
  // The number of adapter round-trips issued so far. Distinct from `zeroProgressRetries`, which
  // is a BUDGET that a partial prefix resets to zero: reporting the budget as "attempt" made
  // every `embedding.batch.partial-progress` line read `attempt: 0`, so the one shape an
  // operator most needs to see — a batch grinding forward one item per round-trip — looked like
  // a single first try repeated forever. This counter only ever climbs.
  attempts: number;
}

// Absorb any completed prefix, spend or reset the retry budget, record the decision, and
// return the backoff to wait before the next attempt. A retry that made progress is a
// DIFFERENT event from one that did not: only the second kind can exhaust the budget, and an
// operator watching a long batch needs to tell "advancing slowly" from "wedged".
function advanceBatchRetry(
  options: EmbedBatchOptions,
  attempted: TimedOutcome<OpenAIEmbeddingBatchOutcome>,
  state: BatchRetryState,
  retry: ResolvedRetry,
): number {
  const advanced = absorbPartialProgress(attempted.outcome, state.completed, state.remaining);
  const progressed = advanced !== undefined;
  if (advanced === undefined) {
    state.zeroProgressRetries += 1;
  } else {
    state.remaining = advanced;
    state.zeroProgressRetries = 0;
  }
  const delayMs = backoffMs(progressed ? 1 : state.zeroProgressRetries, retry.baseDelayMs);
  logEmbeddingRetry(
    options,
    attempted.outcome,
    progressed ? "embedding.batch.partial-progress" : "embedding.batch.retry",
    attempted.durationMs,
    {
      attempt: state.attempts,
      zeroProgressRetries: state.zeroProgressRetries,
      maxRetries: retry.maxRetries,
      delayMs,
      remainingCount: state.remaining.length,
      completedCount: state.completed.length,
      transport: "array-batch",
    },
  );
  return delayMs;
}

async function embedArrayBatchWithRetry(
  options: EmbedBatchOptions,
  inputs: readonly string[],
): Promise<OpenAIEmbeddingBatchOutcome> {
  const requestBatch = options.adapter.requestBatch;
  if (requestBatch === undefined) {
    logEmbedding(options, {
      level: "debug",
      op: "embedding.batch.transport-unavailable",
      extra: { itemCount: inputs.length, transport: "array-batch" },
    });
    return { ok: false, kind: "transport" };
  }
  const retry = resolveRetry(options.retry);
  const state: BatchRetryState = {
    completed: [],
    remaining: inputs,
    zeroProgressRetries: 0,
    attempts: 0,
  };
  const attemptOnce = async (): Promise<TimedOutcome<OpenAIEmbeddingBatchOutcome>> => {
    state.attempts += 1;
    return timedAttempt(async () => requestBatch(batchRequestFor(options, state.remaining)));
  };
  let attempted = await attemptOnce();
  while (state.zeroProgressRetries < retry.maxRetries) {
    if (!isTransientBatchOutcome(attempted.outcome) || options.signal?.aborted === true) {
      break;
    }
    const delayMs = advanceBatchRetry(options, attempted, state, retry);
    try {
      await retry.sleep(delayMs, options.signal);
    } catch {
      break; // aborted mid-backoff; the abort gate converts this to CANCELLED
    }
    attempted = await attemptOnce();
  }
  return mergeCompletedPrefix(state.completed, attempted.outcome);
}

// Apply the per-vector identity gate exactly as the scalar path does. Order-independent:
// once `state.identityFailure` is set, embedChunkBatch persists nothing, so which concurrent
// batch first observes the drift is irrelevant to the outcome.
// Both transports reach the identity gate, and both must record the rejection identically —
// so the state mutation AND its log line live here rather than being duplicated at each call
// site. The safe message is deliberately NOT logged: the line carries the two dimensions that
// explain the drift, which is the whole diagnosis and none of the prose.
function recordIdentityFailure(
  options: EmbedBatchOptions,
  state: BuildOutcomesState,
  observed: EmbeddingModelIdentity,
  safeMessage: string,
): IndexingJobError {
  const failure: IndexingJobError = {
    code: "INCOMPATIBLE_EMBEDDING_IDENTITY",
    message: safeMessage,
  };
  state.identityFailure = failure;
  logEmbedding(options, {
    level: "error",
    op: "embedding.identity.rejected",
    errorKind: failure.code,
    extra: {
      pinnedDimensions: options.pinnedIdentity.vectorDimensions,
      observedDimensions: observed.vectorDimensions,
      pinnedNormalization: options.pinnedIdentity.normalization ?? EMBEDDING_NORMALIZATION,
    },
  });
  return failure;
}

function gateVectorOutcome(
  representative: ChunkToEmbed,
  success: OpenAIEmbeddingSuccess,
  options: EmbedBatchOptions,
  state: BuildOutcomesState,
): ChunkOutcome {
  if (state.identityFailure !== undefined) {
    return { ok: false, chunk: representative, error: state.identityFailure };
  }
  const observed = identityFromAdapter(options.pinnedIdentity, success);
  const compat = assertCompatibleEmbeddingIdentity(options.pinnedIdentity, observed);
  if (!compat.ok) {
    const failure = recordIdentityFailure(options, state, observed, compat.safeMessage);
    return { ok: false, chunk: representative, error: failure };
  }
  return { ok: true, chunk: representative, success };
}

async function embedUniqueBatch(
  batch: readonly UniqueChunkRequest[],
  options: EmbedBatchOptions,
  state: BuildOutcomesState,
): Promise<readonly ChunkOutcome[]> {
  if (state.identityFailure !== undefined) {
    const failure = state.identityFailure;
    return batch.map((r) => ({ ok: false as const, chunk: r.representative, error: failure }));
  }
  const abortError = checkAbort(options.signal);
  if (abortError !== undefined) {
    return batch.map((r) => ({ ok: false as const, chunk: r.representative, error: abortError }));
  }
  const attempted = await timedAttempt(async () =>
    embedArrayBatchWithRetry(
      options,
      batch.map((r) => r.representative.text),
    ),
  );
  const outcome = attempted.outcome;
  if (!outcome.ok) {
    const error = errorFromKind(outcome.kind, outcome.status);
    // The duration here spans the whole retry ladder for this batch — backoff included — which
    // is deliberately a different number from the per-attempt duration on the retry lines: it
    // is how long the RUN spent on these items before giving up on them.
    logEmbedding(options, {
      level: "warn",
      op: "embedding.batch.failed",
      errorKind: outcome.kind,
      status: outcome.status,
      durationMs: attempted.durationMs,
      extra: {
        itemCount: batch.length,
        transient: isTransientFailure(outcome.kind, outcome.status),
        transport: "array-batch",
        ...endpointExtra(options),
      },
    });
    return batch.map((r) => ({ ok: false as const, chunk: r.representative, error }));
  }
  return batch.map((request, i) => {
    const success = outcome.value[i];
    if (success === undefined) {
      return {
        ok: false as const,
        chunk: request.representative,
        error: errorFromKind("invalid-response"),
      };
    }
    return gateVectorOutcome(request.representative, success, options, state);
  });
}

// ─── Identity verification ───────────────────────────────────────────────────
// eslint-disable-next-line complexity
function identityFromAdapter(
  pinned: EmbeddingModelIdentity,
  success: OpenAIEmbeddingSuccess,
): EmbeddingModelIdentity {
  // `provider` and `vectorMetric` are not echoed by the OpenAI API response — they come from
  // the operator's pinned identity. LiteLLM can echo the upstream embedding model while the
  // request must keep using the configured model_name route. Treat that echoed upstream id as
  // an alias only when the pinned capsule already recorded it as the expected revision.
  const responseMatchesPinnedRoute = success.modelId === pinned.modelId;
  const responseMatchesPinnedRevision =
    pinned.modelRevision !== undefined && success.modelId === pinned.modelRevision;
  const modelId =
    responseMatchesPinnedRoute || responseMatchesPinnedRevision ? pinned.modelId : success.modelId;
  const modelRevision =
    success.modelRevision ?? (responseMatchesPinnedRevision ? success.modelId : undefined);
  return {
    provider: pinned.provider,
    modelId,
    vectorDimensions: success.vector.length,
    vectorMetric: pinned.vectorMetric,
    ...(modelRevision !== undefined ? { modelRevision } : {}),
    normalization: pinned.normalization ?? EMBEDDING_NORMALIZATION,
    ...(pinned.instructionVersion !== undefined
      ? { instructionVersion: pinned.instructionVersion }
      : {}),
    ...(pinned.embeddingSpaceFingerprint !== undefined
      ? { embeddingSpaceFingerprint: pinned.embeddingSpaceFingerprint }
      : {}),
    ...(pinned.dimensionsParam !== undefined ? { dimensionsParam: pinned.dimensionsParam } : {}),
  };
}

// ─── Float32 → byte serialisation ────────────────────────────────────────────
// The schema column is BLOB; SQLite expects a Uint8Array. We copy the underlying
// ArrayBuffer rather than aliasing it (Float32Array views can share buffers) so the
// persisted row is a stable copy not affected by any later vector reuse.
export function floatToBytes(vector: Float32Array): Uint8Array {
  return new Uint8Array(
    vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength),
  );
}

function persistedVectorForIdentity(
  vector: Float32Array,
  identity: EmbeddingModelIdentity,
): Float32Array {
  return identity.normalization === "l2" ? l2NormalizeVector(vector) : new Float32Array(vector);
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
  return errorFromKind(outcome.kind, outcome.status);
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
    const failure = recordIdentityFailure(options, state, observed, compat.safeMessage);
    return { ok: false, chunk: request.representative, error: failure };
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

// Array-batch path: collapse the unique requests into ceil(N / itemCap) HTTP calls, run those
// calls with bounded concurrency, then flatten back into request order. A tokenizer failure
// while budgeting degrades the WHOLE set to errors without a single request being issued —
// a silent outcome from the event stream's point of view, so it gets its own line.
async function embedViaArrayBatches(
  uniqueRequests: readonly UniqueChunkRequest[],
  options: EmbedBatchOptions,
  state: BuildOutcomesState,
): Promise<readonly ChunkOutcome[]> {
  let batches: readonly (readonly UniqueChunkRequest[])[];
  try {
    batches = groupIntoBatches(uniqueRequests, options);
  } catch (cause) {
    logEmbedding(options, {
      level: "warn",
      op: "embedding.batch.budgeting-failed",
      errorKind: knowledgeErrorKind(cause),
      extra: { uniqueChunkCount: uniqueRequests.length },
    });
    return tokenBudgetErrorOutcomes(uniqueRequests, cause);
  }
  // Info, not debug: the number of HTTP round-trips this flush will issue is the run's request
  // profile. One batch of 96 that never answers and 96 batches of one that each answer are the
  // same chunk count and completely different investigations, and an operator reading the file
  // at the default level must be able to tell which one is in front of them.
  logEmbedding(options, {
    level: "info",
    op: "embedding.batch.grouped",
    extra: {
      uniqueChunkCount: uniqueRequests.length,
      batchCount: batches.length,
      concurrency: options.concurrency,
      ...endpointExtra(options),
    },
  });
  const batchOutcomes = await runBounded(batches, options.concurrency, async (batch) =>
    embedUniqueBatch(batch, options, state),
  );
  return batchOutcomes.flat();
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
  const arrayBatchCapable = typeof options.adapter.requestBatch === "function";
  // Info, not debug. The transport choice is invisible in the job's event stream, yet it decides
  // the whole request profile of the run: scalar issues one HTTP call per unique chunk where
  // array-batch issues one per ~96, so "36 vectors, no progress" means something different under
  // each. The dedupe ratio beside it explains a request count that does not match the chunk
  // count, which otherwise reads as lost work. One line per flush, not per chunk — the per-chunk
  // detail stays at debug.
  logEmbedding(options, {
    level: "info",
    op: "embedding.batch.transport-selected",
    extra: {
      transport: arrayBatchCapable ? "array-batch" : "scalar",
      chunkCount: chunks.length,
      uniqueChunkCount: uniqueRequests.length,
      dedupedCount: chunks.length - uniqueRequests.length,
      concurrency: options.concurrency,
      ...endpointExtra(options),
    },
  });
  // Scalar fallback (adapters/stubs without `requestBatch`): one HTTP call per unique chunk.
  const uniqueOutcomes = arrayBatchCapable
    ? await embedViaArrayBatches(uniqueRequests, options, state)
    : await runBounded(uniqueRequests, options.concurrency, async (request) =>
        buildUniqueChunkOutcome(request, options, state),
      );
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
  // Collect the distinct capsules touched so index-state invalidation runs ONCE per capsule at the
  // transaction boundary instead of once per row (GEN-PERF-PERSISTENCE-013). The DELETE is idempotent,
  // so a single invalidation before COMMIT is equivalent to the former per-row sequence.
  const touchedCapsules: KnowledgeCapsuleId[] = [];
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
        identity: observed,
        embedding: floatToBytes(persistedVectorForIdentity(out.success.vector, observed)),
        storageReference: idSource(),
        createdAt: now(),
      };
      insertVectorRow(db, store._internal.contentCipher, row, { invalidateIndexState: false });
      touchedCapsules.push(row.capsuleId);
      persisted.push(composeVectorRecord(row));
    }
    invalidateVectorIndexStateForCapsules(db, touchedCapsules);
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
interface BatchClosingCounts {
  readonly chunkCount: number;
  readonly vectorCount: number;
  readonly errorCount: number;
  readonly durationMs: number;
  readonly errorKind?: string | undefined;
}

// One shape for every way a batch can end, so an operator can grep a single op prefix and see
// how many chunks went in, how many vectors came out, and how long it took.
function logBatchClosed(
  options: EmbedBatchOptions,
  level: KnowledgeLogLevel,
  op: string,
  counts: BatchClosingCounts,
): void {
  logEmbedding(options, {
    level,
    op,
    errorKind: counts.errorKind,
    durationMs: counts.durationMs,
    extra: {
      chunkCount: counts.chunkCount,
      vectorCount: counts.vectorCount,
      errorCount: counts.errorCount,
    },
  });
}

// Vector persistence is the LAST step of a flush and the only one that throws instead of
// returning an error: `persistOutcomes` opens a transaction, and a failing insert (a disk-full
// sqlite write, a foreign-key violation from a concurrently deleted chunk row) propagates out of
// `embedChunkBatch` past every closing line below. The run then ends with an exception the
// orchestrator turns into a document failure, and the activity log shows a batch that started,
// grouped, embedded — and simply stopped, with the successful gateway round-trip still recorded
// as if it were the last thing that happened. This is the one line that names the write.
function persistOutcomesLogged(
  options: EmbedBatchOptions,
  outcomes: readonly ChunkOutcome[],
  chunkCount: number,
  elapsed: () => number,
): readonly VectorRecord[] {
  try {
    return persistOutcomes(
      options.store,
      outcomes,
      options.pinnedIdentity,
      options.idSource,
      options.now,
    );
  } catch (cause) {
    logBatchClosed(options, "error", "embedding.batch.persist-failed", {
      chunkCount,
      vectorCount: 0,
      errorCount: outcomes.filter((outcome) => !outcome.ok).length,
      durationMs: elapsed(),
      errorKind: knowledgeErrorKind(cause),
    });
    throw cause;
  }
}

function persistAndReport(
  options: EmbedBatchOptions,
  outcomes: readonly ChunkOutcome[],
  errors: readonly IndexingJobError[],
  chunkCount: number,
  elapsed: () => number,
): EmbedBatchResult {
  const vectors = persistOutcomesLogged(options, outcomes, chunkCount, elapsed);
  const durationMs = elapsed();
  logBatchClosed(options, errors.length === 0 ? "info" : "warn", "embedding.batch.completed", {
    chunkCount,
    vectorCount: vectors.length,
    errorCount: errors.length,
    durationMs,
  });
  return { vectors, errors };
}

export async function embedChunkBatch(
  chunks: readonly ChunkToEmbed[],
  options: EmbedBatchOptions,
): Promise<EmbedBatchResult> {
  if (chunks.length === 0) {
    return { vectors: [], errors: [] };
  }
  const elapsed = startKnowledgeLogTimer();
  const { outcomes, identityFailure } = await buildChunkOutcomes(chunks, options);
  const errors = outcomes
    .filter((o): o is Extract<ChunkOutcome, { ok: false }> => !o.ok)
    .map((o) => o.error);

  // Identity drift OR cancellation: refuse to persist ANY row from this batch. Both are
  // fail-closed rejections that discard completed work, so both are logged at the level that
  // says so rather than being inferred from a missing "completed" line.
  if (identityFailure !== undefined) {
    logBatchClosed(options, "error", "embedding.batch.rejected", {
      chunkCount: chunks.length,
      vectorCount: 0,
      errorCount: errors.length,
      durationMs: elapsed(),
      errorKind: identityFailure.code,
    });
    return { vectors: [], errors };
  }
  const abortError = checkAbort(options.signal);
  if (abortError !== undefined) {
    logBatchClosed(options, "warn", "embedding.batch.cancelled", {
      chunkCount: chunks.length,
      vectorCount: 0,
      errorCount: errors.length + 1,
      durationMs: elapsed(),
      errorKind: abortError.code,
    });
    return { vectors: [], errors: [...errors, abortError] };
  }

  return persistAndReport(options, outcomes, errors, chunks.length, elapsed);
}
