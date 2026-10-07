// Resilience primitives: a real-time Clock, a bounded exponential-backoff retry
// loop, and a per-(model,endpoint) circuit breaker. All time-dependent behaviour
// flows through the injectable Clock so tests are deterministic and instant.

import {
  CancelledError,
  CircuitOpenError,
  ConfigInvalidError,
  GatewayError,
  MalformedToolCallError,
  ProviderEmptyAnswerError,
  ProviderError,
  ProviderOutputExhaustedError,
  RateLimitError,
  TimeoutError,
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

// The provider timeout a coding-workbench-profiled call runs under: the configured value, never
// below the universal silence floor. A slow Coding Workbench provider gets no special treatment
// past what every other interactive Gateway.chat() caller already receives (#3591); the route
// deadlines behind such calls (`gateway-route-deadline.ts` in keiko-server) derive from it.
export function codingWorkbenchProviderTimeoutMs(timeoutMs: number): number {
  return Math.max(timeoutMs, GATEWAY_SILENCE_FLOOR_MS);
}

// The end-to-end budget of `Gateway.chatStream()`, including any pre-content startup retries: the provider's
// `timeoutMs` (a coding-workbench-profiled caller raises it through `codingWorkbenchProviderTimeoutMs`
// first), never below the silence floor its first byte is held to, and never below the
// streamed-answer floor. `gateway.ts`'s `chatStreamBounds` takes its budget from here, and so does
// the route deadline armed behind a streamed call (`gateway-route-deadline.ts` in keiko-server): a
// route that backed a streamed call with the BUFFERED budget cut a healthy stream at ten minutes
// while the gateway itself was still reading it (PR #3602 review).
export function streamRequestBudgetMs(provider: { readonly timeoutMs: number }): number {
  return Math.max(provider.timeoutMs, GATEWAY_SILENCE_FLOOR_MS, GATEWAY_STREAM_BUDGET_FLOOR_MS);
}

/**
 * The retry policy a call runs under (#3873): `attempts` keeps the provider's `maxRetries` and the
 * fail-fast breaker; `outage-window` keeps retrying a transiently unavailable provider for an
 * outage window and waits through an open breaker.
 */
export type RetryPolicy = "attempts" | "outage-window";

// The applied policy on every retry and breaker-wait line, so an analyst can tell a deliberate
// outage window from a retry loop that ignored its attempt count. `required: false` only because a
// record written before this field existed lacks it (as with `outputExhausted`, PR #3602 review);
// every line written since carries it.
const RETRY_POLICY_FIELD = {
  type: "string",
  dataClass: "closed-enum",
  required: false,
  values: ["attempts", "outage-window"],
} as const;

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
    retryAfterHeader: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["absent", "valid", "unparseable", "elapsed"],
    },
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
    retryAfterHeader: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["absent", "valid", "unparseable", "elapsed"],
    },
    retryPolicy: RETRY_POLICY_FIELD,
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
    // #3873 (F17, F23): why a further attempt was scheduled — a retryable provider failure, or the
    // one steered repair of an answer the model could not use (it exhausted its output budget, or it
    // ended after reasoning without a tool call or any text), which is not a provider retry and must
    // read as such. `required: false` only because a record written before this field existed lacks
    // it; every line written since carries it.
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["retryable-error", "output-exhausted-repair", "empty-answer-repair"],
    },
    httpStatus: { type: "integer", dataClass: "count", required: false },
    retryAfterMs: { type: "number", dataClass: "duration", required: false },
    retryAfterHeader: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["absent", "valid", "unparseable", "elapsed"],
    },
    retryPolicy: RETRY_POLICY_FIELD,
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
  readonly shouldRetry?: (error: Error) => boolean;
  readonly jitterProviderCooldown?: boolean;
  readonly maxRetries: number;
  readonly retryBaseDelayMs: number;
  // The end-to-end budget of the whole call: every attempt and every backoff sleep together.
  readonly timeoutMs?: number | undefined;
  // The bound of ONE attempt (ADR-0003). An attempt runs under the smaller of this and what is
  // left of `timeoutMs`, so an attempt that hangs ends in time for its retry and no attempt
  // outlives the end-to-end budget.
  readonly attemptTimeoutMs?: number | undefined;
  // When set, the call keeps scheduling retries after a transient provider failure for this long
  // instead of stopping after `maxRetries`; a failure that reacts to the model's own output keeps
  // the attempt count (`decisionWindowMs`), and `timeoutMs` still bounds the whole call (#3873).
  readonly retryWindowMs?: number | undefined;
  /**
   * A steered repair of a TERMINAL failure the caller can correct (#3873, F17): consulted on every
   * failed attempt; a reason schedules ONE further attempt at once, which receives the failure as
   * its `previousError` and sends a corrected request. The repair is granted once per call, for
   * whichever failure comes first, and is not a provider retry: neither `maxRetries` nor the outage
   * window applies to it, only what is left of `timeoutMs`. A second failure surfaces to the caller.
   */
  readonly repair?: ((error: Error) => RetryRepairReason | undefined) | undefined;
}

/**
 * The steered repairs the loop knows, one per failure of the model's own answer: one that exhausted
 * its output budget (#3873, F17) and one that ended after reasoning without a tool call or any text
 * (#3873, F23). The reason names the correction the caller sends and is what the scheduled line says.
 */
