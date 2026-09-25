// Orchestrator: routes a request through the capability registry, then through the
// circuit breaker, bounded retry, and the provider adapter. Usage metadata
// (request id, latency, cost class) is owned by the gateway, not the provider, so
// the audit ledger (issue #10) has a reliable typed target on every response.

import { randomUUID } from "node:crypto";
import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import {
  CancelledError,
  ConfigInvalidError,
  ContextOverflowError,
  GatewayError,
  ProviderEmptyAnswerError,
  ProviderOutputExhaustedError,
  TransportError,
  UnknownModelError,
} from "@oscharko-dev/keiko-security/errors/gateway";
import { deriveContextProfileFromCapability } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { findConfiguredCapability } from "./model-selection.js";
import {
  activityLogErrorKind,
  logEndpointHost,
  logLevelEnabled,
  logModelId,
  logTimer,
  resolveLogSink,
  type ModelGatewayLogContext,
  type ModelGatewayLogSink,
} from "./observability.js";
import { OpenAiAdapter, ResponseRedactionError } from "./openai-adapter.js";
import { countGatewayPromptTokens } from "./prompt-token-accounting.js";
import { createGatewayToolCatalogBridge, GatewayToolCatalogError } from "./toolCatalogBridge.js";
import {
  CircuitBreaker,
  codingWorkbenchProviderTimeoutMs,
  executeWithRetry,
  GATEWAY_BUFFERED_BUDGET_FLOOR_MS,
  GATEWAY_SILENCE_FLOOR_MS,
  providerRequestBudgetMs,
  providerRetryConfig,
  streamRequestBudgetMs,
  systemClock,
} from "./resilience.js";
import { assertValidGatewaySamplingParameters } from "./types.js";
import type {
  Clock,
  CircuitBreakerStatus,
  GatewayConfig,
  GatewayRequest,
  GatewayStreamChunk,
  ModelCapability,
  ModelProviderConfig,
  NormalizedResponse,
  ProviderAdapter,
  StreamReadBounds,
  UsageMetadata,
} from "./types.js";

/** Shared, durable admission owned by the host; invoked before EVERY provider attempt. */
export interface GatewaySpendBudget {
  reserve(
    capability: ModelCapability,
    request: GatewayCallRequest,
    correlationId: string,
  ): GatewaySpendReservation;
}

export interface GatewaySpendReservation {
  /** Missing usage retains the full upper reservation, including cancellation or process loss. */
  settle(usage: UsageMetadata | undefined): void;
}

export interface GatewayDeps {
  readonly spendBudget?: GatewaySpendBudget | undefined;
  readonly adapter?: ProviderAdapter | undefined;
  readonly clock?: Clock | undefined;
  // Randomness source for the retry backoff's equal jitter. Injectable so tests
  // that pin exact sleep/budget arithmetic stay deterministic (same philosophy
  // as the injectable Clock). Defaults to Math.random.
  readonly random?: (() => number) | undefined;
  // Activity-log sink (ADR-0019: declared as a local port in `observability.ts`, never imported
  // from the server). Unset means no-op — the Gateway behaves exactly as it did before.
  readonly log?: ModelGatewayLogSink | undefined;
  // Correlation for the one-time configuration snapshot emitted by construction. This is not a
  // default for calls: each request continues to carry its own logContext correlation id.
  readonly configurationCorrelationId?: string | undefined;
  // Fetch seam (ADR-0173 §7.3): threaded into every `OpenAiAdapter` this Gateway constructs, so a
  // caller can replace the transport for deterministic replay (`createScriptedGatewayFetch`)
  // without touching the real network. Unset means the adapter falls back to `globalThis.fetch`,
  // exactly as it did before this field existed.
  readonly fetchImpl?: typeof fetch | undefined;
}

// A gateway call plus the caller's log context.
//
// `GatewayRequest` is a wire contract owned by `keiko-contracts` and a correlation id is not wire
// data — it is a local diagnostic handle — so the field is added HERE, as an optional extension of
// the contract type. Every existing caller keeps compiling and keeps passing a plain
// `GatewayRequest`: the extra property is optional, so the contract type is still assignable to
// this one.
export interface GatewayCallRequest extends GatewayRequest {
  readonly logContext?: ModelGatewayLogContext | undefined;
  /** A closed local profile; never serialized into a provider request body. */
  readonly latencyProfile?: "coding-workbench" | undefined;
}

// The two ids a single gateway call carries.
//
// `requestId` is minted here per call and is what `usage.requestId` and a thrown GatewayError
// report. `correlationId` is what the LINES are tagged with, and the caller's id wins when it
// supplied one: an operator diagnosing a frozen indexing run greps for the id of the RUN, and a
// gateway line tagged with an id that exists nowhere outside this process would not be found by
// that grep. The two are never lost — `callIdFields` puts the request id on the line whenever it
// differs from the correlation id, so the join between the two id spaces is on record.
interface CallIds {
  readonly requestId: string;
  readonly correlationId: string;
}

function callIds(requestId: string, request: GatewayCallRequest): CallIds {
  return { requestId, correlationId: request.logContext?.correlationId ?? requestId };
}

function callIdFields(ids: CallIds): { readonly requestId?: string } {
  return ids.correlationId === ids.requestId ? {} : { requestId: ids.requestId };
}

function measuredCatalogFailureUsage(
  error: unknown,
  capability: ModelCapability,
  correlationId: string,
): UsageMetadata | undefined {
  if (!(error instanceof GatewayToolCatalogError) || error.partialUsage === undefined) {
    return undefined;
  }
  const { promptTokens, completionTokens } = error.partialUsage;
  if (
    !Number.isSafeInteger(promptTokens) ||
    promptTokens < 0 ||
    !Number.isSafeInteger(completionTokens) ||
    completionTokens < 0
  ) {
    return undefined;
  }
  return {
    requestId: correlationId,
    promptTokens,
    completionTokens,
    latencyMs: 0,
    costClass: capability.costClass,
  };
}

const GATEWAY_CONFIG_RESOLVED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.config.resolved",
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "gateway.logConfigResolved",
  fields: {
    providerCount: { type: "integer", dataClass: "count", required: true },
    providerConfigDigest: {
      type: "string",
      dataClass: "digest",
      required: true,
      maxLength: 64,
    },
  },
  causal: "none",
  lifecycle: "state",
  analyzerProjection: "capability",
  failureClasses: ["gateway-configuration"],
  proofIds: ["gateway.config.resolved.emitted-line"],
  releaseImpact: "patch",
});

