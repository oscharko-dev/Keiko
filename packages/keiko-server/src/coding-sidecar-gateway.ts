import { gatewaySpendRejectionReason } from "./gateway-spend-budget.js";
import {
  AuthenticationError,
  CircuitOpenError,
  ContextOverflowError,
  ModelRefusalError,
  ProviderError,
  ProviderOutputExhaustedError,
  RateLimitError,
  TimeoutError,
  TransportError,
} from "@oscharko-dev/keiko-security/errors/gateway";
import { createHash, randomUUID } from "node:crypto";
import {
  findConfiguredCapability,
  resolveCodingSafeSidecarGatewayProfile,
  type Gateway,
  type GatewayCallRequest,
  type GatewayConfig,
  type GatewayRequest,
  type GatewayStreamChunk,
  type NormalizedToolCall,
  type NormalizedResponse,
  type ToolDefinition,
} from "@oscharko-dev/keiko-model-gateway";
import {
  countGatewayPromptTokens,
  type ModelTokenAccounting,
} from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import {
  codingWorkbenchProviderTimeoutMs,
  providerRequestBudgetMs,
} from "@oscharko-dev/keiko-model-gateway/internal/resilience";
import { MAX_TIMER_DELAY_MS } from "./abort-race.js";
import type {
  CodingWorkbenchModelSource,
  CodingWorkbenchSidecarGatewayRunMetadata,
  CodingWorkbenchSidecarGatewayResult,
  CodingWorkbenchSidecarGatewayUnavailableReason,
  ModelReasoningEffort,
} from "@oscharko-dev/keiko-contracts";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import { CODING_WORKBENCH_MINIMUM_CODING_CONTEXT_PROMPT_TOKENS } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import type {
  CodingWorkbenchRuntimeSnapshot,
  CodingWorkbenchTurnFailureCode,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  MODEL_REASONING_EFFORTS,
  validateGatewaySamplingParameters,
} from "@oscharko-dev/keiko-contracts/runtime/gateway";
import {
  currentGateway,
  currentGatewayConfig,
  currentGatewayVerification,
  type UiHandlerDeps,
} from "./deps.js";
import {
  OPENCODE_RUNTIME_MODEL_ALIAS,
  OPENCODE_RUNTIME_READINESS_PROMPT,
} from "./coding-runtime/opencodeLaunchProfile.js";
import {
  createOpenCodeGatewayToolCatalogAdvertisement,
  opencodeGatewayOfferLifetimeMs,
  hasExactOpenCodeVisibleToolContract,
  OPENCODE_MODEL_VISIBLE_TOOL_NAMES,
  type OpenCodeGatewayHandlerCoverage,
} from "./coding-runtime/opencodeToolSchemas.js";
import type { OpenCodeOptionalToolName } from "./coding-runtime/opencodeLaunchProfile.js";
import { correlationIdOrUnknown, UNKNOWN_CORRELATION_ID } from "./correlation.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "./diagnostics-log.js";
import { readJsonObject } from "./files.js";
import { safetyMarginTokensFor } from "@oscharko-dev/keiko-contracts/context-engineering";
import {
  ensureCodingWorkbenchContextWindows,
  isAnyCodingWorkbenchProbePending,
  isCodingWorkbenchProbePending,
} from "./gateway-readiness.js";
import { getServerLogger } from "./observability/index.js";
import { STREAMING, errorBody, type RouteContext, type RouteResult } from "./routes.js";
import { startSseHeartbeat } from "./sse.js";
import { createCanonicalOpenCodeHandlerCoverage } from "./tool-catalog/catalogToolFacadeBridge.js";

const ENABLE_TOKENS = new Set(["1", "true", "on", "yes", "enabled"]);
const CODING_SIDECAR_DISABLED_ENV = "KEIKO_CODING_SIDECAR_DISABLED";
// KEIKO-0681: bounded concurrency for the coding-sidecar gateway chat/completions route,
// mirroring MAX_ACTIVE_CHAT_STREAMS_ENV in chat-stream-handlers.ts. Independent counter
// (not shared with desktop chat) so a bulkhead on one path does not starve the other. Rejected
// callers get a JSON 429 BEFORE any SSE header, so an SDK client can transparently retry.
export const MAX_ACTIVE_CODING_GATEWAY_REQUESTS_ENV = "KEIKO_CODING_SIDECAR_MAX_ACTIVE_REQUESTS";
const DEFAULT_MAX_ACTIVE_CODING_GATEWAY_REQUESTS = 16;
const HARD_MAX_ACTIVE_CODING_GATEWAY_REQUESTS = 64;
let activeCodingGatewayRequests = 0;

function maxActiveCodingGatewayRequests(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[MAX_ACTIVE_CODING_GATEWAY_REQUESTS_ENV];
  if (raw === undefined || raw.trim().length === 0)
    return DEFAULT_MAX_ACTIVE_CODING_GATEWAY_REQUESTS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_ACTIVE_CODING_GATEWAY_REQUESTS;
  return Math.min(parsed, HARD_MAX_ACTIVE_CODING_GATEWAY_REQUESTS);
}

// Test seam: not exported via index.ts. Module state; parallel test files each get their own
// module instance, so a reset keeps cases order-independent.
export function _resetActiveCodingGatewayRequestsForTests(): void {
  activeCodingGatewayRequests = 0;
}

/**
 * One outstanding runtime prompt-token reservation (#3384 wave-3 W3-3 "needs"). Mirrors
 * The exactly-once settlement guard: `reserveGatewayPromptBudget` books the
 * pre-call ESTIMATE against the run's real authority-level prompt budget
 * (`agentAuthorityRegistry.ts`'s ledger, via `runtimeAuthorityService.ts`), and this reservation
 * must be settled exactly once against the provider's REAL reported usage once known, so the
 * envelope reflects N calls' worth of real usage instead of N estimates.
 */
interface PromptTokenReservation {
  readonly capability: string;
  readonly reservedPromptTokens: number;
  settled: boolean;
  settlement?: PromptTokenSettlement;
}

interface PromptTokenSettlement {
  readonly promptTokens: number;
  readonly source: "provider-reported" | "reserved-estimate";
  readonly status: "settled" | "retained-after-refusal" | "unverified" | "not-wired";
}

function observedPromptSettlement(
  outcome: unknown,
  selected: PromptTokenSettlement,
  unverified: PromptTokenSettlement,
): PromptTokenSettlement {
  if (!isRecord(outcome)) return unverified;
  if (outcome.ok === true) return selected;
  if (outcome.ok === false) return { ...unverified, status: "retained-after-refusal" };
  return unverified;
}

/**
 * Settles a runtime prompt-token reservation. `actualPromptTokens` is the provider's real reported
 * usage when known; when the outcome is uncertain (dispatched but no usage was ever observed — a
 * mid-flight failure or cancellation) the full reserved estimate is kept as spent, matching
 * the shared Model Gateway spend ledger's conservative-accounting rule. A no-op past the first call, so callers
 * may settle defensively from more than one exit path. Absent `settlePromptTokens` on the injected
 * authenticator (not every deployment wires it) is a silent no-op, never a failure.
 */
function settlePromptTokenReservation(
  deps: UiHandlerDeps,
  reservation: PromptTokenReservation,
  actualPromptTokens?: number,
): PromptTokenSettlement {
  if (reservation.settled) {
    if (reservation.settlement === undefined) throw new TypeError("missing prompt settlement");
    return reservation.settlement;
  }
  reservation.settled = true;
  const providerReported = actualPromptTokens !== undefined && actualPromptTokens > 0;
  const promptTokens = providerReported ? actualPromptTokens : reservation.reservedPromptTokens;
  const unverified: PromptTokenSettlement = {
    promptTokens: reservation.reservedPromptTokens,
    source: "reserved-estimate",
    status: "unverified",
  };
  const selected: PromptTokenSettlement = {
    promptTokens,
    source: providerReported ? "provider-reported" : "reserved-estimate",
    status: "settled",
  };
  reservation.settlement = unverified;
  const authenticator = runtimeCapabilityAuthenticator(deps);
  if (authenticator?.settlePromptTokens === undefined) {
    reservation.settlement = { ...selected, status: "not-wired" };
    return reservation.settlement;
  }
  const outcome = authenticator.settlePromptTokens(
    reservation.capability,
    reservation.reservedPromptTokens,
    promptTokens,
  );
  reservation.settlement = observedPromptSettlement(outcome, selected, unverified);
  return reservation.settlement;
}

const CODING_SIDECAR_GATEWAY_ERROR_CODE = "CODING_SIDECAR_UNAVAILABLE";
const CODING_SIDECAR_GATEWAY_ROUTE = "POST /api/coding-sidecar/gateway/chat/completions";
const CODING_SAFE_SIDECAR_GATEWAY_PROFILE_ID = "coding-safe-openai-compatible";
const BUFFERED_STREAM_HEARTBEAT_MS = 5_000;
const OUTPUT_BYTES_PER_TOKEN_LIMIT = 4;
// The #2680 live-probe fingerprint (many model requests, zero keiko_* facade calls) becomes
// judgeable once the replayed history holds the two system messages, the task prompt, and three
// assistant/user rounds without one governed tool call; legitimate coding turns read a file
// within their first rounds.
const TOOL_ADOPTION_GAP_MESSAGE_THRESHOLD = 9;
const GOVERNED_TOOL_NAME_PREFIX = "keiko_";
const MODEL_REASONING_EFFORT_SET: ReadonlySet<string> = new Set(MODEL_REASONING_EFFORTS);

const CODING_SIDECAR_GATEWAY_REQUEST_VALIDATED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-sidecar.gateway.request-validated",
  category: "gateway",
  owner: "keiko-server",
  emitter: "coding-sidecar-gateway.logValidatedRequestBounds",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    maxRequestBytes: { type: "integer", dataClass: "count", required: true },
    maxPromptTokens: { type: "integer", dataClass: "count", required: true },
    estimatedPromptTokens: { type: "integer", dataClass: "count", required: true },
    // #3591 (1.1.7): the output allowance sent with this request, clamped to the window that
    // remains after the prompt — the value an output-exhausted turn has to be read against.
    maxOutputTokens: { type: "integer", dataClass: "count", required: false },
    inputMessageCount: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-sidecar-gateway-request"],
  proofIds: ["coding-sidecar.gateway.request-validated.line"],
  releaseImpact: "patch",
});

const CODING_SIDECAR_GATEWAY_READINESS_INSUFFICIENT_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-sidecar.gateway.readiness-insufficient",
  category: "gateway",
  owner: "keiko-server",
  emitter: "coding-sidecar-gateway.gatewayReadinessProjection",
  fields: {
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "model-context-window-insufficient",
        "no-tool-calling",
        "tool-calling-unverified",
        "model-verification-pending",
      ],
    },
    maxPromptTokens: { type: "integer", dataClass: "count", required: false },
    minimumRequiredPromptTokens: { type: "integer", dataClass: "count", required: false },
    probeMode: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["passive", "pending"],
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "capability",
  failureClasses: ["coding-sidecar-gateway-readiness"],
  proofIds: ["coding-sidecar.gateway.readiness-insufficient.line"],
  releaseImpact: "patch",
});

const CODING_SIDECAR_GATEWAY_TOOL_AVAILABILITY_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-sidecar.gateway.tool-availability",
  category: "gateway",
  owner: "keiko-server",
  emitter: "coding-sidecar-gateway.resolveToolCatalogHandlerCoverage",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    handlerSetDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    unavailableOptionalTools: {
      type: "string-array",
      dataClass: "closed-enum",
      required: true,
      maxItems: 4,
      values: ["keiko_research_fetch", "keiko_skill_discover", "keiko_skill", "keiko_child_agent"],
    },
    unavailableOptionalToolCount: { type: "integer", dataClass: "count", required: true },
    offeredOptionalTools: {
      type: "string-array",
      dataClass: "closed-enum",
      required: true,
      maxItems: 4,
      values: ["keiko_research_fetch", "keiko_skill_discover", "keiko_skill", "keiko_child_agent"],
    },
    offeredOptionalToolCount: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "capability",
  failureClasses: ["coding-sidecar-tool-availability"],
  proofIds: ["coding-sidecar.gateway.tool-availability.line"],
  releaseImpact: "patch",
});

// #3390 closeout (AGENTS.md §8): every rejection this route can hand back gets ONE body-free
// activity-log line carrying the REASON, so a defect is reconstructable from the log alone instead
// of only the opaque HTTP status the client saw. `reason` is this closed vocabulary — never a raw
// message — and is threaded through every 400/403 rejection path below via `logGatewayRejection`.
// The readiness projection (`/api/coding-sidecar/gateway/profile`) demoting an otherwise
// "available" profile because its context window cannot survive a real request gets its own op:
// it is not a per-request rejection, it is a standing state of the profile itself.

type CodingSidecarGatewayRejectionReason =
  | "request-too-large"
  | "body-not-json"
  | "body-empty-messages"
  | "message-shape-invalid"
  | "content-part-unsupported"
  | "tools-not-openai-compatible"
  | "invalid-sampling"
  | "input-messages-exceeded"
  | "prompt-tokens-exceeded"
  | "invalid-model"
  | "tool-contract-drift"
  | "tool-contract-missing"
  | "tool-contract-empty"
  | "origin-not-allowed"
  | "runtime-prompt-budget-denied"
  | "capability-authenticator-unavailable"
  | "capability-missing"
  | "capability-invalid"
  | "spend-bound-unavailable"
  | "spend-ledger-unavailable"
  | "spend-budget-invalid"
  | "spend-pricing-unavailable"
  | "spend-budget-exceeded"
  | "unclassified-rejection";