export type RetryRepairReason = "output-exhausted-repair" | "empty-answer-repair";

/**
 * An attempt that already ran outside the loop and failed (#3873, F17, option iii): the loop
 * resumes after it, so a streamed answer that failed after nothing but forwarded reasoning — its
 * one steered repair, a schema correction, or a provider retry under the call's policy — is
 * decided, logged and bounded exactly like a failure before the first chunk.
 */
export interface RetryResume {
  readonly failedAttempt: Error;
  /**
   * How many attempts the call has made, the failed one included, and how many of them were the
   * steered repair. A stream can be resumed more than once, so the counts carry over and the call
   * keeps ONE attempt count and ONE repair across its loops (#3873 review). Absent: the failed
   * attempt is attempt 1 and no repair ran.
   */
  readonly attempts?: number | undefined;
  readonly repairs?: number | undefined;
}

// The reason a further attempt was scheduled, on the scheduled line.
type RetryScheduledReason = "retryable-error" | RetryRepairReason;

// The gateway's own repair of an answer the model could not use: one that exhausted its output
// budget (#3873, F17), and one that ended after reasoning without a tool call or any text (F23) —
// an empty answer that carried no reasoning is the model's final word and gets none (#3610).
// `Gateway` sends the corrected request on the attempt that follows; the loop only grants that
// attempt, once, and only on a call whose retry configuration carries it (`RetryConfig.repair`).
// The single classification every path consults: the buffered attempt, the streamed startup, and
// the stream resumed after forwarded reasoning.
export function steeredAnswerRepair(error: Error): RetryRepairReason | undefined {
  if (error instanceof ProviderOutputExhaustedError) return "output-exhausted-repair";
  return error instanceof ProviderEmptyAnswerError && error.afterReasoning
    ? "empty-answer-repair"
    : undefined;
}

// Faults that never indicate the PROVIDER is unhealthy: a client-initiated cancel, our own invalid
// configuration, the gateway's own redaction pass refusing to walk a pathologically deep response
// body (review finding on PR #3394 — an untyped RangeError from that last case used to slip past
// this list and trip the breaker for an otherwise healthy model; ResponseRedactionError is now
// thrown instead, see openai-adapter.ts's redactUnknown), or a ProviderOutputExhaustedError (an
// HTTP 200 with `finish_reason: "length"` and no content — the model answered, it just spent its
// budget on reasoning; that is a caller-fixable budget problem, not evidence the provider is
// failing), or a ProviderEmptyAnswerError (#3610: an HTTP 200 answer that completed with neither
// content nor a tool call — the provider answered, the model produced nothing usable; counting it
// let three such answers lock every caller of a healthy model out), or a MalformedToolCallError
// (the model's own tool call did not parse or did not match the tool's schema: the gateway retries
// it, and the provider answered every time; a lab run of 1.1.8 behind a LiteLLM hosted_vllm route
// opened the breaker after five such calls and failed the run on CircuitOpenError). It covers the
// redaction-depth refusal (ResponseRedactionError) and the catalog's schema rejection
// (GatewayToolCatalogError), both of which extend it. A named, extensible list rather than a
// growing chain of `&&` conditions, so the next non-provider fault is one array entry away.
//
// TimeoutError is deliberately NOT here (review finding on PR #3602 — it was, briefly, during
// #3591's development). Excluding every timeout disabled the breaker's own outage guard: an
// upstream that never responds at all would cost every caller a full (multi-minute, with the new
// floors) attempt before failing, and the breaker would never open for it, no matter how many
// callers piled up. With `GATEWAY_SILENCE_FLOOR_MS`/`GATEWAY_BUFFERED_BUDGET_FLOOR_MS` this
// generous, a `TimeoutError` means the provider produced nothing for minutes — an outage-class
// signal, not the noise of a slow-but-alive gateway (which stays inside the floor and never times
// out at all) — so it counts as a provider failure again, exactly as it did before this PR.
//
// The one classification of "does this failure say the provider is unhealthy": the breaker counts
// only failures outside this list (`gateway.ts`), and the outage window extends only their retries
// (`decisionWindowMs`, #3873 review).
const NON_PROVIDER_FAULTS = [
  CancelledError,
  ConfigInvalidError,
  MalformedToolCallError,
  ProviderOutputExhaustedError,
  ProviderEmptyAnswerError,
] as const;

export function isNonProviderFault(error: unknown): boolean {
  return NON_PROVIDER_FAULTS.some((errorClass) => error instanceof errorClass);
}

// The window a retry decision runs under (#3873 review). The outage window replaces the attempt
// count only after a failure that says the provider is unavailable (a timeout, a refused
// connection, a retryable 5xx, a rate limit). A retry that reacts to the model's own output (a
// rejected tool-call shape and its schema-repair correction) keeps the attempt count, window or
// not: the provider answered every time, and waiting longer cannot make the model's answer valid.
function decisionWindowMs(config: RetryConfig, error: Error): number | undefined {
  return isNonProviderFault(error) ? undefined : config.retryWindowMs;
}