const GATEWAY_TOOL_CATALOG_REPAIR_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.tool-catalog.repair",
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "gateway.logToolSchemaRepair",
  fields: {
    state: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["denied", "scheduled"],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["context-window-exceeded", "invalid-shape"],
    },
    toolCallId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 256 },
    offeredAlias: { type: "string", dataClass: "opaque-id", required: true, maxLength: 256 },
    missingRequiredCount: { type: "integer", dataClass: "count", required: false },
    invalidPathCount: { type: "integer", dataClass: "count", required: false },
    unexpectedPropertyCount: { type: "integer", dataClass: "count", required: false },
    droppedPathCount: { type: "integer", dataClass: "count", required: false },
    promptTokens: { type: "integer", dataClass: "count", required: true },
    maxPromptTokens: { type: "integer", dataClass: "count", required: true },
    maxOutputTokens: { type: "integer", dataClass: "count", required: true },
    safetyMarginTokens: { type: "integer", dataClass: "count", required: true },
    correctionMessageCount: { type: "integer", dataClass: "count", required: true },
    effectStarted: {
      type: "boolean",
      dataClass: "closed-enum",
      required: true,
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["gateway-tool-schema-rejection"],
  proofIds: ["gateway.tool-catalog.repair.emitted-line"],
  releaseImpact: "patch",
});

const GATEWAY_CALL_STARTED_OPERATION_BASE = {
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "gateway.logCallStarted",
  causal: "correlation",
  lifecycle: "start",
  analyzerProjection: "timeline",
  releaseImpact: "patch",
} as const;

const GATEWAY_CALL_STARTED_IDENTITY_FIELDS = {
  requestId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 128 },
  modelId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 256 },
  endpointDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
  costClass: {
    type: "string",
    dataClass: "closed-enum",
    required: true,
    values: ["low", "medium", "high"],
  },
  timeoutMs: { type: "number", dataClass: "duration", required: true },
  maxRetries: { type: "integer", dataClass: "count", required: true },
} as const;

const GATEWAY_CALL_STARTED_EXECUTION_FIELDS = {
  reasoningEffort: {
    type: "string",
    dataClass: "closed-enum",
    required: false,
    values: ["minimal", "low", "medium", "high", "xhigh"],
  },
  streaming: {
    type: "boolean",
    dataClass: "closed-enum",
    required: true,
  },
} as const;

const GATEWAY_CHAT_STARTED_OPERATION = defineActivityLogOperation({
  ...GATEWAY_CALL_STARTED_OPERATION_BASE,
  op: "gateway.chat.started",
  fields: {
    ...GATEWAY_CALL_STARTED_IDENTITY_FIELDS,
    requestBudgetMs: { type: "number", dataClass: "duration", required: true },
    upstreamStreaming: {
      type: "boolean",
      dataClass: "closed-enum",
      required: true,
    },
    ...GATEWAY_CALL_STARTED_EXECUTION_FIELDS,
  },
  failureClasses: ["gateway-chat-call"],
  proofIds: ["gateway.chat.started.emitted-line"],
});

const GATEWAY_STREAM_STARTED_OPERATION = defineActivityLogOperation({
  ...GATEWAY_CALL_STARTED_OPERATION_BASE,
  op: "gateway.stream.started",
  fields: {
    ...GATEWAY_CALL_STARTED_IDENTITY_FIELDS,
    ...GATEWAY_CALL_STARTED_EXECUTION_FIELDS,
  },
  failureClasses: ["gateway-stream-call"],
  proofIds: ["gateway.stream.started.emitted-line"],
});

const GATEWAY_CHAT_FAILED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.chat.failed",
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "gateway.logCallFailed",
  fields: {
    requestId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 128 },
    modelId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 256 },
    streaming: {
      type: "boolean",
      dataClass: "closed-enum",
      required: true,
    },
    // #3591: true only for a ProviderOutputExhaustedError — an HTTP 200 answer that spent its
    // whole output budget on reasoning before any content — so an operator can tell that apart
    // from an ordinary empty/failed provider answer without reaching for the sidecar's own record.
    // `required: false` (PR #3602 review): emitted on every failure line since this field's
    // introduction, but a record written by 1.1.6, before it existed, lacks it — a missing
    // REQUIRED field reads as an incomplete record to the analyzer, which this field is not.
    outputExhausted: {
      type: "boolean",
      dataClass: "closed-enum",
      required: false,
    },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["gateway-chat-call"],
  proofIds: ["gateway.chat.failed.emitted-line"],
  releaseImpact: "patch",
});

const GATEWAY_STREAM_COMPLETED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.stream.completed",
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "gateway.logStreamCompleted",
  fields: {
    requestId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 128 },
    modelId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 256 },
    costClass: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["low", "medium", "high"],
    },
    chunkCount: { type: "integer", dataClass: "count", required: true },
    firstTokenMs: { type: "number", dataClass: "duration", required: false },
    promptTokens: { type: "integer", dataClass: "count", required: false },
    completionTokens: { type: "integer", dataClass: "count", required: false },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["gateway-stream-call"],
  proofIds: ["gateway.stream.completed.emitted-line"],
  releaseImpact: "patch",
});

const GATEWAY_STREAM_ABANDONED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.stream.abandoned",
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "gateway.logStreamAbandoned",
  fields: {
    requestId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 128 },
    modelId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 256 },
    costClass: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["low", "medium", "high"],
    },
    streaming: {
      type: "boolean",
      dataClass: "closed-enum",
      required: true,
    },
    chunkCount: { type: "integer", dataClass: "count", required: true },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["consumer-stopped-iterating"],
    },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["gateway-stream-call"],
  proofIds: ["gateway.stream.abandoned.emitted-line"],
  releaseImpact: "patch",
});

const GATEWAY_STREAM_FAILED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.stream.failed",
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "gateway.logStreamFailed",
  fields: {
    requestId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 128 },
    modelId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 256 },
    streaming: {
      type: "boolean",
      dataClass: "closed-enum",
      required: true,
    },
    chunkCount: { type: "integer", dataClass: "count", required: true },
    afterFirstChunk: {
      type: "boolean",
      dataClass: "closed-enum",
      required: true,
    },
    // #3591: see gateway.chat.failed's identical field; `required: false` for the same reason
    // (PR #3602 review).
    outputExhausted: {
      type: "boolean",
      dataClass: "closed-enum",
      required: false,
    },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["gateway-stream-call"],
  proofIds: ["gateway.stream.failed.emitted-line"],
  releaseImpact: "patch",
});