const CODING_SIDECAR_GATEWAY_REJECTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-sidecar.gateway.rejected",
  category: "gateway",
  owner: "keiko-server",
  emitter: "coding-sidecar-gateway.logGatewayRejection",
  fields: {
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "request-too-large",
        "body-not-json",
        "body-empty-messages",
        "message-shape-invalid",
        "content-part-unsupported",
        "tools-not-openai-compatible",
        "invalid-sampling",
        "input-messages-exceeded",
        "prompt-tokens-exceeded",
        "invalid-model",
        "tool-contract-drift",
        "tool-contract-missing",
        "tool-contract-empty",
        "origin-not-allowed",
        "runtime-prompt-budget-denied",
        "capability-authenticator-unavailable",
        "capability-missing",
        "capability-invalid",
        "spend-bound-unavailable",
        "spend-ledger-unavailable",
        "spend-budget-invalid",
        "spend-pricing-unavailable",
        "spend-budget-exceeded",
        "unclassified-rejection",
      ],
    },
    runId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 128 },
    expectedToolCount: { type: "integer", dataClass: "count", required: false },
    receivedToolCount: { type: "integer", dataClass: "count", required: false },
    unexpectedToolCount: { type: "integer", dataClass: "count", required: false },
    missingToolCount: { type: "integer", dataClass: "count", required: false },
    toolMismatchSha256: {
      type: "string",
      dataClass: "digest",
      required: false,
      maxLength: 64,
    },
    estimatedPromptTokens: { type: "integer", dataClass: "count", required: false },
    maxPromptTokens: { type: "integer", dataClass: "count", required: false },
    // #3591 review: the bound the prompt was actually admitted against — `maxPromptTokens` less
    // the safety margin and the minimum output allowance (`admissiblePromptTokens`).
    admissiblePromptTokens: { type: "integer", dataClass: "count", required: false },
    inputMessageCount: { type: "integer", dataClass: "count", required: false },
    maxInputMessages: { type: "integer", dataClass: "count", required: false },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["coding-sidecar-gateway-rejection"],
  proofIds: ["coding-sidecar.gateway.rejected.line"],
  releaseImpact: "patch",
});

const CODING_SIDECAR_GATEWAY_TURN_FAILED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-sidecar.gateway.turn-failed",
  category: "gateway",
  owner: "keiko-server",
  emitter: "coding-sidecar-gateway.reportGatewayTurnFailure",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    revision: { type: "integer", dataClass: "count", required: true },
    state: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["running", "paused"],
    },
    failureCode: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["provider-failed", "stream-incomplete", "turn-rejected", "output-exhausted"],
    },
    published: { type: "boolean", dataClass: "closed-enum", required: true },
    publicationReason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "published",
        "event-hub-unavailable",
        "terminal-run",
        "invalid-event",
        "sequence-exhausted",
        "capacity-pressure",
      ],
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["coding-sidecar-gateway-turn-failure"],
  proofIds: ["coding-sidecar.gateway.turn-failed.emitted-line"],
  releaseImpact: "patch",
});

const CODING_SIDECAR_GATEWAY_USAGE_SETTLED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-sidecar.gateway.usage-settled",
  category: "gateway",
  owner: "keiko-server",
  emitter: "coding-sidecar-gateway.logGatewayCompletionUsage",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    completionTokens: { type: "integer", dataClass: "count", required: true },
    promptTokens: { type: "integer", dataClass: "count", required: true },
    promptSource: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["provider-reported", "reserved-estimate"],
    },
    promptSettlementStatus: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["settled", "retained-after-refusal", "unverified", "not-wired"],
    },
    outputBytes: { type: "integer", dataClass: "count", required: true },
    source: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["provider-reported", "streamed-byte-estimate", "output-byte-estimate"],
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["coding-sidecar-gateway-request"],
  proofIds: ["coding-sidecar.gateway.usage-settled.line"],
  releaseImpact: "patch",
});

const CODING_SIDECAR_GATEWAY_OUTCOME_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-sidecar.gateway.outcome",
  category: "gateway",
  owner: "keiko-server",
  emitter: "coding-sidecar-gateway.recordGatewayOutcome",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["accepted", "cancelled", "failed", "output-limit"],
    },
    completionTokens: { type: "integer", dataClass: "count", required: true },
    outputBytes: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["coding-sidecar-gateway-request"],
  proofIds: ["coding-sidecar.gateway.outcome.line"],
  releaseImpact: "patch",
});

type GatewayRejectionEvidence = Partial<{
  readonly expectedToolCount: number;
  readonly receivedToolCount: number;
  readonly unexpectedToolCount: number;
  readonly missingToolCount: number;
  readonly toolMismatchSha256: string;
  readonly estimatedPromptTokens: number;
  readonly maxPromptTokens: number;
  readonly admissiblePromptTokens: number;
  readonly inputMessageCount: number;
  readonly maxInputMessages: number;
}>;

function gatewayRejectionErrorKind(
  reason: CodingSidecarGatewayRejectionReason,
):
  | "invalid-request"
  | "validation-failed"
  | "permission-denied"
  | "authority-denied"
  | "unavailable" {
  if (reason === "capability-missing" || reason === "capability-invalid") {
    return "permission-denied";
  }
  if (
    reason === "origin-not-allowed" ||
    reason === "runtime-prompt-budget-denied" ||
    reason === "spend-budget-exceeded" ||
    reason.startsWith("tool-contract-")
  ) {
    return "authority-denied";
  }
  if (reason.includes("unavailable") || reason === "spend-ledger-unavailable") {
    return "unavailable";
  }
  return reason === "unclassified-rejection" ? "validation-failed" : "invalid-request";
}

/** Body-free: `reason` is closed, `runId` and every `extra` field are counts/ids, never text. */
function logGatewayRejection(
  ctx: RouteContext,
  runId: string | undefined,
  status: number,
  reason: CodingSidecarGatewayRejectionReason,
  evidence: GatewayRejectionEvidence = {},
): void {
  getServerLogger().warn(
    activityLogEvent(
      CODING_SIDECAR_GATEWAY_REJECTED_OPERATION,
      {
        correlationId: correlationIdOrUnknown(ctx.correlationId),
        ...(runId === undefined ? {} : { parentCorrelationId: runId }),
        status,
        errorKind: gatewayRejectionErrorKind(reason),
      },
      {
        reason,
        ...(runId === undefined ? {} : { runId }),
        ...evidence,
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}

// One row per message literal `badRequest`/`validationErrorForChatRequest` actually builds — a
// message change and this table must move together. A future unmatched shape receives the explicit
// `unclassified-rejection` reason instead of borrowing one of these known meanings.
const BAD_REQUEST_MESSAGE_REASONS: readonly {
  readonly test: (message: string) => boolean;
  readonly reason: CodingSidecarGatewayRejectionReason;
}[] = [
  {
    test: (message) =>
      message === "Request body is not valid JSON." ||
      message === "Request body must be a JSON object.",
    reason: "body-not-json",
  },
  {
    test: (message) => message.startsWith("Request body messages exceed profile maxInputMessages"),
    reason: "input-messages-exceeded",
  },
  {
    test: (message) =>
      message.startsWith("Request body estimated prompt tokens exceed profile maxPromptTokens"),
    reason: "prompt-tokens-exceeded",
  },
  {
    test: (message) => message === "Request body tools must be OpenAI-compatible function tools.",
    reason: "tools-not-openai-compatible",
  },
  {
    test: (message) => message === "Request body must include a non-empty messages array.",
    reason: "body-empty-messages",
  },
  {
    test: (message) => message.startsWith("Request body messages must be well-formed"),
    reason: "message-shape-invalid",
  },
  {
    test: (message) =>
      message === "Request body message content included an unsupported content part.",
    reason: "content-part-unsupported",
  },
  {
    test: (message) =>
      message.startsWith("Request body temperature") || message.startsWith("Request body top_p"),
    reason: "invalid-sampling",
  },
];

function badRequestErrorFields(result: RouteResult): {
  readonly code: string | undefined;
  readonly message: string | undefined;
} {
  const error = isRecord(result.body) ? result.body.error : undefined;
  return {
    code: isRecord(error) && typeof error.code === "string" ? error.code : undefined,
    message: isRecord(error) && typeof error.message === "string" ? error.message : undefined,
  };
}

/**
 * Classifies a rejection this file itself built (`badRequest`/`readJsonObject`/invalid-model)
 * into the closed reason vocabulary above by its fixed `code`/message shape.
 */
function classifyBadRequestReason(result: RouteResult): CodingSidecarGatewayRejectionReason {
  const { code, message } = badRequestErrorFields(result);
  if (code === "PAYLOAD_TOO_LARGE") return "request-too-large";
  if (code === "INVALID_MODEL") return "invalid-model";
  if (message === undefined) return "unclassified-rejection";
  return (
    BAD_REQUEST_MESSAGE_REASONS.find(({ test }) => test(message))?.reason ??
    "unclassified-rejection"
  );
}

// Test seam: keeps the future/unknown classification directly provable without inventing a
// production parser branch that does not exist yet.
export function _classifyBadRequestReasonForTests(
  result: RouteResult,
): CodingSidecarGatewayRejectionReason {
  return classifyBadRequestReason(result);
}

function isModelReasoningEffort(value: unknown): value is ModelReasoningEffort {
  return typeof value === "string" && MODEL_REASONING_EFFORT_SET.has(value);
}

export interface OpenCodeGatewayReadinessRegistry {
  readonly claim: (runId: string) => boolean;
  readonly verifyObserved: (runId: string) => void;
  readonly isVerified: (runId: string) => boolean;
  readonly waitForObservedRequest: (runId: string, signal: AbortSignal) => Promise<boolean>;
  /** True only on the first call per run — bounds the adoption-gap diagnostic to one per run. */
  readonly noteAdoptionGapDiagnosed: (runId: string) => boolean;
  readonly clear: (runId: string, preserveVerification?: boolean) => void;
}

export function createOpenCodeGatewayReadinessRegistry(): OpenCodeGatewayReadinessRegistry {
  const observed = new Set<string>();
  const armed = new Set<string>();
  const adoptionGapDiagnosed = new Set<string>();
  const waiters = new Map<string, (result: boolean) => void>();
  const verifyObserved = (runId: string): void => {
    observed.add(runId);
    waiters.get(runId)?.(true);
  };
  return {
    claim: (runId): boolean => {
      if (!armed.delete(runId)) return false;
      verifyObserved(runId);
      return true;
    },
    verifyObserved,
    isVerified: (runId): boolean => observed.has(runId),
    waitForObservedRequest: (runId, signal): Promise<boolean> => {
      if (observed.has(runId)) return Promise.resolve(true);
      if (signal.aborted) return Promise.resolve(false);
      waiters.get(runId)?.(false);
      armed.add(runId);
      return new Promise((resolve) => {
        const settle = (result: boolean): void => {
          signal.removeEventListener("abort", abort);
          if (waiters.get(runId) === settle) waiters.delete(runId);
          if (!result) armed.delete(runId);
          resolve(result);
        };
        const abort = (): void => {
          settle(false);
        };
        waiters.set(runId, settle);
        signal.addEventListener("abort", abort, { once: true });
      });
    },
    noteAdoptionGapDiagnosed: (runId): boolean => {
      if (adoptionGapDiagnosed.has(runId)) return false;
      adoptionGapDiagnosed.add(runId);
      return true;
    },
    clear: (runId, preserveVerification = false): void => {
      if (!preserveVerification) observed.delete(runId);
      armed.delete(runId);
      adoptionGapDiagnosed.delete(runId);
      waiters.get(runId)?.(false);
    },
  };
}

export interface CodingSidecarGatewayChatCompletionRequest {
  readonly model?: string | undefined;
  readonly messages: readonly CodingSidecarGatewayChatMessage[];
  readonly tools?: readonly ToolDefinition[] | undefined;
  readonly stream?: boolean | undefined;
  readonly temperature?: number | undefined;
  readonly top_p?: number | undefined;
}

export interface CodingSidecarGatewayChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCalls?: readonly NormalizedToolCall[] | undefined;
  readonly toolCallId?: string | undefined;
}

export type CodingSidecarGatewayChatFactory = (
  config: GatewayConfig,
  modelId: string,
) => (request: GatewayRequest) => Promise<NormalizedResponse>;

/** A testable stream seam; production defaults to Gateway.chatStream(). */
export type CodingSidecarGatewayChatStreamFactory = (
  config: GatewayConfig,
  modelId: string,
) => (request: GatewayRequest) => AsyncIterable<GatewayStreamChunk>;

/** Local until UiHandlerDeps owns this port (Issue #2256). */
export interface CodingSidecarGatewayCancellationRegistry {
  readonly signalFor: (runId: string) => AbortSignal | undefined;
}

type CodingSidecarGatewayRunOutcome = "accepted" | "cancelled" | "failed" | "output-limit";

/** Content-free, run-scoped accounting only; it must never be a durable request log. */
export interface CodingSidecarGatewayEvidenceAggregator {
  readonly record: (event: {
    readonly runId: string;
    readonly outcome: CodingSidecarGatewayRunOutcome;
    readonly completionTokens: number;
    readonly outputBytes: number;
  }) => void | Promise<void>;
}

interface ResolvedGatewayProfile {
  readonly config: GatewayConfig | undefined;
  readonly gateway: Gateway | undefined;
  readonly modelSource: CodingWorkbenchModelSource;
  readonly result: CodingWorkbenchSidecarGatewayResult;
}

type AvailableGatewayProfile = ResolvedGatewayProfile & {
  readonly config: GatewayConfig;
  readonly gateway: Gateway;
  readonly result: Extract<CodingWorkbenchSidecarGatewayResult, { readonly status: "available" }>;
};

function envEnabled(value: string | undefined): boolean {
  return value !== undefined && ENABLE_TOKENS.has(value.trim().toLowerCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRouteResult(value: unknown): value is RouteResult {
  return isRecord(value) && typeof value.status === "number" && "body" in value;
}

function isCodingSidecarGatewayChatRole(
  value: string,
): value is CodingSidecarGatewayChatMessage["role"] {
  return value === "system" || value === "user" || value === "assistant" || value === "tool";
}

function chatFactoryFor(deps: UiHandlerDeps, gateway: Gateway): CodingSidecarGatewayChatFactory {
  return deps.codingSidecarGatewayChatFactory ?? defaultChatFactoryFor(gateway);
}

function defaultChatFactoryFor(gateway: Gateway): CodingSidecarGatewayChatFactory {
  return (_config, modelId) => {
    return (request: GatewayRequest) =>
      gateway.chat({ ...request, modelId, latencyProfile: "coding-workbench" });
  };
}

function defaultChatStreamFactoryFor(gateway: Gateway): CodingSidecarGatewayChatStreamFactory {
  return (_config, modelId) => {
    return (request: GatewayRequest) =>
      gateway.chatStream({ ...request, modelId, latencyProfile: "coding-workbench" });
  };
}

function chatStreamFactoryFor(
  deps: UiHandlerDeps,
  gateway: Gateway,
): CodingSidecarGatewayChatStreamFactory {
  return deps.codingSidecarGatewayChatStreamFactory ?? defaultChatStreamFactoryFor(gateway);
}

function unavailableError(): RouteResult {
  return {
    status: 503,
    body: errorBody(CODING_SIDECAR_GATEWAY_ERROR_CODE, "Coding sidecar gateway is unavailable."),
  };
}

type ParsedMessagePiece<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "content-part-unsupported" }
  | { readonly kind: "invalid" };

/**
 * OpenAI-compatible content part accepted from the model: `{type:"text", text}` only. A bare
 * single-part prompt still arrives as `content: string`, but when the server sends a multi-part
 * prompt (opencodeHttpClient.ts `promptParts`: the task text plus the issue context as a
 * synthetic part), OpenCode's AI-SDK provider re-shapes the outgoing user message as an OpenAI
 * content-part ARRAY instead (#3390). Every other content-part type (image_url, input_audio,
 * file, or anything unrecognized) is rejected closed, never silently dropped.
 */
function isTextContentPart(
  value: unknown,
): value is { readonly type: "text"; readonly text: string } {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

/**
 * Collapses an accepted OpenAI content-part array to the single string the Model Gateway core
 * consumes, joining parts with a blank line. The synthetic issue-context part is untrusted
 * repository data, so it is kept inside the same user turn it arrived in rather than becoming a
 * second, unaccounted-for message. Part count and total byte size ride on the existing
 * `readJsonObject` request-body budget already enforced before this runs — no new limit is added.
 */
function parseMessageContent(value: unknown): ParsedMessagePiece<string> {
  if (typeof value === "string") return { kind: "ok", value };
  if (!Array.isArray(value) || value.length === 0) return { kind: "invalid" };
  const texts: string[] = [];
  for (const part of value) {
    if (isTextContentPart(part)) {
      texts.push(part.text);
      continue;
    }
    if (isRecord(part) && typeof part.type === "string")
      return { kind: "content-part-unsupported" };
    return { kind: "invalid" };
  }
  return { kind: "ok", value: texts.join("\n\n") };
}

function parseMessageEntry(value: unknown): ParsedMessagePiece<CodingSidecarGatewayChatMessage> {
  const base = parseMessageBase(value);
  if (base.kind !== "ok") return base;
  const continuation = parseMessageContinuation(value, base.value.role);
  if (continuation === undefined) return { kind: "invalid" };
  return { kind: "ok", value: { ...base.value, ...continuation } };
}

function parseMessageBase(
  value: unknown,
): ParsedMessagePiece<Pick<CodingSidecarGatewayChatMessage, "role" | "content">> {
  if (
    !isRecord(value) ||
    typeof value.role !== "string" ||
    !isCodingSidecarGatewayChatRole(value.role)
  ) {
    return { kind: "invalid" };
  }
  const content =
    value.content === null &&
    value.role === "assistant" &&
    parseContinuationToolCalls(value.tool_calls) !== undefined
      ? { kind: "ok" as const, value: "" }
      : parseMessageContent(value.content);
  if (content.kind !== "ok") return content;
  return { kind: "ok", value: { role: value.role, content: content.value } };
}

function parseMessageContinuation(
  value: unknown,
  role: CodingSidecarGatewayChatMessage["role"],
): Pick<CodingSidecarGatewayChatMessage, "toolCalls" | "toolCallId"> | undefined {
  if (!isRecord(value)) return undefined;
  const toolCalls = parseContinuationToolCalls(value.tool_calls);
  const toolCallId = typeof value.tool_call_id === "string" ? value.tool_call_id : undefined;
  if (invalidAssistantToolCalls(value.tool_calls, toolCalls, role)) return undefined;
  if (invalidToolCallId(value.tool_call_id, toolCallId, role)) return undefined;
  return {
    ...(toolCalls === undefined ? {} : { toolCalls }),
    ...(toolCallId === undefined ? {} : { toolCallId }),
  };
}

function invalidAssistantToolCalls(
  supplied: unknown,
  toolCalls: readonly NormalizedToolCall[] | undefined,
  role: CodingSidecarGatewayChatMessage["role"],
): boolean {
  return supplied !== undefined && (toolCalls === undefined || role !== "assistant");
}

function invalidToolCallId(
  supplied: unknown,
  toolCallId: string | undefined,
  role: CodingSidecarGatewayChatMessage["role"],
): boolean {
  return supplied !== undefined && (toolCallId === undefined || role !== "tool");
}

function parseContinuationToolCalls(value: unknown): readonly NormalizedToolCall[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const calls: NormalizedToolCall[] = [];
  for (const call of value) {
    const parsed = parseContinuationToolCall(call);
    if (parsed === undefined) return undefined;
    calls.push(parsed);
  }
  return calls;
}

function parseContinuationToolCall(value: unknown): NormalizedToolCall | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || value.type !== "function")
    return undefined;
  const fn = value.function;
  if (!isRecord(fn) || typeof fn.name !== "string" || typeof fn.arguments !== "string") {
    return undefined;
  }
  try {
    const argumentsValue: unknown = JSON.parse(fn.arguments);
    return isRecord(argumentsValue)
      ? { id: value.id, name: fn.name, arguments: argumentsValue }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Distinguishes the two 400 reasons an unusable `messages` array can hand back (#3390): `undefined`
 * for the array being missing/empty (`body-empty-messages`), a `RouteResult` when entries were
 * present but at least one was unparsable — `content-part-unsupported` for a recognized-but-closed
 * content part, `message-shape-invalid` (carrying only the total entry COUNT, never any entry's
 * content) for every other malformed shape.
 */
function parseMessages(
  value: unknown,
): readonly CodingSidecarGatewayChatMessage[] | RouteResult | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const messages: CodingSidecarGatewayChatMessage[] = [];
  for (const entry of value) {
    const parsed = parseMessageEntry(entry);
    if (parsed.kind === "content-part-unsupported") {
      return badRequest("Request body message content included an unsupported content part.");
    }
    if (parsed.kind === "invalid") {
      return badRequest(
        `Request body messages must be well-formed chat messages (entries: ${String(value.length)}).`,
      );
    }
    messages.push(parsed.value);
  }
  return messages;
}

function badRequest(message: string): RouteResult {
  return { status: 400, body: errorBody("BAD_REQUEST", message) };
}

function isOpenAiCompatibleFunctionToolFunction(value: unknown): value is {
  readonly name: string;
  readonly description?: string | undefined;
  readonly parameters: Record<string, unknown>;
} {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    (value.description === undefined || typeof value.description === "string") &&
    isRecord(value.parameters)
  );
}

function parseTools(value: unknown): readonly ToolDefinition[] | RouteResult | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return badRequest("Request body tools must be OpenAI-compatible function tools.");
  }
  const tools: ToolDefinition[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      entry.type !== "function" ||
      !isOpenAiCompatibleFunctionToolFunction(entry.function)
    ) {
      return badRequest("Request body tools must be OpenAI-compatible function tools.");
    }
    tools.push({
      name: entry.function.name,
      description: entry.function.description ?? "",
      parameters: entry.function.parameters,
    });
  }
  return tools;
}