// The policy one retry decision applies, derived from the window it actually runs under, so a
// retry line can never name a policy the loop did not apply (#3873).
function retryPolicyFor(config: RetryConfig, error: Error): RetryPolicy {
  return decisionWindowMs(config, error) === undefined ? "attempts" : "outage-window";
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

// A provider cooldown is a minimum wait, not the exponential backoff ceiling. Honour it
// within the remaining request budget and platform timer bound; retrying early can consume
// every attempt while the same overloaded provider is still unavailable.
function retryDelayMs(
  error: Error,
  attempt: number,
  base: number,
  random: () => number,
  jitterProviderCooldown = false,
): number {
  const retryAfterMs = providerErrorDetail(error).retryAfterMs;
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    const jitter = jitterProviderCooldown ? Math.max(1, backoffDelayMs(attempt, base, random)) : 0;
    return Math.min(retryAfterMs + jitter, MAX_TIMER_DELAY_MS);
  }
  return backoffDelayMs(attempt, base, random);
}

// What the loop does after a failed attempt: sleep and retry, or stop and say why. A retry whose
// delay does not fit what is left of the budget could never run, so the call ends at once instead
// of sleeping the rest of the budget away first (PR #3452 review).
type RetryStop =
  | { readonly stop: "terminal" | "max-retries" }
  | { readonly stop: "budget"; readonly delayMs: number; readonly remainingMs: number };
type RetryDecision =
  { readonly sleepMs: number; readonly repair?: RetryRepairReason | undefined } | RetryStop;

interface RetryBudget {
  readonly remainingMs: number;
  readonly elapsedMs: () => number;
}

// The one steered repair of a call (#3873, F17), decided before the ordinary retry rules: it runs at
// once, is granted once, ignores the attempt count and the outage window, and only the budget can
// refuse it — a refused repair ends the call as a budget stop, so the log says the loop wanted to go
// on, not that the failure was terminal.
function repairDecision(
  lastError: Error,
  config: RetryConfig,
  budget: RetryBudget,
  repairs: number,
): RetryDecision | undefined {
  const repair = repairs === 0 ? config.repair?.(lastError) : undefined;
  if (repair === undefined) return undefined;
  if (budget.remainingMs <= 0)
    return { stop: "budget", delayMs: 0, remainingMs: budget.remainingMs };
  return { sleepMs: 0, repair };
}

// `attempt` counts the provider attempts only: a steered repair is granted on top of them.
function retryDecision(
  lastError: Error,
  attempt: number,
  config: RetryConfig,
  budget: RetryBudget,
  random: () => number,
): RetryDecision {
  if (!isRetryableError(lastError) || config.shouldRetry?.(lastError) === false)
    return { stop: "terminal" };
  const windowMs = decisionWindowMs(config, lastError);
  if (windowMs === undefined && attempt > config.maxRetries) return { stop: "max-retries" };
  const delayMs = retryDelayMs(
    lastError,
    attempt,
    config.retryBaseDelayMs,
    random,
    config.jitterProviderCooldown,
  );
  // Never below zero: an attempt that outlives the window (a silent one runs to its own bound)
  // ends it with nothing left, and a negative duration would make its exhausted line invalid, so
  // the very line that says the window ran out was dropped (#3873 review).
  const remainingMs =
    windowMs === undefined
      ? budget.remainingMs
      : Math.max(0, Math.min(budget.remainingMs, windowMs - budget.elapsedMs()));
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

/**
 * What a call tells the caller that asked to hear it (#3873 review): a failure that says the
 * provider is unavailable — a timeout, a refused connection, a retryable 5xx, a rate limit — was
 * met with a scheduled retry; the call's admission is held, before an attempt, by an open circuit
 * breaker, a saturated half-open probe slot or a cooldown the provider announced; or a call that
 * had been retried or held settled. The retries a steered repair or a schema correction grant
 * answer the model's own output, not an unavailable provider, and are never announced. Counts and
 * closed words only — no provider text, no content. Local: never serialized into a provider request.
 */
export type GatewayRetryNotice =
  | {
      readonly kind: "scheduled";
      /** The failed provider attempt this retry follows, counted from 1. */
      readonly attempt: number;
      readonly retryPolicy: RetryPolicy;
    }
  | {
      /**
       * Told when an admission begins to wait, for the first attempt of a buffered or a streamed
       * call and for every retry's alike: no failed attempt of the call precedes the first one, so
       * this is the only way a caller learns that the call is held. A wait that cannot fit what is
       * left of the call's window never begins and is not announced; the `budget-refused` outcome
       * of the `gateway.circuit.wait` line records that refusal.
       */
      readonly kind: "admission-wait";
      readonly reason: CircuitWaitReason;
      readonly retryPolicy: RetryPolicy;
    }
  | {
      /**
       * Told only to a call that was retried or held before, once, when the call ends: it was
       * answered, or it failed for good (the window refused it, or it was cancelled, included).
       */
      readonly kind: "settled";
      readonly outcome: "answered" | "failed";
    };

/**
 * Runs inside the retry loop and the admission wait, synchronously, so it MUST NOT throw: it owns
 * and logs its own failures (the same contract as `GatewayDeps.onContextWindowReported`).
 */
export type GatewayRetryObserver = (notice: GatewayRetryNotice) => void;

/**
 * One call's conversation with its observer (#3873 review): what the call does — a retry scheduled,
 * an admission held — is told to the observer, and the call is remembered as owed exactly one
 * settlement when it ends. The call's admission waits and every retry loop it runs share the one
 * announcer, which is why a streamed call's first admission, ahead of its loop, settles with the
 * loop that follows it. A call whose caller did not ask to hear it has no announcer and takes its
 * exact path as before.
 */
export interface RetryAnnouncer {
  /** A failure that says the provider is unavailable was met with a scheduled retry. */
  scheduled(attempt: number, retryPolicy: RetryPolicy): void;
  /** The call's admission began to wait for the breaker or a provider cooldown. */
  admissionWait(reason: CircuitWaitReason, retryPolicy: RetryPolicy): void;
  /** The call ended. Silent for a call the observer heard nothing about, and for a second end. */
  settled(outcome: "answered" | "failed"): void;
}

export function retryAnnouncer(observer: GatewayRetryObserver): RetryAnnouncer {
  // Set before the observer is told, so an observer that broke its contract still leaves the call
  // owed its settlement.
  let owed = false;
  return {
    scheduled: (attempt, retryPolicy): void => {
      owed = true;
      observer({ kind: "scheduled", attempt, retryPolicy });
    },
    admissionWait: (reason, retryPolicy): void => {
      owed = true;
      observer({ kind: "admission-wait", reason, retryPolicy });
    },
    settled: (outcome): void => {
      if (!owed) return;
      owed = false;
      observer({ kind: "settled", outcome });
    },
  };
}

// What the retry loop needs in order to LABEL its lines. Optional in full: an unwired caller
// keeps the exact behaviour it had before instrumentation, down to the allocation count. The
// announcer is the one member that is not a label: the caller's own ear on the call, set only by a
// caller that surfaces an outage to its operator (the coding sidecar route) and shared with the
// call's admission waits.
export interface RetryLogContext {
  readonly sink?: ModelGatewayLogSink | undefined;
  readonly modelId?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly announcer?: RetryAnnouncer | undefined;
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
// restating it here costs one field and removes that inference entirely. Both error types
// preserve a provider cooldown as a duration; neither contributes provider response content.
export interface ProviderErrorDetail {
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
  readonly retryAfterHeader?: NonNullable<RateLimitError["retryAfterHeader"]>;
}

export function providerErrorDetail(error: unknown): ProviderErrorDetail {
  const httpStatus = providerErrorHttpStatus(error);
  const retryAfterMs =
    error instanceof RateLimitError || error instanceof ProviderError
      ? (error.retryAfterMs ?? undefined)
      : undefined;
  const retryAfterHeader =
    error instanceof RateLimitError || error instanceof ProviderError
      ? error.retryAfterHeader
      : undefined;
  return {
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(retryAfterHeader === undefined ? {} : { retryAfterHeader }),
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
  readonly retryPolicy: RetryPolicy;
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
        retryPolicy: input.retryPolicy,
      },
    ),
  );
}

