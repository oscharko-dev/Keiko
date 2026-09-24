// Resilience primitives: a real-time Clock, a bounded exponential-backoff retry
// loop, and a per-(model,endpoint) circuit breaker. All time-dependent behaviour
// flows through the injectable Clock so tests are deterministic and instant.

import {
  CancelledError,
  CircuitOpenError,
  GatewayError,
  ProviderError,
  RateLimitError,
} from "@oscharko-dev/keiko-security/errors/gateway";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { MAX_TIMER_DELAY_MS } from "./config.js";
import {
  activityLogErrorKind,
  logLevelEnabled,
  logModelId,
  logTimer,
  nullModelGatewayLogSink,
  resolveLogSink,
  type ModelGatewayLogSink,
} from "./observability.js";
import type {
  CircuitBreakerConfig,
  CircuitBreakerStatus,
  CircuitState,
  Clock,
  ModelProviderConfig,
} from "./types.js";

const MAX_BACKOFF_MS = 30_000;

// #3591: the field customer's LiteLLM proxy in front of vLLM answers slowly at peak load — 30s,
// 45s, 120s and longer before the first byte, with stalls between stream chunks — and Keiko must
// stay in the request rather than abort on its own for such delays. Bounded, but generous: a slow
// gateway is not a broken gateway. These floors are the minimum every interactive gateway surface
// waits before treating silence or total duration as a failure; a caller's own configuration may
// only raise them, never lower them.
//
// The buffered-vs-stream rule (review finding on PR #3602): a STREAMED read can prove it is alive
// as it goes — a chunk every so often is the provider saying "still here" — so it only needs to be
// watched for SILENCE (no data for `GATEWAY_SILENCE_FLOOR_MS`) while its total duration is allowed
// to run to the much larger stream/budget floor below. A BUFFERED (whole-body) read cannot observe
// progress at all: an OpenAI-compatible endpoint sends nothing, headers included, until the whole
// generation is ready, so there is no "silence" to watch — the single number that bounds it must
// already cover the longest legitimate generation. That is why `chatAttemptTimeoutMs` below floors
// a buffered `Gateway.chat()` attempt to `GATEWAY_BUFFERED_BUDGET_FLOOR_MS`, the SAME floor as the
// end-to-end budget, rather than to the shorter silence floor: with `maxRetries: 0` the one attempt
// IS the whole call, and flooring it to the silence floor left a healthy six-minute buffered answer
// aborted at five minutes while the budget "advertised" ten (PR #3602 review). A `chat()` attempt
// that happens to read over the provider's own stream keeps the silence floor for that read
// instead (`gateway.ts`'s `effectiveSilenceMs`, threaded through `streamedReadBounds`) — only the
// WHOLE-BODY case, and `chatStream()`'s own buffered fallback for a non-streaming adapter (same
// reasoning: no incremental progress to observe), use the buffered floor as their per-attempt bound.
// Longest wait for the first byte, and between two stream data events.
export const GATEWAY_SILENCE_FLOOR_MS = 300_000;
// Longest total read of a streamed answer (`Gateway.chatStream()` — Conversation Center and any
// other true streaming consumer).
export const GATEWAY_STREAM_BUDGET_FLOOR_MS = 1_800_000;
// Longest total read of a buffered answer (`Gateway.chat()` — coding-workbench and every buffered
// call that answers a user action: commit draft, prompt enhancer, memory salience, quality judge).
export const GATEWAY_BUFFERED_BUDGET_FLOOR_MS = 600_000;
// Per-call floor for retrieval/indexing transports (embeddings, rerank): the actual outbound HTTP
// deadline for ONE call, never the ladder/batch bookkeeping deadline those transports derive from
// the caller's configured value (that bookkeeping must stay driven by what the caller asked for,
// including an intentionally exhausted budget).
export const GATEWAY_RETRIEVAL_TIMEOUT_FLOOR_MS = 120_000;
// Per-call floor for the voice adapters (realtime, text-to-speech, speech-to-text).
export const GATEWAY_VOICE_TIMEOUT_FLOOR_MS = 120_000;