function isMatchingModelAlias(
  model: string | undefined,
  modelAlias: string,
  runtimeAuthenticated: boolean,
): boolean {
  return runtimeAuthenticated
    ? model === OPENCODE_RUNTIME_MODEL_ALIAS
    : model === undefined || model === modelAlias;
}

/**
 * The exact managed set is advertised through the catalog, never forwarded raw: the model-gateway
 * bridge (packages/keiko-model-gateway/src/toolCatalogBridge.ts) derives its actual `tools` from a
 * `toolCatalog` projection and rejects any request that also carries a handwritten `tools` field
 * alongside a "bound" advertisement. `isExactManagedToolSet` is the same trust-boundary check
 * `runtimeGatewayAdmissionResponse` already applies to the incoming sidecar request below, so the
 * advertisement and the admission gate are provably the same source (ADR-0175 D1/D4).
 */
/** The per-request facts the tool-catalog advertisement is minted from. */
interface GatewayToolCatalogOffer {
  readonly coverage: OpenCodeGatewayHandlerCoverage | undefined;
  readonly offerLifetimeMs: number;
}

function toolCatalogFor(
  tools: readonly ToolDefinition[] | undefined,
  offer: GatewayToolCatalogOffer,
): GatewayCallRequest["toolCatalog"] {
  return isExactManagedToolSet(tools)
    ? createOpenCodeGatewayToolCatalogAdvertisement(
        Date.now(),
        offer.coverage,
        offer.offerLifetimeMs,
      )
    : undefined;
}

function toolRequestFields(
  parsed: CodingSidecarGatewayChatCompletionRequest,
  offer: GatewayToolCatalogOffer,
): Pick<GatewayCallRequest, "toolCatalog"> {
  const toolCatalog = toolCatalogFor(parsed.tools, offer);
  if (toolCatalog !== undefined) return { toolCatalog };
  return {};
}

const OPENCODE_OPTIONAL_TOOL_NAMES: ReadonlySet<string> = new Set<OpenCodeOptionalToolName>([
  "keiko_research_fetch",
  "keiko_skill_discover",
  "keiko_skill",
  "keiko_child_agent",
]);

/**
 * #3384 wave-3 W3-1 redirect (reviewer 3941816393 / B1): `createOpenCodeGatewayToolCatalogAdvertisement`'s
 * `offered`/`readiness`/`handlerSetDigest` previously reflected the catalog's static declarations
 * only -- every tool always "ready" regardless of whether its handler is actually bound for this run
 * (#3413-AC1/#3414-AC4/AC9). `runtimeCapabilityAuthenticator(deps)?.unavailableOptionalTools` is the
 * real per-run fact (`productionManagedWorktreeTools.ts`'s `deriveOptionalToolAvailability`, wired
 * through `productionCodingRuntimeResolver.ts` the same way `reservePromptTokens`/
 * `settlePromptTokens` already are). The catalog's thirteen mandatory tools are never gated by this
 * check -- only the three optional tools (`keiko_research_fetch`/`keiko_skill`/`keiko_child_agent`)
 * can ever be reported unavailable -- so a structural (no-coverage) first pass is used only to learn
 * the compiled projection's real tool ids/aliases, never to decide readiness itself. Absent
 * capability info (no run bound, or an older composition that has not wired this yet) preserves the
 * advertisement's prior, structural-only behaviour byte-for-byte.
 */
function resolveToolCatalogHandlerCoverage(
  deps: UiHandlerDeps,
  runId: string,
  correlationId: string | undefined,
): OpenCodeGatewayHandlerCoverage | undefined {
  const unavailable = runtimeCapabilityAuthenticator(deps)?.unavailableOptionalTools?.(runId);
  if (unavailable === undefined) return undefined;
  const unavailableOptionalTools = [...OPENCODE_OPTIONAL_TOOL_NAMES]
    .filter((name): name is OpenCodeOptionalToolName =>
      unavailable.has(name as OpenCodeOptionalToolName),
    )
    .sort(compareStrings);
  const offeredOptionalTools = [...OPENCODE_OPTIONAL_TOOL_NAMES]
    .filter(
      (name): name is OpenCodeOptionalToolName =>
        !unavailable.has(name as OpenCodeOptionalToolName),
    )
    .sort(compareStrings);
  const coverage = createCanonicalOpenCodeHandlerCoverage(unavailable);
  getServerLogger().info(
    activityLogEvent(
      CODING_SIDECAR_GATEWAY_TOOL_AVAILABILITY_OPERATION,
      { correlationId: correlationIdOrUnknown(correlationId) },
      {
        runId,
        handlerSetDigest: coverage.handlerSetDigest,
        unavailableOptionalTools,
        unavailableOptionalToolCount: unavailableOptionalTools.length,
        offeredOptionalTools,
        offeredOptionalToolCount: offeredOptionalTools.length,
        completeness: "complete",
        loss: "none",
      },
    ),
  );
  return coverage;
}

function buildChatRequest(
  parsed: CodingSidecarGatewayChatCompletionRequest,
  modelAlias: string,
  cancellationSignal: AbortSignal,
  maxOutputTokens: number,
  correlationId: string | undefined,
  reasoningEffort: ModelReasoningEffort | undefined,
  toolCatalogOffer: GatewayToolCatalogOffer,
): GatewayCallRequest {
  return {
    modelId: modelAlias,
    messages: parsed.messages,
    ...toolRequestFields(parsed, toolCatalogOffer),
    ...(parsed.temperature === undefined ? {} : { temperature: parsed.temperature }),
    ...(parsed.top_p === undefined ? {} : { topP: parsed.top_p }),
    cancellationSignal,
    maxOutputTokens,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    logContext: { correlationId },
  };
}

function parseChatRequest(
  body: Record<string, unknown>,
): CodingSidecarGatewayChatCompletionRequest | RouteResult | undefined {
  const messages = parseMessages(body.messages);
  if (messages === undefined) {
    return undefined;
  }
  if (isRouteResult(messages)) {
    return messages;
  }
  const tools = parseTools(body.tools);
  if (isRouteResult(tools)) {
    return tools;
  }
  return {
    ...(typeof body.model === "string" && body.model.length > 0 ? { model: body.model } : {}),
    messages,
    ...(tools === undefined ? {} : { tools }),
    ...(typeof body.stream === "boolean" ? { stream: body.stream } : {}),
    ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === "number" ? { top_p: body.top_p } : {}),
  };
}