function logRetryScheduled(
  input: RetryFailureLogInput,
  decision: Readonly<{ sleepMs: number; repair?: RetryRepairReason | undefined }>,
): void {
  const reason: RetryScheduledReason = decision.repair ?? "retryable-error";
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
        reason,
        ...providerErrorDetail(input.error),
        retryPolicy: input.retryPolicy,
      },
    ),
  );
}

// Admission did not call the provider: retrying this refusal would invent another attempt.
// Retry callers retain their actual provider failure; fresh callers receive the existing
// non-retryable circuit error taxonomy. The wait event carries the closed refusal reason.
class CircuitAdmissionRefusal extends CircuitOpenError {
  constructor(readonly originalError: Error | undefined) {
    super("request budget cannot accommodate provider admission");
  }
}

class AdmissionBudgetExhausted extends TimeoutError {
  constructor(readonly originalError: Error | undefined) {
    super("request budget exhausted before provider admission");
  }
}

function rethrowTerminalAdmission(error: unknown): void {
  if (error instanceof CircuitAdmissionRefusal || error instanceof AdmissionBudgetExhausted)
    throw error.originalError ?? error;
}

type RetryOperation<T> = (
  attemptTimeoutMs?: number,
  remainingBudgetMs?: number,
  previousError?: Error,
  // How long this attempt may wait for provider admission; with a retry window it is clipped to
  // what is left of the window, so a breaker wait never outlasts the window (#3873).
  admissionBudgetMs?: number,
) => Promise<T>;

interface RetryState {
  readonly config: RetryConfig;
  readonly clock: Clock;
  readonly signal: AbortSignal | undefined;
  readonly random: () => number;
  readonly context: RetryLogContext;
  readonly sink: ModelGatewayLogSink;
  readonly elapsed: () => number;
  readonly start: number;
  attempt: number;
  // Steered repairs granted so far (#3873, F17): at most one per call. They sit on top of the
  // provider attempts, so `attempt - repairs` is what the attempt count and the backoff ladder see.
  repairs: number;
  lastError: Error | undefined;
}

type RetryAttemptResult<T> = { readonly done: true; readonly value: T } | { readonly done: false };