// Kept as its own export (coding-sidecar-gateway.ts mirrors it to derive a matching deadline) but
// now equal to the universal silence floor: a slow Coding Workbench provider gets no special
// treatment past what every other interactive Gateway.chat() caller already receives (#3591).
export const CODING_WORKBENCH_PROVIDER_TIMEOUT_FLOOR_MS = GATEWAY_SILENCE_FLOOR_MS;

export function codingWorkbenchProviderTimeoutMs(timeoutMs: number): number {
  return Math.max(timeoutMs, CODING_WORKBENCH_PROVIDER_TIMEOUT_FLOOR_MS);
}

const GATEWAY_RETRY_BUDGET_EXHAUSTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.retry.budget-exhausted",
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "resilience.budgetExhaustedError",
  fields: {
    modelId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 256 },
    attempt: { type: "integer", dataClass: "count", required: true },
    hadPriorFailure: {
      type: "boolean",
      dataClass: "closed-enum",
      required: true,
    },
    httpStatus: { type: "integer", dataClass: "count", required: false },
    retryAfterMs: { type: "number", dataClass: "duration", required: false },
  },
  causal: "none",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["gateway-retry"],
  proofIds: ["gateway.retry.budget-exhausted.emitted-line"],
  releaseImpact: "patch",
});

const GATEWAY_RETRY_EXHAUSTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.retry.exhausted",
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "resilience.executeWithRetry",
  fields: {
    modelId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 256 },
    attempt: { type: "integer", dataClass: "count", required: true },
    maxRetries: { type: "integer", dataClass: "count", required: true },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["terminal", "max-retries", "budget"],
    },
    delayMs: { type: "number", dataClass: "duration", required: false },
    remainingMs: { type: "number", dataClass: "duration", required: false },
    httpStatus: { type: "integer", dataClass: "count", required: false },
    retryAfterMs: { type: "number", dataClass: "duration", required: false },
  },
  causal: "none",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["gateway-retry"],
  proofIds: ["gateway.retry.exhausted.emitted-line"],
  releaseImpact: "patch",
});

const GATEWAY_RETRY_SCHEDULED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.retry.scheduled",
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "resilience.executeWithRetry",
  fields: {
    modelId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 256 },
    attempt: { type: "integer", dataClass: "count", required: true },
    maxRetries: { type: "integer", dataClass: "count", required: true },
    delayMs: { type: "number", dataClass: "duration", required: true },
    httpStatus: { type: "integer", dataClass: "count", required: false },
    retryAfterMs: { type: "number", dataClass: "duration", required: false },
  },
  causal: "none",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["gateway-retry"],
  proofIds: ["gateway.retry.scheduled.emitted-line"],
  releaseImpact: "patch",
});

const GATEWAY_CIRCUIT_REJECTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.circuit.rejected",
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "resilience.CircuitBreaker.noteRejection",
  fields: {
    modelId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 256 },
    state: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["closed", "open", "half-open"],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["cooldown", "probe-saturated"],
    },
    probesInFlight: { type: "integer", dataClass: "count", required: true },
    rejectedSinceTransition: { type: "integer", dataClass: "count", required: true },
  },
  causal: "none",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["gateway-circuit-breaker"],
  proofIds: ["gateway.circuit.rejected.emitted-line"],
  releaseImpact: "patch",
});

const GATEWAY_CIRCUIT_HALF_OPEN_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.circuit.half-open",
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "resilience.CircuitBreaker.enterHalfOpenOrReject",
  fields: {
    modelId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 256 },
    probes: { type: "integer", dataClass: "count", required: true },
    rejectedWhileOpen: { type: "integer", dataClass: "count", required: true },
  },
  causal: "none",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["gateway-circuit-breaker"],
  proofIds: ["gateway.circuit.half-open.emitted-line"],
  releaseImpact: "patch",
});