const GATEWAY_CHAT_COMPLETED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.chat.completed",
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "gateway.logCallCompleted",
  fields: {
    requestId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 128 },
    modelId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 256 },
    costClass: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["low", "medium", "high"],
    },
    finishReason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["stop", "tool_calls", "length", "content_filter", "error", "cancelled"],
    },
    toolCallCount: { type: "integer", dataClass: "count", required: true },
    promptTokens: { type: "integer", dataClass: "count", required: true },
    completionTokens: { type: "integer", dataClass: "count", required: true },
    streaming: {
      type: "boolean",
      dataClass: "closed-enum",
      required: true,
    },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["gateway-chat-call"],
  proofIds: ["gateway.chat.completed.emitted-line"],
  releaseImpact: "patch",
});

const GATEWAY_STREAM_BUFFERED_FALLBACK_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.stream.buffered-fallback",
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "gateway.streamFrom",
  fields: {
    requestId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 128 },
    modelId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 256 },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["adapter-has-no-stream"],
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["gateway-stream-call"],
  proofIds: ["gateway.stream.buffered-fallback.emitted-line"],
  releaseImpact: "patch",
});

const GATEWAY_ROUTE_REJECTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.route.rejected",
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "gateway.logRouteRejected",
  fields: {
    modelId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 256 },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["no-provider-configured", "no-capability-metadata", "wrong-model-kind"],
    },
    kind: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["chat", "embedding", "ocr-vision", "voice"],
    },
  },
  causal: "none",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["gateway-route-rejection"],
  proofIds: ["gateway.route.rejected.emitted-line"],
  releaseImpact: "patch",
});

function routeRejectionErrorKind(
  reason: "no-provider-configured" | "no-capability-metadata" | "wrong-model-kind",
): ActivityLogErrorKind {
  return reason === "wrong-model-kind" ? "validation-failed" : "unavailable";
}