async function executeRetryAttempt<T>(
  operation: RetryOperation<T>,
  state: RetryState,
): Promise<RetryAttemptResult<T>> {
  const { config, clock, signal, context, sink, elapsed, start, attempt } = state;
  const maxAttempts = config.maxRetries + 1;
  if (
    Number.isNaN(maxAttempts) ||
    (config.retryWindowMs === undefined && attempt - state.repairs > maxAttempts)
  )
    throw state.lastError ?? new CancelledError("request timeout budget exhausted after retries");
  assertNotAborted(signal);
  const remaining = remainingBudgetMs(start, config.timeoutMs, clock);
  if (remaining <= 0)
    throw budgetExhaustedError(state.lastError, sink, context, attempt, elapsed());
  try {
    const value = await operation(
      attemptTimeoutFor(config, remaining),
      remaining,
      state.lastError,
      admissionBudgetFor(config, remaining, (): number => clock.now() - start),
    );
    return { done: true, value };
  } catch (error) {
    rethrowTerminalAdmission(error);
    return recordFailedAttempt(state, asError(error));
  }
}

// What follows a failed attempt: the steered repair when one is due, else the retry rules; the
// line that says which, and the sleep before the next attempt or the rethrow that ends the call.
// Every path records the failure on the retry lines first, which is why the catch above may hand it
// over (a `record` helper is the evidence call `check:error-observability` looks for).
async function recordFailedAttempt<T>(
  state: RetryState,
  error: Error,
): Promise<RetryAttemptResult<T>> {
  const { config, clock, signal, random, context, sink, elapsed, start, attempt } = state;
  state.lastError = error;
  const budget: RetryBudget = {
    remainingMs: remainingBudgetMs(start, config.timeoutMs, clock),
    elapsedMs: (): number => clock.now() - start,
  };
  const decision =
    repairDecision(error, config, budget, state.repairs) ??
    retryDecision(error, attempt - state.repairs, config, budget, random);
  const failureLog: RetryFailureLogInput = {
    sink,
    context,
    attempt,
    maxRetries: config.maxRetries,
    retryPolicy: retryPolicyFor(config, error),
    error,
    durationMs: elapsed(),
  };
  if (!("sleepMs" in decision)) {
    logRetryExhausted(failureLog, decision);
    throw error;
  }
  if (decision.repair !== undefined) state.repairs += 1;
  logRetryScheduled(failureLog, decision);
  announceProviderRetry(state, error, decision.repair, failureLog.retryPolicy);
  await sleepWithCancellation(clock, decision.sleepMs, signal);
  return { done: false };
}

// Tells the call's observer that a provider that says it is unavailable is being retried. A
// steered repair or a schema correction answers the model's own output (`isNonProviderFault`), so
// the provider was not unavailable and nothing is announced.
function announceProviderRetry(
  state: RetryState,
  error: Error,
  repair: RetryRepairReason | undefined,
  retryPolicy: RetryPolicy,
): void {
  if (repair !== undefined || isNonProviderFault(error)) return;
  state.context.announcer?.scheduled(state.attempt - state.repairs, retryPolicy);
}

// Tells the observer that a call it heard retry or wait has ended; a call it heard nothing about
// stays silent, and so does one whose admission was refused before it ever began to wait.
function announceSettled(state: RetryState, outcome: "answered" | "failed"): void {
  state.context.announcer?.settled(outcome);
}

// The admission wait of one attempt: the call's remaining budget, clipped by what is left of a
// retry window. Never below one millisecond, so an attempt at the window's edge refuses at once.
// The clock is read only for a windowed call, so every other call keeps its exact clock reads.
// Exported for the one admission that precedes the loop: a streamed call's initial admission
// (`gateway.ts`), which waits under the same clip as every retry's admission (#3873).
export function admissionBudgetFor(
  config: RetryConfig,
  remainingMs: number,
  elapsedMs: () => number,
): number {
  return config.retryWindowMs === undefined
    ? remainingMs
    : Math.max(1, Math.min(remainingMs, config.retryWindowMs - elapsedMs()));
}

export function executeWithRetry<T>(
  // Each attempt gets its own bound and what is left of the call's budget, which a streamed read
  // may spend while the provider keeps producing (ADR-0003).
  operation: RetryOperation<T>,
  config: RetryConfig,
  clock: Clock,
  signal?: AbortSignal,
  random: () => number = Math.random,
  logContext: RetryLogContext = {},
  resume?: RetryResume,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const state: RetryState = {
      config,
      clock,
      signal,
      random,
      context: logContext,
      sink: resolveLogSink(logContext.sink),
      elapsed: logTimer(),
      start: clock.now(),
      attempt: resume?.attempts ?? 1,
      repairs: resume?.repairs ?? 0,
      lastError: undefined,
    };
    const fail = (error: unknown): void => {
      announceSettled(state, "failed");
      reject(asError(error));
    };
    const advance = (): void => {
      // Return no successor promise: completed attempts are released rather than retained in a
      // recursive promise chain. Only the current provider attempt or its backoff is pending.
      void executeRetryAttempt(operation, state).then((result) => {
        if (result.done) {
          announceSettled(state, "answered");
          resolve(result.value);
        } else {
          state.attempt += 1;
          advance();
        }
      }, fail);
    };
    if (resume === undefined) {
      advance();
      return;
    }
    // The failed attempt comes first (attempt 1, or the call's count so far): its repair or retry
    // decision, and the line that says which; a stop rejects with the failure itself, exactly as
    // the loop would have.
    void recordFailedAttempt(state, resume.failedAttempt).then(() => {
      state.attempt += 1;
      advance();
    }, fail);
  });
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