const GATEWAY_CIRCUIT_OPENED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.circuit.opened",
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "resilience.CircuitBreaker.open",
  fields: {
    modelId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 256 },
    previousState: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["closed", "open", "half-open"],
    },
    consecutiveFailures: { type: "integer", dataClass: "count", required: true },
    cooldownMs: { type: "number", dataClass: "duration", required: true },
    rejectedSincePreviousTransition: { type: "integer", dataClass: "count", required: true },
  },
  causal: "none",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["gateway-circuit-breaker"],
  proofIds: ["gateway.circuit.opened.emitted-line"],
  releaseImpact: "patch",
});

const GATEWAY_CIRCUIT_CLOSED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.circuit.closed",
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "resilience.CircuitBreaker.close",
  fields: {
    modelId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 256 },
    previousState: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["closed", "open", "half-open"],
    },
    rejectedSincePreviousTransition: { type: "integer", dataClass: "count", required: true },
  },
  causal: "none",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["gateway-circuit-breaker"],
  proofIds: ["gateway.circuit.closed.emitted-line"],
  releaseImpact: "patch",
});

export const systemClock: Clock = {
  now: (): number => Date.now(),
  sleep: (ms: number, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted === true) {
      return Promise.reject(new DOMException("cancelled", "AbortError"));
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      function onAbort(): void {
        clearTimeout(timeout);
        reject(new DOMException("cancelled", "AbortError"));
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  },
};

export interface RetryConfig {
  readonly maxRetries: number;
  readonly retryBaseDelayMs: number;
  // The end-to-end budget of the whole call: every attempt and every backoff sleep together.
  readonly timeoutMs?: number | undefined;
  // The bound of ONE attempt (ADR-0003). An attempt runs under the smaller of this and what is
  // left of `timeoutMs`, so an attempt that hangs ends in time for its retry and no attempt
  // outlives the end-to-end budget.
  readonly attemptTimeoutMs?: number | undefined;
}

// Equal jitter over the capped exponential ladder: half the delay is fixed, half
// is random, so concurrent callers hitting a recovering provider spread across
// [0.5·d, d] instead of retrying in lockstep (thundering herd) while never
// collapsing to a zero delay. Randomness is injected for deterministic tests. The step is a whole
// number of milliseconds: a timer cannot honour a fraction, and the retry line logs the sleep as is.
function backoffDelayMs(attempt: number, base: number, random: () => number): number {
  return Math.round(maxBackoffDelayMs(attempt, base) * (0.5 + 0.5 * random()));
}

// The top of the jitter band for the sleep after failed attempt `attempt`.
function maxBackoffDelayMs(attempt: number, base: number): number {
  return Math.min(base * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

// Only a GatewayError that declares itself retryable is retried; anything else is terminal.
function isRetryableError(error: Error): boolean {
  return error instanceof GatewayError && error.retryable;
}

// A RateLimitError with an explicit retryAfterMs is honoured VERBATIM (the server
// told us when to come back — jitter would only delay recovery), capped at 30 s;
// every other retryable error takes the jittered backoff step.
function retryDelayMs(error: Error, attempt: number, base: number, random: () => number): number {
  if (error instanceof RateLimitError && error.retryAfterMs !== null && error.retryAfterMs > 0) {
    return Math.min(error.retryAfterMs, MAX_BACKOFF_MS);
  }
  return backoffDelayMs(attempt, base, random);
}

// What the loop does after a failed attempt: sleep and retry, or stop and say why. A retry whose
// delay does not fit what is left of the budget could never run, so the call ends at once instead
// of sleeping the rest of the budget away first (PR #3452 review).
type RetryStop =
  | { readonly stop: "terminal" | "max-retries" }
  | { readonly stop: "budget"; readonly delayMs: number; readonly remainingMs: number };
type RetryDecision = { readonly sleepMs: number } | RetryStop;

function retryDecision(
  lastError: Error,
  attempt: number,
  config: RetryConfig,
  remainingMs: number,
  random: () => number,
): RetryDecision {
  if (!isRetryableError(lastError)) return { stop: "terminal" };
  if (attempt > config.maxRetries) return { stop: "max-retries" };
  const delayMs = retryDelayMs(lastError, attempt, config.retryBaseDelayMs, random);
  if (delayMs >= remainingMs) return { stop: "budget", delayMs, remainingMs };
  return { sleepMs: delayMs };
}

// Why the loop stopped retrying, on its exhausted line; a budget stop carries both numbers.
function retryStopDetail(
  decision: RetryStop,
):
  | { readonly reason: "terminal" | "max-retries" }
  | { readonly reason: "budget"; readonly delayMs: number; readonly remainingMs: number } {
  return decision.stop === "budget"
    ? { reason: "budget", delayMs: decision.delayMs, remainingMs: decision.remainingMs }
    : { reason: decision.stop };
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new CancelledError("request cancelled during retry");
  }
}

function remainingBudgetMs(start: number, timeoutMs: number | undefined, clock: Clock): number {
  if (timeoutMs === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, timeoutMs - (clock.now() - start));
}

// What one attempt runs under: its own bound, clipped to what is left of the end-to-end budget.
// Undefined when neither is set, so an unbounded caller stays unbounded.
function attemptTimeoutFor(config: RetryConfig, remainingMs: number): number | undefined {
  const bound = Math.min(remainingMs, config.attemptTimeoutMs ?? Number.POSITIVE_INFINITY);
  return Number.isFinite(bound) ? Math.max(1, Math.floor(bound)) : undefined;
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

async function sleepWithCancellation(
  clock: Clock,
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  assertNotAborted(signal);
  try {
    await clock.sleep(delayMs, signal);
  } catch (error) {
    if (signal?.aborted === true) {
      throw new CancelledError("request cancelled during retry backoff");
    }
    throw error;
  }
  assertNotAborted(signal);
}

// What the retry loop needs in order to LABEL its lines. Optional in full: an unwired caller
// keeps the exact behaviour it had before instrumentation, down to the allocation count.
export interface RetryLogContext {
  readonly sink?: ModelGatewayLogSink | undefined;
  readonly modelId?: string | undefined;
  readonly correlationId?: string | undefined;
}

function loggedRetryModel(context: RetryLogContext): Readonly<{ modelId?: string }> {
  return context.modelId === undefined ? {} : { modelId: logModelId(context.modelId) };
}

// The provider-specific detail that turns "a retry happened" into "the provider said 503" or
// "the provider said wait 2000ms", mirroring `logErrorKind`'s shape: it reads only fields these
// error classes already type and already redact at construction (never `message`, which is where
// a provider response body ends up), so a plain `TransportError`, a `CancelledError`, or any
// non-`GatewayError` contributes nothing here. Both fields are optional because most retryable
// errors carry neither. `httpStatus` is read off BOTH `ProviderError` and `RateLimitError`: a
// rate-limited call is always HTTP 429 by definition, and a consumer building a replay/reproduction
// artifact from these lines (e.g. `GatewayReplayAttempt.httpStatus`) should never have to infer the
// status from `errorKind === GATEWAY_RATE_LIMIT` when the error itself already carries it —
// restating it here costs one field and removes that inference entirely. `retryAfterMs` stays
// `RateLimitError`-only: `ProviderError` never carries a server-supplied retry delay.
export interface ProviderErrorDetail {
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
}

export function providerErrorDetail(error: unknown): ProviderErrorDetail {
  const httpStatus = providerErrorHttpStatus(error);
  const retryAfterMs =
    error instanceof RateLimitError ? (error.retryAfterMs ?? undefined) : undefined;
  return {
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

function providerErrorHttpStatus(error: unknown): number | undefined {
  if (error instanceof ProviderError) {
    return error.httpStatus;
  }
  if (error instanceof RateLimitError) {
    return error.httpStatus;
  }
  return undefined;
}

// The budget ran out BEFORE an attempt was made. Preserves the original throw exactly (the last
// provider error when there is one, a CancelledError otherwise) and only adds the line that says
// which of the two happened — the difference between "the provider kept failing" and "the caller's
// deadline was already spent" is invisible from the thrown error alone.
function budgetExhaustedError(
  lastError: Error | undefined,
  sink: ModelGatewayLogSink,
  context: RetryLogContext,
  attempt: number,
  durationMs: number,
): Error {
  const error =
    lastError ?? new CancelledError("request timeout budget exhausted before provider call");
  sink.write(
    activityLogEvent(
      GATEWAY_RETRY_BUDGET_EXHAUSTED_OPERATION,
      {
        level: "warn",
        ...(context.correlationId === undefined ? {} : { correlationId: context.correlationId }),
        durationMs,
        errorKind: activityLogErrorKind(error),
      },
      {
        ...loggedRetryModel(context),
        attempt,
        hadPriorFailure: lastError !== undefined,
        ...providerErrorDetail(error),
      },
    ),
  );
  return error;
}

interface RetryFailureLogInput {
  readonly sink: ModelGatewayLogSink;
  readonly context: RetryLogContext;
  readonly attempt: number;
  readonly maxRetries: number;
  readonly error: Error;
  readonly durationMs: number;
}

function logRetryExhausted(input: RetryFailureLogInput, decision: RetryStop): void {
  input.sink.write(
    activityLogEvent(
      GATEWAY_RETRY_EXHAUSTED_OPERATION,
      {
        level: "warn",
        ...(input.context.correlationId === undefined
          ? {}
          : { correlationId: input.context.correlationId }),
        durationMs: input.durationMs,
        errorKind: activityLogErrorKind(input.error),
      },
      {
        ...loggedRetryModel(input.context),
        attempt: input.attempt,
        maxRetries: input.maxRetries,
        ...retryStopDetail(decision),
        ...providerErrorDetail(input.error),
      },
    ),
  );
}

function logRetryScheduled(
  input: RetryFailureLogInput,
  decision: Readonly<{ sleepMs: number }>,
): void {
  input.sink.write(
    activityLogEvent(
      GATEWAY_RETRY_SCHEDULED_OPERATION,
      {
        level: "warn",
        ...(input.context.correlationId === undefined
          ? {}
          : { correlationId: input.context.correlationId }),
        durationMs: input.durationMs,
        errorKind: activityLogErrorKind(input.error),
      },
      {
        ...loggedRetryModel(input.context),
        attempt: input.attempt,
        maxRetries: input.maxRetries,
        delayMs: decision.sleepMs,
        ...providerErrorDetail(input.error),
      },
    ),
  );
}

export async function executeWithRetry<T>(
  // Each attempt gets its own bound and what is left of the call's budget, which a streamed read
  // may spend while the provider keeps producing (ADR-0003).
  operation: (attemptTimeoutMs?: number, remainingBudgetMs?: number) => Promise<T>,
  config: RetryConfig,
  clock: Clock,
  signal?: AbortSignal,
  random: () => number = Math.random,
  logContext: RetryLogContext = {},
): Promise<T> {
  const sink = resolveLogSink(logContext.sink);
  const elapsed = logTimer();
  let lastError: Error | undefined;
  const start = clock.now();
  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt += 1) {
    assertNotAborted(signal);
    const remaining = remainingBudgetMs(start, config.timeoutMs, clock);
    if (remaining <= 0) {
      throw budgetExhaustedError(lastError, sink, logContext, attempt, elapsed());
    }
    try {
      return await operation(attemptTimeoutFor(config, remaining), remaining);
    } catch (error) {
      lastError = asError(error);
      const remainingMs = remainingBudgetMs(start, config.timeoutMs, clock);
      const decision = retryDecision(lastError, attempt, config, remainingMs, random);
      const failureLog: RetryFailureLogInput = {
        sink,
        context: logContext,
        attempt,
        maxRetries: config.maxRetries,
        error: lastError,
        durationMs: elapsed(),
      };
      if (!("sleepMs" in decision)) {
        logRetryExhausted(failureLog, decision);
        throw lastError;
      }
      logRetryScheduled(failureLog, decision);
      await sleepWithCancellation(clock, decision.sleepMs, signal);
    }
  }
  throw lastError ?? new CancelledError("request timeout budget exhausted after retries");
}

// The provider settings a retry policy is made of.
type ProviderRetryPolicy = Pick<
  ModelProviderConfig,
  "timeoutMs" | "maxRetries" | "retryBaseDelayMs"
>;

// The per-attempt bound `Gateway.chat()` runs a BUFFERED (whole-body) attempt under: the
// provider's configured `timeoutMs`, floored to the BUFFERED budget floor, never the shorter
// silence floor (#3591, PR #3602 review — see the buffered-vs-stream rule above). A buffered read
// cannot observe progress, so with `maxRetries: 0` this one attempt IS the whole call: flooring it
// to the silence floor left a healthy six-minute answer cut off at five. A `chat()` attempt that
// reads over the provider's own stream is bounded differently by its caller (`gateway.ts`'s
// `effectiveSilenceMs`/`streamedReadBounds`) and does not use this value for its read deadline —
// this function only floors the WHOLE-BODY read and the retry loop's own bookkeeping (attempt
// scheduling, the end-to-end budget derived below).
function chatAttemptTimeoutMs(provider: ProviderRetryPolicy): number {
  return Math.max(provider.timeoutMs, GATEWAY_BUFFERED_BUDGET_FLOOR_MS);
}

// The end-to-end budget of one buffered call to `provider`: every attempt its full `timeoutMs`
// (ADR-0003), and before every retry the longest sleep the loop honours. The backoff cap and the
// cap on a provider's Retry-After are both MAX_BACKOFF_MS, so a rate-limited provider keeps all its
// configured attempts and the cool-down it asked for. The one derivation: the gateway's retry loop
// and every deadline a caller builds around a gateway call (the coding sidecar route) take it from
// here, so the two cannot drift apart again. They had: the provider's `timeoutMs` was passed to
// the loop as the budget of the WHOLE call, an attempt that hung spent it, and the retry a
// `TimeoutError` is declared retryable for never ran (coding run 23, 2026-09-11).
//
// The per-attempt bound is floored first (`chatAttemptTimeoutMs`, now the SAME buffered floor this
// function floors to), so the trailing `Math.max` below is a provable no-op today — kept as an
// explicit invariant ("this budget is never less than the buffered floor, however the per-attempt
// term is computed") rather than relying on the reader to re-derive that from the arithmetic.
export function providerRequestBudgetMs(provider: ProviderRetryPolicy): number {
  const attemptTimeoutMs = chatAttemptTimeoutMs(provider);
  const budgetMs =
    (provider.maxRetries + 1) * attemptTimeoutMs + provider.maxRetries * MAX_BACKOFF_MS;
  // Config validation holds each term to the timer ceiling, never their sum: past it, every
  // deadline armed from this budget would fire the moment it is set (PR #3452 review).
  return Math.min(Math.max(budgetMs, GATEWAY_BUFFERED_BUDGET_FLOOR_MS), MAX_TIMER_DELAY_MS);
}

// The retry configuration a provider's settings stand for: `timeoutMs` bounds each attempt, and
// the budget derived from it bounds the call.
export function providerRetryConfig(provider: ProviderRetryPolicy): RetryConfig {
  return {
    maxRetries: provider.maxRetries,
    retryBaseDelayMs: provider.retryBaseDelayMs,
    attemptTimeoutMs: chatAttemptTimeoutMs(provider),
    timeoutMs: providerRequestBudgetMs(provider),
  };
}

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private probesRemaining = 0;
  // Tracks how many half-open probe slots are currently in-flight.
  private probesInFlight = 0;
  // Calls refused since the last state change. See `noteRejection` — this is both the rate limiter
  // and the number the transition lines report, so the volume survives the demotion.
  private rejectedSinceTransition = 0;

  constructor(
    private readonly modelId: string,
    private readonly config: CircuitBreakerConfig,
    private readonly clock: Clock,
    private readonly log: ModelGatewayLogSink = nullModelGatewayLogSink,
  ) {}

  // A refused call is the highest-volume, lowest-information event this class produces: while the
  // breaker is open EVERY caller is refused, so a busy model under a provider outage turns one
  // fact — "the breaker for model X is open" — into thousands of identical `warn` lines, drowning
  // the transitions that actually carry news and pushing the lines before the outage out of the
  // retention window. That is worse than saying nothing: the log is loudest exactly when it is
  // least informative.
  //
  // So the FIRST refusal after each transition is reported at `warn` — an operator reading at the
  // default threshold still learns, once, that calls are being refused and why — and every
  // subsequent one is demoted to `debug` and counted. The count rides the next transition line
  // (`rejectedSinceTransition`), so nothing is lost: the volume is still reported, once, as a
  // number instead of as thousands of lines. The `logLevelEnabled` guard means a demoted refusal
  // costs a predicate call and an increment, not an allocation, when nobody is reading `debug`.
  private noteRejection(
    state: CircuitState,
    reason: "cooldown" | "probe-saturated",
    correlationId: string | undefined,
  ): void {
    this.rejectedSinceTransition += 1;
    const first = this.rejectedSinceTransition === 1;
    if (!first && !logLevelEnabled(this.log, "debug")) return;
    this.log.write(
      activityLogEvent(
        GATEWAY_CIRCUIT_REJECTED_OPERATION,
        {
          level: first ? "warn" : "debug",
          errorKind: "unavailable",
          ...(correlationId === undefined ? {} : { correlationId }),
        },
        {
          modelId: logModelId(this.modelId),
          state,
          reason,
          probesInFlight: this.probesInFlight,
          rejectedSinceTransition: this.rejectedSinceTransition,
        },
      ),
    );
  }

  // Returns the refusal count accumulated since the last transition and resets it, so every
  // transition line carries the volume of the window it is ending.
  private takeRejectedCount(): number {
    const rejected = this.rejectedSinceTransition;
    this.rejectedSinceTransition = 0;
    return rejected;
  }

  // Called before forwarding a request. Throws CircuitOpenError when the breaker is
  // open and the cooldown has not elapsed; otherwise lets the call through (entering
  // half-open as a side effect when cooldown has passed).
  // In half-open, at most config.halfOpenProbes concurrent probes are admitted; excess
  // callers receive CircuitOpenError until a probe slot is freed by recordSuccess/Failure.
  assertAllowed(correlationId?: string): void {
    if (this.state === "open") {
      this.enterHalfOpenOrReject(correlationId);
    }
    if (this.state === "half-open") {
      this.admitProbeOrReject(correlationId);
    }
  }

  private enterHalfOpenOrReject(correlationId: string | undefined): void {
    if (this.openedAt !== null && this.clock.now() - this.openedAt >= this.config.cooldownMs) {
      this.state = "half-open";
      this.probesRemaining = this.config.halfOpenProbes;
      this.probesInFlight = 0;
      this.log.write(
        activityLogEvent(
          GATEWAY_CIRCUIT_HALF_OPEN_OPERATION,
          {
            level: "info",
            ...(correlationId === undefined ? {} : { correlationId }),
          },
          {
            modelId: logModelId(this.modelId),
            probes: this.config.halfOpenProbes,
            rejectedWhileOpen: this.takeRejectedCount(),
          },
        ),
      );
      return;
    }
    this.noteRejection("open", "cooldown", correlationId);
    throw new CircuitOpenError(`circuit open for model '${this.modelId}'`);
  }

  private admitProbeOrReject(correlationId: string | undefined): void {
    if (this.probesInFlight >= this.config.halfOpenProbes) {
      this.noteRejection("half-open", "probe-saturated", correlationId);
      throw new CircuitOpenError(`circuit half-open for model '${this.modelId}'`);
    }
    this.probesInFlight += 1;
  }

  recordSuccess(correlationId?: string): void {
    if (this.state === "half-open") {
      this.probesInFlight = Math.max(0, this.probesInFlight - 1);
      this.probesRemaining -= 1;
      if (this.probesRemaining <= 0) {
        this.close(correlationId);
      }
      return;
    }
    this.consecutiveFailures = 0;
  }

  recordFailure(correlationId?: string): void {
    if (this.state === "half-open") {
      this.probesInFlight = Math.max(0, this.probesInFlight - 1);
      this.open(correlationId);
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.config.failureThreshold) {
      this.open(correlationId);
    }
  }

  // A non-provider fault (a client cancel, our own invalid configuration, the gateway's own
  // redaction limit, a caller-fixable output-budget exhaustion) never tested whether the provider
  // recovered, so it must move the breaker NEITHER toward open (mistaking the caller's own fault
  // for a fresh outage) nor toward closed (mistaking an untested call for a health signal) — but a
  // half-open probe still claimed one of the limited `probesInFlight` slots in `admitProbeOrReject`,
  // and neither `recordSuccess` nor `recordFailure` is the right call to release it. Left
  // unreleased, the slot stays occupied forever: once every half-open probe is stuck this way the
  // breaker rejects every later call with `CircuitOpenError` although the provider may be healthy
  // (review finding on PR #3602). A no-op while closed or open: there is no probe slot to free.
  recordNonProviderFault(): void {
    if (this.state !== "half-open") return;
    this.probesInFlight = Math.max(0, this.probesInFlight - 1);
  }

  status(modelId: string): CircuitBreakerStatus {
    return {
      modelId,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      openedAt: this.openedAt,
    };
  }

  // The transitions are the news, and they are rare — one per outage, not one per call. `opened`
  // stays `warn` because it is the moment the model stopped serving traffic; `half-open` and
  // `closed` are recoveries and stay `info`, where a recovery belongs. Each one carries the
  // refusals its window absorbed, which is the number the demoted per-call lines no longer report.
  private open(correlationId: string | undefined): void {
    const previousState = this.state;
    this.state = "open";
    this.openedAt = this.clock.now();
    this.probesRemaining = 0;
    this.probesInFlight = 0;
    this.log.write(
      activityLogEvent(
        GATEWAY_CIRCUIT_OPENED_OPERATION,
        {
          level: "warn",
          errorKind: "unavailable",
          ...(correlationId === undefined ? {} : { correlationId }),
        },
        {
          modelId: logModelId(this.modelId),
          previousState,
          consecutiveFailures: this.consecutiveFailures,
          cooldownMs: this.config.cooldownMs,
          rejectedSincePreviousTransition: this.takeRejectedCount(),
        },
      ),
    );
  }

  private close(correlationId: string | undefined): void {
    const previousState = this.state;
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.probesRemaining = 0;
    this.probesInFlight = 0;
    this.log.write(
      activityLogEvent(
        GATEWAY_CIRCUIT_CLOSED_OPERATION,
        {
          level: "info",
          ...(correlationId === undefined ? {} : { correlationId }),
        },
        {
          modelId: logModelId(this.modelId),
          previousState,
          rejectedSincePreviousTransition: this.takeRejectedCount(),
        },
      ),
    );
  }
}