function openAiResponse(modelId: string, response: NormalizedResponse): RouteResult {
  return {
    status: 200,
    body: {
      id: `chatcmpl-${randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: response.content,
            ...(response.toolCalls.length === 0
              ? {}
              : { tool_calls: openAiToolCalls(response.toolCalls) }),
          },
          finish_reason: response.finishReason,
        },
      ],
      usage: {
        prompt_tokens: response.usage.promptTokens,
        completion_tokens: response.usage.completionTokens,
        total_tokens: response.usage.promptTokens + response.usage.completionTokens,
      },
    },
  };
}

function openAiToolCalls(calls: readonly NormalizedToolCall[]): readonly Record<string, unknown>[] {
  return calls.map((call, index) => ({
    index,
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  }));
}

/** Single source for the `KEIKO_CODING_SIDECAR_DISABLED` kill-switch token semantics. */
export function codingSidecarDisabledByPolicy(env: UiHandlerDeps["env"]): boolean {
  return envEnabled(env[CODING_SIDECAR_DISABLED_ENV]);
}

function sidecarPolicyDisabled(deps: UiHandlerDeps): boolean {
  return codingSidecarDisabledByPolicy(deps.env);
}

function currentModelSource(deps: UiHandlerDeps): CodingWorkbenchModelSource {
  return (
    deps.codingSidecarGatewayModelSourceResolver?.() ??
    deps.codingSidecarGatewayModelSource ??
    "keiko-model-gateway"
  );
}

function resolveGatewayProfile(
  deps: UiHandlerDeps,
  selectedModelId?: string,
  verificationAtMs?: number,
): ResolvedGatewayProfile {
  const config = currentGatewayConfig(deps);
  const gateway = config === undefined ? undefined : currentGateway(deps);
  const modelSource = currentModelSource(deps);
  const result = resolveCodingSafeSidecarGatewayProfile(config, {
    deploymentPolicyDisabled: sidecarPolicyDisabled(deps),
    modelSource,
    // F-01: the projection this route publishes must carry the last live-probe outcome, not just
    // the stored config. The admission decision below is deliberately unchanged: a stale negative
    // probe must not lock out a gateway that answers now — a request that cannot be served fails on
    // its own live error, while the projection is what a surface is allowed to CLAIM.
    gatewayVerification: currentGatewayVerification(deps),
    ...(selectedModelId === undefined ? {} : { modelId: selectedModelId }),
    // An admitted run's calls judge the tool-calling proof as of its admission (F73); the profile
    // projection and every new run judge it now.
    ...(verificationAtMs === undefined ? {} : { verificationAtMs }),
  });
  return { config, gateway, modelSource, result };
}

function cancellationRegistry(
  deps: UiHandlerDeps,
): CodingSidecarGatewayCancellationRegistry | undefined {
  return deps.codingSidecarGatewayCancellationRegistry;
}

function evidenceAggregator(
  deps: UiHandlerDeps,
): CodingSidecarGatewayEvidenceAggregator | undefined {
  return deps.codingSidecarGatewayEvidenceAggregator;
}

function emitGatewayEvidenceAggregationDiagnostic(deps: UiHandlerDeps, runId: string): void {
  emitServerDiagnostic(deps.diagnostics, {
    correlationId: runId,
    timestamp: new Date(Date.now()).toISOString(),
    operation: CODING_SIDECAR_GATEWAY_ROUTE,
    source: "coding-sidecar-gateway.evidence-aggregation",
    errorClass: "CodingSidecarGatewayEvidenceAggregationFailure",
    message: "sidecar-gateway-evidence-aggregation-failed",
  });
}

function recordGatewayOutcome(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  runId: string,
  outcome: CodingSidecarGatewayRunOutcome,
  completionTokens: number,
  outputBytes: number,
): void {
  getServerLogger().info(
    activityLogEvent(
      CODING_SIDECAR_GATEWAY_OUTCOME_OPERATION,
      { correlationId: correlationIdOrUnknown(ctx.correlationId), parentCorrelationId: runId },
      { runId, outcome, completionTokens, outputBytes, completeness: "complete", loss: "none" },
    ),
  );
  try {
    void Promise.resolve(
      evidenceAggregator(deps)?.record({ runId, outcome, completionTokens, outputBytes }),
    ).catch(() => {
      emitGatewayEvidenceAggregationDiagnostic(deps, runId);
    });
  } catch {
    emitGatewayEvidenceAggregationDiagnostic(deps, runId);
  }
}

function outputByteBudget(maxOutputTokens: number): number {
  return maxOutputTokens * OUTPUT_BYTES_PER_TOKEN_LIMIT;
}

function incrementalUtf8ByteCount(
  token: string,
  previousEndedWithHighSurrogate: boolean,
): { readonly bytes: number; readonly endsWithHighSurrogate: boolean } {
  if (token.length === 0) {
    return { bytes: 0, endsWithHighSurrogate: previousEndedWithHighSurrogate };
  }
  // codePointAt reports the trailing code unit itself at these positions unless the token starts
  // a full surrogate pair, whose combined code point falls outside both surrogate ranges anyway.
  const firstCodeUnit = token.codePointAt(0) ?? 0;
  const lastCodeUnit = token.codePointAt(token.length - 1) ?? 0;
  const joinsSplitSurrogatePair =
    previousEndedWithHighSurrogate && firstCodeUnit >= 0xdc00 && firstCodeUnit <= 0xdfff;
  return {
    // Buffer encodes each isolated surrogate as a three-byte replacement. When
    // provider chunks split a valid pair, the accumulated string encodes it as
    // one four-byte scalar, so remove the two-byte replacement overcount.
    bytes: Buffer.byteLength(token, "utf8") - (joinsSplitSurrogatePair ? 2 : 0),
    endsWithHighSurrogate: lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff,
  };
}

function outputMetrics(response: NormalizedResponse): {
  readonly completionTokens: number;
  readonly outputBytes: number;
} {
  // Include every provider-produced output field, including tool arguments and
  // structured output, rather than counting only visible assistant prose.
  const output = JSON.stringify({
    content: response.content,
    toolCalls: response.toolCalls,
    structuredOutput: response.structuredOutput,
  });
  return {
    completionTokens: response.usage.completionTokens,
    outputBytes: Buffer.byteLength(output, "utf8"),
  };
}

function exceedsOutputBudget(
  metrics: { readonly completionTokens: number; readonly outputBytes: number },
  maxOutputTokens: number,
): boolean {
  return (
    metrics.completionTokens > maxOutputTokens ||
    metrics.outputBytes > outputByteBudget(maxOutputTokens)
  );
}

function samplingValidationMessage(
  parsed: CodingSidecarGatewayChatCompletionRequest,
): string | undefined {
  const [issue] = validateGatewaySamplingParameters({
    temperature: parsed.temperature,
    topP: parsed.top_p,
  });
  if (issue === undefined) {
    return undefined;
  }
  return `Request body ${issue.message.replace("topP", "top_p")}.`;
}

function promptTokenEstimate(
  parsed: CodingSidecarGatewayChatCompletionRequest,
  accounting: ModelTokenAccounting | undefined,
): number {
  return countGatewayPromptTokens(parsed, accounting);
}

function promptTokenAccounting(profile: AvailableGatewayProfile): ModelTokenAccounting | undefined {
  return findConfiguredCapability(profile.config, profile.result.modelAlias)?.tokenAccounting;
}

interface OpenAiCompatibleContextOverflowBody {
  readonly error: {
    readonly code: "context_length_exceeded";
    readonly message: string;
  };
}

function openAiCompatibleContextOverflowBody(message: string): OpenAiCompatibleContextOverflowBody {
  return { error: { code: "context_length_exceeded", message } };
}

function contextOverflowRequest(message: string): RouteResult {
  return { status: 400, body: openAiCompatibleContextOverflowBody(message) };
}

function budgetValidationError(
  parsed: CodingSidecarGatewayChatCompletionRequest,
  runMetadata: CodingWorkbenchSidecarGatewayRunMetadata,
  estimatedPromptTokens: number,
): RouteResult | undefined {
  if (parsed.messages.length > runMetadata.maxInputMessages) {
    return contextOverflowRequest(
      `Request body messages exceed profile maxInputMessages (${String(runMetadata.maxInputMessages)}).`,
    );
  }
  const admissible = admissiblePromptTokens(runMetadata);
  if (estimatedPromptTokens > admissible) {
    return contextOverflowRequest(
      `Request body estimated prompt tokens exceed profile maxPromptTokens (${String(runMetadata.maxPromptTokens)}) less the reserved output allowance (${String(admissible)} admissible).`,
    );
  }
  return undefined;
}

async function readChatCompletionRequest(
  ctx: RouteContext,
  maxRequestBytes: number,
): Promise<CodingSidecarGatewayChatCompletionRequest | RouteResult> {
  const body = await readJsonObject(ctx.req, maxRequestBytes);
  if (isRouteResult(body)) {
    return body;
  }
  if (!isRecord(body)) {
    return badRequest("Request body must be a JSON object.");
  }
  const parsed = parseChatRequest(body);
  if (parsed === undefined) {
    return badRequest("Request body must include a non-empty messages array.");
  }
  return parsed;
}

function validationErrorForChatRequest(
  parsed: CodingSidecarGatewayChatCompletionRequest | RouteResult,
  modelAlias: string,
  runMetadata: CodingWorkbenchSidecarGatewayRunMetadata,
  runtimeAuthenticated: boolean,
  estimatedPromptTokens: number,
): RouteResult | undefined {
  if (isRouteResult(parsed)) {
    return parsed;
  }
  const invalidSamplingMessage = samplingValidationMessage(parsed);
  if (invalidSamplingMessage !== undefined) {
    return badRequest(invalidSamplingMessage);
  }
  const invalidBudget = budgetValidationError(parsed, runMetadata, estimatedPromptTokens);
  if (invalidBudget !== undefined) return invalidBudget;
  if (!isMatchingModelAlias(parsed.model, modelAlias, runtimeAuthenticated)) {
    return {
      status: 400,
      body: errorBody("INVALID_MODEL", "Request model does not match the selected profile."),
    };
  }
  return undefined;
}

function gatewayDiagnosticCorrelation(
  ctx: RouteContext,
  runId: string,
): { readonly correlationId: string; readonly parentCorrelationId?: string } {
  const correlationId = ctx.correlationId ?? runId;
  return correlationId === runId
    ? { correlationId }
    : { correlationId, parentCorrelationId: runId };
}

function emitGatewayFailureDiagnostic(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  error: unknown,
  runId: string,
): void {
  emitServerDiagnostic(
    deps.diagnostics,
    serverDiagnosticFromError({
      ...gatewayDiagnosticCorrelation(ctx, runId),
      operation: CODING_SIDECAR_GATEWAY_ROUTE,
      source: "coding-sidecar-gateway.chat",
      error,
      redact: (message) => String(deps.redactor(message)),
    }),
  );
}

function reportGatewayTurnFailure(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  runId: string,
  failureCode: CodingWorkbenchTurnFailureCode,
): void {
  const snapshot = deps.codingRuntimeOrchestrator?.getSnapshot(runId);
  if (snapshot?.state !== "running" && snapshot?.state !== "paused") return;
  const publicationReason = gatewayTurnFailurePublication(deps, runId, snapshot, failureCode);
  logGatewayTurnFailure(
    ctx,
    runId,
    snapshot.revision,
    snapshot.state,
    failureCode,
    publicationReason,
  );
}

type GatewayFailurePublicationReason =
  | "published"
  | "event-hub-unavailable"
  | "invalid-event"
  | "sequence-exhausted"
  | "capacity-pressure"
  | "terminal-run";

function gatewayTurnFailurePublication(
  deps: UiHandlerDeps,
  runId: string,
  snapshot: CodingWorkbenchRuntimeSnapshot,
  failureCode: CodingWorkbenchTurnFailureCode,
): GatewayFailurePublicationReason {
  const publication = deps.codingRuntimeEventHub?.publishTurnFailure(
    runId,
    snapshot.state,
    snapshot.revision,
    failureCode,
  );
  const publicationReason =
    publication?.ok === true ? "published" : (publication?.reason ?? "event-hub-unavailable");
  return publicationReason;
}

function logGatewayTurnFailure(
  ctx: RouteContext,
  runId: string,
  revision: number,
  state: "running" | "paused",
  failureCode: CodingWorkbenchTurnFailureCode,
  publicationReason: GatewayFailurePublicationReason,
): void {
  getServerLogger().warn(
    activityLogEvent(
      CODING_SIDECAR_GATEWAY_TURN_FAILED_OPERATION,
      {
        ...gatewayDiagnosticCorrelation(ctx, runId),
        errorKind: failureCode === "turn-rejected" ? "validation-failed" : "unavailable",
      },
      {
        runId,
        revision,
        state,
        failureCode,
        published: publicationReason === "published",
        publicationReason,
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}

function gatewayTurnFailureCode(error: unknown): CodingWorkbenchTurnFailureCode {
  if (error instanceof ContextOverflowError || error instanceof ModelRefusalError)
    return "turn-rejected";
  if (error instanceof ProviderOutputExhaustedError) return "output-exhausted";
  if (
    error instanceof TimeoutError ||
    error instanceof TransportError ||
    (error instanceof ProviderError && error.httpStatus === 200)
  )
    return "stream-incomplete";
  return "provider-failed";
}

function gatewayStreamFailureCode(error: unknown): CodingWorkbenchTurnFailureCode {
  if (gatewaySpendRejectionReason(error) !== undefined) return "turn-rejected";
  if (error instanceof ContextOverflowError || error instanceof ModelRefusalError)
    return "turn-rejected";
  if (error instanceof ProviderOutputExhaustedError) return "output-exhausted";
  if (
    error instanceof AuthenticationError ||
    error instanceof RateLimitError ||
    error instanceof CircuitOpenError ||
    (error instanceof ProviderError && error.httpStatus !== 200)
  )
    return "provider-failed";
  return "stream-incomplete";
}

/**
 * A mid-stream failure aborts an in-flight coding turn. Before this the cause went into a bare
 * `catch {}` — the pattern AGENTS.md §7 forbids — leaving `settleGatewayStreamError` to emit the SSE
 * error frame with nothing recorded anywhere, on the coding path. The frame and the run outcome are
 * unchanged; only the redacted cause is added, keyed by the request and linked to its run,
 * separated from the pre-stream failure by `source` so an operator can tell "the stream never opened" from "the
 * stream died after N deltas". `partialUsage` rides along through `serverDiagnosticFromError`, so an
 * interrupted turn's accumulated token counts stay visible instead of vanishing with the error.
 */
function emitGatewayStreamFailureDiagnostic(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  error: unknown,
  runId: string,
): void {
  emitServerDiagnostic(
    deps.diagnostics,
    serverDiagnosticFromError({
      ...gatewayDiagnosticCorrelation(ctx, runId),
      operation: CODING_SIDECAR_GATEWAY_ROUTE,
      source: "coding-sidecar-gateway.stream",
      error,
      summary: "The coding sidecar gateway stream failed mid-response.",
      redact: (message) => String(deps.redactor(message)),
    }),
  );
}

interface RuntimeCapabilityAuthenticator {
  readonly authenticate: (capability: string, audience: "model-gateway" | "tool-facade") => unknown;
  readonly reservePromptTokens?:
    ((capability: string, promptTokens: number) => unknown) | undefined;
  readonly settlePromptTokens?:
    | ((capability: string, reservedPromptTokens: number, actualPromptTokens: number) => unknown)
    | undefined;
  // #3384 wave-3 W3-1 redirect (reviewer 3941816393 / B1): the real per-run fact behind the
  // outgoing tool-catalog advertisement's readiness (#3413-AC1/#3414-AC4/AC9). `undefined` for a
  // runId this capability has no record of (or an authenticator that predates this wiring)
  // preserves the advertisement's prior, structural-only behaviour.
  readonly unavailableOptionalTools?:
    ((runId: string) => ReadonlySet<OpenCodeOptionalToolName> | undefined) | undefined;
}

type RuntimeAdapterKind = "model-gateway-sidecar" | "codex-cli-adapter";

function runtimeCapabilityAuthenticator(
  deps: UiHandlerDeps,
): RuntimeCapabilityAuthenticator | undefined {
  return deps.runtimeCapabilityAuthenticator;
}

interface AuthenticatedRuntimeBinding {
  readonly runId: string;
  readonly adapterKind?: RuntimeAdapterKind | undefined;
  readonly modelProfileId?: string | undefined;
  readonly reasoningEffort?: ModelReasoningEffort | undefined;
  // When the run was admitted (its capability issued): a sidecar call judges the model's
  // tool-calling proof as of this instant, so a proof that ages out mid-run cannot strand the run
  // (coding run 24, F73).
  readonly admittedAtMs?: number | undefined;
}

function authenticatedRuntimeBinding(value: unknown): AuthenticatedRuntimeBinding | undefined {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.binding)) return undefined;
  if (typeof value.binding.runId !== "string" || value.binding.runId.length === 0) return undefined;
  return {
    runId: value.binding.runId,
    ...optionalBindingFields(value.binding),
    ...(isAdmissionInstant(value.issuedAtMs) ? { admittedAtMs: value.issuedAtMs } : {}),
  };
}

function optionalBindingFields(
  binding: Readonly<Record<string, unknown>>,
): Omit<AuthenticatedRuntimeBinding, "runId" | "admittedAtMs"> {
  const adapterKind = runtimeAdapterKind(binding.adapterKind);
  const effort = binding.reasoningEffort;
  return {
    ...(adapterKind === undefined ? {} : { adapterKind }),
    ...(typeof binding.modelProfileId === "string"
      ? { modelProfileId: binding.modelProfileId }
      : {}),
    ...(isModelReasoningEffort(effort) ? { reasoningEffort: effort } : {}),
  };
}

function isAdmissionInstant(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function runtimeAdapterKind(value: unknown): RuntimeAdapterKind | undefined {
  return value === "model-gateway-sidecar" || value === "codex-cli-adapter" ? value : undefined;
}

function promptReservationRunId(value: unknown): string | undefined {
  if (!isRecord(value) || value.ok !== true) return undefined;
  return typeof value.runId === "string" && value.runId.length > 0 ? value.runId : undefined;
}

function gatewayReadinessRegistry(
  deps: UiHandlerDeps,
): OpenCodeGatewayReadinessRegistry | undefined {
  return deps.openCodeGatewayReadinessRegistry;
}

function hasOrigin(ctx: RouteContext): boolean {
  return ctx.req.headers.origin !== undefined;
}

function bearerCapability(ctx: RouteContext): string | undefined {
  const value = ctx.req.headers.authorization;
  if (typeof value !== "string" || !value.startsWith("Bearer ")) return undefined;
  const capability = value.slice("Bearer ".length);
  return capability.length > 0 ? capability : undefined;
}

function isExactManagedToolSet(tools: readonly ToolDefinition[] | undefined): boolean {
  return hasExactOpenCodeVisibleToolContract(tools);
}

function isAdmittedManagedToolSet(
  tools: readonly ToolDefinition[] | undefined,
  registry: OpenCodeGatewayReadinessRegistry | undefined,
  runId: string,
): boolean {
  return (
    isExactManagedToolSet(tools) || (tools === undefined && registry?.isVerified(runId) === true)
  );
}

function isRuntimeReadinessProbe(parsed: CodingSidecarGatewayChatCompletionRequest): boolean {
  const readiness = parsed.messages.at(-1);
  return (
    readiness?.role === "user" &&
    readiness.content === OPENCODE_RUNTIME_READINESS_PROMPT &&
    parsed.messages.slice(0, -1).every((message) => message.role === "system")
  );
}

function toolContractRejectionReason(tools: readonly ToolDefinition[] | undefined): {
  readonly code: string;
  readonly reason: CodingSidecarGatewayRejectionReason;
} {
  if (tools === undefined) {
    return { code: "CODING_GATEWAY_TOOL_CONTRACT_MISSING", reason: "tool-contract-missing" };
  }
  if (tools.length === 0) {
    return { code: "CODING_GATEWAY_TOOL_CONTRACT_EMPTY", reason: "tool-contract-empty" };
  }
  return { code: "CODING_GATEWAY_TOOL_CONTRACT_DRIFT", reason: "tool-contract-drift" };
}

/**
 * Identifiers only — the mismatching tool NAMES, never a schema or a body — so the activity-log
 * line this feeds stays body-free (AGENTS.md §8) while still naming exactly which tools drifted.
 */
function toolNameSetDigest(names: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update("keiko.coding-sidecar.tool-mismatch.v1\0");
  for (const name of [...names].sort(compareStrings)) hash.update(`${String(name.length)}:${name}`);
  return hash.digest("hex");
}

function toolContractMismatch(
  tools: readonly ToolDefinition[] | undefined,
): GatewayRejectionEvidence {
  const expected = new Set<string>(OPENCODE_MODEL_VISIBLE_TOOL_NAMES);
  const received = new Set(tools?.map((tool) => tool.name) ?? []);
  const unexpected = [...received].filter((name) => !expected.has(name));
  const missing = [...expected].filter((name) => !received.has(name));
  return {
    expectedToolCount: expected.size,
    receivedToolCount: received.size,
    unexpectedToolCount: unexpected.length,
    missingToolCount: missing.length,
    toolMismatchSha256: toolNameSetDigest([...unexpected, "--missing--", ...missing]),
  };
}

function emitGatewayToolContractDiagnostic(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  runId: string,
  tools: readonly ToolDefinition[] | undefined,
): void {
  const { code, reason } = toolContractRejectionReason(tools);
  emitServerDiagnostic(deps.diagnostics, {
    correlationId: ctx.correlationId ?? UNKNOWN_CORRELATION_ID,
    parentCorrelationId: runId,
    timestamp: new Date(Date.now()).toISOString(),
    operation: CODING_SIDECAR_GATEWAY_ROUTE,
    source: "coding-sidecar-gateway.tool-contract",
    errorClass: "CodingSidecarGatewayToolContractRejection",
    message: "coding-sidecar-gateway-tool-contract-rejected",
    code,
  });
  logGatewayRejection(ctx, runId, 403, reason, toolContractMismatch(tools));
  reportGatewayTurnFailure(ctx, deps, runId, "turn-rejected");
}

/**
 * True when a long managed-tool-set history never invoked one governed keiko_* tool: the model is
 * burning turns without adopting the projected suite. Question/todowrite calls do not count as
 * adoption — a planning-only loop is the same operator-facing gap.
 */
function hasToolAdoptionGapFingerprint(
  messages: readonly CodingSidecarGatewayChatMessage[],
): boolean {
  if (messages.length < TOOL_ADOPTION_GAP_MESSAGE_THRESHOLD) return false;
  return !messages.some(
    (message) =>
      message.toolCalls?.some((call) => call.name.startsWith(GOVERNED_TOOL_NAME_PREFIX)) === true,
  );
}

/**
 * Diagnostic only — the request keeps flowing; fixed labels only, never message content. One
 * record per run: a stuck planning loop keeps matching the fingerprint on every request, and the
 * registry mark keeps that from flooding the operator log (a missing registry never suppresses).
 */
function noteToolAdoptionGap(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  runId: string,
  messages: readonly CodingSidecarGatewayChatMessage[],
): void {
  if (!hasToolAdoptionGapFingerprint(messages)) return;
  if (gatewayReadinessRegistry(deps)?.noteAdoptionGapDiagnosed(runId) === false) return;
  emitServerDiagnostic(deps.diagnostics, {
    correlationId: ctx.correlationId ?? UNKNOWN_CORRELATION_ID,
    timestamp: new Date(Date.now()).toISOString(),
    operation: CODING_SIDECAR_GATEWAY_ROUTE,
    source: "coding-sidecar-gateway.tool-adoption",
    errorClass: "CodingSidecarGatewayToolAdoptionGap",
    message: "coding-sidecar-gateway-tool-adoption-gap",
    code: "CODING_GATEWAY_TOOL_ADOPTION_GAP",
  });
}

function forbiddenGatewayRequest(): RouteResult {
  return { status: 403, body: errorBody("FORBIDDEN", "Coding sidecar gateway request is denied.") };
}

function unauthorizedGatewayRequest(): RouteResult {
  return {
    status: 401,
    body: errorBody("UNAUTHORIZED", "Coding sidecar gateway authentication failed."),
  };
}

interface AuthenticatedGatewayRequest {
  readonly runtimeAuthenticated: boolean;
  readonly runId: string;
  readonly capability: string;
  readonly adapterKind?: RuntimeAdapterKind | undefined;
  readonly modelProfileId?: string | undefined;
  readonly reasoningEffort?: ModelReasoningEffort | undefined;
  readonly admittedAtMs?: number | undefined;
}

// The optional facts a runtime capability carries onto the authenticated request.
function runtimeBindingFields(
  binding: AuthenticatedRuntimeBinding,
): Omit<AuthenticatedGatewayRequest, "runtimeAuthenticated" | "runId" | "capability"> {
  return {
    ...(binding.adapterKind === undefined ? {} : { adapterKind: binding.adapterKind }),
    ...(binding.modelProfileId === undefined ? {} : { modelProfileId: binding.modelProfileId }),
    ...(binding.reasoningEffort === undefined ? {} : { reasoningEffort: binding.reasoningEffort }),
    ...(binding.admittedAtMs === undefined ? {} : { admittedAtMs: binding.admittedAtMs }),
  };
}

function authenticateGatewayRequest(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): AuthenticatedGatewayRequest | RouteResult {
  if (hasOrigin(ctx)) {
    // No runId yet — this refusal happens before capability authentication resolves one.
    logGatewayRejection(ctx, undefined, 403, "origin-not-allowed");
    return forbiddenGatewayRequest();
  }
  const authenticator = runtimeCapabilityAuthenticator(deps);
  const capability = bearerCapability(ctx);
  if (authenticator === undefined) {
    // No runId yet — capability authentication never ran.
    logGatewayRejection(ctx, undefined, 401, "capability-authenticator-unavailable");
    return unauthorizedGatewayRequest();
  }
  if (capability === undefined) {
    logGatewayRejection(ctx, undefined, 401, "capability-missing");
    return unauthorizedGatewayRequest();
  }
  const binding = authenticatedRuntimeBinding(
    authenticator.authenticate(capability, "model-gateway"),
  );
  if (binding === undefined) {
    // No runId available — the presented capability failed to bind to a runtime.
    logGatewayRejection(ctx, undefined, 401, "capability-invalid");
    return unauthorizedGatewayRequest();
  }
  // Runtime launch wires the readiness registry. Other callers still require the
  // same bound bearer, but do not claim the one-shot OpenCode readiness challenge.
  return {
    runtimeAuthenticated:
      binding.adapterKind === "model-gateway-sidecar" ||
      gatewayReadinessRegistry(deps) !== undefined,
    runId: binding.runId,
    capability,
    ...runtimeBindingFields(binding),
  };
}

// The profile an authenticated request is served under: its run's model, with the tool-calling proof
// judged as of the run's admission (F73).
function resolveAuthenticatedGatewayProfile(
  deps: UiHandlerDeps,
  authentication: AuthenticatedGatewayRequest,
): ResolvedGatewayProfile {
  return resolveGatewayProfile(
    deps,
    gatewayProfileModelIdForAuthentication(authentication),
    authentication.admittedAtMs,
  );
}

function gatewayProfileModelIdForAuthentication(
  authentication: AuthenticatedGatewayRequest,
): string | undefined {
  return isRuntimeTransportProfileId(authentication.modelProfileId)
    ? undefined
    : authentication.modelProfileId;
}

function isRuntimeTransportProfileId(modelProfileId: string | undefined): boolean {
  return (
    modelProfileId === undefined ||
    modelProfileId === OPENCODE_RUNTIME_MODEL_ALIAS ||
    modelProfileId === CODING_SAFE_SIDECAR_GATEWAY_PROFILE_ID
  );
}

function reserveGatewayPromptBudget(
  deps: UiHandlerDeps,
  capability: string,
  runId: string,
  reservedPromptTokens: number,
): PromptTokenReservation | undefined {
  const reserved = runtimeCapabilityAuthenticator(deps)?.reservePromptTokens?.(
    capability,
    reservedPromptTokens,
  );
  return promptReservationRunId(reserved) === runId
    ? { capability, reservedPromptTokens, settled: false }
    : undefined;
}

function isAvailableGatewayProfile(
  resolved: ResolvedGatewayProfile,
): resolved is AvailableGatewayProfile {
  return (
    resolved.result.status === "available" &&
    resolved.config !== undefined &&
    resolved.gateway !== undefined
  );
}

function unavailableGatewayProfile(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  resolved: ResolvedGatewayProfile,
  authentication: AuthenticatedGatewayRequest,
): RouteResult {
  const selectedModelId = gatewayProfileModelIdForAuthentication(authentication);
  emitServerDiagnostic(deps.diagnostics, {
    correlationId: authentication.runtimeAuthenticated
      ? authentication.runId
      : (ctx.correlationId ?? UNKNOWN_CORRELATION_ID),
    timestamp: new Date(Date.now()).toISOString(),
    operation: CODING_SIDECAR_GATEWAY_ROUTE,
    source: "coding-sidecar-gateway.chat",
    errorClass: "CodingSidecarGatewayUnavailable",
    message: "coding-sidecar-gateway-profile-unavailable",
    code: unavailableGatewayProfileCode(resolved, selectedModelId, authentication),
  });
  reportGatewayTurnFailure(ctx, deps, authentication.runId, "turn-rejected");
  return unavailableError();
}

function unavailableGatewayProfileCode(
  resolved: ResolvedGatewayProfile,
  selectedModelId: string | undefined,
  authentication: AuthenticatedGatewayRequest,
): string {
  const reason = unavailableGatewayReason(resolved);
  const config = resolved.config === undefined ? "missing-config" : "configured";
  const gateway = resolved.gateway === undefined ? "missing-gateway" : "configured";
  const source =
    resolved.modelSource === "chatgpt-codex-subscription-profile"
      ? "subscription"
      : "model-gateway";
  const selector = gatewaySelectorKind(selectedModelId);
  const authority = gatewayAuthorityKind(authentication);
  return `status=unavailable:reason=${reason}:config=${config}:gateway=${gateway}:source=${source}:selector=${selector}:authority=${authority}`;
}

function gatewaySelectorKind(selectedModelId: string | undefined): string {
  if (selectedModelId === undefined) return "absent";
  if (selectedModelId === OPENCODE_RUNTIME_MODEL_ALIAS) return "runtime-alias";
  if (selectedModelId === CODING_SAFE_SIDECAR_GATEWAY_PROFILE_ID) return "runtime-profile";
  return "provider-model";
}

function gatewayAuthorityKind(authentication: AuthenticatedGatewayRequest): string {
  if (authentication.adapterKind === "model-gateway-sidecar") return "sidecar";
  if (authentication.runtimeAuthenticated) return "runtime";
  return "gateway";
}

function unavailableGatewayReason(
  resolved: ResolvedGatewayProfile,
): CodingWorkbenchSidecarGatewayUnavailableReason {
  return resolved.result.status === "unavailable" ? resolved.result.reason : "missing-provider";
}

interface GatewayRequestCancellation {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
}

// The route's deadline is a backstop BEHIND the gateway's own end-to-end budget, never the budget
// itself. It used to be the provider's per-attempt `timeoutMs`: the first attempt that hung spent
// it, and this deadline, armed before the gateway started its own clock, aborted the retry the
// gateway had just scheduled, so a provider timeout surfaced as a cancellation nobody had asked
// for and failed the run (coding run 23, 2026-09-11). The grace lets the gateway settle its own
// timeout or exhausted-retry error first.
const GATEWAY_ROUTE_DEADLINE_GRACE_MS = 1_000;

export function codingSidecarGatewayRequestDeadlineMs(
  config: GatewayConfig,
  modelId: string,
): number {
  const provider = config.providers.find((candidate) => candidate.modelId === modelId);
  // An unconfigured model is refused before any provider call; 30 s only bounds that refusal.
  const budget =
    provider === undefined
      ? 30_000
      : providerRequestBudgetMs({
          ...provider,
          timeoutMs: codingWorkbenchProviderTimeoutMs(provider.timeoutMs),
        });
  // Armed with AbortSignal.timeout, which fires at once past 2^31 - 1 ms: an absurd budget must not
  // turn the backstop into an immediate abort.
  return Math.min(budget + GATEWAY_ROUTE_DEADLINE_GRACE_MS, MAX_TIMER_DELAY_MS);
}

function gatewayRequestCancellation(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  config: GatewayConfig,
  modelId: string,
  runId: string,
): GatewayRequestCancellation {
  const client = new AbortController();
  const abortClient = (): void => {
    client.abort();
  };
  ctx.req.once("aborted", abortClient);
  ctx.res.once("close", abortClient);
  const deadline = AbortSignal.timeout(codingSidecarGatewayRequestDeadlineMs(config, modelId));
  const runSignal = cancellationRegistry(deps)?.signalFor(runId);
  const signals = [client.signal, deadline, runSignal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  return {
    signal: AbortSignal.any(signals),
    dispose: (): void => {
      ctx.req.removeListener("aborted", abortClient);
      ctx.res.removeListener("close", abortClient);
    },
  };
}

interface GatewayChatDelivery {
  readonly modelAlias: string;
  readonly maxOutputTokens: number;
  readonly upstreamStreamingSupported: boolean;
  readonly reasoningEffort?: ModelReasoningEffort | undefined;
  readonly promptTokenReservation: PromptTokenReservation;
  readonly toolCatalogCoverage: OpenCodeGatewayHandlerCoverage | undefined;
  // How long the per-request tool-catalog offer stays bindable: the request deadline the gateway
  // enforces for this model plus the bridge's settlement grace (`opencodeGatewayOfferLifetimeMs`),
  // so a legitimately long generation never comes back to an expired offer.
  readonly offerLifetimeMs: number;
}

interface PinnedGatewayBinding {
  readonly config: GatewayConfig;
  readonly gateway: Gateway;
}

interface GatewayChatDispatchContext {
  readonly deps: UiHandlerDeps;
  readonly binding: PinnedGatewayBinding;
  readonly modelAlias: string;
  readonly request: GatewayRequest;
  readonly runId: string;
  readonly cancellationSignal: AbortSignal;
  readonly promptTokenReservation: PromptTokenReservation;
}

function requestForGatewayDelivery(
  ctx: RouteContext,
  parsed: CodingSidecarGatewayChatCompletionRequest,
  delivery: GatewayChatDelivery,
  signal: AbortSignal,
): GatewayCallRequest {
  return buildChatRequest(
    parsed,
    delivery.modelAlias,
    signal,
    delivery.maxOutputTokens,
    ctx.correlationId,
    delivery.reasoningEffort,
    { coverage: delivery.toolCatalogCoverage, offerLifetimeMs: delivery.offerLifetimeMs },
  );
}

async function executeGatewayChat(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  binding: PinnedGatewayBinding,
  parsed: CodingSidecarGatewayChatCompletionRequest,
  runId: string,
  delivery: GatewayChatDelivery,
): Promise<RouteResult | typeof STREAMING> {
  const cancellation = gatewayRequestCancellation(
    ctx,
    deps,
    binding.config,
    delivery.modelAlias,
    runId,
  );
  try {
    return await dispatchGatewayChat(
      ctx,
      deps,
      binding,
      parsed,
      runId,
      delivery,
      cancellation.signal,
    );
  } finally {
    cancellation.dispose();
  }
}

// Extracted so `executeGatewayChat` stays under AGENTS.md §6's 50-line ceiling.
async function dispatchGatewayChat(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  binding: PinnedGatewayBinding,
  parsed: CodingSidecarGatewayChatCompletionRequest,
  runId: string,
  delivery: GatewayChatDelivery,
  cancellationSignal: AbortSignal,
): Promise<RouteResult | typeof STREAMING> {
  const { modelAlias, upstreamStreamingSupported } = delivery;
  const request = requestForGatewayDelivery(ctx, parsed, delivery, cancellationSignal);
  const dispatch = {
    deps,
    binding,
    modelAlias,
    request,
    runId,
    cancellationSignal,
    promptTokenReservation: delivery.promptTokenReservation,
  } satisfies GatewayChatDispatchContext;
  let bufferedStream: BufferedOpenAiStreamSession | undefined;
  try {
    if (parsed.stream && upstreamStreamingSupported) {
      return await streamGatewayChat(ctx, dispatch);
    }
    if (parsed.stream) bufferedStream = beginBufferedOpenAiStream(ctx, modelAlias);
    return await executeBufferedGatewayChat(ctx, dispatch, bufferedStream);
  } catch (error) {
    return settleFailedGatewayChat(
      ctx,
      deps,
      runId,
      cancellationSignal,
      error,
      delivery,
      bufferedStream,
    );
  }
}

// Extracted so `executeGatewayChat` stays under AGENTS.md §6's 50-line ceiling.
function settleFailedGatewayChat(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  runId: string,
  cancellationSignal: AbortSignal,
  error: unknown,
  delivery: Pick<GatewayChatDelivery, "promptTokenReservation">,
  bufferedStream: BufferedOpenAiStreamSession | undefined,
): RouteResult | typeof STREAMING {
  recordGatewayOutcome(ctx, deps, runId, cancellationSignal.aborted ? "cancelled" : "failed", 0, 0);
  emitGatewayFailureDiagnostic(ctx, deps, error, runId);
  const spendReason = gatewaySpendRejectionReason(error);
  if (!cancellationSignal.aborted)
    reportGatewayTurnFailure(
      ctx,
      deps,
      runId,
      spendReason === undefined ? gatewayTurnFailureCode(error) : "turn-rejected",
    );
  settlePromptTokenReservation(deps, delivery.promptTokenReservation);
  if (spendReason !== undefined && bufferedStream === undefined) {
    logGatewayRejection(ctx, runId, 403, spendReason);
    return forbiddenGatewayRequest();
  }
  return bufferedStream === undefined
    ? unavailableError()
    : settleBufferedOpenAiStreamError(bufferedStream, "error");
}

async function executeBufferedGatewayChat(
  ctx: RouteContext,
  dispatch: GatewayChatDispatchContext,
  stream: BufferedOpenAiStreamSession | undefined,
): Promise<RouteResult | typeof STREAMING> {
  const { deps, binding, modelAlias, request, runId, cancellationSignal, promptTokenReservation } =
    dispatch;
  const response = await chatFactoryFor(deps, binding.gateway)(binding.config, modelAlias)(request);
  const promptSettlement = settlePromptTokenReservation(
    deps,
    promptTokenReservation,
    response.usage.promptTokens,
  );
  const output = outputMetrics(response);
  const usage = completionUsage(response, output.outputBytes, 0);
  const metrics = { ...output, completionTokens: usage.completionTokens };
  const settledResponse = {
    ...response,
    usage: { ...response.usage, completionTokens: usage.completionTokens },
  };
  logGatewayCompletionUsage(ctx, runId, metrics, usage.source, promptSettlement);
  const record = (outcome: CodingSidecarGatewayRunOutcome): void => {
    recordGatewayOutcome(ctx, deps, runId, outcome, metrics.completionTokens, metrics.outputBytes);
  };
  if (cancellationSignal.aborted) {
    record("cancelled");
    return stream === undefined
      ? unavailableError()
      : settleBufferedOpenAiStreamError(stream, "error");
  }
  if (exceedsOutputBudget(metrics, request.maxOutputTokens ?? 1)) {
    record("output-limit");
    return stream === undefined
      ? unavailableError()
      : settleBufferedOpenAiStreamError(stream, "length");
  }
  return deliverBufferedGatewayAnswer(
    ctx,
    deps,
    runId,
    stream,
    modelAlias,
    settledResponse,
    metrics,
  );
}

function deliverBufferedGatewayAnswer(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  runId: string,
  stream: BufferedOpenAiStreamSession | undefined,
  modelAlias: string,
  response: NormalizedResponse,
  metrics: { readonly completionTokens: number; readonly outputBytes: number },
): RouteResult | typeof STREAMING {
  if (stream === undefined) {
    recordGatewayOutcome(
      ctx,
      deps,
      runId,
      "accepted",
      metrics.completionTokens,
      metrics.outputBytes,
    );
    return openAiResponse(modelAlias, response);
  }
  completeBufferedOpenAiStream(stream, response);
  recordGatewayOutcome(
    ctx,
    deps,
    runId,
    ctx.res.writableEnded && !ctx.res.destroyed ? "accepted" : "cancelled",
    metrics.completionTokens,
    metrics.outputBytes,
  );
  return STREAMING;
}

// Closed stream state machine keeps iterator, cancellation, and SSE backpressure transitions together.
async function streamGatewayChat(
  ctx: RouteContext,
  dispatch: GatewayChatDispatchContext,
): Promise<RouteResult | typeof STREAMING> {
  const { deps, binding, modelAlias, request, runId, promptTokenReservation } = dispatch;
  let iterator: AsyncIterator<GatewayStreamChunk>;
  try {
    iterator = chatStreamFactoryFor(deps, binding.gateway)(
      binding.config,
      modelAlias,
    )(request)[Symbol.asyncIterator]();
  } catch (error) {
    recordGatewayOutcome(ctx, deps, runId, "failed", 0, 0);
    emitGatewayFailureDiagnostic(ctx, deps, error, runId);
    reportGatewayTurnFailure(ctx, deps, runId, gatewayTurnFailureCode(error));
    settlePromptTokenReservation(deps, promptTokenReservation);
    return unavailableError();
  }
  const session = createGatewayStreamSession(ctx, dispatch, iterator);
  try {
    if (beginGatewayStream(session)) await pumpGatewayStreamWithCancellation(deps, session);
    return STREAMING;
  } finally {
    // Every exit path above returns/throws without necessarily having observed real usage
    // (cancelled before the first chunk, mid-stream failure, or budget/cancellation cutoff).
    // Idempotent: a no-op once `streamGatewayResponse` has already settled with real usage.
    settlePromptTokenReservation(session.deps, session.promptTokenReservation);
  }
}

async function pumpGatewayStreamWithCancellation(
  deps: UiHandlerDeps,
  session: GatewayStreamSession,
): Promise<void> {
  const { cancellationSignal, iterator } = session;
  const cancelIterator = (): void => {
    void iterator.return?.();
  };
  cancellationSignal.addEventListener("abort", cancelIterator, { once: true });
  try {
    await pumpGatewayStream(session);
  } catch (error) {
    emitGatewayStreamFailureDiagnostic(session.ctx, deps, error, session.runId);
    if (!session.cancellationSignal.aborted) {
      reportGatewayTurnFailure(session.ctx, deps, session.runId, gatewayStreamFailureCode(error));
    }
    settleGatewayStreamError(session);
  } finally {
    cancellationSignal.removeEventListener("abort", cancelIterator);
  }
}

interface GatewayStreamSession {
  readonly ctx: RouteContext;
  readonly deps: UiHandlerDeps;
  readonly id: string;
  readonly created: number;
  readonly modelId: string;
  readonly request: GatewayRequest;
  readonly runId: string;
  readonly cancellationSignal: AbortSignal;
  readonly iterator: AsyncIterator<GatewayStreamChunk>;
  readonly promptTokenReservation: PromptTokenReservation;
  readonly metrics: {
    completionTokens: number;
    promptTokens: number;
    outputBytes: number;
    previousDeltaEndedWithHighSurrogate: boolean;
  };
}

function createGatewayStreamSession(
  ctx: RouteContext,
  dispatch: GatewayChatDispatchContext,
  iterator: AsyncIterator<GatewayStreamChunk>,
): GatewayStreamSession {
  const { deps, modelAlias, request, runId, cancellationSignal, promptTokenReservation } = dispatch;
  return {
    ctx,
    deps,
    id: `chatcmpl-${randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
    modelId: modelAlias,
    request,
    runId,
    cancellationSignal,
    iterator,
    promptTokenReservation,
    metrics: {
      completionTokens: 0,
      promptTokens: 0,
      outputBytes: 0,
      previousDeltaEndedWithHighSurrogate: false,
    },
  };
}

/** Returns false when the initial SSE handshake could not be delivered. */
function beginGatewayStream(session: GatewayStreamSession): boolean {
  const { ctx, id, created, modelId } = session;
  ctx.res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  if (!writeOpenAiSse(ctx, openAiStreamChunk(id, created, modelId, { role: "assistant" }, null))) {
    ctx.res.destroy();
    recordSessionOutcome(session, "cancelled");
    return false;
  }
  return true;
}

function recordSessionOutcome(
  session: GatewayStreamSession,
  outcome: CodingSidecarGatewayRunOutcome,
): void {
  const { ctx, deps, runId, metrics } = session;
  recordGatewayOutcome(ctx, deps, runId, outcome, metrics.completionTokens, metrics.outputBytes);
}

function writeSessionTerminal(
  session: GatewayStreamSession,
  finishReason: NormalizedResponse["finishReason"],
): void {
  const { ctx, id, created, modelId, metrics } = session;
  writeStreamTerminal(
    ctx,
    id,
    created,
    modelId,
    finishReason,
    metrics.promptTokens,
    metrics.completionTokens,
  );
}

async function pumpGatewayStream(session: GatewayStreamSession): Promise<void> {
  const { cancellationSignal, iterator } = session;
  for (;;) {
    if (isGatewayRequestCancelled(cancellationSignal)) {
      await iterator.return?.();
      recordSessionOutcome(session, "cancelled");
      return;
    }
    const next = await iterator.next();
    if (cancellationSignal.aborted) {
      recordSessionOutcome(session, "cancelled");
      return;
    }
    if (next.done) break;
    const chunk = next.value;
    if (chunk.type === "delta") {
      if (await streamGatewayDelta(session, chunk.token)) continue;
      return;
    }
    await streamGatewayResponse(session, chunk.response);
    return;
  }
  // A stream without a terminal response must reach the shared diagnostic and turn-event path.
  throw new ProviderError("provider stream ended without a terminal response", 200);
}

/** Returns true when the stream may continue with the next chunk. */
async function streamGatewayDelta(session: GatewayStreamSession, token: string): Promise<boolean> {
  const { ctx, id, created, modelId, request, iterator, metrics } = session;
  const deltaMetrics = incrementalUtf8ByteCount(token, metrics.previousDeltaEndedWithHighSurrogate);
  metrics.outputBytes += deltaMetrics.bytes;
  metrics.previousDeltaEndedWithHighSurrogate = deltaMetrics.endsWithHighSurrogate;
  metrics.completionTokens = Math.ceil(metrics.outputBytes / OUTPUT_BYTES_PER_TOKEN_LIMIT);
  const budget = { completionTokens: metrics.completionTokens, outputBytes: metrics.outputBytes };
  if (exceedsOutputBudget(budget, request.maxOutputTokens ?? 1)) {
    await iterator.return?.();
    recordSessionOutcome(session, "output-limit");
    writeSessionTerminal(session, "length");
    return false;
  }
  if (!writeOpenAiSse(ctx, openAiStreamChunk(id, created, modelId, { content: token }, null))) {
    ctx.res.destroy();
    await iterator.return?.();
    recordSessionOutcome(session, "cancelled");
    return false;
  }
  return true;
}

async function streamGatewayResponse(
  session: GatewayStreamSession,
  response: NormalizedResponse,
): Promise<void> {
  const { ctx, id, created, modelId, request, iterator, metrics, promptTokenReservation } = session;
  const outcome = outputMetrics(response);
  metrics.outputBytes = Math.max(outcome.outputBytes, metrics.outputBytes);
  metrics.promptTokens = response.usage.promptTokens;
  const promptSettlement = settlePromptTokenReservation(
    session.deps,
    promptTokenReservation,
    response.usage.promptTokens,
  );
  settleStreamCompletionUsage(session, response, outcome, promptSettlement);
  if (exceedsOutputBudget(metrics, request.maxOutputTokens ?? 1)) {
    await iterator.return?.();
    recordSessionOutcome(session, "output-limit");
    writeSessionTerminal(session, "length");
    return;
  }
  if (response.toolCalls.length > 0) {
    const wrote = writeOpenAiSse(
      ctx,
      openAiStreamChunk(
        id,
        created,
        modelId,
        { tool_calls: openAiToolCalls(response.toolCalls) },
        null,
      ),
    );
    if (!wrote) {
      ctx.res.destroy();
      await iterator.return?.();
      recordSessionOutcome(session, "cancelled");
      return;
    }
  }
  writeSessionTerminal(session, response.finishReason);
  recordSessionOutcome(
    session,
    ctx.res.writableEnded && !ctx.res.destroyed ? "accepted" : "cancelled",
  );
}

function settleStreamCompletionUsage(
  session: GatewayStreamSession,
  response: NormalizedResponse,
  outcome: ReturnType<typeof outputMetrics>,
  promptSettlement: PromptTokenSettlement,
): void {
  const { metrics, ctx, runId } = session;
  const usage = completionUsage(response, outcome.outputBytes, metrics.completionTokens);
  metrics.completionTokens = usage.completionTokens;
  logGatewayCompletionUsage(
    ctx,
    runId,
    {
      completionTokens: metrics.completionTokens,
      outputBytes: Math.max(outcome.outputBytes, metrics.outputBytes),
    },
    usage.source,
    promptSettlement,
  );
}

type CompletionUsageSource =
  "provider-reported" | "streamed-byte-estimate" | "output-byte-estimate";

function completionUsage(
  response: NormalizedResponse,
  outputBytes: number,
  streamedCompletionTokens: number,
): { readonly completionTokens: number; readonly source: CompletionUsageSource } {
  if (response.usage.completionTokens > 0) {
    return { completionTokens: response.usage.completionTokens, source: "provider-reported" };
  }
  if (response.toolCalls.length > 0 || response.structuredOutput !== null) {
    return {
      completionTokens: Math.ceil(outputBytes / OUTPUT_BYTES_PER_TOKEN_LIMIT),
      source: "output-byte-estimate",
    };
  }
  if (streamedCompletionTokens > 0) {
    return { completionTokens: streamedCompletionTokens, source: "streamed-byte-estimate" };
  }
  const hasOutput = response.content.length > 0;
  return {
    completionTokens: hasOutput ? Math.ceil(outputBytes / OUTPUT_BYTES_PER_TOKEN_LIMIT) : 0,
    source: "output-byte-estimate",
  };
}

function logGatewayCompletionUsage(
  ctx: RouteContext,
  runId: string,
  metrics: { readonly completionTokens: number; readonly outputBytes: number },
  source: CompletionUsageSource,
  promptSettlement: PromptTokenSettlement,
): void {
  getServerLogger().info(
    activityLogEvent(
      CODING_SIDECAR_GATEWAY_USAGE_SETTLED_OPERATION,
      { correlationId: correlationIdOrUnknown(ctx.correlationId), parentCorrelationId: runId },
      {
        runId,
        completionTokens: metrics.completionTokens,
        promptTokens: promptSettlement.promptTokens,
        promptSource: promptSettlement.source,
        promptSettlementStatus: promptSettlement.status,
        outputBytes: metrics.outputBytes,
        source,
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}

function settleGatewayStreamError(session: GatewayStreamSession): void {
  if (!session.cancellationSignal.aborted) {
    recordSessionOutcome(session, "failed");
    writeSessionTerminal(session, "error");
  } else {
    recordSessionOutcome(session, "cancelled");
  }
}

function isGatewayRequestCancelled(signal: AbortSignal): boolean {
  return signal.aborted;
}

interface BufferedOpenAiStreamSession {
  readonly ctx: RouteContext;
  readonly id: string;
  readonly created: number;
  readonly modelId: string;
  readonly stopHeartbeat: () => void;
}

function beginBufferedOpenAiStream(
  ctx: RouteContext,
  modelId: string,
): BufferedOpenAiStreamSession {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  ctx.res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  if (!writeOpenAiSse(ctx, openAiStreamChunk(id, created, modelId, { role: "assistant" }, null))) {
    ctx.res.destroy();
  }
  return {
    ctx,
    id,
    created,
    modelId,
    stopHeartbeat: startSseHeartbeat(ctx.res, BUFFERED_STREAM_HEARTBEAT_MS),
  };
}

function completeBufferedOpenAiStream(
  session: BufferedOpenAiStreamSession,
  response: NormalizedResponse,
): typeof STREAMING {
  const { ctx, id, created, modelId, stopHeartbeat } = session;
  stopHeartbeat();
  if (response.content.length > 0 || response.toolCalls.length > 0) {
    const wrote = writeOpenAiSse(
      ctx,
      openAiStreamChunk(
        id,
        created,
        modelId,
        {
          ...(response.content.length === 0 ? {} : { content: response.content }),
          ...(response.toolCalls.length === 0
            ? {}
            : { tool_calls: openAiToolCalls(response.toolCalls) }),
        },
        null,
      ),
    );
    if (!wrote) {
      ctx.res.destroy();
      return STREAMING;
    }
  }
  writeStreamTerminal(
    ctx,
    id,
    created,
    modelId,
    response.finishReason,
    response.usage.promptTokens,
    response.usage.completionTokens,
  );
  return STREAMING;
}

function settleBufferedOpenAiStreamError(
  session: BufferedOpenAiStreamSession,
  finishReason: "error" | "length",
): typeof STREAMING {
  const { ctx, id, created, modelId, stopHeartbeat } = session;
  stopHeartbeat();
  writeStreamTerminal(ctx, id, created, modelId, finishReason, 0, 0);
  return STREAMING;
}

function bufferedOpenAiStream(
  ctx: RouteContext,
  modelId: string,
  response: NormalizedResponse,
): typeof STREAMING {
  return completeBufferedOpenAiStream(beginBufferedOpenAiStream(ctx, modelId), response);
}

function writeOpenAiSse(ctx: RouteContext, payload: Readonly<Record<string, unknown>>): boolean {
  if (!ctx.res.writableEnded && !ctx.res.destroyed) {
    return ctx.res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
  return false;
}

function writeStreamTerminal(
  ctx: RouteContext,
  id: string,
  created: number,
  modelId: string,
  finishReason: NormalizedResponse["finishReason"],
  promptTokens: number,
  completionTokens: number,
): void {
  writeOpenAiSse(ctx, openAiStreamChunk(id, created, modelId, {}, finishReason));
  writeOpenAiSse(ctx, {
    id,
    object: "chat.completion.chunk",
    created,
    model: modelId,
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  });
  if (!ctx.res.writableEnded && !ctx.res.destroyed) ctx.res.end("data: [DONE]\n\n");
}

function openAiStreamChunk(
  id: string,
  created: number,
  model: string,
  delta: Readonly<Record<string, unknown>>,
  finishReason: NormalizedResponse["finishReason"] | null,
): Readonly<Record<string, unknown>> {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/**
 * Readiness dimension (#3390 closeout): a profile can be "available" per the stored config and
 * probe yet still be unusable — its `runMetadata.maxPromptTokens` (derived from the capability via
 * `deriveContextProfileFromCapability`) can sit below what a coding run's fixed system prompt and
 * governed tool schemas alone need. That capability reports itself ready and then dies on the
 * FIRST gateway call. This demotes the readiness projection before a run ever starts, WITHOUT
 * touching the live admission gate below (`isAvailableGatewayProfile`) — an already-minted run's
 * requests keep failing exactly as before, unchanged by this readiness-only check.
 */
function gatewayReadinessProjection(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): CodingWorkbenchSidecarGatewayResult {
  const result = resolveGatewayProfile(deps).result;
  if (
    result.status === "available" &&
    result.runMetadata.maxPromptTokens >= CODING_WORKBENCH_MINIMUM_CODING_CONTEXT_PROMPT_TOKENS
  )
    return result;
  const shortfall =
    result.status === "available" ? "model-context-window-insufficient" : result.reason;
  if (
    shortfall !== "model-context-window-insufficient" &&
    shortfall !== "no-tool-calling" &&
    shortfall !== "tool-calling-unverified"
  )
    return result;
  // #3591 (1.1.7): while the automatic probe is still running against a slow gateway the shortfall
  // is not a verdict. The profile says so, and the Workbench re-reads it instead of refusing.
  const pending = readinessProbePending(deps, result, shortfall);
  const reason: CodingWorkbenchReadinessShortfall = pending
    ? "model-verification-pending"
    : shortfall;
  logReadinessShortfall(ctx, result, reason, pending);
  // An open verification replaces the stored shortfall for an unavailable projection too (an
  // unverified tool-calling proof whose probe is still running), or the Workbench would stop
  // reading and keep the refusal until an unrelated refresh.
  if (result.status === "available" || pending) return { status: "unavailable", reason };
  return result;
}

type CodingWorkbenchReadinessShortfall =
  | "model-context-window-insufficient"
  | "no-tool-calling"
  | "tool-calling-unverified"
  | "model-verification-pending";

function readinessProbePending(
  deps: UiHandlerDeps,
  result: CodingWorkbenchSidecarGatewayResult,
  shortfall: CodingWorkbenchReadinessShortfall,
): boolean {
  if (shortfall === "no-tool-calling") return false;
  const config = currentGatewayConfig(deps);
  if (config === undefined) return false;
  // An unavailable projection (an unverified tool-calling proof) names no model: its verification
  // is open while any model the Workbench could still elect has an open probe.
  return result.status === "available"
    ? isCodingWorkbenchProbePending(config, result.modelAlias)
    : isAnyCodingWorkbenchProbePending(config);
}

function logReadinessShortfall(
  ctx: RouteContext,
  result: CodingWorkbenchSidecarGatewayResult,
  reason: CodingWorkbenchReadinessShortfall,
  pending: boolean,
): void {
  getServerLogger().warn(
    activityLogEvent(
      CODING_SIDECAR_GATEWAY_READINESS_INSUFFICIENT_OPERATION,
      {
        correlationId: correlationIdOrUnknown(ctx.correlationId),
        errorKind: "unavailable",
      },
      {
        reason,
        probeMode: pending ? "pending" : "passive",
        ...(result.status === "available"
          ? {
              maxPromptTokens: result.runMetadata.maxPromptTokens,
              minimumRequiredPromptTokens: CODING_WORKBENCH_MINIMUM_CODING_CONTEXT_PROMPT_TOKENS,
            }
          : {}),
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}

export async function handleCodingSidecarGatewayProfile(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  // What Keiko can determine itself it determines itself: a model whose gateway declared no token
  // limits gets its context window proven here, before the projection judges it.
  const elected = resolveGatewayProfile(deps).result;
  // Only while the gateway is the usable source: a subscription source, a disabled policy or a
  // missing configuration must never cause a paid provider probe (ADR-0124 D5).
  if (elected.status === "available" || elected.reason === "tool-calling-unverified") {
    // #3591 (1.1.7): the browser reads this profile with a 15 s deadline while a probe against a
    // slow gateway may take minutes. Wait a bounded moment for the elected model's proof; past it,
    // answer with the projection (`model-verification-pending` while the probe runs) and let
    // the Workbench read again — never leave the read hanging until the browser gives up.
    await Promise.race([
      ensureCodingWorkbenchContextWindows(
        deps,
        elected.status === "available" ? elected.modelAlias : undefined,
        ctx.correlationId,
      ),
      boundedProfileWait(),
    ]);
  }
  return { status: 200, body: gatewayReadinessProjection(ctx, deps) };
}

// Under the browser's 15 s read deadline for this profile (keiko-ui `DEFAULT_READ_TIMEOUT_MS`).
export const PROFILE_PROBE_WAIT_MS = 8_000;

function boundedProfileWait(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, PROFILE_PROBE_WAIT_MS);
    timer.unref();
  });
}

function upstreamGatewayStreamingSupported(
  deps: UiHandlerDeps,
  advertisedSupport: boolean,
): boolean {
  return advertisedSupport || deps.codingSidecarGatewayChatStreamFactory !== undefined;
}

/** A single explicit result shape for `runtimeGatewayAdmissionResponse`: every branch returns an
 * object literal discriminated on `kind`, instead of mixing a `RouteResult`/`STREAMING` payload
 * with a bare `undefined` "proceed" signal. */
type RuntimeGatewayAdmission =
  | { readonly kind: "handled"; readonly result: RouteResult | typeof STREAMING }
  | { readonly kind: "proceed" };

/** The unmanaged-tool-contract rejection applies before authentication is even known, so it stays
 * its own check: extracting it keeps `runtimeGatewayAdmissionResponse` and
 * `authenticatedGatewayAdmission` each under the complexity ceiling instead of one function
 * carrying every branch. */
function rejectUnmanagedGatewayToolContract(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  parsed: CodingSidecarGatewayChatCompletionRequest,
  authentication: AuthenticatedGatewayRequest,
): RouteResult | undefined {
  const declaresTools = parsed.tools !== undefined && parsed.tools.length > 0;
  if (!declaresTools || isExactManagedToolSet(parsed.tools)) return undefined;
  emitGatewayToolContractDiagnostic(ctx, deps, authentication.runId, parsed.tools);
  return forbiddenGatewayRequest();
}

function runtimeGatewayAdmissionResponse(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  parsed: CodingSidecarGatewayChatCompletionRequest,
  authentication: AuthenticatedGatewayRequest,
  modelAlias: string,
): RuntimeGatewayAdmission {
  const contractRejection = rejectUnmanagedGatewayToolContract(ctx, deps, parsed, authentication);
  if (contractRejection !== undefined) return { kind: "handled", result: contractRejection };
  if (!authentication.runtimeAuthenticated) return { kind: "proceed" };
  return authenticatedGatewayAdmission(ctx, deps, parsed, authentication, modelAlias);
}

function authenticatedGatewayAdmission(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  parsed: CodingSidecarGatewayChatCompletionRequest,
  authentication: AuthenticatedGatewayRequest,
  modelAlias: string,
): RuntimeGatewayAdmission {
  const registry = gatewayReadinessRegistry(deps);
  if (!isAdmittedManagedToolSet(parsed.tools, registry, authentication.runId)) {
    emitGatewayToolContractDiagnostic(ctx, deps, authentication.runId, parsed.tools);
    return { kind: "handled", result: forbiddenGatewayRequest() };
  }
  if (
    isExactManagedToolSet(parsed.tools) &&
    isRuntimeReadinessProbe(parsed) &&
    registry?.claim(authentication.runId) === true
  ) {
    return {
      kind: "handled",
      result: fixedReadinessResponse(ctx, modelAlias, parsed.stream === true),
    };
  }
  if (isExactManagedToolSet(parsed.tools)) registry?.verifyObserved(authentication.runId);
  noteToolAdoptionGap(ctx, deps, authentication.runId, parsed.messages);
  return { kind: "proceed" };
}

export async function handleCodingSidecarGatewayChatCompletions(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult | typeof STREAMING> {
  // KEIKO-0681: fail-closed concurrency bulkhead. Reject with a JSON 429 BEFORE any SSE header,
  // BEFORE authentication, and BEFORE any upstream connection so a burst of requests cannot fan
  // out unbounded upstream connections. Defense-in-depth on top of the singleton-run governance
  // gate in codingRuntimeOrchestrator.ts.
  if (activeCodingGatewayRequests >= maxActiveCodingGatewayRequests()) {
    return {
      status: 429,
      body: errorBody(
        "TOO_MANY_CODING_GATEWAY_REQUESTS",
        "Too many concurrent coding-sidecar gateway requests; retry shortly.",
        ctx.correlationId,
      ),
    };
  }
  activeCodingGatewayRequests += 1;
  try {
    return await runHandleCodingSidecarGatewayChatCompletions(ctx, deps);
  } finally {
    activeCodingGatewayRequests -= 1;
  }
}

function logChatRequestRejection(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  runId: string,
  validationError: RouteResult,
  observed?: {
    readonly parsed: CodingSidecarGatewayChatCompletionRequest;
    readonly bounds: CodingWorkbenchSidecarGatewayRunMetadata;
    readonly estimatedPromptTokens: number;
  },
): void {
  const reason = classifyBadRequestReason(validationError);
  const boundedEvidence =
    observed !== undefined &&
    (reason === "input-messages-exceeded" || reason === "prompt-tokens-exceeded")
      ? {
          estimatedPromptTokens: observed.estimatedPromptTokens,
          maxPromptTokens: observed.bounds.maxPromptTokens,
          admissiblePromptTokens: admissiblePromptTokens(observed.bounds),
          inputMessageCount: observed.parsed.messages.length,
          maxInputMessages: observed.bounds.maxInputMessages,
        }
      : undefined;
  logGatewayRejection(ctx, runId, validationError.status, reason, boundedEvidence);
  reportGatewayTurnFailure(ctx, deps, runId, "turn-rejected");
}

interface ValidatedChatRequest {
  readonly parsed: CodingSidecarGatewayChatCompletionRequest;
  readonly estimatedPromptTokens: number;
}

async function readValidatedChatRequest(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  resolved: AvailableGatewayProfile,
  authentication: AuthenticatedGatewayRequest,
): Promise<RouteResult | ValidatedChatRequest> {
  const parsed = await readChatCompletionRequest(ctx, resolved.result.runMetadata.maxRequestBytes);
  const estimatedPromptTokens = isRouteResult(parsed)
    ? 0
    : promptTokenEstimate(parsed, promptTokenAccounting(resolved));
  const validationError = validationErrorForChatRequest(
    parsed,
    resolved.result.modelAlias,
    resolved.result.runMetadata,
    authentication.runtimeAuthenticated,
    estimatedPromptTokens,
  );
  if (validationError !== undefined) {
    logChatRequestRejection(
      ctx,
      deps,
      authentication.runId,
      validationError,
      isRouteResult(parsed)
        ? undefined
        : { parsed, bounds: resolved.result.runMetadata, estimatedPromptTokens },
    );
    return validationError;
  }
  if (isRouteResult(parsed)) return parsed;
  return { parsed, estimatedPromptTokens };
}

async function runHandleCodingSidecarGatewayChatCompletions(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult | typeof STREAMING> {
  const authentication = authenticateGatewayRequest(ctx, deps);
  if (isRouteResult(authentication)) return authentication;
  const resolved = resolveAuthenticatedGatewayProfile(deps, authentication);
  if (!isAvailableGatewayProfile(resolved))
    return unavailableGatewayProfile(ctx, deps, resolved, authentication);
  const validated = await readValidatedChatRequest(ctx, deps, resolved, authentication);
  if (isRouteResult(validated)) return validated;
  const { parsed, estimatedPromptTokens } = validated;
  logValidatedRequestBounds(
    ctx,
    authentication.runId,
    parsed,
    resolved.result.runMetadata,
    estimatedPromptTokens,
  );
  const admission = runtimeGatewayAdmissionResponse(
    ctx,
    deps,
    parsed,
    authentication,
    resolved.result.modelAlias,
  );
  if (admission.kind === "handled") return admission.result;
  return executeBudgetedGatewayChat(
    ctx,
    deps,
    resolved,
    parsed,
    authentication,
    estimatedPromptTokens,
    {
      modelAlias: resolved.result.modelAlias,
      maxOutputTokens: admittedOutputTokens(resolved.result.runMetadata, estimatedPromptTokens),
      upstreamStreamingSupported: upstreamGatewayStreamingSupported(
        deps,
        resolved.result.supportsStreaming,
      ),
      ...(authentication.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: authentication.reasoningEffort }),
    },
  );
}

// #3591 (1.1.7): the run's output reserve (8k for an undeclared limit) is a reserve against the
// whole window, and `maxPromptTokens` IS that whole window. A prompt close to the window would
// leave the provider a request larger than its window, so the allowance actually sent is what
// remains after the prompt and the safety margin — and the least allowance that still lets the
// model answer (and report an exhausted budget instead of failing silently) is reserved at
// admission, never added on top of a prompt that already fills the window.
export const MINIMUM_ADMITTED_OUTPUT_TOKENS = 512;

type OutputBounds = Pick<
  CodingWorkbenchSidecarGatewayRunMetadata,
  "maxPromptTokens" | "maxOutputTokens"
>;

// What a prompt must leave free of `maxPromptTokens`: the window's safety margin plus the minimum
// allowance (or the whole reserve, when that is smaller).
function reservedWindowTokens(bounds: OutputBounds): number {
  return (
    safetyMarginTokensFor(bounds.maxPromptTokens, bounds.maxOutputTokens) +
    Math.min(MINIMUM_ADMITTED_OUTPUT_TOKENS, bounds.maxOutputTokens)
  );
}

// Review of #3591 (P1): admission used to check the prompt against `maxPromptTokens` alone while
// the allowance floored at 512, so a prompt just under the window was sent WITH 512 output tokens
// — past the window the probe had proven, and the provider refused the turn. The prompt must
// leave the margin and the minimum allowance free, or the turn is refused before any call.
export function admissiblePromptTokens(bounds: OutputBounds): number {
  return bounds.maxPromptTokens - reservedWindowTokens(bounds);
}

// The allowance an ADMITTED turn sends: the run's reserve, shrunk to what the prompt leaves after
// the safety margin. Admission (`admissiblePromptTokens`) guarantees at least the minimum.
export function admittedOutputTokens(bounds: OutputBounds, estimatedPromptTokens: number): number {
  const remaining =
    bounds.maxPromptTokens -
    estimatedPromptTokens -
    safetyMarginTokensFor(bounds.maxPromptTokens, bounds.maxOutputTokens);
  return Math.min(bounds.maxOutputTokens, remaining);
}

function logValidatedRequestBounds(
  ctx: RouteContext,
  runId: string,
  request: CodingSidecarGatewayChatCompletionRequest,
  bounds: CodingWorkbenchSidecarGatewayRunMetadata,
  estimatedPromptTokens: number,
): void {
  getServerLogger().info(
    activityLogEvent(
      CODING_SIDECAR_GATEWAY_REQUEST_VALIDATED_OPERATION,
      {
        correlationId: correlationIdOrUnknown(ctx.correlationId),
        parentCorrelationId: runId,
      },
      {
        runId,
        maxRequestBytes: bounds.maxRequestBytes,
        maxPromptTokens: bounds.maxPromptTokens,
        estimatedPromptTokens,
        maxOutputTokens: admittedOutputTokens(bounds, estimatedPromptTokens),
        inputMessageCount: request.messages.length,
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}

function executeBudgetedGatewayChat(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  binding: PinnedGatewayBinding,
  parsed: CodingSidecarGatewayChatCompletionRequest,
  authentication: { readonly capability: string; readonly runId: string },
  estimatedPromptTokens: number,
  profile: {
    readonly modelAlias: string;
    readonly maxOutputTokens: number;
    readonly upstreamStreamingSupported: boolean;
  },
): Promise<RouteResult | typeof STREAMING> {
  const promptTokenReservation = reserveGatewayPromptBudget(
    deps,
    authentication.capability,
    authentication.runId,
    estimatedPromptTokens,
  );
  if (promptTokenReservation === undefined) {
    logGatewayRejection(ctx, authentication.runId, 403, "runtime-prompt-budget-denied");
    reportGatewayTurnFailure(ctx, deps, authentication.runId, "turn-rejected");
    return Promise.resolve(forbiddenGatewayRequest());
  }
  return executeGatewayChat(ctx, deps, binding, parsed, authentication.runId, {
    ...profile,
    promptTokenReservation,
    toolCatalogCoverage: resolveToolCatalogHandlerCoverage(
      deps,
      authentication.runId,
      ctx.correlationId,
    ),
    offerLifetimeMs: opencodeGatewayOfferLifetimeMs(
      codingSidecarGatewayRequestDeadlineMs(binding.config, profile.modelAlias),
    ),
  });
}

function fixedReadinessResponse(
  ctx: RouteContext,
  modelId: string,
  stream: boolean,
): RouteResult | typeof STREAMING {
  const response: NormalizedResponse = {
    modelId,
    content: "",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "opencode-readiness",
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: 0,
      costClass: "low",
    },
  };
  return stream ? bufferedOpenAiStream(ctx, modelId, response) : openAiResponse(modelId, response);
}