// One end-to-end buffered budget reserves every configured attempt and capped backoff sleep.
// A longer provider cooldown consumes this same budget and may leave fewer attempts; it is never
// shortened to retry before recovery. Gateway retries and surrounding route deadlines share this
// derivation so an outer deadline cannot interrupt the provider's own bounded wait.
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
// the budget derived from it bounds the call. Every chat call — buffered, and a stream before its
// first content — derives its policy from here. The one steered repair of an exhausted or empty
// answer (#3873, F17, F23) is NOT part of it: only a call that asks for it with the explicit
// `answerRepair: "steered"` signal gets it (`gateway.ts` `callRetryConfig`), so an interactive
// surface such as the commit draft never makes a hidden second generation (#3873 review).
export function providerRetryConfig(provider: ProviderRetryPolicy): RetryConfig {
  return {
    maxRetries: provider.maxRetries,
    retryBaseDelayMs: provider.retryBaseDelayMs,
    attemptTimeoutMs: chatAttemptTimeoutMs(provider),
    timeoutMs: providerRequestBudgetMs(provider),
  };
}

// #3873: how long an autonomous coding turn keeps retrying a transiently unavailable provider (429,
// a retryable 5xx, a refused connection, a silent attempt) and waits through an open breaker,
// instead of failing after the provider's configured attempt count. At peak load a customer's
// LiteLLM gateway sheds load for minutes, and an autonomous coding run that gave up after three
// attempts within two seconds failed outright although the gateway recovered (live chaos
// qualification). The breaker still admits only its half-open probes, so waiting callers do not
// add load while it recovers.
// Only a call that carries the explicit `outagePolicy: "outage-window"` request signal (the coding
// sidecar route's buffered and streamed calls) runs under it; see `gateway.ts`.
export const GATEWAY_CODING_OUTAGE_WINDOW_MS = 600_000;

/**
 * The outage window a call runs under (#3873): the configuration's `codingOutageWindowMs`
 * (`GATEWAY_CODING_OUTAGE_WINDOW_MS` when absent) for a call that asked for the outage policy, 0
 * for every other call and whenever the window is switched off. The one resolution the gateway and
 * the route deadline behind a coding call share.
 */
export function callOutageWindowMs(
  config: { readonly codingOutageWindowMs?: number | undefined },
  outagePolicy: "outage-window" | undefined,
): number {
  return outagePolicy === "outage-window"
    ? (config.codingOutageWindowMs ?? GATEWAY_CODING_OUTAGE_WINDOW_MS)
    : 0;
}

// #3873 review: under the outage window it is the WINDOW, not the provider's attempt budget, that
// bounds how long a call keeps scheduling retries and waiting for admission. The call's end-to-end
// budget must therefore never cut the window short: it is the window plus one full attempt bound
// (the attempt the window admits last keeps that bound, so a healthy answer is never cut at the
// window's edge), and never less than the budget the call has without a window. Without this, the
// window was silently clipped to the provider budget: 600 s at `maxRetries: 0`, whatever was set.
function outageCallBudgetMs(budgetMs: number, windowMs: number, attemptBoundMs: number): number {
  if (windowMs <= 0) return budgetMs;
  return Math.min(Math.max(budgetMs, windowMs + attemptBoundMs), MAX_TIMER_DELAY_MS);
}

/** The end-to-end budget of a buffered call (`Gateway.chat()`) under an outage window (0: none). */
export function bufferedCallBudgetMs(provider: ProviderRetryPolicy, windowMs: number): number {
  return outageCallBudgetMs(
    providerRequestBudgetMs(provider),
    windowMs,
    chatAttemptTimeoutMs(provider),
  );
}

/**
 * The end-to-end budget of a streamed call (`Gateway.chatStream()`) under an outage window (0:
 * none). A streamed attempt's own bound is the whole stream budget its read may spend.
 */
export function streamedCallBudgetMs(
  provider: { readonly timeoutMs: number },
  windowMs: number,
): number {
  const budgetMs = streamRequestBudgetMs(provider);
  return outageCallBudgetMs(budgetMs, windowMs, budgetMs);
}

/**
 * The retry policy of a call that asked for the outage window: retries for the window, inside a
 * budget the window cannot outrun (`bufferedCallBudgetMs`). A window of 0 (`codingOutageWindowMs:
 * 0`, or a call without the outage signal) keeps the provider's attempt count and budget instead.
 */
export function codingWorkbenchRetryConfig(
  provider: ProviderRetryPolicy,
  windowMs: number,
): RetryConfig {
  const config = providerRetryConfig(provider);
  return windowMs > 0
    ? { ...config, retryWindowMs: windowMs, timeoutMs: bufferedCallBudgetMs(provider, windowMs) }
    : config;
}

export interface CircuitBreakerAdmission {
  readonly halfOpen: boolean;
  settle(outcome: "success" | "failure" | "non-provider-fault", error?: unknown): void;
}

