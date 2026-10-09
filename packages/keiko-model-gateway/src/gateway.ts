import {
  callerAdmittedRequest,
  settleCallerAttempt,
  settleFailedCallerAttempt,
  onceCallerReservation,
  CallerAttemptAdmissionError,
} from "./gateway-attempt-admission.js";
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
  ContextOverflowError,
  GatewayError,
  ProviderEmptyAnswerError,
  ProviderOutputExhaustedError,
  TransportError,
  UnknownModelError,
} from "@oscharko-dev/keiko-security/errors/gateway";
import {
  deriveContextProfile,
  deriveContextProfileFromCapability,
} from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import type { GatewayOutputRepairOutcome } from "@oscharko-dev/keiko-contracts/runtime/gateway";
import { GatewayPromptAdmission, ProviderPromptCounter } from "./gateway-prompt-admission.js";
import { findConfiguredCapability } from "./model-selection.js";
import { carriedReasoning } from "./normalize.js";
import {
  activityLogErrorKind,
  logEndpointHost,
  logLevelEnabled,
  logModelId,
  logTimer,
  resolveLogSink,
  withCorrelationId,
  type ModelGatewayLogContext,
  type ModelGatewayLogSink,
} from "./observability.js";
import { toolCallingConfigurationFingerprint } from "./config.js";
import { OpenAiAdapter } from "./openai-adapter.js";
import { countGatewayPromptTokens } from "./prompt-token-accounting.js";
import { createGatewayToolCatalogBridge, GatewayToolCatalogError } from "./toolCatalogBridge.js";
import {
  admissionBudgetFor,
  bufferedCallBudgetMs,
  callOutageWindowMs,
  CircuitBreaker,
  type CircuitBreakerAdmission,
  type GatewayRetryObserver,
  type RetryAnnouncer,
  type RetryConfig,
  type RetryLogContext,
  type RetryLogLabels,
  type RetryPolicy,
  type RetryRepairReason,
  type RetryResume,
  codingWorkbenchProviderTimeoutMs,
  executeWithRetry,
  GATEWAY_BUFFERED_BUDGET_FLOOR_MS,
  GATEWAY_SILENCE_FLOOR_MS,
  isNonProviderFault,
  providerRequestBudgetMs,
  codingWorkbenchRetryConfig,
  retryAnnouncer,
  steeredAnswerRepair,
  streamedCallBudgetMs,
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

function completeTransportUsage(
  usage: Pick<UsageMetadata, "promptTokens" | "completionTokens"> | undefined,
): UsageMetadata | undefined {
  if (
    usage === undefined ||
    !("requestId" in usage) ||
    !("latencyMs" in usage) ||
    !("costClass" in usage)
  )
    return undefined;
  if (typeof usage.requestId !== "string" || typeof usage.latencyMs !== "number") return undefined;
  if (usage.costClass !== "low" && usage.costClass !== "medium" && usage.costClass !== "high")
    return undefined;
  return {
    ...usage,
    requestId: usage.requestId,
    latencyMs: usage.latencyMs,
    costClass: usage.costClass,
  };
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
  // Receives the total context window a provider stated in an overflow answer, so the host can
  // adopt a deployment's real window instead of a placeholder (customer report on 1.1.13). A
  // count, a model id and the call's correlation id — never content. Invoked synchronously before
  // the overflow is rethrown, so the observer MUST NOT throw: it owns and logs its own failures.
  readonly onContextWindowReported?: ((report: ContextWindowReport) => void) | undefined;
}

export interface ContextWindowReport {
  readonly modelId: string;
  readonly contextWindowTokens: number;
  readonly correlationId: string;
  /**
   * The deployment that stated the window (`toolCallingConfigurationFingerprint` of the provider
   * the call used). A host adopts the window only while its configuration still routes the model
   * to that deployment: a late answer must never rewrite a replacement's window.
   */
  readonly deploymentFingerprint?: string | undefined;
  /**
   * The host configuration generation the reporting Gateway was built for, stamped by the host (the
   * Gateway itself never sets it). A setup that replaces credentials behind the same endpoint and
   * alias advances the generation, so a late report of the replaced routing is never adopted.
   */
  readonly configurationGeneration?: number | undefined;
}

// A gateway call plus the caller's log context.
//
// `GatewayRequest` is a wire contract owned by `keiko-contracts` and a correlation id is not wire
// data — it is a local diagnostic handle — so the field is added HERE, as an optional extension of
// the contract type. Every existing caller keeps compiling and keeps passing a plain
// `GatewayRequest`: the extra property is optional, so the contract type is still assignable to
// this one.
export interface GatewayCallRequest extends GatewayRequest {
  /** Optional caller-owned narrowing grant, checked for every provider attempt, including retry.
   * Local count-only metadata; never serialized into the provider request. Missing keeps the
   * existing retry policy. A refused grant is a non-provider admission failure.
   */
  readonly attemptAdmission?:
    | ((input: { readonly promptTokens: number; readonly maxOutputTokens: number }) =>
        | {
            readonly maxOutputTokens?: number | undefined;
            settle(
              usage: Pick<UsageMetadata, "promptTokens" | "completionTokens"> | undefined,
              dispatched: boolean,
              outputState?: "observed" | "none" | "unknown",
            ): void;
          }
        | undefined)
    | undefined;
  readonly logContext?: ModelGatewayLogContext | undefined;
  /**
   * A closed local profile; never serialized into a provider request body. It selects only the
   * coding-workbench timeout floors, never the retry policy and never the reasoning delivery: an
   * interactive surface may borrow the floors (the commit draft does, #3591) and still fails fast
   * and still receives its answer without the model's reasoning (#3873, F23).
   */
  readonly latencyProfile?: "coding-workbench" | undefined;
  /**
   * The explicit outage policy of an autonomous coding turn (#3873); local, never serialized into a
   * provider request body. `outage-window` keeps retrying a transiently unavailable provider and
   * waits through an open circuit breaker for the configuration's `codingOutageWindowMs`, for a
   * buffered and a streamed call alike. Only the coding sidecar route sets it; every other call
   * keeps the provider's attempt count and the fail-fast breaker.
   */
  readonly outagePolicy?: "outage-window" | undefined;
  /**
   * The explicit reasoning delivery of a call whose surface displays the model's reasoning (#3878,
   * #3873 F23); local, never serialized into a provider request body. `forward` hands the model's
   * reasoning to the caller beside its answer (as `reasoning` chunks and `NormalizedResponse.reasoning`),
   * while the configuration's `codingReasoningDisplay` is not `"off"`. Only the coding sidecar route
   * sets it; every other call, whatever latency profile it borrows, receives its answer without the
   * reasoning, which the gateway still parses and counts.
   */
  readonly reasoningDelivery?: "forward" | undefined;
  /**
   * The explicit answer repair of an autonomous coding turn (#3873, F17, F23); local, never
   * serialized into a provider request body. `steered` gives an answer the model could not use (it
   * exhausted its output budget without a tool call or a final answer, or ended after reasoning
   * without either) ONE further attempt with a fixed correction before the failure surfaces. Only
   * the coding sidecar route sets it; every other call, the commit draft included, surfaces such an
   * answer at once and never makes a hidden second generation.
   */
  readonly answerRepair?: "steered" | undefined;
  /**
   * Hears the call's outage (#3873 review); local, never serialized into a provider request. It is
   * told when a failure that says the provider is unavailable is met with a scheduled retry, when
   * the call's admission waits for the circuit breaker or a provider cooldown (the wait before the
   * first attempt included, which follows no failed attempt of the call), and when a call it heard
   * settles, so a caller that surfaces an outage to its operator (the coding sidecar route, behind
   * the Workbench's run status) knows the call is held by the gateway instead of silently waiting.
   * Counts and closed words only. The observer runs inside the retry loop and the admission wait
   * and should not throw: it owns and logs its own failures. A throw that escapes it is absorbed
   * and recorded on `gateway.retry.observer-failed`, and never changes what the call does or
   * returns. Only the coding sidecar route sets it.
   */
  readonly retryObserver?: GatewayRetryObserver | undefined;
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
    transport: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["assistant-text"],
    },
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

// #3878: the reasoning share of a completed call, as counts: the UTF-8 size of the reasoning the
// answer carried, the provider's own reasoning-token count when it reports one (never estimated),
// and whether the reasoning was forwarded to the caller or discarded. Never the reasoning itself.
// `required: false`: records written before these fields existed lack them.
const REASONING_COMPLETION_FIELDS = {
  reasoningBytes: { type: "integer", dataClass: "count", required: false },
  reasoningTokens: { type: "integer", dataClass: "count", required: false },
  reasoningDisposition: {
    type: "string",
    dataClass: "closed-enum",
    required: false,
    values: ["none", "forwarded", "discarded"],
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
    ...REASONING_COMPLETION_FIELDS,
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
  diagnosticWhen: [{ field: "reason", values: ["consumer-stopped-iterating"] }],
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
    ...REASONING_COMPLETION_FIELDS,
  },
  diagnosticWhen: [
    { field: "finishReason", values: ["length", "content_filter", "error", "cancelled"] },
  ],
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

// #3873: ONE retry policy for both call shapes. A call that asked for the outage window
// (`outageWindowMs` > 0) keeps retrying for what is left of it since the call started — `elapsedMs`
// is the time a streamed call already spent on its initial admission, 0 for a buffered call whose
// loop starts with the call — and waits through an open breaker; every other call keeps the
// provider's attempt count (`codingWorkbenchRetryConfig` with a window of 0). Never below one
// millisecond, so a window spent on admission still ends, and reports, as an outage-window call.
// The steered answer repair (#3873, F17, F23) joins the policy only for a call that asked for it
// (`answerRepair: "steered"`).
function callRetryConfig(
  provider: ModelProviderConfig,
  outageWindowMs: number,
  elapsedMs = 0,
  answerRepair?: GatewayCallRequest["answerRepair"],
): RetryConfig {
  const windowMs = outageWindowMs > 0 ? Math.max(1, outageWindowMs - elapsedMs) : 0;
  return {
    ...codingWorkbenchRetryConfig(provider, windowMs),
    jitterProviderCooldown: true,
    ...(answerRepair === "steered" ? { repair: steeredAnswerRepair } : {}),
  };
}

// The call's conversation with its observer (#3873 review): one per call, shared by its admission
// waits and by every retry loop it runs, and none for a call that set no `retryObserver`, which
// keeps its exact path. The labels are those of the call's retry lines, so an observer that throws
// is recorded under the call's own correlation id.
function callAnnouncer(
  request: GatewayCallRequest,
  labels: RetryLogLabels,
): RetryAnnouncer | undefined {
  return request.retryObserver === undefined
    ? undefined
    : retryAnnouncer(request.retryObserver, labels);
}

// The admission owns exactly one outcome; cancellations and local refusal release only its own
// probe, and a stale admission cannot mutate a later breaker generation.
function recordProviderFailure(
  admission: CircuitBreakerAdmission,
  error: unknown,
  providerAdmitted: boolean,
): void {
  admission.settle(
    providerAdmitted && !isNonProviderFault(error) ? "failure" : "non-provider-fault",
    error,
  );
}

function observedProviderDispatch(
  observed: (() => boolean) | undefined,
  admitted: boolean,
): boolean {
  return observed?.() ?? admitted;
}

interface RoutedCall {
  readonly provider: ModelProviderConfig;
  readonly compatibilityMemoScope: ModelProviderConfig;
  readonly capability: ModelCapability;
}

interface PreparedStream {
  readonly route: RoutedCall;
  readonly prepared: GatewayCallRequest;
  readonly ids: CallIds;
  readonly start: number;
  readonly elapsed: () => number;
  readonly adapter: ProviderAdapter;
  readonly admission: CircuitBreakerAdmission;
  readonly promptAdmission: GatewayPromptAdmission;
  // The outage window this call retries for, measured from `start` (#3873); 0 for every call
  // that keeps the provider's attempt count.
  readonly outageWindowMs: number;
  readonly outputRepair: OutputRepairState;
  readonly attempts: StreamAttemptState;
  // The call's conversation with its observer (#3873 review), shared by its first admission and by
  // every loop the stream resumes; absent for a call that set no `retryObserver`.
  readonly announcer: RetryAnnouncer | undefined;
}

// What a streamed call carries from one attempt to the next, across every loop it resumes
// (#3873 review): how many attempts it made, the request the next provider retry resends, the
// schema correction the current attempt carries, and the usage of the attempts it discarded.
interface StreamAttemptState {
  count: number;
  request: GatewayCallRequest;
  schemaRepair?: GatewayToolCatalogError["repair"] | undefined;
  // Whether a forwarded reasoning chunk already reached the caller in this call.
  reasoningDelivered: boolean;
  readonly discarded: DiscardedUsageTally;
}

// The request an attempt sends without asking for reasoning delivery: its reasoning is parsed,
// counted and discarded like on any surface that does not display it.
function withoutReasoningDelivery(request: GatewayCallRequest): GatewayCallRequest {
  const { reasoningDelivery: _undelivered, ...rest } = request;
  return rest;
}

// The provider-reported usage of the attempts a call discarded (#3873 review): a steered repair's
// first answer, a tool call the catalog rejected, a stream that failed after its usage arrived.
interface DiscardedUsageTally {
  attemptCount: number;
  promptTokens: number;
  completionTokens: number;
}

function emptyDiscardedUsage(): DiscardedUsageTally {
  return { attemptCount: 0, promptTokens: 0, completionTokens: 0 };
}

// Counts one discarded attempt whose provider reported usage; an attempt that failed before any
// usage arrived (a refused connection, a silent attempt) adds nothing. Counts only, never content.
function tallyDiscardedAttempt(tally: DiscardedUsageTally, failure: Error | undefined): void {
  if (!(failure instanceof GatewayError) || failure.partialUsage === undefined) return;
  const { promptTokens, completionTokens } = failure.partialUsage;
  if (!isTokenCount(promptTokens) || !isTokenCount(completionTokens)) return;
  if (promptTokens === 0 && completionTokens === 0) return;
  tally.attemptCount += 1;
  tally.promptTokens += promptTokens;
  tally.completionTokens += completionTokens;
}

function isTokenCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

// The answer a call settled with, carrying what its discarded attempts consumed, so the caller's
// own budget can count every attempt the provider processed (ADR-0137 D2).
function withDiscardedUsage(
  response: NormalizedResponse,
  tally: DiscardedUsageTally,
): NormalizedResponse {
  return tally.attemptCount === 0 ? response : { ...response, discardedAttemptUsage: { ...tally } };
}

// A catalog rejection is retried only WITH its schema correction (`requestAfterToolSchemaRejection`):
// one that carries no repair would replay the identical request.
function unrepairableCatalogRejection(error: Error): boolean {
  return error instanceof GatewayToolCatalogError && error.repair === undefined;
}

// A failure the call's retry loop can still act on after its stream delivered nothing but
// reasoning (#3873 review): the steered repair the call asked for and has not used yet, a catalog
// rejection that carries its schema correction, or a retryable provider failure — the loop then
// applies the call's own policy (attempt count, outage window, budget). Anything else surfaces at
// once, as it did.
// A non-streaming adapter's fallback is one whole-body read, so its attempt keeps the buffered floor.
function streamAttemptBudgetMs(
  adapter: ProviderAdapter,
  route: RoutedCall,
  bounds: StreamReadBounds,
): number {
  return adapter.callStream === undefined
    ? Math.min(bounds.budgetMs, effectiveBufferedAttemptMs(route.provider))
    : bounds.budgetMs;
}

// The loop a stream resumes after a failed attempt, on the call's own attempt count and repair.
function streamResume(state: PreparedStream, failedAttempt?: Error): RetryResume | undefined {
  if (failedAttempt === undefined) return undefined;
  return {
    failedAttempt,
    attempts: state.attempts.count,
    repairs: state.outputRepair.steered === undefined ? 0 : 1,
  };
}

function noteDelivered(state: PreparedStream, chunk: GatewayStreamChunk): void {
  if (chunk.type === "reasoning") state.attempts.reasoningDelivered = true;
}

function resumableAfterReasoning(state: PreparedStream, error: unknown): error is GatewayError {
  if (!(error instanceof GatewayError)) return false;
  const repairable =
    state.prepared.answerRepair === "steered" &&
    state.outputRepair.steered === undefined &&
    steeredAnswerRepair(error) !== undefined;
  return repairable || (error.retryable && !unrepairableCatalogRejection(error));
}

// How long a streamed call has already run (its first admission included) and what is left of its
// budget, the outage window's extension included (#3873): the two inputs of its startup retries.
function streamStartupBudget(
  state: PreparedStream,
  now: number,
): { readonly remainingMs: number; readonly elapsedMs: number } {
  const elapsedMs = now - state.start;
  const budgetMs = streamedCallBudgetMs(state.route.provider, state.outageWindowMs);
  return { remainingMs: Math.max(0, budgetMs - elapsedMs), elapsedMs };
}

// The startup retries of a streamed call run under the same policy as a buffered call
// (`callRetryConfig`), with what is left of the stream budget and of the outage window. Under the
// attempt policy a failed half-open probe ends the call; under the outage window the next attempt
// waits through the re-opened breaker for the next probe, exactly as a buffered call does (#3873).
function streamStartupRetryConfig(
  state: PreparedStream,
  admission: () => CircuitBreakerAdmission,
  budget: { readonly remainingMs: number; readonly elapsedMs: number },
): RetryConfig {
  const config = callRetryConfig(
    state.route.provider,
    state.outageWindowMs,
    budget.elapsedMs,
    state.prepared.answerRepair,
  );
  const probeEndsCall = config.retryWindowMs === undefined;
  return {
    ...config,
    maxRetries: probeEndsCall && state.admission.halfOpen ? 0 : state.route.provider.maxRetries,
    shouldRetry: (error): boolean =>
      !(probeEndsCall && admission().halfOpen) && !unrepairableCatalogRejection(error),
    timeoutMs: budget.remainingMs,
  };
}

// The one steered repair of an answer the model could not use (#3873, F17, F23): the correction the
// retry loop granted and the failure the repaired attempt corrects.
interface SteeredRepair {
  readonly reason: RetryRepairReason;
  readonly failure: Error;
}

// The steered repair of a call, set the moment the repaired attempt starts and absent until then.
// Shared by the buffered attempt state and the prepared stream, and read once the call settles.
interface OutputRepairState {
  steered?: SteeredRepair | undefined;
}

interface BufferedChatAttempt {
  readonly route: RoutedCall;
  readonly adapter: ProviderAdapter;
  readonly originalRequest: GatewayCallRequest;
  readonly promptAdmission: GatewayPromptAdmission;
  readonly correlationId: string;
  // The call's conversation with its observer (#3873 review), shared by every attempt's admission
  // and by the retry loop; absent for a call that set no `retryObserver`.
  readonly announcer: RetryAnnouncer | undefined;
  readonly state: OutputRepairState & {
    request: GatewayCallRequest;
    attemptNumber: number;
    repair?: GatewayToolCatalogError["repair"];
    readonly discarded: DiscardedUsageTally;
  };
}

/**
 * What the model is told after it spent its whole output budget without a tool call or a final
 * answer (#3873, F17: Gemma 4 31B with reasoning enabled reasoned for 8k tokens on a plain file-read
 * turn, three times in a row). Fixed and body-free: it names the budget outcome, never the reasoning.
 * Module-level export (not part of the package surface) so the sentence can be pinned directly.
 */
export const OUTPUT_EXHAUSTED_REPAIR_MESSAGE =
  "Your previous answer used the whole output budget without producing a tool call or a final answer. Reply now with the tool call or the final answer directly; keep any reasoning to a few sentences.";

/**
 * What the model is told after an answer that ended after reasoning without a tool call or any text
 * (#3873, F23: Gemma 4 31B streamed through LiteLLM reasoned for about 4,500 tokens, then produced
 * nothing, turn after turn). Fixed and body-free like the sentence above: it names the outcome,
 * never the reasoning. Module-level export (not part of the package surface) so it can be pinned.
 */
export const EMPTY_ANSWER_REPAIR_MESSAGE =
  "Your previous answer ended after reasoning without a tool call or a final answer. Call the next tool now, or give the final answer; keep any reasoning to a few sentences.";

// The one correction each steered repair sends.
const REPAIR_MESSAGES: Readonly<Record<RetryRepairReason, string>> = {
  "output-exhausted-repair": OUTPUT_EXHAUSTED_REPAIR_MESSAGE,
  "empty-answer-repair": EMPTY_ANSWER_REPAIR_MESSAGE,
};

// The steered request: the ORIGINAL request plus one system correction, like the schema repair —
// one correction at a time, and never the failed answer's reasoning quoted back.
function steeredRepairRequest(
  original: GatewayCallRequest,
  reason: RetryRepairReason,
): GatewayCallRequest {
  return {
    ...original,
    messages: [...original.messages, { role: "system", content: REPAIR_MESSAGES[reason] }],
  };
}

// The repair the retry loop granted for the failure an attempt follows, as that attempt starts.
// Undefined for every other attempt: an ordinary provider retry keeps whatever steer is already set,
// and a call that did not ask for the repair (`answerRepair`) is never granted one.
function grantedRepair(
  request: GatewayCallRequest,
  previousError: Error | undefined,
): SteeredRepair | undefined {
  if (request.answerRepair !== "steered" || previousError === undefined) return undefined;
  const reason = steeredAnswerRepair(previousError);
  return reason === undefined ? undefined : { reason, failure: previousError };
}

// How the steered attempt ended, by the failure it ended with, whichever failure triggered the
// repair: the model spent the whole budget (`exhausted-again`) or ended empty (`empty-again`) once
// more, or the attempt failed for another reason — including the first failure itself resurfacing
// because the repair was refused admission (`failed`).
function repairOutcomeOf(
  error: GatewayError,
  steered: SteeredRepair,
): Exclude<GatewayOutputRepairOutcome, "recovered"> {
  if (error === steered.failure) return "failed";
  if (error instanceof ProviderOutputExhaustedError) return "exhausted-again";
  return error instanceof ProviderEmptyAnswerError ? "empty-again" : "failed";
}

// Marks the error that ended a steered attempt (attach-at-throw-site, like `requestId`) with how
// that attempt ended. A call that never started a repair leaves the error unmarked.
function attachOutputRepair(error: unknown, state: OutputRepairState): void {
  const { steered } = state;
  if (steered === undefined || !(error instanceof GatewayError)) return;
  if (error.outputRepair !== undefined) return;
  error.outputRepair = repairOutcomeOf(error, steered);
}

// The answer a steered attempt recovered, marked so the caller's own evidence can say so.
function recoveredResponse(
  response: NormalizedResponse,
  state: OutputRepairState,
): NormalizedResponse {
  return state.steered === undefined ? response : { ...response, outputRepair: "recovered" };
}

interface OpenedStream {
  readonly first: GatewayStreamChunk;
  readonly iterator: AsyncGenerator<GatewayStreamChunk>;
}

// A chunk that commits a stream, after which nothing may be replayed: answer text or the terminal
// answer. An empty delta does not, and neither does a forwarded reasoning chunk (`streamFrom`).
function commitsStream(chunk: GatewayStreamChunk): boolean {
  return chunk.type === "done" || (chunk.type === "delta" && chunk.token.length > 0);
}

function admissionBudget(
  provider: ModelProviderConfig,
  bounds: StreamReadBounds | undefined,
  remainingMs: number | undefined,
): number {
  return remainingMs ?? bounds?.budgetMs ?? provider.timeoutMs;
}

function clippedStreamBounds(
  bounds: StreamReadBounds | undefined,
  remainingMs: number,
): StreamReadBounds | undefined {
  return bounds === undefined
    ? undefined
    : {
        budgetMs: Math.min(bounds.budgetMs, remainingMs),
        silenceMs: Math.min(bounds.silenceMs, remainingMs),
      };
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

// The bounds shared by a `chatStream()` call and its pre-content retries (ADR-0003): floored the same way
// every interactive gateway surface is (#3591) — a slow gateway is not a broken gateway. Unlike
// `streamedReadBounds` (the buffered `chat()` path's per-attempt bound), there is no retry budget
// to multiply by, so both bounds come straight from the provider's own (possibly
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
  if (repair.transport === "assistant-text") {
    return `${TOOL_SCHEMA_REPAIR_PREFIX} The previous answer serialized a tool invocation as assistant text, which executes no tool. Call offered tool ${repair.offeredAlias} through native function tool_calls with JSON arguments matching its advertised schema. Do not write model transport markers or a tool invocation in answer text.`;
  }
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

type ReasoningDisposition = "none" | "forwarded" | "discarded";

interface ReasoningCompletion {
  readonly reasoningBytes: number;
  readonly reasoningTokens?: number;
  readonly reasoningDisposition: ReasoningDisposition;
}

function reasoningDisposition(
  response: NormalizedResponse,
  forwards: boolean,
): ReasoningDisposition {
  if (!carriedReasoning(response)) return "none";
  return forwards ? "forwarded" : "discarded";
}

// The body-free reasoning share a completion line records (#3878).
function reasoningCompletion(response: NormalizedResponse, forwards: boolean): ReasoningCompletion {
  const { reasoningBytes, reasoningTokens } = response.usage;
  return {
    reasoningBytes: reasoningBytes ?? 0,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    reasoningDisposition: reasoningDisposition(response, forwards),
  };
}

// #3878: an answer handed to a caller that does not display reasoning loses the reasoning text and
// keeps only its counts on `usage`.
function withReasoningPolicy(response: NormalizedResponse, forwards: boolean): NormalizedResponse {
  if (forwards || response.reasoning === undefined) return response;
  const { reasoning: _discarded, ...answer } = response;
  return answer;
}

// Reasoning chunks of a caller that does not display reasoning are dropped where the provider's
// stream is read, below the gateway's commit point: a discarded thought is never a delivered chunk,
// so it neither starts the caller's answer nor ends the startup retries.
async function* withoutReasoningChunks(
  stream: AsyncIterable<GatewayStreamChunk>,
): AsyncGenerator<GatewayStreamChunk> {
  for await (const chunk of stream) {
    if (chunk.type !== "reasoning") yield chunk;
  }
}

export class Gateway {
  private readonly spendBudget: GatewaySpendBudget | undefined;
  private readonly promptCounter: ProviderPromptCounter;
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly adapter: ProviderAdapter | undefined;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly providers: ReadonlyMap<string, ModelProviderConfig>;
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly log: ModelGatewayLogSink;
  private readonly configurationCorrelationId: string | undefined;
  private readonly onContextWindowReported: GatewayDeps["onContextWindowReported"];

  constructor(
    private readonly config: GatewayConfig,
    deps: GatewayDeps = {},
  ) {
    this.spendBudget = deps.spendBudget;
    this.clock = deps.clock ?? systemClock;
    this.promptCounter = new ProviderPromptCounter(() => this.clock.now());
    this.random = deps.random ?? Math.random;
    this.adapter = deps.adapter;
    this.fetchImpl = deps.fetchImpl;
    this.log = resolveLogSink(deps.log);
    this.configurationCorrelationId = deps.configurationCorrelationId;
    this.onContextWindowReported = deps.onContextWindowReported;
    this.providers = new Map(config.providers.map((p) => [p.modelId, p]));
    this.logConfigResolved();
  }

  private prepareRequest(
    request: GatewayCallRequest,
    capability: ModelCapability,
  ): GatewayCallRequest {
    assertValidGatewaySamplingParameters(request);
    if (request.maxOutputTokens !== undefined || this.spendBudget === undefined) return request;
    return {
      ...request,
      maxOutputTokens: deriveContextProfileFromCapability(capability).reservedOutputTokens,
    };
  }

  private promptAdmission(route: RoutedCall, ids: CallIds): GatewayPromptAdmission {
    return new GatewayPromptAdmission({
      ...route,
      correlationId: ids.correlationId,
      log: this.log,
      now: () => this.clock.now(),
      counter: this.promptCounter,
      fetchImpl: this.fetchImpl,
    });
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

  // What the retry loop labels its lines with, and what the call's announcer labels the failure
  // line of an observer that throws with (#3873 review).
  private retryLabels(route: RoutedCall, ids: CallIds): RetryLogLabels {
    return {
      sink: this.log,
      modelId: route.provider.modelId,
      correlationId: ids.correlationId,
    };
  }

  // The labels, and the call's own ear on the loop: the call's announcer (#3873 review), which
  // exists only for a request that set a `retryObserver` — the coding sidecar route alone.
  private retryLogContext(
    route: RoutedCall,
    ids: CallIds,
    announcer: RetryAnnouncer | undefined,
  ): RetryLogContext {
    return { ...this.retryLabels(route, ids), announcer };
  }

  async chat(request: GatewayCallRequest): Promise<NormalizedResponse> {
    const route = this.routeForCall(request);
    request = this.prepareRequest(request, route.capability);
    const requestId = randomUUID();
    const ids = callIds(requestId, request);
    const start = this.clock.now();
    const elapsed = logTimer();
    const adapter = this.adapterFor(requestId, route, ids.correlationId);
    const attempt: BufferedChatAttempt = {
      route,
      adapter,
      originalRequest: request,
      promptAdmission: this.promptAdmission(route, ids),
      correlationId: ids.correlationId,
      announcer: callAnnouncer(request, this.retryLabels(route, ids)),
      state: { request, attemptNumber: 0, discarded: emptyDiscardedUsage() },
    };
    this.logCallStarted(ids, route, false, request, readsOverStream(route, adapter));
    let result;
    try {
      result = await executeWithRetry(
        this.invokeBufferedAttempt.bind(this, attempt),
        callRetryConfig(route.provider, this.outageWindowMs(request), 0, request.answerRepair),
        this.clock,
        request.cancellationSignal,
        this.random,
        this.retryLogContext(route, ids, attempt.announcer),
      );
    } catch (error) {
      attachOutputRepair(error, attempt.state);
      this.settleFailedCall(ids, route, elapsed(), error);
      throw error;
    }
    const forwardsReasoning = this.forwardsReasoning(request);
    this.logCallCompleted(ids, route, result, elapsed(), forwardsReasoning);
    return withDiscardedUsage(
      recoveredResponse(
        this.enrich(withReasoningPolicy(result, forwardsReasoning), requestId, start, route),
        attempt.state,
      ),
      attempt.state.discarded,
    );
  }

  private async invokeBufferedAttempt(
    attempt: BufferedChatAttempt,
    attemptTimeoutMs: number | undefined,
    remainingBudgetMs: number | undefined,
    previousError?: Error,
    admissionBudgetMs?: number,
  ): Promise<NormalizedResponse> {
    attempt.state.attemptNumber += 1;
    tallyDiscardedAttempt(attempt.state.discarded, previousError);
    this.prepareBufferedAttempt(attempt, previousError);
    const provider = {
      ...attempt.route.provider,
      ...(attemptTimeoutMs === undefined ? {} : { timeoutMs: attemptTimeoutMs }),
    };
    return this.invoke(
      attempt,
      provider,
      streamedReadBounds(attempt, remainingBudgetMs),
      remainingBudgetMs,
      previousError,
      admissionBudgetMs,
    );
  }

  // The request of the attempt the retry loop just scheduled, decided from the failure it follows
  // (#3873 review): the one steered repair the loop granted (F17, F23) in place of any pending
  // schema correction; a schema correction after a catalog rejection that carries a repair; or,
  // after an ordinary provider failure, the request the failed attempt sent. Deciding it here, at
  // the start of an attempt the loop actually runs, keeps the corrections on the loop's own attempt
  // count: a correction is never prepared for an attempt that will not run, and every attempt that
  // runs after a rejection carries the correction for THAT rejection.
  private prepareBufferedAttempt(attempt: BufferedChatAttempt, previousError?: Error): void {
    attempt.state.repair = undefined;
    const granted = grantedRepair(attempt.originalRequest, previousError);
    if (granted !== undefined) {
      attempt.state.request = steeredRepairRequest(attempt.originalRequest, granted.reason);
      attempt.state.steered = granted;
      return;
    }
    if (previousError instanceof GatewayToolCatalogError && previousError.repair !== undefined) {
      attempt.state.repair = previousError.repair;
      attempt.state.request = this.requestAfterToolSchemaRejection(
        attempt.originalRequest,
        attempt.state.request,
        attempt.route.capability,
        previousError,
      );
    }
  }

  // The streamed counterpart of `prepareBufferedAttempt`, on the call's own attempt state, which
  // spans every loop the stream resumes.
  private prepareStreamAttempt(
    state: PreparedStream,
    previousError: Error | undefined,
  ): GatewayCallRequest {
    const { attempts } = state;
    attempts.count += 1;
    attempts.schemaRepair = undefined;
    tallyDiscardedAttempt(attempts.discarded, previousError);
    const granted = grantedRepair(state.prepared, previousError);
    if (granted !== undefined) {
      state.outputRepair.steered = granted;
      attempts.request = steeredRepairRequest(state.prepared, granted.reason);
    } else if (
      previousError instanceof GatewayToolCatalogError &&
      previousError.repair !== undefined
    ) {
      attempts.schemaRepair = previousError.repair;
      attempts.request = this.requestAfterToolSchemaRejection(
        state.prepared,
        attempts.request,
        state.route.capability,
        previousError,
      );
    }
    // A call forwards at most two reasoning passages: the first attempt that delivers reasoning and
    // the one steered repair. Any other attempt after forwarded reasoning — a provider retry or a
    // schema correction — streams its reasoning undelivered, so a retried outage never repeats a
    // passage and the turn's reasoning stays within the sidecar's bound of two passages.
    const forwardsPassage = !attempts.reasoningDelivered || granted !== undefined;
    return forwardsPassage ? attempts.request : withoutReasoningDelivery(attempts.request);
  }

  private requestAfterToolSchemaRejection(
    original: GatewayCallRequest,
    current: GatewayCallRequest,
    capability: ModelCapability,
    error: unknown,
  ): GatewayCallRequest {
    const candidate = repairedRequest(original, error);
    if (candidate === undefined) return current;
    return this.prepareRequest(candidate, capability);
  }

  private logAttemptRepair(attempt: BufferedChatAttempt, state: "scheduled" | "denied"): void {
    this.logRequestRepair(
      attempt.route.capability,
      attempt.correlationId,
      attempt.state.repair,
      attempt.state.request,
      state,
    );
  }

  // `gateway.tool-catalog.repair` for the attempt that carries a schema correction, buffered or
  // streamed: `scheduled` once the corrected prompt was admitted, `denied` when it no longer fits
  // the model's window. Nothing for an attempt without a correction.
  private logRequestRepair(
    capability: ModelCapability,
    correlationId: string,
    repair: GatewayToolCatalogError["repair"],
    request: GatewayCallRequest,
    state: "scheduled" | "denied",
  ): void {
    if (repair === undefined) return;
    const profile = deriveContextProfileFromCapability(capability);
    const maxOutputTokens = request.maxOutputTokens ?? profile.reservedOutputTokens;
    const tools = createGatewayToolCatalogBridge(
      request,
      (): number => this.clock.now(),
      withCorrelationId(this.log, correlationId),
      false,
    ).tools;
    this.logToolSchemaRepair(correlationId, repair, state, {
      promptTokens: countGatewayPromptTokens({ ...request, tools }, profile.tokenAccounting, {
        contextWindow: profile.maxInputTokens,
      }),
      maxOutputTokens,
      safetyMarginTokens: profile.safetyMarginTokens,
      maxPromptTokens: deriveContextProfile({
        ...profile,
        reservedOutputTokens: maxOutputTokens,
      }).effectiveInputBudget,
    });
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
          ...(repair.transport === undefined ? {} : { transport: repair.transport }),
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

  // Streaming counterpart of chat(). Routes identically and guards with the circuit breaker. A
  // failure before the first delivered answer delta — at startup, or after nothing but forwarded
  // reasoning (#3873 review) — goes through the same retry loop as a buffered attempt: the steered
  // repair the call asked for, a schema correction, a provider retry under the call's policy. Once
  // answer text or the terminal answer was delivered, a retry would replay it, so the failure
  // surfaces at once. An adapter without a streaming variant falls back to a single delta+done
  // synthesised from its buffered call().
  async *chatStream(request: GatewayCallRequest): AsyncGenerator<GatewayStreamChunk> {
    const state = await this.prepareStream(request);
    const { route, ids, start, elapsed, admission } = state;
    let chunkCount = 0;
    // The moment the caller saw its first actual content, timed off the same `elapsed()` as every
    // other stream outcome. `??=` locks it in on the first non-empty delta and leaves it alone.
    let firstTokenMs: number | undefined;
    let terminalResponse: NormalizedResponse | undefined;
    // EVERY started stream needs exactly one outcome line. Set the moment an outcome is written,
    // so the `finally` can tell "the consumer walked away" from the two paths that already spoke.
    let settled = false;
    try {
      for await (const chunk of this.streamFrom(state)) {
        chunkCount += 1;
        firstTokenMs ??= firstNonEmptyDeltaMs(chunk, elapsed);
        if (chunk.type === "done") {
          terminalResponse = chunk.response;
          break;
        } else {
          yield chunk;
        }
      }
      settled = true;
    } catch (error) {
      settled = true;
      attachOutputRepair(error, state.outputRepair);
      this.failStream(ids, route, chunkCount, elapsed(), error);
    } finally {
      admission.settle("non-provider-fault");
      // A consumer that stops iterating (client disconnect, request abort, `break`) closes this
      // generator through `return()`: the loop is left without running either outcome branch, so
      // without this line the log keeps `gateway.stream.started` with nothing after it — the exact
      // shape of a wedged provider. Not a failure and not a fault, so it is an outcome of its own.
      if (!settled) {
        this.logStreamAbandoned(ids, route, chunkCount, elapsed());
      }
    }
    const forwardsReasoning = this.forwardsReasoning(state.prepared);
    // Outside the try on purpose: a sink that throws here must not be caught above and reported as
    // a mid-stream provider failure — which would also trip the circuit breaker on a logging fault.
    this.logStreamCompleted(ids, route, chunkCount, elapsed(), {
      firstTokenMs,
      usage: streamUsageIfSupplied(terminalResponse?.usage),
      reasoning:
        terminalResponse === undefined
          ? undefined
          : reasoningCompletion(terminalResponse, forwardsReasoning),
    });
    // Production consumers stop at done without advancing or closing the iterator again.
    // Close the provider, settle spend/circuit state and emit the outcome before handing it off.
    if (terminalResponse !== undefined) {
      yield this.terminalStreamAnswer(state, terminalResponse, forwardsReasoning, start);
    }
  }

  // The `done` chunk a settled stream hands its caller: the reasoning policy applied, the steered
  // repair that recovered it and the attempts it discarded marked, the call's ids and timing added.
  private terminalStreamAnswer(
    state: PreparedStream,
    response: NormalizedResponse,
    forwardsReasoning: boolean,
    start: number,
  ): GatewayStreamChunk {
    return this.enrichDone(
      withDiscardedUsage(
        recoveredResponse(withReasoningPolicy(response, forwardsReasoning), state.outputRepair),
        state.attempts.discarded,
      ),
      state.ids.requestId,
      start,
      state.route,
    );
  }

  // #3878: only a call that asks for reasoning delivery (`reasoningDelivery: "forward"`, set by the
  // coding sidecar route alone) forwards the model's reasoning, so the Coding Workbench can show it,
  // and only while the operator has not switched `codingReasoningDisplay` off. Every other surface
  // keeps today's answer: the reasoning is parsed and discarded — including a surface that borrows
  // the coding-workbench latency profile for its timeout floors, which selects timeouts only (the
  // commit draft received the reasoning with it until #3873, F23).
  private forwardsReasoning(request: GatewayCallRequest): boolean {
    return request.reasoningDelivery === "forward" && this.config.codingReasoningDisplay !== "off";
  }

  private async prepareStream(request: GatewayCallRequest): Promise<PreparedStream> {
    const route = this.routeForCall(request);
    const prepared = this.prepareRequest(request, route.capability);
    const ids = callIds(randomUUID(), prepared);
    const start = this.clock.now();
    const elapsed = logTimer();
    const adapter = this.adapterFor(ids.requestId, route, ids.correlationId);
    const outageWindowMs = this.outageWindowMs(prepared);
    const announcer = callAnnouncer(prepared, this.retryLabels(route, ids));
    this.logCallStarted(ids, route, true, prepared, adapter.callStream !== undefined);
    // The admission before the first attempt waits under the same window clip as the admission
    // of every retry (#3873): an open breaker cannot hold a streamed call past its outage window,
    // and the window, not the stream budget, is what bounds that wait (#3873 review).
    const admissionBudgetMs = admissionBudgetFor(
      callRetryConfig(route.provider, outageWindowMs),
      streamedCallBudgetMs(route.provider, outageWindowMs),
      (): number => this.clock.now() - start,
    );
    const { admission } = await this.initialStreamAdmission(
      route,
      prepared,
      ids,
      elapsed,
      admissionBudgetMs,
      announcer,
    );
    return {
      route,
      prepared,
      ids,
      start,
      elapsed,
      adapter,
      admission,
      promptAdmission: this.promptAdmission(route, ids),
      outageWindowMs,
      outputRepair: {},
      attempts: {
        count: 0,
        request: prepared,
        reasoningDelivered: false,
        discarded: emptyDiscardedUsage(),
      },
      announcer,
    };
  }

  // A first admission that waits is announced to the call's observer like every other wait; the
  // loop that follows an admitted call settles it. No loop follows a refused one, so the call
  // settles here: refused by its window, or cancelled while it waited.
  private async initialStreamAdmission(
    route: RoutedCall,
    request: GatewayCallRequest,
    ids: CallIds,
    elapsed: () => number,
    admissionBudgetMs: number,
    announcer: RetryAnnouncer | undefined,
  ): ReturnType<CircuitBreaker["waitForAdmission"]> {
    try {
      return await this.providerAdmission(
        route.provider,
        request,
        ids.correlationId,
        admissionBudgetMs,
        undefined,
        announcer,
      );
    } catch (error) {
      attachGatewayRequestId(error, ids.requestId);
      this.logStreamFailed(ids, route, 0, elapsed(), error);
      announcer?.settled("failed");
      throw error;
    }
  }

  private failStream(
    ids: CallIds,
    route: RoutedCall,
    chunkCount: number,
    durationMs: number,
    error: unknown,
  ): never {
    attachGatewayRequestId(error, ids.requestId);
    this.logStreamFailed(ids, route, chunkCount, durationMs, error);
    this.reportContextWindow(route, ids, error);
    throw error;
  }

  // RB-6: stamp the gateway request id onto the thrown error so a FAILED buffered call is traceable
  // to the gateway record (previously requestId was attached only on success/usage).
  private settleFailedCall(
    ids: CallIds,
    route: RoutedCall,
    durationMs: number,
    error: unknown,
  ): void {
    attachGatewayRequestId(error, ids.requestId);
    this.logCallFailed(ids, route, durationMs, error);
    this.reportContextWindow(route, ids, error);
  }

  // Hands a provider-stated window to the host before the overflow is rethrown.
  private reportContextWindow(route: RoutedCall, ids: CallIds, error: unknown): void {
    if (!(error instanceof ContextOverflowError)) return;
    const contextWindowTokens = error.reportedContextWindowTokens;
    if (contextWindowTokens === undefined) return;
    this.onContextWindowReported?.({
      modelId: route.provider.modelId,
      contextWindowTokens,
      correlationId: ids.correlationId,
      deploymentFingerprint: toolCallingConfigurationFingerprint(route.provider),
    });
  }

  // THE ATTEMPT LINE for a model call — written BEFORE the adapter is invoked, not after it
  // returns. A provider that accepts the connection and then goes quiet produces no completion
  // and no failure, so without this the gateway is silent for exactly the window an operator is
  // trying to diagnose. `timeoutMs` and `maxRetries` are on it because the pair bounds how long
  // this silence can legitimately last: an attempt line whose deadline has already passed with no
  // outcome is a wedge, not a slow provider. `timeoutMs` reports the bound THIS call's transport
  // actually applies (PR #3602 review) — the silence floor for a call that reads incrementally
  // (`upstreamStreaming`), the larger buffered floor for a whole-body read or `chatStream()`'s
  // degraded fallback, never a value the transport itself does not honour. `requestBudgetMs` is the
  // budget the buffered call really runs under, the outage window's extension included (#3873).
  private logCallStarted(
    ids: CallIds,
    route: RoutedCall,
    streaming: boolean,
    request: GatewayCallRequest,
    upstreamStreaming = false,
  ): void {
    if (!logLevelEnabled(this.log, "info")) return;
    const { reasoningEffort } = request;
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
          requestBudgetMs: bufferedCallBudgetMs(route.provider, this.outageWindowMs(request)),
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
    terminal: {
      readonly firstTokenMs: number | undefined;
      readonly usage: StreamTerminalUsage | undefined;
      readonly reasoning: ReasoningCompletion | undefined;
    },
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
          ...(terminal.firstTokenMs === undefined ? {} : { firstTokenMs: terminal.firstTokenMs }),
          ...terminal.usage,
          ...terminal.reasoning,
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
          // The call's terminal failure: `chunkCount` is how far it got, and a failure after an
          // answer delta could not be retried (a failure after nothing but reasoning was, inside
          // the call's retry loop).
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
    forwardsReasoning: boolean,
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
          ...reasoningCompletion(result, forwardsReasoning),
        },
      ),
    );
  }

  // The attempts of a streamed call: its startup retries, or — resumed after an attempt that failed
  // while it had delivered nothing but reasoning (#3873 F17, F23, option iii; #3873 review) — the
  // rest of the same loop: the one steered repair, a schema correction, or a provider retry under
  // the call's policy, all on the call's one attempt count and its one repair.
  private async openRetriedStream(
    state: PreparedStream,
    failedAttempt?: Error,
  ): Promise<OpenedStream> {
    const { prepared: request, route, ids, admission: initialAdmission } = state;
    const budget = streamStartupBudget(state, this.clock.now());
    let admission = initialAdmission;
    const resume = streamResume(state, failedAttempt);
    // Under a resumed loop every attempt follows the failed one, so each needs its own admission.
    let attempt = resume === undefined ? 0 : 1;
    return executeWithRetry(
      async (_attemptMs, remainingMs, previousError, admissionBudgetMs) => {
        const current = this.prepareStreamAttempt(state, previousError);
        if (attempt++ > 0) {
          const allowed = await this.admitAttempt(
            route.provider,
            current,
            ids.correlationId,
            remainingMs ?? budget.remainingMs,
            previousError,
            admissionBudgetMs,
            state.announcer,
          );
          admission = allowed.admission;
          remainingMs = allowed.remainingMs;
        }
        return this.openStreamAttempt(state, current, remainingMs, admission);
      },
      // A catalog rejection is retried only with its schema correction, never replayed as it was.
      streamStartupRetryConfig(state, () => admission, budget),
      this.clock,
      request.cancellationSignal,
      this.random,
      this.retryLogContext(route, ids, state.announcer),
      resume,
    );
  }

  // A delivered answer delta or `done` commits the stream: nothing may be replayed after it, so a
  // later failure surfaces at once. Forwarded reasoning does not commit it (owner decision
  // 2026-10-06, #3873 F17 option iii): while a stream has delivered nothing but reasoning, its
  // failure goes back to the call's retry loop, which decides it exactly like a failure before the
  // first chunk (#3873 review) — the one steered repair of an exhausted or empty answer, a schema
  // correction after a catalog rejection, or a provider retry under the call's policy, the outage
  // window included. The caller then sees a further reasoning passage; no answer text or tool call
  // is ever duplicated. Each resumed passage is one more delegation level, opened only after the
  // previous level closed its stream; the call's retry budget bounds how many there are.
  private async *streamFrom(
    state: PreparedStream,
    failedAttempt?: Error,
  ): AsyncGenerator<GatewayStreamChunk> {
    const opened = await this.openRetriedStream(state, failedAttempt);
    let resumable: Error | undefined;
    try {
      resumable = yield* this.deliverUntilCommitted(state, opened);
    } finally {
      await opened.iterator.return(undefined);
    }
    if (resumable !== undefined) yield* this.streamFrom(state, resumable);
  }

  // Delivers an opened stream. Returns the failure of a stream that delivered nothing but reasoning
  // when the call's retry loop can still act on it, and rethrows every other failure.
  private async *deliverUntilCommitted(
    state: PreparedStream,
    opened: OpenedStream,
  ): AsyncGenerator<GatewayStreamChunk, Error | undefined> {
    let committed = commitsStream(opened.first);
    try {
      noteDelivered(state, opened.first);
      yield opened.first;
      for await (const chunk of opened.iterator) {
        committed ||= commitsStream(chunk);
        noteDelivered(state, chunk);
        yield chunk;
      }
      return undefined;
    } catch (error) {
      if (committed || !resumableAfterReasoning(state, error)) throw error;
      return error;
    }
  }

  // One streamed attempt of the call (`state`: its route, ids, adapter, prompt admission and the
  // schema correction the attempt carries) for `request`, under what is left of its budget.
  private async openStreamAttempt(
    state: PreparedStream,
    request: GatewayCallRequest,
    remainingMs: number | undefined,
    admission: CircuitBreakerAdmission,
  ): Promise<{ first: GatewayStreamChunk; iterator: AsyncGenerator<GatewayStreamChunk> }> {
    const bounds = chatStreamBounds(state.route.provider);
    const budgetMs = Math.min(bounds.budgetMs, remainingMs ?? bounds.budgetMs);
    const iterator = this.reservedStreamAttempt(
      state,
      request,
      { budgetMs, silenceMs: Math.min(bounds.silenceMs, budgetMs) },
      admission,
    );
    try {
      let first = await iterator.next();
      while (!first.done && first.value.type === "delta" && first.value.token.length === 0) {
        first = await iterator.next();
      }
      if (first.done) throw new TransportError("provider stream ended without an answer");
      return { first: first.value, iterator };
    } catch (error) {
      await iterator.return(undefined);
      throw error;
    }
  }

  private async *reservedStreamAttempt(
    state: PreparedStream,
    request: GatewayCallRequest,
    bounds: StreamReadBounds,
    admission: CircuitBreakerAdmission,
  ): AsyncGenerator<GatewayStreamChunk> {
    const { adapter, route, ids } = state;
    let reservation: GatewaySpendReservation | undefined;
    let callerReservation: ReturnType<NonNullable<GatewayCallRequest["attemptAdmission"]>>;
    let dispatchObserved: (() => boolean) | undefined;
    let admitted = false;
    let usage: UsageMetadata | undefined;
    let received = false;
    let terminal: GatewayStreamChunk | undefined;
    const logRepair = this.streamRepairLogger(state, request);
    try {
      ({ request, bounds, callerReservation, reservation, dispatchObserved } =
        await this.prepareStreamDispatch(state, request, bounds));
      admitted = true;
      const stream = this.readProviderStream(adapter, request, route.provider, ids, bounds);
      for await (const chunk of stream) {
        if (chunk.type === "done") {
          usage = chunk.response.usage;
          received = true;
          terminal = chunk;
          break;
        } else if (chunk.token.length > 0) received = true;
        yield chunk;
      }
      if (!received) throw new TransportError("provider stream ended without an answer");
      admission.settle("success");
    } catch (error) {
      if (error instanceof ContextOverflowError) logRepair("denied");
      usage = measuredCatalogFailureUsage(error, route.capability, ids.correlationId);
      settleFailedCallerAttempt(callerReservation, error, admitted);
      recordProviderFailure(admission, error, observedProviderDispatch(dispatchObserved, admitted));
      throw error;
    } finally {
      // Closing an iterator early does not enter catch and is not proof of provider recovery.
      admission.settle("non-provider-fault");
      reservation?.settle(usage);
      settleCallerAttempt(callerReservation, usage, admitted);
    }
    if (terminal !== undefined) yield terminal;
  }

  private async prepareStreamDispatch(
    state: PreparedStream,
    request: GatewayCallRequest,
    bounds: StreamReadBounds,
  ): Promise<ReturnType<Gateway["reserveAdapterAttempt"]> & { bounds: StreamReadBounds }> {
    const remaining = await state.promptAdmission.admit(
      request,
      streamAttemptBudgetMs(state.adapter, state.route, bounds),
    );
    this.streamRepairLogger(state, request)("scheduled");
    return {
      bounds: { budgetMs: remaining, silenceMs: Math.min(bounds.silenceMs, remaining) },
      ...this.reserveAdapterAttempt(
        state.adapter,
        request,
        state.route.capability,
        state.ids.correlationId,
      ),
    };
  }

  private streamRepairLogger(
    state: PreparedStream,
    request: GatewayCallRequest,
  ): (repairState: "scheduled" | "denied") => void {
    return (repairState): void => {
      this.logRequestRepair(
        state.route.capability,
        state.ids.correlationId,
        state.attempts.schemaRepair,
        request,
        repairState,
      );
    };
  }

  private async *readProviderStream(
    adapter: ProviderAdapter,
    request: GatewayCallRequest,
    provider: ModelProviderConfig,
    ids: CallIds,
    bounds: StreamReadBounds,
  ): AsyncGenerator<GatewayStreamChunk> {
    const forwardsReasoning = this.forwardsReasoning(request);
    if (adapter.callStream !== undefined) {
      const stream = adapter.callStream(request, provider, bounds);
      yield* forwardsReasoning ? stream : withoutReasoningChunks(stream);
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
      timeoutMs: Math.min(effectiveBufferedAttemptMs(provider), bounds.budgetMs),
    };
    const response = await adapter.call(request, bufferedProvider);
    if (forwardsReasoning && response.reasoning !== undefined) {
      yield { type: "reasoning", token: response.reasoning };
    }
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
    attempt: BufferedChatAttempt,
    provider: ModelProviderConfig,
    bounds?: StreamReadBounds,
    remainingBudgetMs?: number,
    previousError?: Error,
    admissionBudgetMs?: number,
  ): Promise<NormalizedResponse> {
    const { adapter, correlationId } = attempt;
    const { capability } = attempt.route;
    let request = attempt.state.request;
    const { admission, remainingMs } = await this.admitAttempt(
      provider,
      request,
      correlationId,
      admissionBudget(provider, bounds, remainingBudgetMs),
      previousError,
      admissionBudgetMs,
      attempt.announcer,
    );
    provider = { ...provider, timeoutMs: Math.min(provider.timeoutMs, remainingMs) };
    bounds = clippedStreamBounds(bounds, remainingMs);
    let reservation: GatewaySpendReservation | undefined;
    let callerReservation: ReturnType<NonNullable<GatewayCallRequest["attemptAdmission"]>>;
    let dispatchObserved: (() => boolean) | undefined;
    let admitted = false;
    let usage: UsageMetadata | undefined;
    try {
      ({ provider, bounds, request, callerReservation, reservation, dispatchObserved } =
        await this.prepareBufferedDispatch(attempt, provider, bounds));
      admitted = true;
      const response = await readAnswer(adapter, request, provider, bounds);
      usage = response.usage;
      admission.settle("success");
      return response;
    } catch (error) {
      if (error instanceof ContextOverflowError) this.logAttemptRepair(attempt, "denied");
      usage = measuredCatalogFailureUsage(error, capability, correlationId);
      settleFailedCallerAttempt(callerReservation, error, admitted);
      // A client-initiated cancel is not a provider fault — skip the breaker.
      recordProviderFailure(admission, error, observedProviderDispatch(dispatchObserved, admitted));
      throw error;
    } finally {
      admission.settle("non-provider-fault");
      reservation?.settle(usage);
      settleCallerAttempt(callerReservation, usage, admitted);
    }
  }

  private async prepareBufferedDispatch(
    attempt: BufferedChatAttempt,
    provider: ModelProviderConfig,
    bounds: StreamReadBounds | undefined,
  ): Promise<
    ReturnType<Gateway["reserveAdapterAttempt"]> & {
      provider: ModelProviderConfig;
      bounds: StreamReadBounds | undefined;
    }
  > {
    const admitted = await this.admitBufferedPrompt(attempt, provider, bounds);
    this.logAttemptRepair(attempt, "scheduled");
    return {
      ...admitted,
      ...this.reserveAdapterAttempt(
        attempt.adapter,
        attempt.state.request,
        attempt.route.capability,
        attempt.correlationId,
      ),
    };
  }

  private async admitBufferedPrompt(
    attempt: BufferedChatAttempt,
    provider: ModelProviderConfig,
    bounds: StreamReadBounds | undefined,
  ): Promise<{
    readonly provider: ModelProviderConfig;
    readonly bounds: StreamReadBounds | undefined;
  }> {
    const remaining = await attempt.promptAdmission.admit(
      attempt.state.request,
      bounds?.budgetMs ?? provider.timeoutMs,
    );
    return {
      provider: { ...provider, timeoutMs: Math.min(provider.timeoutMs, remaining) },
      bounds:
        bounds === undefined
          ? undefined
          : { budgetMs: remaining, silenceMs: Math.min(bounds.silenceMs, remaining) },
    };
  }

  private callerAttemptReservation(
    request: GatewayCallRequest,
    capability: ModelCapability,
  ): ReturnType<NonNullable<GatewayCallRequest["attemptAdmission"]>> {
    const admit = request.attemptAdmission;
    if (admit === undefined) return undefined;
    const profile = deriveContextProfileFromCapability(capability);
    const reservation = admit({
      promptTokens: countGatewayPromptTokens(request, profile.tokenAccounting, {
        contextWindow: profile.maxInputTokens,
      }),
      maxOutputTokens: request.maxOutputTokens ?? profile.reservedOutputTokens,
    });
    if (reservation === undefined)
      throw new CallerAttemptAdmissionError(
        "Caller synthesis attempt grant exhausted before dispatch",
      );
    return onceCallerReservation(reservation);
  }

  private reserveAdapterAttempt(
    adapter: ProviderAdapter,
    request: GatewayCallRequest,
    capability: ModelCapability,
    correlationId: string,
  ): {
    request: GatewayCallRequest;
    callerReservation: ReturnType<NonNullable<GatewayCallRequest["attemptAdmission"]>>;
    reservation: GatewaySpendReservation | undefined;
    dispatchObserved?: () => boolean;
  } {
    if (adapter.attemptAdmissionBoundary === "transport") {
      let dispatched = false;
      return {
        request: {
          ...request,
          attemptAdmission: (input) =>
            this.reserveTransportAttempt(
              {
                ...request,
                ...(input.maxOutputTokens <= 0 ? {} : { maxOutputTokens: input.maxOutputTokens }),
              },
              capability,
              correlationId,
              (observed): void => {
                dispatched ||= observed;
              },
            ),
        },
        callerReservation: undefined,
        reservation: undefined,
        dispatchObserved: (): boolean => dispatched,
      };
    }
    const callerReservation = this.callerAttemptReservation(request, capability);
    try {
      request = callerAdmittedRequest(request, callerReservation);
      return {
        request,
        callerReservation,
        reservation: this.spendBudget?.reserve(capability, request, correlationId),
      };
    } catch (failure) {
      settleCallerAttempt(callerReservation, undefined, false, "none");
      throw failure;
    }
  }

  private reserveTransportAttempt(
    request: GatewayCallRequest,
    capability: ModelCapability,
    correlationId: string,
    observeDispatch: (dispatched: boolean) => void,
  ): NonNullable<ReturnType<NonNullable<GatewayCallRequest["attemptAdmission"]>>> {
    const caller = this.callerAttemptReservation(request, capability);
    let spend: GatewaySpendReservation | undefined;
    try {
      request = callerAdmittedRequest(request, caller);
      spend = this.spendBudget?.reserve(capability, request, correlationId);
    } catch (failure) {
      settleCallerAttempt(caller, undefined, false, "none");
      throw failure;
    }
    return onceCallerReservation({
      maxOutputTokens: request.maxOutputTokens,
      settle(usage, dispatched, outputState): void {
        observeDispatch(dispatched);
        try {
          spend?.settle(completeTransportUsage(usage));
        } finally {
          settleCallerAttempt(caller, usage, dispatched, outputState);
        }
      },
    });
  }

  // The admission of an attempt, the first one's and a retry's, buffered or streamed: the wait is
  // clipped to the retry window, and the attempt keeps the call's own budget, less only the time it
  // actually waited (#3873). A wait that begins is announced to the call's observer (#3873 review).
  private async admitAttempt(
    provider: ModelProviderConfig,
    request: GatewayCallRequest,
    correlationId: string,
    budgetMs: number,
    previousError: Error | undefined,
    admissionBudgetMs: number | undefined,
    announcer: RetryAnnouncer | undefined,
  ): Promise<{ readonly admission: CircuitBreakerAdmission; readonly remainingMs: number }> {
    const waitBudgetMs = Math.min(budgetMs, admissionBudgetMs ?? budgetMs);
    const admitted = await this.providerAdmission(
      provider,
      request,
      correlationId,
      waitBudgetMs,
      previousError,
      announcer,
    );
    return {
      admission: admitted.admission,
      remainingMs: budgetMs - (waitBudgetMs - admitted.remainingMs),
    };
  }

  private providerAdmission(
    provider: ModelProviderConfig,
    request: GatewayCallRequest,
    correlationId: string,
    remainingMs: number,
    previousError?: Error,
    announcer?: RetryAnnouncer,
  ): ReturnType<CircuitBreaker["waitForAdmission"]> {
    return this.breakerFor(provider).waitForAdmission({
      remainingMs,
      previousError,
      signal: request.cancellationSignal,
      correlationId,
      jitterMs: (): number => Math.max(1, Math.round(provider.retryBaseDelayMs * this.random())),
      retryPolicy: this.retryPolicy(request),
      announcer,
    });
  }

  // #3873: the outage window a call retries for. Only a call that carries the explicit
  // `outagePolicy: "outage-window"` signal — the coding sidecar route's buffered and streamed calls
  // — gets the configured `codingOutageWindowMs`. Every other call gets 0, the provider's attempt
  // count and the fail-fast breaker: the commit draft and interactive chat included, even where
  // they borrow the coding-workbench timeout floors (`latencyProfile`).
  private outageWindowMs(request: GatewayCallRequest): number {
    return callOutageWindowMs(this.config, request.outagePolicy);
  }

  private retryPolicy(request: GatewayCallRequest): RetryPolicy {
    return this.outageWindowMs(request) > 0 ? "outage-window" : "attempts";
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