// RB-6 (GEN-OBS-CORRELATION-503): tag a thrown GatewayError with the gateway's per-call request id
// so a failed model call is traceable to the gateway record (mirrors the id already carried by a
// successful call's `usage.requestId`). Only the first (innermost) tag wins so a retry does not
// overwrite the id of the attempt that actually failed. No-op for non-GatewayError throws.
function attachGatewayRequestId(error: unknown, requestId: string): void {
  if (error instanceof GatewayError && error.requestId === undefined) {
    error.requestId = requestId;
  }
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
// let three such answers lock every caller of a healthy model out). A named, extensible list rather
// than a growing chain of `&&` conditions, so the next non-provider fault is one array entry away.
//
// TimeoutError is deliberately NOT here (review finding on PR #3602 — it was, briefly, during
// #3591's development). Excluding every timeout disabled the breaker's own outage guard: an
// upstream that never responds at all would cost every caller a full (multi-minute, with the new
// floors) attempt before failing, and the breaker would never open for it, no matter how many
// callers piled up. With `GATEWAY_SILENCE_FLOOR_MS`/`GATEWAY_BUFFERED_BUDGET_FLOOR_MS` this
// generous, a `TimeoutError` means the provider produced nothing for minutes — an outage-class
// signal, not the noise of a slow-but-alive gateway (which stays inside the floor and never times
// out at all) — so it counts as a provider failure again, exactly as it did before this PR.
const NON_PROVIDER_FAULTS = [
  CancelledError,
  ConfigInvalidError,
  ResponseRedactionError,
  ProviderOutputExhaustedError,
  ProviderEmptyAnswerError,
] as const;

function isNonProviderFault(error: unknown): boolean {
  return NON_PROVIDER_FAULTS.some((errorClass) => error instanceof errorClass);
}

// A half-open probe that ends in a non-provider fault must still release the probe slot it
// claimed — `CircuitBreaker.recordNonProviderFault()` does exactly that, without counting the call
// as either a success or a failure (review finding on PR #3602: leaving the slot claimed forever
// stuck the breaker half-open, rejecting every later call once every probe slot was in this state).
function recordProviderFailure(
  breaker: CircuitBreaker,
  error: unknown,
  correlationId: string,
): void {
  if (isNonProviderFault(error)) {
    breaker.recordNonProviderFault();
    return;
  }
  breaker.recordFailure(correlationId);
}

interface RoutedCall {
  readonly provider: ModelProviderConfig;
  readonly compatibilityMemoScope: ModelProviderConfig;
  readonly capability: ModelCapability;
}

interface BufferedChatAttempt {
  readonly route: RoutedCall;
  readonly breaker: CircuitBreaker;
  readonly adapter: ProviderAdapter;
  readonly originalRequest: GatewayCallRequest;
  readonly correlationId: string;
  readonly state: { request: GatewayCallRequest; attemptNumber: number };
}

// Whether a buffered call reads each attempt's answer over the provider's stream (ADR-0003): the
// route's capability streams and the adapter can read a stream.
function readsOverStream(route: RoutedCall, adapter: ProviderAdapter): boolean {
  return route.capability.streaming && adapter.callStream !== undefined;
}

// The bounds of one attempt's streamed read: its SILENCE bound comes from the route's own provider
// config (`effectiveSilenceMs`), never from the retry loop's per-attempt `timeoutMs` — the two
// diverge on purpose (see resilience.ts's buffered-vs-stream rule): the loop's attempt bound now
// floors to the much larger buffered-answer floor so a WHOLE-BODY attempt is not cut off early
// (#3591, PR #3602 review), but a read that can observe progress must still be watched for silence
// at the shorter floor. What is left of the call's budget bounds the read's total duration, so a
// long generation that keeps producing is not cut off at a fixed timeout and generated again
// (coding run 30).
function streamedReadBounds(
  attempt: BufferedChatAttempt,
  remainingBudgetMs: number | undefined,
): StreamReadBounds | undefined {
  if (!readsOverStream(attempt.route, attempt.adapter)) return undefined;
  const budgetMs =
    remainingBudgetMs !== undefined && Number.isFinite(remainingBudgetMs)
      ? Math.max(1, Math.floor(remainingBudgetMs))
      : providerRequestBudgetMs(attempt.route.provider);
  // The silence bound never grants more than what is left of the call's budget: a retry that
  // starts with 120 s left is watched for 120 s, not for the 300 s floor, so the call can never
  // overrun the `requestBudgetMs` its own lines report (PR #3602 review).
  const silenceMs = Math.min(effectiveSilenceMs(attempt.route.provider), budgetMs);
  return { silenceMs, budgetMs };
}

// The effective silence bound a read that can observe progress runs under (#3591): the provider's
// configured `timeoutMs`, floored so a slow-but-alive gateway is never treated as wedged before it
// has had a fair chance to answer. Used for `Gateway.chatStream()`'s native read and, inside
// `streamedReadBounds`, for a buffered `chat()` attempt that happens to read over the provider's
// own stream.
function effectiveSilenceMs(provider: ModelProviderConfig): number {
  return Math.max(provider.timeoutMs, GATEWAY_SILENCE_FLOOR_MS);
}

// The effective bound a WHOLE-BODY (unobservable) read runs under (#3591, PR #3602 review): the
// provider's configured `timeoutMs`, floored to the buffered-answer floor rather than the shorter
// silence floor, because a read that cannot observe progress has no "silence" to watch — the one
// number that bounds it must already cover the longest legitimate generation. Used for a buffered
// `chat()` attempt against a non-streaming adapter (mirrors resilience.ts's private
// `chatAttemptTimeoutMs`, which floors the SAME value for the retry loop's own bookkeeping) and for
// `chatStream()`'s buffered fallback, which degrades to the identical whole-body read.
function effectiveBufferedAttemptMs(provider: ModelProviderConfig): number {
  return Math.max(provider.timeoutMs, GATEWAY_BUFFERED_BUDGET_FLOOR_MS);
}

// The bounds of the ONE, unretried read `chatStream()` performs (ADR-0003): floored the same way
// every interactive gateway surface is (#3591) — a slow gateway is not a broken gateway. Unlike
// `streamedReadBounds` (the buffered `chat()` path's per-attempt bound), there is no retry budget
// to derive a total from, so both bounds come straight from the provider's own (possibly
// Coding-Workbench-raised) `timeoutMs`: the silence bound floored to the silence floor, the budget
// through `streamRequestBudgetMs` — the one derivation the route deadline behind a streamed call
// shares (PR #3602 review).
function chatStreamBounds(provider: ModelProviderConfig): StreamReadBounds {
  return { silenceMs: effectiveSilenceMs(provider), budgetMs: streamRequestBudgetMs(provider) };
}

// One attempt's answer: over the provider's stream when the attempt has read bounds, whole
// otherwise.
async function readAnswer(
  adapter: ProviderAdapter,
  request: GatewayCallRequest,
  provider: ModelProviderConfig,
  bounds: StreamReadBounds | undefined,
): Promise<NormalizedResponse> {
  if (bounds === undefined || adapter.callStream === undefined) {
    return adapter.call(request, provider);
  }
  for await (const chunk of adapter.callStream(request, provider, bounds)) {
    if (chunk.type === "done") return chunk.response;
  }
  throw new TransportError(`provider stream for '${provider.modelId}' ended without an answer`);
}

interface RepairPromptBudget {
  readonly promptTokens: number;
  readonly maxPromptTokens: number;
  readonly maxOutputTokens: number;
  readonly safetyMarginTokens: number;
}

const TOOL_SCHEMA_REPAIR_PREFIX =
  "The previous tool call was rejected before execution because its arguments did not match the advertised schema.";
const BODY_FREE_TOOL_CALL_ID = /^(?![<{])[\x21-\x7e]{1,256}$/u;

function loggedToolCallId(toolCallId: string): string {
  return BODY_FREE_TOOL_CALL_ID.test(toolCallId)
    ? toolCallId
    : `tool-call-${sha256Hex(toolCallId)}`;
}

// What the model is told to fix, in the schema's vocabulary only (declared property paths and
// counts; the rejected arguments are never quoted back). A generic "match the schema" sentence left
// gpt-5.4 repeating the same omission until the retry budget was gone (run 7, 2026-09-10: three
// `keiko_repository_search` calls without the properties the dialect declares required).
// Module-level export (not part of the package surface) so the sentence for each branch of the
// account can be pinned directly: the real catalog offers no tool with more than sixteen distinct
// schema paths, so the "further properties not listed" branch is unreachable through a provider
// round trip today and stays a guard for a wider future schema (PR #3452 review).
export function schemaMismatchGuidance(repair: GatewayToolCatalogError["repair"]): string {
  const shape = repair?.shape;
  if (shape === undefined) return "";
  const parts: string[] = [];
  if (shape.missingRequired.length > 0) {
    parts.push(
      ` Missing required properties: ${shape.missingRequired.join(", ")}. Every property the schema declares is required; pass an explicit value such as false or [] when a property does not apply.`,
    );
  }
  if (shape.invalidPaths.length > 0) {
    parts.push(
      ` Properties whose value does not match the schema: ${shape.invalidPaths.join(", ")}.`,
    );
  }
  if (shape.unexpectedPropertyCount > 0) {
    const plural = shape.unexpectedPropertyCount === 1 ? "property is" : "properties are";
    parts.push(
      ` ${String(shape.unexpectedPropertyCount)} ${plural} not declared by the schema and must be removed.`,
    );
  }
  if (shape.droppedPathCount > 0) {
    parts.push(
      ` ${String(shape.droppedPathCount)} further mismatching ${shape.droppedPathCount === 1 ? "property is" : "properties are"} not listed; check every remaining property against the schema.`,
    );
  }
  return parts.join("");
}

function toolSchemaRepairMessage(error: GatewayToolCatalogError): string | undefined {
  const repair = error.repair;
  if (repair === undefined) return undefined;
  return `${TOOL_SCHEMA_REPAIR_PREFIX} Retry tool call ${repair.toolCallId} for offered tool ${repair.offeredAlias} with arguments that match its advertised schema exactly.${schemaMismatchGuidance(repair)}`;
}

function repairedRequest(
  original: GatewayCallRequest,
  error: unknown,
): GatewayCallRequest | undefined {
  if (!(error instanceof GatewayToolCatalogError)) return undefined;
  const correction = toolSchemaRepairMessage(error);
  if (correction === undefined) return undefined;
  return {
    ...original,
    messages: [...original.messages, { role: "system", content: correction }],
  };
}

// Bare hostname only — never `scheme://host:port` (that's `logEndpointHost`, used on the per-call
// attempt line) and never the full `baseUrl`, which can carry a path or embedded credentials for a
// misconfigured provider entry (`https://user:token@host/deploy-path`). An unparseable URL yields
// undefined rather than echoing the raw string back, mirroring `logEndpointHost`'s own failure mode.
function providerEndpointHost(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
}

// The moment worth naming on a stream is the FIRST content the caller actually saw, not the first
// chunk of any kind — a synthesised buffered-fallback stream's lone "delta" already carries the
// whole answer, and a provider's own stream can open with a role-only or empty delta before real
// content arrives. Called on every chunk; returns undefined once a non-empty one has already fired
// so the caller's `??=` never re-times a later chunk.
function firstNonEmptyDeltaMs(
  chunk: GatewayStreamChunk,
  elapsed: () => number,
): number | undefined {
  return chunk.type === "delta" && chunk.token.length > 0 ? elapsed() : undefined;
}

// A minimal usage projection carried on the stream-completed line — never the full UsageMetadata,
// whose `requestId`/`latencyMs`/`costClass` are already on the envelope or on `extra` elsewhere.
interface StreamTerminalUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

// Streaming usage is accumulated by the adapter from an optional provider-supplied final chunk
// (OpenAI's `include_usage`); a provider that never sends one leaves both counts at their initial
// zero. Zero counts are therefore not a measurement, they are the absence of one — logging them
// would tell an operator "this call cost nothing", which is a stronger and false claim compared to
// simply not printing a field the provider never supplied.
function streamUsageIfSupplied(usage: UsageMetadata | undefined): StreamTerminalUsage | undefined {
  if (usage === undefined || (usage.promptTokens === 0 && usage.completionTokens === 0)) {
    return undefined;
  }
  return { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens };
}

export class Gateway {
  private readonly spendBudget: GatewaySpendBudget | undefined;
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly adapter: ProviderAdapter | undefined;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly providers: ReadonlyMap<string, ModelProviderConfig>;
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly log: ModelGatewayLogSink;
  private readonly configurationCorrelationId: string | undefined;

  constructor(
    private readonly config: GatewayConfig,
    deps: GatewayDeps = {},
  ) {
    this.spendBudget = deps.spendBudget;
    this.clock = deps.clock ?? systemClock;
    this.random = deps.random ?? Math.random;
    this.adapter = deps.adapter;
    this.fetchImpl = deps.fetchImpl;
    this.log = resolveLogSink(deps.log);
    this.configurationCorrelationId = deps.configurationCorrelationId;
    this.providers = new Map(config.providers.map((p) => [p.modelId, p]));
    this.logConfigResolved();
  }

  private prepareRequest(
    request: GatewayCallRequest,
    capability: ModelCapability,
  ): GatewayCallRequest {
    assertValidGatewaySamplingParameters(request);
    if (this.spendBudget === undefined || request.maxOutputTokens !== undefined) return request;
    return { ...request, maxOutputTokens: capability.maxOutputTokens };
  }

  // ONE-TIME configuration snapshot, written once per Gateway construction (the process-wide
  // instance cache in keiko-server constructs exactly one Gateway per distinct GatewayConfig, so
  // this line does not repeat on every call). Answers "what did the gateway actually resolve to
  // run with" — the question an operator has no other way to answer once a provider's env-sourced
  // baseUrl or timeout has been merged and parsed. Per-provider fields only, and never `baseUrl`
  // or `apiKey`: `endpointHost` is the bare hostname a misconfigured entry cannot turn into a path
  // or embedded-credential leak.
  private logConfigResolved(): void {
    const providerConfigDigest = sha256Hex(
      canonicalise(
        this.config.providers.map((provider) => ({
          modelId: provider.modelId,
          endpointHost: providerEndpointHost(provider.baseUrl),
          timeoutMs: provider.timeoutMs,
          maxRetries: provider.maxRetries,
          retryBaseDelayMs: provider.retryBaseDelayMs,
        })),
      ),
    );
    this.log.write(
      activityLogEvent(
        GATEWAY_CONFIG_RESOLVED_OPERATION,
        {
          level: "info",
          ...(this.configurationCorrelationId === undefined
            ? {}
            : { correlationId: this.configurationCorrelationId }),
        },
        { providerCount: this.config.providers.length, providerConfigDigest },
      ),
    );
  }

  async chat(request: GatewayCallRequest): Promise<NormalizedResponse> {
    const route = this.routeForCall(request);
    request = this.prepareRequest(request, route.capability);
    const breaker = this.breakerFor(route.provider);
    const requestId = randomUUID();
    const ids = callIds(requestId, request);
    const start = this.clock.now();
    const elapsed = logTimer();
    const adapter = this.adapterFor(requestId, route, ids.correlationId);
    const attempt: BufferedChatAttempt = {
      route,
      breaker,
      adapter,
      originalRequest: request,
      correlationId: ids.correlationId,
      state: { request, attemptNumber: 0 },
    };
    this.logCallStarted(
      ids,
      route,
      false,
      request.reasoningEffort,
      readsOverStream(route, adapter),
    );
    let result;
    try {
      result = await executeWithRetry(
        this.invokeBufferedAttempt.bind(this, attempt),
        providerRetryConfig(route.provider),
        this.clock,
        request.cancellationSignal,
        this.random,
        { sink: this.log, modelId: route.provider.modelId, correlationId: ids.correlationId },
      );
    } catch (error) {
      // RB-6: stamp the gateway request id onto the thrown error so a FAILED buffered call is
      // traceable to the gateway record (previously requestId was attached only on success/usage).
      attachGatewayRequestId(error, requestId);
      this.logCallFailed(ids, route, elapsed(), error);
      throw error;
    }
    this.logCallCompleted(ids, route, result, elapsed());
    return {
      ...result,
      usage: {
        ...result.usage,
        requestId,
        latencyMs: Math.max(1, this.clock.now() - start),
        costClass: route.capability.costClass,
      },
    };
  }

  private async invokeBufferedAttempt(
    attempt: BufferedChatAttempt,
    attemptTimeoutMs: number | undefined,
    remainingBudgetMs: number | undefined,
  ): Promise<NormalizedResponse> {
    attempt.state.attemptNumber += 1;
    const provider = {
      ...attempt.route.provider,
      ...(attemptTimeoutMs === undefined ? {} : { timeoutMs: attemptTimeoutMs }),
    };
    try {
      return await this.invoke(
        attempt.breaker,
        attempt.adapter,
        attempt.state.request,
        attempt.route.capability,
        attempt.correlationId,
        provider,
        streamedReadBounds(attempt, remainingBudgetMs),
      );
    } catch (error) {
      if (attempt.state.attemptNumber <= attempt.route.provider.maxRetries) {
        attempt.state.request = this.requestAfterToolSchemaRejection(
          attempt.originalRequest,
          attempt.state.request,
          attempt.route.capability,
          attempt.correlationId,
          error,
        );
      }
      throw error;
    }
  }

  private requestAfterToolSchemaRejection(
    original: GatewayCallRequest,
    current: GatewayCallRequest,
    capability: ModelCapability,
    correlationId: string,
    error: unknown,
  ): GatewayCallRequest {
    const candidate = repairedRequest(original, error);
    if (candidate === undefined) return current;
    const prepared = this.prepareRequest(candidate, capability);
    const context = deriveContextProfileFromCapability(capability);
    const maxOutputTokens = prepared.maxOutputTokens ?? context.reservedOutputTokens;
    const promptTokens = countGatewayPromptTokens(
      {
        messages: prepared.messages,
        tools: createGatewayToolCatalogBridge(prepared, (): number => this.clock.now()).tools,
      },
      capability.tokenAccounting,
    );
    const { safetyMarginTokens } = context;
    const maxPromptTokens = Math.max(
      0,
      context.maxInputTokens - maxOutputTokens - safetyMarginTokens,
    );
    const budget = { promptTokens, maxPromptTokens, maxOutputTokens, safetyMarginTokens };
    const repair = error instanceof GatewayToolCatalogError ? error.repair : undefined;
    if (promptTokens > maxPromptTokens) {
      this.logToolSchemaRepair(correlationId, repair, "denied", budget);
      throw new ContextOverflowError("tool-call schema repair exceeds the model context window");
    }
    this.logToolSchemaRepair(correlationId, repair, "scheduled", budget);
    return prepared;
  }

  private logToolSchemaRepair(
    correlationId: string,
    repair: GatewayToolCatalogError["repair"],
    state: "denied" | "scheduled",
    budget: RepairPromptBudget,
  ): void {
    if (repair === undefined) return;
    this.log.write(
      activityLogEvent(
        GATEWAY_TOOL_CATALOG_REPAIR_OPERATION,
        { level: "warn", correlationId },
        {
          state,
          reason: state === "denied" ? "context-window-exceeded" : "invalid-shape",
          toolCallId: loggedToolCallId(repair.toolCallId),
          offeredAlias: repair.offeredAlias,
          ...(repair.shape === undefined
            ? {}
            : {
                missingRequiredCount: repair.shape.missingRequired.length,
                invalidPathCount: repair.shape.invalidPaths.length,
                unexpectedPropertyCount: repair.shape.unexpectedPropertyCount,
                droppedPathCount: repair.shape.droppedPathCount,
              }),
          ...budget,
          correctionMessageCount: 1,
          effectStarted: false,
        },
      ),
    );
  }

  // Streaming counterpart of chat(). Routes identically and guards with the circuit
  // breaker, but is NOT wrapped in executeWithRetry: a mid-stream retry would replay
  // already-emitted tokens. An adapter without a streaming variant falls back to a
  // single delta+done synthesised from its buffered call().
  async *chatStream(request: GatewayCallRequest): AsyncGenerator<GatewayStreamChunk> {
    const route = this.routeForCall(request);
    request = this.prepareRequest(request, route.capability);
    const breaker = this.breakerFor(route.provider);
    const ids = callIds(randomUUID(), request);
    breaker.assertAllowed(ids.correlationId);
    const start = this.clock.now();
    const elapsed = logTimer();
    const adapter = this.adapterFor(ids.requestId, route, ids.correlationId);
    // streamFrom degrades to its buffered fallback without a native stream (#3591, PR #3602
    // review); the started line must report the bound that branch actually applies.
    const usesNativeStream = adapter.callStream !== undefined;
    this.logCallStarted(ids, route, true, request.reasoningEffort, usesNativeStream);
    let reservation: GatewaySpendReservation | undefined;
    let chunkCount = 0;
    // The moment the caller saw its first actual content, timed off the same `elapsed()` as every
    // other stream outcome. `??=` locks it in on the first non-empty delta and leaves it alone.
    let firstTokenMs: number | undefined;
    let terminalUsage: UsageMetadata | undefined;
    // EVERY started stream needs exactly one outcome line. Set the moment an outcome is written,
    // so the `finally` can tell "the consumer walked away" from the two paths that already spoke.
    let settled = false;
    try {
      reservation = this.spendBudget?.reserve(route.capability, request, ids.correlationId);
      for await (const chunk of this.streamFrom(adapter, request, route.provider, ids)) {
        chunkCount += 1;
        firstTokenMs ??= firstNonEmptyDeltaMs(chunk, elapsed);
        if (chunk.type === "done") {
          terminalUsage = chunk.response.usage;
          yield this.enrichDone(chunk.response, ids.requestId, start, route);
        } else {
          yield chunk;
        }
      }
      breaker.recordSuccess(ids.correlationId);
      settled = true;
    } catch (error) {
      settled = true;
      terminalUsage = measuredCatalogFailureUsage(error, route.capability, ids.correlationId);
      this.failStream(ids, route, breaker, chunkCount, elapsed(), error);
    } finally {
      reservation?.settle(terminalUsage);
      // A consumer that stops iterating (client disconnect, request abort, `break`) closes this
      // generator through `return()`: the loop is left without running either outcome branch, so
      // without this line the log keeps `gateway.stream.started` with nothing after it — the exact
      // shape of a wedged provider. Not a failure and not a fault, so it is an outcome of its own.
      if (!settled) {
        this.logStreamAbandoned(ids, route, chunkCount, elapsed());
      }
    }
    // Outside the try on purpose: a sink that throws here must not be caught above and reported as
    // a mid-stream provider failure — which would also trip the circuit breaker on a logging fault.
    this.logStreamCompleted(
      ids,
      route,
      chunkCount,
      elapsed(),
      firstTokenMs,
      streamUsageIfSupplied(terminalUsage),
    );
  }

  private failStream(
    ids: CallIds,
    route: RoutedCall,
    breaker: CircuitBreaker,
    chunkCount: number,
    durationMs: number,
    error: unknown,
  ): never {
    recordProviderFailure(breaker, error, ids.correlationId);
    attachGatewayRequestId(error, ids.requestId);
    this.logStreamFailed(ids, route, chunkCount, durationMs, error);
    throw error;
  }

  // THE ATTEMPT LINE for a model call — written BEFORE the adapter is invoked, not after it
  // returns. A provider that accepts the connection and then goes quiet produces no completion
  // and no failure, so without this the gateway is silent for exactly the window an operator is
  // trying to diagnose. `timeoutMs` and `maxRetries` are on it because the pair bounds how long
  // this silence can legitimately last: an attempt line whose deadline has already passed with no
  // outcome is a wedge, not a slow provider. `timeoutMs` reports the bound THIS call's transport
  // actually applies (PR #3602 review) — the silence floor for a call that reads incrementally
  // (`upstreamStreaming`), the larger buffered floor for a whole-body read or `chatStream()`'s
  // degraded fallback, never a value the transport itself does not honour.
  private logCallStarted(
    ids: CallIds,
    route: RoutedCall,
    streaming: boolean,
    reasoningEffort: GatewayCallRequest["reasoningEffort"],
    upstreamStreaming = false,
  ): void {
    if (!logLevelEnabled(this.log, "info")) return;
    const endpoint = logEndpointHost(route.provider.baseUrl);
    const endpointDigest = endpoint === undefined ? undefined : sha256Hex(endpoint);
    const commonFields = {
      ...callIdFields(ids),
      modelId: logModelId(route.provider.modelId),
      ...(endpointDigest === undefined ? {} : { endpointDigest }),
      costClass: route.capability.costClass,
      // The bound this call's transport actually applies: the silence floor when it reads
      // incrementally (each chunk proves the provider alive), the buffered floor for a whole-body
      // read or `chatStream()`'s degraded fallback for a non-streaming adapter.
      timeoutMs: upstreamStreaming
        ? effectiveSilenceMs(route.provider)
        : effectiveBufferedAttemptMs(route.provider),
      maxRetries: route.provider.maxRetries,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    };
    if (streaming) {
      this.log.write(
        activityLogEvent(
          GATEWAY_STREAM_STARTED_OPERATION,
          { level: "info", correlationId: ids.correlationId },
          { ...commonFields, streaming: true },
        ),
      );
      return;
    }
    this.log.write(
      activityLogEvent(
        GATEWAY_CHAT_STARTED_OPERATION,
        { level: "info", correlationId: ids.correlationId },
        {
          ...commonFields,
          requestBudgetMs: providerRequestBudgetMs(route.provider),
          upstreamStreaming,
          streaming: false,
        },
      ),
    );
  }

  private logCallFailed(ids: CallIds, route: RoutedCall, durationMs: number, error: unknown): void {
    this.log.write(
      activityLogEvent(
        GATEWAY_CHAT_FAILED_OPERATION,
        {
          level: "warn",
          correlationId: ids.correlationId,
          durationMs,
          errorKind: activityLogErrorKind(error),
        },
        {
          ...callIdFields(ids),
          modelId: logModelId(route.provider.modelId),
          streaming: false,
          outputExhausted: error instanceof ProviderOutputExhaustedError,
        },
      ),
    );
  }

  private logStreamCompleted(
    ids: CallIds,
    route: RoutedCall,
    chunkCount: number,
    durationMs: number,
    firstTokenMs: number | undefined,
    usage: StreamTerminalUsage | undefined,
  ): void {
    this.log.write(
      activityLogEvent(
        GATEWAY_STREAM_COMPLETED_OPERATION,
        { level: "info", correlationId: ids.correlationId, durationMs },
        {
          ...callIdFields(ids),
          modelId: logModelId(route.provider.modelId),
          costClass: route.capability.costClass,
          chunkCount,
          ...(firstTokenMs === undefined ? {} : { firstTokenMs }),
          ...usage,
        },
      ),
    );
  }

  // The third stream outcome: the provider never finished because nobody was listening any more.
  // `info`, not `warn` — a user pressing stop is routine, and the line exists to close the
  // started/outcome pair an operator scans for, not to report a fault. `chunkCount` says how much
  // of the answer had already been paid for and thrown away.
  private logStreamAbandoned(
    ids: CallIds,
    route: RoutedCall,
    chunkCount: number,
    durationMs: number,
  ): void {
    this.log.write(
      activityLogEvent(
        GATEWAY_STREAM_ABANDONED_OPERATION,
        { level: "info", correlationId: ids.correlationId, durationMs },
        {
          ...callIdFields(ids),
          modelId: logModelId(route.provider.modelId),
          costClass: route.capability.costClass,
          streaming: true,
          chunkCount,
          reason: "consumer-stopped-iterating",
        },
      ),
    );
  }

  private logStreamFailed(
    ids: CallIds,
    route: RoutedCall,
    chunkCount: number,
    durationMs: number,
    error: unknown,
  ): void {
    this.log.write(
      activityLogEvent(
        GATEWAY_STREAM_FAILED_OPERATION,
        {
          level: "warn",
          correlationId: ids.correlationId,
          durationMs,
          errorKind: activityLogErrorKind(error),
        },
        {
          ...callIdFields(ids),
          modelId: logModelId(route.provider.modelId),
          streaming: true,
          chunkCount,
          // A mid-stream failure has already handed tokens to the caller and cannot be retried
          // (chatStream is deliberately outside executeWithRetry); the count is how far it got.
          afterFirstChunk: chunkCount > 0,
          outputExhausted: error instanceof ProviderOutputExhaustedError,
        },
      ),
    );
  }

  // Buffered completions only: the streaming path has its own outcome lines with their own fields
  // (`gateway.stream.completed` / `.abandoned` / `.failed`). The `streaming: false` here is a
  // constant of THIS op rather than a parameter — a caller able to pass `true` would emit
  // `gateway.chat.completed` for a stream and break the op naming every reader filters on.
  private logCallCompleted(
    ids: CallIds,
    route: RoutedCall,
    result: NormalizedResponse,
    durationMs: number,
  ): void {
    this.log.write(
      activityLogEvent(
        GATEWAY_CHAT_COMPLETED_OPERATION,
        { level: "info", correlationId: ids.correlationId, durationMs },
        {
          ...callIdFields(ids),
          modelId: logModelId(route.provider.modelId),
          costClass: route.capability.costClass,
          finishReason: result.finishReason,
          toolCallCount: result.toolCalls.length,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          streaming: false,
        },
      ),
    );
  }

  private async *streamFrom(
    adapter: ProviderAdapter,
    request: GatewayCallRequest,
    provider: ModelProviderConfig,
    ids: CallIds,
  ): AsyncGenerator<GatewayStreamChunk> {
    if (adapter.callStream !== undefined) {
      yield* adapter.callStream(request, provider, chatStreamBounds(provider));
      return;
    }
    // Degradation: this adapter has no streaming variant, so the caller gets ONE synthetic delta
    // after the full buffered latency instead of incremental tokens. Silently, that reads to an
    // operator as a provider that took seconds to emit its first token.
    this.log.write(
      activityLogEvent(
        GATEWAY_STREAM_BUFFERED_FALLBACK_OPERATION,
        { level: "warn", correlationId: ids.correlationId },
        {
          ...callIdFields(ids),
          modelId: logModelId(provider.modelId),
          reason: "adapter-has-no-stream",
        },
      ),
    );
    // This read is whole-body and cannot observe progress, exactly like a non-streaming-capable
    // buffered chat() attempt, so it gets the SAME buffered floor rather than the (configured, or
    // silence-floored) `provider.timeoutMs` the fallback used to pass through unbounded (PR #3602
    // review): a healthy 45 s answer through a 30 s-configured provider was cut off while the
    // started line above already claimed a 300 s effective timeout.
    const bufferedProvider: ModelProviderConfig = {
      ...provider,
      timeoutMs: effectiveBufferedAttemptMs(provider),
    };
    const response = await adapter.call(request, bufferedProvider);
    yield { type: "delta", token: response.content };
    yield { type: "done", response };
  }

  private enrich(
    response: NormalizedResponse,
    requestId: string,
    start: number,
    route: RoutedCall,
  ): NormalizedResponse {
    return {
      ...response,
      usage: {
        ...response.usage,
        requestId,
        latencyMs: Math.max(1, this.clock.now() - start),
        costClass: route.capability.costClass,
      },
    };
  }

  private enrichDone(
    response: NormalizedResponse,
    requestId: string,
    start: number,
    route: RoutedCall,
  ): GatewayStreamChunk {
    return { type: "done", response: this.enrich(response, requestId, start, route) };
  }

  circuitStatus(modelId: string): CircuitBreakerStatus {
    const breaker = this.breakers.get(modelId);
    return (
      breaker?.status(modelId) ?? {
        modelId,
        state: "closed",
        consecutiveFailures: 0,
        openedAt: null,
      }
    );
  }

  private async invoke(
    breaker: CircuitBreaker,
    adapter: ProviderAdapter,
    request: GatewayCallRequest,
    capability: ModelCapability,
    correlationId: string,
    provider: ModelProviderConfig,
    bounds?: StreamReadBounds,
  ): Promise<NormalizedResponse> {
    breaker.assertAllowed(correlationId);
    const reservation = this.spendBudget?.reserve(capability, request, correlationId);
    let usage: UsageMetadata | undefined;
    try {
      const response = await readAnswer(adapter, request, provider, bounds);
      usage = response.usage;
      breaker.recordSuccess(correlationId);
      return response;
    } catch (error) {
      usage = measuredCatalogFailureUsage(error, capability, correlationId);
      // A client-initiated cancel is not a provider fault — skip the breaker.
      recordProviderFailure(breaker, error, correlationId);
      throw error;
    } finally {
      reservation?.settle(usage);
    }
  }

  // Fail-closed routing. Each of the three refusals is a DIFFERENT operator problem — an unknown
  // model id, a configured provider with no capability metadata, and a correctly configured model
  // of the wrong kind — and all three surface to the caller as the same UnknownModelError, so the
  // reason label is the only thing that separates them after the fact.
  //
  // Routing happens BEFORE this call has a request id of its own, so the caller's correlation id
  // is the only thing that can attribute a refusal to the operation that provoked it — and a
  // refusal is exactly the "never started" case an operator has to separate from "started and
  // hung". Absent when the caller supplied none, as before.
  private logRouteRejected(
    modelId: string,
    correlationId: string | undefined,
    reason: "no-provider-configured" | "no-capability-metadata" | "wrong-model-kind",
    kind?: ModelCapability["kind"],
  ): void {
    this.log.write(
      activityLogEvent(
        GATEWAY_ROUTE_REJECTED_OPERATION,
        {
          level: "warn",
          errorKind: routeRejectionErrorKind(reason),
          ...(correlationId === undefined ? {} : { correlationId }),
        },
        { modelId: logModelId(modelId), reason, ...(kind === undefined ? {} : { kind }) },
      ),
    );
  }

  private route(modelId: string, correlationId?: string): RoutedCall {
    const provider = this.providers.get(modelId);
    if (provider === undefined) {
      this.logRouteRejected(modelId, correlationId, "no-provider-configured");
      throw new UnknownModelError(`no provider configured for model '${modelId}'`);
    }
    const capability = findConfiguredCapability(this.config, modelId);
    if (capability === undefined) {
      this.logRouteRejected(modelId, correlationId, "no-capability-metadata");
      throw new UnknownModelError(`model '${modelId}' has no capability metadata`);
    }
    if (capability.kind !== "chat") {
      this.logRouteRejected(modelId, correlationId, "wrong-model-kind", capability.kind);
      throw new UnknownModelError(
        `model '${modelId}' has kind '${capability.kind}'; the chat path requires a chat model`,
      );
    }
    return { provider, compatibilityMemoScope: provider, capability };
  }

  private routeForCall(request: GatewayCallRequest): RoutedCall {
    const route = this.route(request.modelId, request.logContext?.correlationId);
    if (request.latencyProfile !== "coding-workbench") return route;
    return {
      ...route,
      provider: {
        ...route.provider,
        timeoutMs: codingWorkbenchProviderTimeoutMs(route.provider.timeoutMs),
      },
    };
  }

  private breakerFor(provider: ModelProviderConfig): CircuitBreaker {
    const existing = this.breakers.get(provider.modelId);
    if (existing !== undefined) {
      return existing;
    }
    // Prefer the provider-level override (audit KEIKO-0167). Falls through to the top-level
    // GatewayConfig.circuitBreaker when the provider did not declare its own — every existing
    // config keeps its exact behaviour.
    const breakerConfig = provider.circuitBreaker ?? this.config.circuitBreaker;
    const breaker = new CircuitBreaker(provider.modelId, breakerConfig, this.clock, this.log);
    this.breakers.set(provider.modelId, breaker);
    return breaker;
  }

  private adapterFor(requestId: string, route: RoutedCall, correlationId: string): ProviderAdapter {
    return (
      this.adapter ??
      new OpenAiAdapter({
        requestId,
        costClass: route.capability.costClass,
        compatibilityMemoScope: route.compatibilityMemoScope,
        now: this.clock.now,
        fetchImpl: this.fetchImpl,
        log: this.log,
        logContext: { correlationId },
      })
    );
  }
}