interface CircuitAdmissionWait {
  readonly remainingMs: number;
  readonly previousError?: Error | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly correlationId?: string | undefined;
  readonly jitterMs: number | (() => number);
  // The waiting call's retry policy (#3873). `outage-window` waits for an open breaker's cooldown
  // and probe slot even without a provider-announced cooldown, instead of refusing at once; absent
  // means `attempts`, the fail-fast breaker. Every wait line reports it.
  readonly retryPolicy?: RetryPolicy | undefined;
  // The waiting call's announcer (#3873 review), told each time the admission begins to wait. The
  // admission before a call's first attempt follows no failed attempt, so the retry loop alone
  // could never tell the call's observer that the breaker or a provider cooldown holds it.
  readonly announcer?: RetryAnnouncer | undefined;
}

type CircuitWaitReason = "provider-cooldown" | "circuit-cooldown" | "probe-saturated";

const GATEWAY_CIRCUIT_WAIT_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.circuit.wait",
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "resilience.CircuitBreaker.logWait",
  fields: {
    modelId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 256 },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["provider-cooldown", "circuit-cooldown", "probe-saturated"],
    },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["started", "changed", "timer", "cancelled", "failed", "budget-refused"],
    },
    delayMs: { type: "number", dataClass: "duration", required: true },
    remainingMs: { type: "number", dataClass: "duration", required: false },
    retryPolicy: RETRY_POLICY_FIELD,
  },
  diagnosticWhen: [{ field: "outcome", values: ["cancelled", "failed", "budget-refused"] }],
  causal: "none",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["gateway-circuit-breaker"],
  proofIds: ["gateway.circuit.wait.emitted-line"],
  releaseImpact: "patch",
});

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private generation = 0;
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private probesRemaining = 0;
  // Tracks how many half-open probe slots are currently in-flight.
  private probesInFlight = 0;
  private providerCooldownUntil = 0;
  private readonly waiters = new Set<() => void>();
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
  assertAllowed(correlationId?: string): CircuitBreakerAdmission {
    if (this.state === "open") {
      this.enterHalfOpenOrReject(correlationId);
    }
    if (this.state === "half-open") {
      this.admitProbeOrReject(correlationId);
    }
    return this.createAdmission(correlationId);
  }

  waitForAdmission(options: CircuitAdmissionWait): Promise<{
    readonly admission: CircuitBreakerAdmission;
    readonly remainingMs: number;
  }> {
    return new Promise((resolve, reject) => {
      const start = this.clock.now();
      const announced = this.providerCooldownUntil > start;
      const recovering =
        announced ||
        options.retryPolicy === "outage-window" ||
        (options.previousError !== undefined &&
          providerErrorDetail(options.previousError).retryAfterMs !== undefined);
      const advance = async (): Promise<void> => {
        assertNotAborted(options.signal);
        const remainingMs = Math.max(0, options.remainingMs - (this.clock.now() - start));
        const blocked = this.blockedWait(recovering, options.jitterMs);
        if (remainingMs <= 0) throw this.waitBudgetError(options, blocked, remainingMs);
        if (blocked === undefined) {
          resolve({ admission: this.assertAllowed(options.correlationId), remainingMs });
          return;
        }
        if (blocked.delayMs >= remainingMs && blocked.reason !== "probe-saturated")
          throw this.waitBudgetError(options, blocked, remainingMs);
        await this.waitForChange(Math.min(blocked.delayMs, remainingMs), blocked.reason, options);
        // Rearm only after this wait has disposed its listener and timer; do not retain it by
        // awaiting or returning the next admission attempt.
        void advance().catch(reject);
      };
      void advance().catch(reject);
    });
  }

  private waitBudgetError(
    options: CircuitAdmissionWait,
    blocked: { readonly reason: CircuitWaitReason; readonly delayMs: number } | undefined,
    remainingMs: number,
  ): Error {
    if (blocked === undefined) return new AdmissionBudgetExhausted(options.previousError);
    this.logWait(
      blocked.reason,
      "budget-refused",
      blocked.reason === "probe-saturated"
        ? remainingMs
        : Math.min(blocked.delayMs, MAX_TIMER_DELAY_MS),
      options,
      remainingMs,
    );
    return new CircuitAdmissionRefusal(options.previousError);
  }

  private blockedWait(
    allowCircuitWait: boolean,
    jitterMs: CircuitAdmissionWait["jitterMs"],
  ): { readonly reason: CircuitWaitReason; readonly delayMs: number } | undefined {
    const cooldown = this.providerCooldownUntil - this.clock.now();
    if (cooldown > 0) {
      const jitter = typeof jitterMs === "number" ? jitterMs : jitterMs();
      return {
        reason: "provider-cooldown",
        delayMs: Math.min(cooldown + Math.max(1, jitter), MAX_TIMER_DELAY_MS),
      };
    }
    if (!allowCircuitWait) return undefined;
    if (this.state === "open" && this.openedAt !== null) {
      const remaining = this.config.cooldownMs - (this.clock.now() - this.openedAt);
      if (remaining > 0) return { reason: "circuit-cooldown", delayMs: remaining };
    }
    return this.state === "half-open" && this.probesInFlight >= this.config.halfOpenProbes
      ? { reason: "probe-saturated", delayMs: Number.POSITIVE_INFINITY }
      : undefined;
  }

  private async waitForChange(
    delayMs: number,
    reason: CircuitWaitReason,
    options: CircuitAdmissionWait,
  ): Promise<void> {
    const controller = new AbortController();
    const abort = (): void => {
      controller.abort();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    let notify: (() => void) | undefined;
    const changed = new Promise<"changed">((resolve) => {
      notify = (): void => {
        resolve("changed");
      };
      this.waiters.add(notify);
    });
    try {
      this.beginWait(reason, delayMs, options);
      assertNotAborted(options.signal);
      const outcome = await Promise.race([
        changed,
        this.clock.sleep(delayMs, controller.signal).then(() => "timer" as const),
      ]);
      assertNotAborted(options.signal);
      this.logWait(reason, outcome, delayMs, options);
    } catch (error) {
      this.logWait(
        reason,
        options.signal?.aborted === true ? "cancelled" : "failed",
        delayMs,
        options,
      );
      if (options.signal?.aborted === true)
        throw new CancelledError("request cancelled while waiting for provider admission");
      throw error;
    } finally {
      if (notify !== undefined) this.waiters.delete(notify);
      options.signal?.removeEventListener("abort", abort);
      controller.abort();
    }
  }

  // The moment an admission begins to wait: its `started` line first, then the call's announcer, so
  // the observer hears of the wait the log already records. Both happen once per wait the call
  // enters, never for a refusal that precedes the wait.
  private beginWait(
    reason: CircuitWaitReason,
    delayMs: number,
    options: CircuitAdmissionWait,
  ): void {
    this.logWait(reason, "started", delayMs, options);
    options.announcer?.admissionWait(reason, options.retryPolicy ?? "attempts");
  }

  private logWait(
    reason: CircuitWaitReason,
    outcome: "started" | "changed" | "timer" | "cancelled" | "failed" | "budget-refused",
    delayMs: number,
    options: CircuitAdmissionWait,
    remainingMs?: number,
  ): void {
    const { correlationId } = options;
    this.log.write(
      activityLogEvent(
        GATEWAY_CIRCUIT_WAIT_OPERATION,
        { level: "info", ...(correlationId === undefined ? {} : { correlationId }) },
        {
          modelId: logModelId(this.modelId),
          reason,
          outcome,
          delayMs,
          ...(remainingMs === undefined ? {} : { remainingMs }),
          retryPolicy: options.retryPolicy ?? "attempts",
        },
      ),
    );
  }

  // Each admission settles once. Circuit state and probe ownership stay generation-bound;
  // parallel recovery minima may extend only the open outage caused by that generation.
  private createAdmission(correlationId: string | undefined): CircuitBreakerAdmission {
    const origin = { generation: this.generation, halfOpen: this.state === "half-open" };
    let settled = false;
    return {
      halfOpen: origin.halfOpen,
      settle: (outcome, error): void => {
        if (settled) return;
        settled = true;
        this.settleAdmission(origin, outcome, error, correlationId);
      },
    };
  }

  private settleAdmission(
    origin: { readonly generation: number; readonly halfOpen: boolean },
    outcome: "success" | "failure" | "non-provider-fault",
    error: unknown,
    correlationId: string | undefined,
  ): void {
    const current = origin.generation === this.generation;
    // Parallel responses from the generation that opened this outage still announce recovery
    // minima. Once a probe generation has begun, earlier responses have no authority over it.
    if (!current && !this.canExtendClosedGenerationOutage(origin)) return;
    const before = this.admissionState();
    this.announceProviderCooldown(outcome, error);
    if (current) {
      if (outcome === "success") this.recordSuccess(correlationId);
      else if (outcome === "failure") this.recordFailure(correlationId);
      else this.recordNonProviderFault();
    }
    if (before !== this.admissionState()) {
      for (const notify of this.waiters) notify();
    }
  }

  private canExtendClosedGenerationOutage(origin: {
    readonly generation: number;
    readonly halfOpen: boolean;
  }): boolean {
    return !origin.halfOpen && this.state === "open" && this.generation === origin.generation + 1;
  }

  private announceProviderCooldown(outcome: string, error: unknown): void {
    if (outcome !== "failure") return;
    if (!(error instanceof ProviderError || error instanceof RateLimitError) || !error.retryable)
      return;
    const cooldown = error.retryAfterMs;
    if (cooldown === null || !Number.isFinite(cooldown) || cooldown <= 0) return;
    this.providerCooldownUntil = Math.max(
      this.providerCooldownUntil,
      this.clock.now() + Math.min(cooldown, MAX_TIMER_DELAY_MS),
    );
  }

  private admissionState(): string {
    return [this.state, this.openedAt, this.probesInFlight, this.providerCooldownUntil].join(":");
  }

  private enterHalfOpenOrReject(correlationId: string | undefined): void {
    if (this.openedAt !== null && this.clock.now() - this.openedAt >= this.config.cooldownMs) {
      this.state = "half-open";
      this.generation += 1;
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

  private recordSuccess(correlationId?: string): void {
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

  private recordFailure(correlationId?: string): void {
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
  private recordNonProviderFault(): void {
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
    this.generation += 1;
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
    this.generation += 1;
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
