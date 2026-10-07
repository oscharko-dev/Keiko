import { gatewaySpendRejectionReason } from "./gateway-spend-budget.js";
import { CodingRuntimeLaunchRejectedError } from "./coding-runtime/launchFailure.js";
import {
  CancelledError,
  CircuitOpenError,
  ContextOverflowError,
  GatewayError,
  MalformedToolCallError,
  ModelRefusalError,
  ProviderEmptyAnswerError,
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
  ResponseRedactionError,
  type Gateway,
  type GatewayCallRequest,
  type GatewayConfig,
  type GatewayRequest,
  type GatewayRetryNotice,
  type GatewayRetryObserver,
  type GatewayStreamChunk,
  type NormalizedToolCall,
  type NormalizedResponse,
  type ToolDefinition,
} from "@oscharko-dev/keiko-model-gateway";
import {
  countGatewayPromptTokens,
  type ModelTokenAccounting,
} from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import { gatewayRouteDeadlineMs } from "./gateway-route-deadline.js";
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
  type GatewayOutputRepairOutcome,
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
import {
  describeError,
  emitServerDiagnostic,
  serverDiagnosticFromError,
} from "./diagnostics-log.js";
import { readJsonObject } from "./files.js";
import { safetyMarginTokensFor } from "@oscharko-dev/keiko-contracts/context-engineering";
import {
  ensureCodingWorkbenchContextWindows,
  isAnyCodingWorkbenchProbePending,
  isCodingWorkbenchProbePending,
} from "./gateway-readiness.js";
import { getServerLogger } from "./observability/index.js";
import { STREAMING, errorBody, type RouteContext, type RouteResult } from "./routes.js";
import {
  sseBackpressureReporter,
  type SseBackpressureSignal,
  writeOrDestroy,
} from "./sse-write.js";
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
  /**
   * The opaque identity the admitted reservation answered (#3873 run effort roll-up), handed back
   * with the settlement so the call is timed from its own reservation, never from another call's
   * of the same size. Absent when the authenticator answered none.
   */
  readonly modelCallId?: number | undefined;
  settled: boolean;
  settlement?: PromptTokenSettlement;
}

interface PromptTokenSettlement {
  readonly promptTokens: number;
  readonly source: "provider-reported" | "reserved-estimate" | "released-unspent";
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
  discardedPromptTokens = 0,
): PromptTokenSettlement {
  const providerReported = actualPromptTokens !== undefined && actualPromptTokens > 0;
  return applyPromptTokenSettlement(deps, reservation, {
    promptTokens:
      (providerReported ? actualPromptTokens : reservation.reservedPromptTokens) +
      discardedPromptTokens,
    source: providerReported ? "provider-reported" : "reserved-estimate",
  });
}

/**
 * The prompt tokens of the attempts the gateway discarded on its way to this answer (#3873 review):
 * a steered repair's first answer, a catalog-rejected tool call, a stream that failed after its
 * usage arrived. The provider processed them, so the run's prompt allowance (ADR-0137 D2, the only
 * default per-run token bound) counts them beside the answer's own prompt.
 */
function discardedPromptTokens(response: NormalizedResponse): number {
  return response.discardedAttemptUsage?.promptTokens ?? 0;
}

/**
 * Releases a reservation whose provider call never ran — the client would not take the opening
 * SSE frame, so the buffered path never called the chat factory and the streamed path never pulled
 * the gateway's generator. The conservative rule above keeps the estimate only for a call that WAS
 * dispatched; here nothing was spent, so the whole reservation goes back to the run's budget
 * (#3602 review). Same idempotence and same not-wired fallback as a settlement.
 */
function releasePromptTokenReservation(
  deps: UiHandlerDeps,
  reservation: PromptTokenReservation,
): PromptTokenSettlement {
  return applyPromptTokenSettlement(deps, reservation, {
    promptTokens: 0,
    source: "released-unspent",
  });
}

function applyPromptTokenSettlement(
  deps: UiHandlerDeps,
  reservation: PromptTokenReservation,
  usage: Pick<PromptTokenSettlement, "promptTokens" | "source">,
): PromptTokenSettlement {
  if (reservation.settled) {
    if (reservation.settlement === undefined) throw new TypeError("missing prompt settlement");
    return reservation.settlement;
  }
  reservation.settled = true;
  const unverified: PromptTokenSettlement = {
    promptTokens: reservation.reservedPromptTokens,
    source: "reserved-estimate",
    status: "unverified",
  };
  const selected: PromptTokenSettlement = { ...usage, status: "settled" };
  reservation.settlement = unverified;
  const authenticator = runtimeCapabilityAuthenticator(deps);
  if (authenticator?.settlePromptTokens === undefined) {
    reservation.settlement = { ...selected, status: "not-wired" };
    return reservation.settlement;
  }
  const outcome =
    reservation.modelCallId === undefined
      ? authenticator.settlePromptTokens(
          reservation.capability,
          reservation.reservedPromptTokens,
          usage.promptTokens,
        )
      : authenticator.settlePromptTokens(
          reservation.capability,
          reservation.reservedPromptTokens,
          usage.promptTokens,
          reservation.modelCallId,
        );
  reservation.settlement = observedPromptSettlement(outcome, selected, unverified);
  return reservation.settlement;
}

const CODING_SIDECAR_GATEWAY_ERROR_CODE = "CODING_SIDECAR_UNAVAILABLE";
const CODING_SIDECAR_GATEWAY_ROUTE = "POST /api/coding-sidecar/gateway/chat/completions";
const CODING_SAFE_SIDECAR_GATEWAY_PROFILE_ID = "coding-safe-openai-compatible";
const SIDECAR_SSE_HEARTBEAT_MS = 5_000;
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
    inputTokenLimit: { type: "integer", dataClass: "count", required: false },
    admissiblePromptTokens: { type: "integer", dataClass: "count", required: false },
    maxPromptTokens: { type: "integer", dataClass: "count", required: true },
    estimatedPromptTokens: { type: "integer", dataClass: "count", required: true },
    // #3591 (1.1.7): the output allowance sent with this request, clamped to the window that
    // remains after the prompt — the value an output-exhausted turn has to be read against.
    maxOutputTokens: { type: "integer", dataClass: "count", required: false },
    inputMessageCount: { type: "integer", dataClass: "count", required: true },
    // #3873 (F23): how many prior assistant messages carried nothing but the reasoning of a turn that
    // already ran and were dropped before the gateway request was built, so the estimate above and
    // `inputMessageCount` describe what is actually sent upstream. A count; the reasoning is never
    // recorded. `required: false` only because a record written before this field existed lacks it.
    droppedReasoningMessageCount: { type: "integer", dataClass: "count", required: false },
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
    inputTokenLimit: { type: "integer", dataClass: "count", required: false },
    availablePromptTokens: { type: "integer", dataClass: "count", required: false },
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
    inputTokenLimit: { type: "integer", dataClass: "count", required: false },
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

// #3873 (F17, F23): the gateway's one steered repair of an answer the model could not use — one that
// exhausted its output budget, or ended after reasoning without a tool call or any text — on every
// settlement line of a turn: whether it ran, and how the repaired attempt ended, so an
// `output-exhausted` or `empty-answer` turn the runtime may not retry names its cause, and a
// recovered turn shows the repair that saved it. `exhausted-again` and `empty-again` name how the
// repaired attempt ended (the whole budget spent once more; no text or tool call once more),
// whichever failure triggered the repair; `gateway.retry.scheduled` names that trigger. `required:
// false` only because a record written before these fields existed lacks them; every line written
// since carries `repairAttempted`, and `repairOutcome` whenever a repair ran.
const OUTPUT_REPAIR_FIELDS = {
  repairAttempted: { type: "boolean", dataClass: "closed-enum", required: false },
  repairOutcome: {
    type: "string",
    dataClass: "closed-enum",
    required: false,
    values: ["recovered", "exhausted-again", "empty-again", "failed"],
  },
} as const;

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
      values: [
        "provider-failed",
        "stream-incomplete",
        "turn-rejected",
        "output-exhausted",
        "empty-answer",
        "invalid-tool-call",
      ],
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
    // Whether the answer to the runtime lets it retry the turn: `refused` for a provider rejection
    // no retry can change, which the runtime reads as final (lab 2026-09-26), and for an exhausted
    // or empty answer whose one steered repair failed the same way again (#3873, F17, F23).
    runtimeRetry: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["allowed", "refused"],
    },
    // #3873 review (PR #3876): `provider-failed` names a provider that rejected the turn and one that
    // stayed unavailable alike. `true` marks the second — a retryable provider status (408, 429,
    // 5xx), a rate limit or an open breaker that outlasted the gateway's outage window — so a run
    // that ends on this failure settles `provider-unavailable` and the log shows why. Absent for
    // every other failure; `required: false` because a line written before this field existed
    // lacks it.
    providerUnavailable: { type: "boolean", dataClass: "closed-enum", required: false },
    ...OUTPUT_REPAIR_FIELDS,
    // The Keiko-code frames and cause classes of the failure, when the turn failed on an error
    // (PR #3617 review): a model-answer failure writes no error-level diagnostic, so this line is
    // where its frames live.
    frames: {
      type: "string-array",
      dataClass: "safe-platform-class",
      required: false,
      maxLength: 512,
      maxItems: 8,
    },
    causeChain: {
      type: "string-array",
      dataClass: "error-kind",
      required: false,
      maxLength: 128,
      maxItems: 5,
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

// #3873 review: while the gateway rides out a provider outage the turn waits silently, and the
// Workbench's run status read "Waiting for the model" for the whole window. The first retry of an
// unavailable provider, or the first wait of a call's admission behind the circuit breaker or a
// provider cooldown, is published to the run's event replay as `model-gateway-retrying`, and the
// answer that ends the outage as `model-gateway-recovered`; this line records each publication and
// whether it reached the replay, so the status the operator saw can be rebuilt from the log. Counts
// and closed words only: the attempt that was retried and the policy it ran under, or the reason
// the admission was held.
const CODING_SIDECAR_GATEWAY_RETRY_SURFACED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-sidecar.gateway.retry-surfaced",
  category: "gateway",
  owner: "keiko-server",
  emitter: "coding-sidecar-gateway.surfaceGatewayRetry",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    revision: { type: "integer", dataClass: "count", required: true },
    state: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["running", "paused"],
    },
    fact: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["retrying", "recovered"],
    },
    // What the `retrying` fact followed, and the policy the call ran under; only on a `retrying`
    // fact. A retry carries the failed provider `attempt` it followed. A call whose admission waited
    // before any attempt of its own carries the `waitReason` that held it instead — the closed
    // reason of the `gateway.circuit.wait` line it joins on — and no attempt.
    attempt: { type: "integer", dataClass: "count", required: false },
    waitReason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["provider-cooldown", "circuit-cooldown", "probe-saturated"],
    },
    retryPolicy: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["attempts", "outage-window"],
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
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-sidecar-gateway-retry"],
  proofIds: ["coding-sidecar.gateway.retry-surfaced.emitted-line"],
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
    // `released-unspent`: the provider call never ran, the whole reservation went back (#3602).
    promptSource: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["provider-reported", "reserved-estimate", "released-unspent"],
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
    // #3878: the turn's share of visible text and model reasoning, as counts beside `outputBytes`
    // (answer text, tool calls and structured output together): the UTF-8 size of the answer text,
    // of the reasoning the provider returned (also when it was not forwarded), and the provider's
    // own reasoning-token count when it reports one, never an estimate. Never the text itself.
    // `required: false`: lines written before these fields existed lack them.
    contentBytes: { type: "integer", dataClass: "count", required: false },
    reasoningBytes: { type: "integer", dataClass: "count", required: false },
    reasoningTokens: { type: "integer", dataClass: "count", required: false },
    // #3873 review: the attempts of this turn the gateway discarded on its way to the answer (a
    // steered repair's first answer, a catalog-rejected tool call, a stream that failed after its
    // usage arrived), with their provider-reported tokens. `promptTokens` above already includes
    // the discarded prompt tokens, because the run's allowance counts every prompt the provider
    // processed. Absent when no attempt was discarded with reported usage.
    discardedAttemptCount: { type: "integer", dataClass: "count", required: false },
    discardedPromptTokens: { type: "integer", dataClass: "count", required: false },
    discardedCompletionTokens: { type: "integer", dataClass: "count", required: false },
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
    // #3878: the frames (or the one buffered answer) that carried model reasoning to the coding
    // runtime; 0 when the answer had none or the reasoning display is off. A count only.
    reasoningFrames: { type: "integer", dataClass: "count", required: false },
    // #3873 review: the UTF-8 bytes of model reasoning the runtime actually received, beside the
    // frames that carried them. `required: false`: lines written before this field existed lack it.
    forwardedReasoningBytes: { type: "integer", dataClass: "count", required: false },
    // #3873 review: on an `output-limit` turn, which byte bound ended it — the answer's or the
    // forwarded reasoning's — so a support analysis can tell the two cuts apart.
    limit: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["answer", "reasoning"],
    },
    // #3873 review: a complete buffered answer whose reasoning exceeded the reasoning byte bound is
    // delivered without it rather than refused; `true` says the reasoning was withheld.
    reasoningWithheld: { type: "boolean", dataClass: "closed-enum", required: false },
    // The route backstop armed for this turn (#3602 review); absent on lines written before 1.1.7.
    deadlineMs: { type: "integer", dataClass: "duration", required: false },
    // On a cancelled outcome only: which armed abort source ended the turn, so a stall that ran into
    // the backstop, or a slow client the shared SSE path killed, never reads like a client that left.
    cancellationCause: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["client-disconnect", "route-deadline", "backpressure-killed", "run-stopped"],
    },
    ...OUTPUT_REPAIR_FIELDS,
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  diagnosticWhen: [{ field: "outcome", values: ["cancelled", "failed", "output-limit"] }],
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
      message.startsWith("Request body estimated prompt tokens exceed profile maxPromptTokens") ||
      message.startsWith("Request body estimated prompt tokens exceed profile inputTokenLimit"),
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
  /**
   * Ends a run's pending gateway challenge at once when the route refused its request: a
   * deterministic 400 cannot turn into an observed request later, so the handshake must not wait
   * out the start timeout for it (#3603). A run without a pending challenge is unaffected.
   */
  readonly refuseChallenge: (runId: string) => void;
  /** True only on the first call per run — bounds the adoption-gap diagnostic to one per run. */
  readonly noteAdoptionGapDiagnosed: (runId: string) => boolean;
  readonly clear: (runId: string, preserveVerification?: boolean) => void;
}

// A run's one pending challenge wait: an observed request ends it with true; a refused request, a
// clear, the start signal, or a newer wait for the same run ends it with false and disarms the run.
function pendingChallengeWait(
  runId: string,
  signal: AbortSignal,
  armed: Set<string>,
  waiters: Map<string, (result: boolean) => void>,
): Promise<boolean> {
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
      return pendingChallengeWait(runId, signal, armed, waiters);
    },
    refuseChallenge: (runId): void => {
      if (!armed.delete(runId)) return;
      waiters.get(runId)?.(false);
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
  /**
   * How many prior assistant messages were dropped because they carried nothing but reasoning
   * (#3873, F23). They are not in `messages`, so neither the prompt estimate nor the message count
   * the route admits against includes them.
   */
  readonly droppedReasoningMessageCount: number;
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

// How every model call of a coding turn reaches the gateway, buffered or streamed: under the
// coding-workbench timeout floors (#3591), the explicit outage policy (#3873), which rides out a
// gateway overload for the configured `codingOutageWindowMs` instead of failing the autonomous run,
// and the explicit reasoning delivery (#3878, #3873 F23), which hands the model's reasoning to the
// Workbench. This route is the only one that sets the last two: an interactive surface that borrows
// the latency profile for its timeout floors (the commit draft) keeps the fail-fast attempt count
// and receives its answer without the model's reasoning.
const CODING_TURN_GATEWAY_POLICY = {
  latencyProfile: "coding-workbench",
  outagePolicy: "outage-window",
  reasoningDelivery: "forward",
  answerRepair: "steered",
} as const satisfies Pick<
  GatewayCallRequest,
  "latencyProfile" | "outagePolicy" | "reasoningDelivery" | "answerRepair"
>;

function defaultChatFactoryFor(gateway: Gateway): CodingSidecarGatewayChatFactory {
  return (_config, modelId) => {
    return (request: GatewayRequest) =>
      gateway.chat({ ...request, modelId, ...CODING_TURN_GATEWAY_POLICY });
  };
}

function defaultChatStreamFactoryFor(gateway: Gateway): CodingSidecarGatewayChatStreamFactory {
  return (_config, modelId) => {
    return (request: GatewayRequest) =>
      gateway.chatStream({ ...request, modelId, ...CODING_TURN_GATEWAY_POLICY });
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

// The fields an OpenAI-compatible message carries a model's reasoning in. The gateway reads the same
// two names off a provider's answer (`reasoningText`, keiko-model-gateway normalize.ts), and the
// sidecar hands reasoning to the runtime as `reasoning_content` (#3878), so a client that echoes an
// earlier assistant turn's reasoning back sends it under one of them.
const REASONING_MESSAGE_FIELDS = ["reasoning_content", "reasoning"] as const;

function carriesReasoning(entry: Readonly<Record<string, unknown>>): boolean {
  return REASONING_MESSAGE_FIELDS.some((field) => {
    const reasoning = entry[field];
    return typeof reasoning === "string" && reasoning.length > 0;
  });
}

// No answer text: absent, null, blank, or a list of nothing but blank text parts. A part of any other
// kind is not "no text" — it is left to the content parser, which rejects what it does not accept.
function hasNoAnswerText(content: unknown): boolean {
  if (content === undefined || content === null) return true;
  if (typeof content === "string") return content.trim().length === 0;
  return (
    Array.isArray(content) &&
    content.every((part) => isTextContentPart(part) && part.text.trim().length === 0)
  );
}

function hasNoToolCalls(toolCalls: unknown): boolean {
  return (
    toolCalls === undefined ||
    toolCalls === null ||
    (Array.isArray(toolCalls) && toolCalls.length === 0)
  );
}

/**
 * An assistant message that carries nothing but the reasoning of a turn that already ran (#3873,
 * F23): a reasoning field, no answer text and no tool call. The runtime keeps the reasoning the
 * sidecar forwarded for a turn that then failed in its history and sends that history back with
 * every later request (the live F23 run: about 6,200 prompt tokens and two messages more per failed
 * attempt). Prior reasoning is never resent upstream, so such a message is dropped; the reasoning of
 * a message that also carries text or a tool call is dropped with it by the parser, which copies no
 * reasoning field.
 */
function isReasoningOnlyAssistantMessage(entry: unknown): boolean {
  return (
    isRecord(entry) &&
    entry.role === "assistant" &&
    carriesReasoning(entry) &&
    hasNoAnswerText(entry.content) &&
    hasNoToolCalls(entry.tool_calls)
  );
}

interface ParsedMessages {
  readonly messages: readonly CodingSidecarGatewayChatMessage[];
  readonly droppedReasoningMessageCount: number;
}

/**
 * Distinguishes the two 400 reasons an unusable `messages` array can hand back (#3390): `undefined`
 * for the array being missing/empty (`body-empty-messages`), a `RouteResult` when entries were
 * present but at least one was unparsable — `content-part-unsupported` for a recognized-but-closed
 * content part, `message-shape-invalid` (carrying only the total entry COUNT, never any entry's
 * content) for every other malformed shape. Reasoning-only assistant messages are dropped and
 * counted (#3873, F23); a history that was nothing else is an empty one.
 */
function parseMessages(value: unknown): ParsedMessages | RouteResult | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const messages: CodingSidecarGatewayChatMessage[] = [];
  let droppedReasoningMessageCount = 0;
  for (const entry of value) {
    if (isReasoningOnlyAssistantMessage(entry)) {
      droppedReasoningMessageCount += 1;
      continue;
    }
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
  return messages.length === 0 ? undefined : { messages, droppedReasoningMessageCount };
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
  const parsedMessages = parseMessages(body.messages);
  if (parsedMessages === undefined) {
    return undefined;
  }
  if (isRouteResult(parsedMessages)) {
    return parsedMessages;
  }
  const tools = parseTools(body.tools);
  if (isRouteResult(tools)) {
    return tools;
  }
  return {
    ...(typeof body.model === "string" && body.model.length > 0 ? { model: body.model } : {}),
    messages: parsedMessages.messages,
    droppedReasoningMessageCount: parsedMessages.droppedReasoningMessageCount,
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
            // #3878: the field OpenCode's OpenAI-compatible provider reads as a reasoning part.
            ...(response.reasoning === undefined ? {} : { reasoning_content: response.reasoning }),
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

// A cancelled outcome names the abort source that ended the turn. Without an aborted source it is
// the transport path — an SSE or terminal write found the response gone before its `close`
// listener ran — which is the client leaving, never the deadline.
function gatewayOutcomeCancellationCause(
  cancellation: GatewayRequestCancellation,
  outcome: CodingSidecarGatewayRunOutcome,
): { readonly cancellationCause: CodingSidecarGatewayCancellationCause } | undefined {
  if (outcome !== "cancelled") return undefined;
  return { cancellationCause: cancellation.cause() ?? "client-disconnect" };
}

/** What a turn handed the coding runtime, as counts for its outcome line. */
interface GatewayOutcomeMetrics {
  readonly completionTokens: number;
  readonly outputBytes: number;
  /** Frames (or the one buffered answer) that carried model reasoning to the runtime (#3878). */
  readonly reasoningFrames: number;
  /** The UTF-8 bytes of reasoning those frames carried (#3873 review). */
  readonly forwardedReasoningBytes: number;
  /** On an `output-limit` turn, the byte bound that ended it (#3873 review). */
  readonly limit?: "answer" | "reasoning";
  /** A delivered buffered answer whose oversized reasoning was withheld (#3873 review). */
  readonly reasoningWithheld?: true;
}

const NO_GATEWAY_OUTPUT: GatewayOutcomeMetrics = {
  completionTokens: 0,
  outputBytes: 0,
  reasoningFrames: 0,
  forwardedReasoningBytes: 0,
};

/**
 * What an outcome line can say about the gateway's steered repair (#3873, F17, F23). A line written
 * from the settled answer or error knows whether a repair ran and how it ended; a line written
 * before the call settled — a turn cut at a byte bound, a cancellation mid-stream — cannot know, and
 * omits both fields (#3873 review): absent means unknown, never "no repair ran".
 */
type RepairEvidence =
  | { readonly settled: true; readonly outcome: GatewayOutputRepairOutcome | undefined }
  | { readonly settled: false };

const REPAIR_NOT_SETTLED: RepairEvidence = { settled: false };

function settledRepair(outcome: GatewayOutputRepairOutcome | undefined): RepairEvidence {
  return { settled: true, outcome };
}

// The gateway's one steered repair of an exhausted or empty answer (#3873, F17, F23), read off what
// the call settled with: `recovered` rides on the response (`NormalizedResponse.outputRepair`), the
// failures on the error the repaired attempt surfaced. Absent when no repair ran.
function outputRepairOf(error: unknown): GatewayOutputRepairOutcome | undefined {
  return error instanceof GatewayError ? error.outputRepair : undefined;
}

function repairEvidence(evidence: RepairEvidence): {
  readonly repairAttempted?: boolean;
  readonly repairOutcome?: GatewayOutputRepairOutcome;
} {
  if (!evidence.settled) return {};
  const { outcome } = evidence;
  return {
    repairAttempted: outcome !== undefined,
    ...(outcome === undefined ? {} : { repairOutcome: outcome }),
  };
}

function recordGatewayOutcome(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  runId: string,
  cancellation: GatewayRequestCancellation,
  outcome: CodingSidecarGatewayRunOutcome,
  metrics: GatewayOutcomeMetrics,
  repair: RepairEvidence,
): void {
  const { completionTokens, outputBytes } = metrics;
  getServerLogger().info(
    activityLogEvent(
      CODING_SIDECAR_GATEWAY_OUTCOME_OPERATION,
      { correlationId: correlationIdOrUnknown(ctx.correlationId), parentCorrelationId: runId },
      {
        runId,
        outcome,
        completionTokens,
        outputBytes,
        reasoningFrames: metrics.reasoningFrames,
        forwardedReasoningBytes: metrics.forwardedReasoningBytes,
        ...(metrics.limit === undefined ? {} : { limit: metrics.limit }),
        ...(metrics.reasoningWithheld === undefined ? {} : { reasoningWithheld: true }),
        deadlineMs: cancellation.deadlineMs,
        ...gatewayOutcomeCancellationCause(cancellation, outcome),
        ...repairEvidence(repair),
        completeness: "complete",
        loss: "none",
      },
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

function promptOverflowMessage(
  bounds: CodingWorkbenchSidecarGatewayRunMetadata,
  admissible: number,
): string {
  if (bounds.inputTokenLimit !== undefined && admissible === bounds.inputTokenLimit) {
    return `Request body estimated prompt tokens exceed profile inputTokenLimit (${String(bounds.inputTokenLimit)}).`;
  }
  return `Request body estimated prompt tokens exceed profile maxPromptTokens (${String(bounds.maxPromptTokens)}) less the reserved output allowance (${String(admissible)} admissible).`;
}

function declaredInputBound(
  bounds: Pick<CodingWorkbenchSidecarGatewayRunMetadata, "inputTokenLimit">,
): { readonly inputTokenLimit?: number } {
  return bounds.inputTokenLimit === undefined ? {} : { inputTokenLimit: bounds.inputTokenLimit };
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
    return contextOverflowRequest(promptOverflowMessage(runMetadata, admissible));
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

// A turn the model ended without a usable answer -- nothing at all, reasoning until its output budget
// ran out, or a tool call that never parsed or matched its schema -- is the model's answer, not a
// server fault: the warn-level turn-failed line names it. An error-level diagnostic opened a support
// incident for every such turn; a lab run of the 1.1.8 candidate behind a LiteLLM hosted_vllm route
// opened one on its first empty answer. The runtime may retry these, with one exception: an
// exhausted or empty answer whose steered gateway repair failed the same way again is answered as
// final (`runtimeRetryFor`, #3873 F17, F23) — the identical turn ran away identically, and a third
// attempt would only burn the envelope's duration.
const MODEL_ANSWER_FAILURES: ReadonlySet<CodingWorkbenchTurnFailureCode> = new Set([
  "output-exhausted",
  "empty-answer",
  "invalid-tool-call",
]);

function isModelAnswerFailure(error: unknown): boolean {
  const cause = modelTurnFailureCode(error);
  return cause !== undefined && MODEL_ANSWER_FAILURES.has(cause);
}

// A model-answer failure writes no error-level diagnostic only when its warn-level turn-failed line
// was written. A run no longer running or paused gets no such line, so the diagnostic keeps the
// failure's class and frames (PR #3617 review).
function emitGatewayFailureDiagnostic(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  error: unknown,
  runId: string,
  turnFailureRecorded: boolean,
): void {
  if (turnFailureRecorded && isModelAnswerFailure(error)) return;
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

/**
 * Writes the run's turn-failed line; false for a run that is no longer running or paused.
 * `runtimeRetry` is what the answer the runtime receives lets it do (PR #3625 review): the caller
 * names it from that answer, so the line never states the opposite of what the runtime got.
 */
function reportGatewayTurnFailure(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  runId: string,
  failure: {
    readonly failureCode: CodingWorkbenchTurnFailureCode;
    readonly runtimeRetry: RuntimeRetry;
    readonly error?: unknown;
  },
): boolean {
  const { failureCode, runtimeRetry, error } = failure;
  const snapshot = deps.codingRuntimeOrchestrator?.getSnapshot(runId);
  if (snapshot?.state !== "running" && snapshot?.state !== "paused") return false;
  const providerUnavailable = failureCode === "provider-failed" && providerUnavailableFault(error);
  const publicationReason = gatewayTurnFailurePublication(
    deps,
    runId,
    snapshot,
    failureCode,
    providerUnavailable,
  );
  const run = { revision: snapshot.revision, state: snapshot.state };
  logGatewayTurnFailure(
    ctx,
    runId,
    run,
    failureCode,
    { publicationReason, runtimeRetry, providerUnavailable },
    error,
  );
  return true;
}

/** A turn the gateway refused itself, with no error: its answer's status decides the retry. */
function reportGatewayTurnRejection(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  runId: string,
  answer: RouteResult,
): void {
  reportGatewayTurnFailure(ctx, deps, runId, {
    failureCode: "turn-rejected",
    runtimeRetry: runtimeRetryForStatus(answer.status),
  });
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
  providerUnavailable: boolean,
): GatewayFailurePublicationReason {
  const publication = deps.codingRuntimeEventHub?.publishTurnFailure(
    runId,
    snapshot.state,
    snapshot.revision,
    failureCode,
    { providerUnavailable },
  );
  const publicationReason =
    publication?.ok === true ? "published" : (publication?.reason ?? "event-hub-unavailable");
  return publicationReason;
}

// The coding turn's ear on the gateway's outage (#3873 review): the first retry of an unavailable
// provider, or the first wait of the call's admission behind the circuit breaker or a provider
// cooldown (a call that follows no failed attempt of its own), is surfaced as
// `model-gateway-retrying`, and the answer that ends the outage as `model-gateway-recovered`. One
// frame per outage of a call, however many retries and waits it takes; a call that fails for good
// surfaces nothing here, its turn-failure frame follows. The observer runs inside the gateway's
// retry loop and admission wait and must not throw, so a failure is recorded, never raised.
function gatewayRetryObserver(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  runId: string,
): GatewayRetryObserver {
  let retrying = false;
  return (notice): void => {
    try {
      if (notice.kind === "settled") {
        if (retrying && notice.outcome === "answered") {
          surfaceGatewayRetry(ctx, deps, runId, "recovered");
        }
        retrying = false;
        return;
      }
      if (!retrying) surfaceGatewayRetry(ctx, deps, runId, "retrying", notice);
      retrying = true;
    } catch (error) {
      emitServerDiagnostic(
        deps.diagnostics,
        serverDiagnosticFromError({
          ...gatewayDiagnosticCorrelation(ctx, runId),
          operation: CODING_SIDECAR_GATEWAY_ROUTE,
          source: "coding-sidecar-gateway.retry-observer",
          error,
          redact: (message) => String(deps.redactor(message)),
        }),
      );
    }
  };
}

type GatewayRetryFact = "retrying" | "recovered";

interface LiveRunSnapshot {
  readonly state: "running" | "paused";
  readonly revision: number;
}

// The run's state while it can still show a status: running or paused. Any other run (stopping,
// settled, unknown) has none, and the gateway's own retry line is its record.
function liveRunSnapshot(deps: UiHandlerDeps, runId: string): LiveRunSnapshot | undefined {
  const snapshot = deps.codingRuntimeOrchestrator?.getSnapshot(runId);
  if (snapshot?.state !== "running" && snapshot?.state !== "paused") return undefined;
  return { state: snapshot.state, revision: snapshot.revision };
}

function publishGatewayRetryFact(
  deps: UiHandlerDeps,
  runId: string,
  run: LiveRunSnapshot,
  fact: GatewayRetryFact,
): GatewayFailurePublicationReason {
  const publication = deps.codingRuntimeEventHub?.publishModelGatewayFact(
    runId,
    run.state,
    run.revision,
    fact === "retrying" ? "model-gateway-retrying" : "model-gateway-recovered",
  );
  return publication?.ok === true ? "published" : (publication?.reason ?? "event-hub-unavailable");
}

// What a `retrying` fact followed: a retry the call's failed attempt was met with, or a wait of its
// admission before any attempt of its own.
type GatewayRetryCause = Exclude<GatewayRetryNotice, { readonly kind: "settled" }>;

// The body-free fields the fact's line records for its cause: the failed attempt of a retry, or the
// reason an admission was held, and the policy the call ran under either way.
function gatewayRetryCauseFields(cause: GatewayRetryCause): {
  readonly attempt?: number;
  readonly waitReason?: Extract<GatewayRetryCause, { readonly kind: "admission-wait" }>["reason"];
  readonly retryPolicy: GatewayRetryCause["retryPolicy"];
} {
  return cause.kind === "scheduled"
    ? { attempt: cause.attempt, retryPolicy: cause.retryPolicy }
    : { waitReason: cause.reason, retryPolicy: cause.retryPolicy };
}

// Publishes the fact to the run's event replay and records the publication.
function surfaceGatewayRetry(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  runId: string,
  fact: GatewayRetryFact,
  cause?: GatewayRetryCause,
): void {
  const run = liveRunSnapshot(deps, runId);
  if (run === undefined) return;
  const publicationReason = publishGatewayRetryFact(deps, runId, run, fact);
  const published = publicationReason === "published";
  const event = activityLogEvent(
    CODING_SIDECAR_GATEWAY_RETRY_SURFACED_OPERATION,
    {
      ...gatewayDiagnosticCorrelation(ctx, runId),
      ...(published ? {} : { errorKind: "unavailable" as const }),
    },
    {
      runId,
      revision: run.revision,
      state: run.state,
      fact,
      ...(cause === undefined ? {} : gatewayRetryCauseFields(cause)),
      published,
      publicationReason,
      completeness: "complete",
      loss: "none",
    },
  );
  if (published) getServerLogger().info(event);
  else getServerLogger().warn(event);
}

function logGatewayTurnFailure(
  ctx: RouteContext,
  runId: string,
  { revision, state }: { readonly revision: number; readonly state: "running" | "paused" },
  failureCode: CodingWorkbenchTurnFailureCode,
  {
    publicationReason,
    runtimeRetry,
    providerUnavailable,
  }: {
    readonly publicationReason: GatewayFailurePublicationReason;
    readonly runtimeRetry: RuntimeRetry;
    readonly providerUnavailable: boolean;
  },
  error: unknown,
): void {
  const { frames, causeChain } = describeError(error);
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
        runtimeRetry,
        // Present only when the provider could not serve the call (a retryable status, a rate limit,
        // an open breaker): the fact a run that ends on this failure settles `provider-unavailable`.
        ...(providerUnavailable ? { providerUnavailable } : {}),
        // The turn failed with a settled gateway error, which says whether a repair ran.
        ...repairEvidence(settledRepair(outputRepairOf(error))),
        ...(error === undefined || frames === undefined ? {} : { frames }),
        ...(error === undefined || causeChain === undefined ? {} : { causeChain }),
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}

// The causes the buffered and the streamed path name the same way. Both output-budget exhaustion
// and an empty answer are HTTP 200 provider errors, so they are resolved before any status check.
function modelTurnFailureCode(error: unknown): CodingWorkbenchTurnFailureCode | undefined {
  // The gateway's own redaction refused an answer nested too deep to walk: a Workbench guard
  // rejected the turn, whether or not a tool was called, so it is no invalid tool call and keeps
  // its error-level diagnostic (PR #3617 review). It extends MalformedToolCallError, so it is named
  // before that check.
  if (
    error instanceof ContextOverflowError ||
    error instanceof ModelRefusalError ||
    error instanceof ResponseRedactionError
  )
    return "turn-rejected";
  if (error instanceof ProviderOutputExhaustedError) return "output-exhausted";
  if (error instanceof ProviderEmptyAnswerError) return "empty-answer";
  if (error instanceof MalformedToolCallError) return "invalid-tool-call";
  return undefined;
}

// A gateway error that says the call stopped answering rather than that it was refused: a timeout, a
// refused or dropped connection, a stream that ended without its terminal answer (HTTP 200).
function isStreamInterruption(error: unknown): boolean {
  return (
    error instanceof TimeoutError ||
    error instanceof TransportError ||
    (error instanceof ProviderError && error.httpStatus === 200)
  );
}

function gatewayTurnFailureCode(error: unknown): CodingWorkbenchTurnFailureCode {
  const modelCause = modelTurnFailureCode(error);
  if (modelCause !== undefined) return modelCause;
  return isStreamInterruption(error) ? "stream-incomplete" : "provider-failed";
}

// The streamed path names `stream-incomplete` only for a call that stopped answering: an
// interruption, or a failure that is no gateway error at all (a decoder or socket fault inside the
// stream). Every other gateway error — a refused credential, a configuration or egress refusal, an
// unknown model, a provider status — is named `provider-failed`, as the buffered path always named
// it. Before (#3873 review, PR #3876) the default bucket was `stream-incomplete`, so a configuration
// or egress error that reached the stream settled the whole run `provider-unavailable`: "nothing was
// rejected, check that the gateway is running".
function gatewayStreamFailureCode(error: unknown): CodingWorkbenchTurnFailureCode {
  if (gatewaySpendRejectionReason(error) !== undefined) return "turn-rejected";
  const modelCause = modelTurnFailureCode(error);
  if (modelCause !== undefined) return modelCause;
  return error instanceof GatewayError && !isStreamInterruption(error)
    ? "provider-failed"
    : "stream-incomplete";
}

// Whether the provider could not serve the call, as opposed to rejecting it: a retryable provider
// status (408, 429, 5xx), a rate limit or an open breaker. `provider-failed` names both alike, and
// the gateway has by now retried through its outage window, so such a failure means the provider
// stayed unavailable (#3873 review, F10). Positively identified from the error, never inferred from
// the turn-failure bucket; an output-exhausted or empty answer is an HTTP 200 and never one.
function providerUnavailableFault(error: unknown): boolean {
  if (error instanceof RateLimitError || error instanceof CircuitOpenError) return true;
  return (
    error instanceof ProviderError &&
    (error.httpStatus === 408 || error.httpStatus === 429 || error.httpStatus >= 500)
  );
}

type RuntimeRetry = "allowed" | "refused";

// A rejection no retry can change — a provider 4xx other than 408/409/429, a refused credential, an
// invalid configuration, an exhausted spend budget — which the gateway's own retry policy already
// treats as terminal. A breaker's cooldown and a cancellation are no verdict on the turn, so they
// stay retryable. A spend rejection is final on every path: answered retryable on a stream, it was
// retried by the runtime without end, the same way as the lab's rejected turn (PR #3625 review).
function runtimeRetryFor(
  error: unknown,
  failureCode: CodingWorkbenchTurnFailureCode,
): RuntimeRetry {
  if (gatewaySpendRejectionReason(error) !== undefined) return "refused";
  if (repairFailedAgain(error, failureCode)) return "refused";
  return isFinalProviderRejection(error, failureCode) ? "refused" : "allowed";
}

// How the repaired attempt of each model-answer failure ends when the model fails that way again.
const REPAIRED_ANSWER_FAILED_AGAIN: ReadonlyMap<
  CodingWorkbenchTurnFailureCode,
  GatewayOutputRepairOutcome
> = new Map([
  ["output-exhausted", "exhausted-again"],
  ["empty-answer", "empty-again"],
]);

// #3873 (F17, F23): the gateway already steered the one repair an exhausted or empty answer gets,
// and the model failed the same way again. A runtime retry of the identical turn would run away
// identically (run 324076066246415201273338647160811469441: three seven-minute attempts, no
// progress; run 74202984158312182524609898190850427735: seven attempts that each ended empty after
// reasoning), so the turn is final. A first failure the call's budget could not repair, and a
// repair that failed for another reason, stay retryable.
function repairFailedAgain(error: unknown, failureCode: CodingWorkbenchTurnFailureCode): boolean {
  const again = REPAIRED_ANSWER_FAILED_AGAIN.get(failureCode);
  return again !== undefined && outputRepairOf(error) === again;
}

function isFinalProviderRejection(
  error: unknown,
  failureCode: CodingWorkbenchTurnFailureCode,
): boolean {
  return (
    failureCode === "provider-failed" &&
    error instanceof GatewayError &&
    !error.retryable &&
    !(error instanceof CircuitOpenError) &&
    !(error instanceof CancelledError) &&
    !(error instanceof ProviderError && runtimeRetriesStatus(error.httpStatus))
  );
}

// The provider statuses OpenCode 2.0.10 retries on its own (408, 409, 429, 5xx): a rejection with one
// of them is no verdict on the turn, whatever Keiko's own retry policy did with it (PR #3625 review:
// a LiteLLM 409 is not retryable for Keiko's gateway, yet the runtime must still retry it).
function runtimeRetriesStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

// What the runtime does with an HTTP answer of this status: it retries the statuses above and ends
// the turn on any other 4xx.
function runtimeRetryForStatus(status: number): RuntimeRetry {
  return runtimeRetriesStatus(status) ? "allowed" : "refused";
}

// OpenCode 2.0.10 reads an error chunk whose numeric `code` is an HTTP status as that status (its
// OpenAIChat protocol, then its provider-error classifier): a 400 `invalid_request_error` ends the
// turn at once. `finish_reason: "error"` reads as an unknown provider error, which it retries without
// end — lab 2026-09-26: ten retries of the same rejected turn until the fault was removed.
const PROVIDER_REJECTION_MESSAGE = "The model provider rejected this turn.";
const PROVIDER_REJECTION_CHUNK = {
  error: { code: 400, type: "invalid_request_error", message: PROVIDER_REJECTION_MESSAGE },
} as const;

function providerRejectionError(): RouteResult {
  return { status: 400, body: errorBody("BAD_REQUEST", PROVIDER_REJECTION_MESSAGE) };
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
  turnFailureRecorded: boolean,
): void {
  if (turnFailureRecorded && isModelAnswerFailure(error)) return;
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
    | ((
        capability: string,
        reservedPromptTokens: number,
        actualPromptTokens: number,
        modelCallId?: number,
      ) => unknown)
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

// The identity an admitted reservation answers beside its run, when it answers one: a safe integer
// the settlement hands back verbatim. Anything else is no identity, and the call is then untracked.
function promptReservationModelCallId(value: unknown): number | undefined {
  if (!isRecord(value) || value.ok !== true) return undefined;
  return typeof value.modelCallId === "number" && Number.isSafeInteger(value.modelCallId)
    ? value.modelCallId
    : undefined;
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

function refuseGatewayToolContract(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  runId: string,
  parsed: CodingSidecarGatewayChatCompletionRequest,
): RouteResult {
  const { tools } = parsed;
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
  const answer = forbiddenGatewayRequest();
  logGatewayRejection(ctx, runId, answer.status, reason, toolContractMismatch(tools));
  refuseReadinessChallenge(deps, runId, parsed);
  reportGatewayTurnRejection(ctx, deps, runId, answer);
  return answer;
}

// Ends a pending readiness challenge at once when the route refused the challenge's own request: a
// deterministic refusal of the readiness prompt cannot turn into an observed request later (#3603).
// A refused side request, a title or compaction call the runtime sends meanwhile, leaves the
// challenge waiting for the readiness prompt (PR #3617 review).
function refuseReadinessChallenge(
  deps: UiHandlerDeps,
  runId: string,
  parsed: CodingSidecarGatewayChatCompletionRequest | undefined,
): void {
  if (parsed !== undefined && isRuntimeReadinessProbe(parsed)) {
    gatewayReadinessRegistry(deps)?.refuseChallenge(runId);
  }
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
  if (promptReservationRunId(reserved) !== runId) return undefined;
  const modelCallId = promptReservationModelCallId(reserved);
  return {
    capability,
    reservedPromptTokens,
    ...(modelCallId === undefined ? {} : { modelCallId }),
    settled: false,
  };
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
  const answer = unavailableError();
  reportGatewayTurnRejection(ctx, deps, authentication.runId, answer);
  return answer;
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

/** Which of the four armed abort sources ended a cancelled turn; the outcome line's closed value. */
type CodingSidecarGatewayCancellationCause =
  "client-disconnect" | "route-deadline" | "backpressure-killed" | "run-stopped";

// The sidecar's SSE frames go through the server's shared protective write path (`writeOrDestroy`):
// a frame the client is not draining aborts this controller, reports the body-free backpressure
// diagnostic and destroys the socket, exactly as every other SSE route does. The controller is one
// of the request's abort sources, so the outcome line can name the kill instead of guessing.
interface SidecarSseTransport {
  readonly backpressure: AbortController;
  readonly onBackpressure: (signal: SseBackpressureSignal) => void;
  /**
   * The one id the outcome line, the backpressure diagnostic and the `sse.stream.closed` line
   * share, so a termination can be joined across its evidence: the request's own correlation id,
   * or the sanctioned `UNKNOWN_CORRELATION_ID` fallback — never a fresh mint on one line only.
   */
  readonly correlationId: string;
}

function sidecarSseTransport(ctx: RouteContext, deps: UiHandlerDeps): SidecarSseTransport {
  const correlationId = correlationIdOrUnknown(ctx.correlationId);
  return {
    backpressure: new AbortController(),
    onBackpressure: sseBackpressureReporter(deps, "coding-sidecar-gateway", correlationId),
    correlationId,
  };
}

interface GatewayRequestCancellation {
  readonly signal: AbortSignal;
  /** The route backstop armed for this request, recorded on the outcome line. */
  readonly deadlineMs: number;
  readonly transport: SidecarSseTransport;
  /** The source that aborted first, or undefined while nothing has aborted. */
  readonly cause: () => CodingSidecarGatewayCancellationCause | undefined;
  readonly dispose: () => void;
}

interface GatewayCancellationSources {
  readonly client: AbortSignal;
  readonly deadline: AbortSignal;
  readonly backpressure: AbortSignal;
}

// `AbortSignal.any` carries the reason of the source that aborted first, so a client that leaves
// after the deadline already fired still reads as the deadline, never the other way round.
function gatewayCancellationCause(
  signal: AbortSignal,
  sources: GatewayCancellationSources,
): CodingSidecarGatewayCancellationCause | undefined {
  if (!signal.aborted) return undefined;
  if (signal.reason === sources.client.reason) return "client-disconnect";
  if (signal.reason === sources.deadline.reason) return "route-deadline";
  if (signal.reason === sources.backpressure.reason) return "backpressure-killed";
  return "run-stopped";
}

// The route's deadline is a backstop BEHIND the gateway's own end-to-end budget, never the budget
// itself (`gateway-route-deadline.ts`, shared with the commit draft since the #3602 review). It used
// to be the provider's per-attempt `timeoutMs`: the first attempt that hung spent it, and this
// deadline, armed before the gateway started its own clock, aborted the retry the gateway had just
// scheduled, so a provider timeout surfaced as a cancellation nobody had asked for and failed the
// run (coding run 23, 2026-09-11).
export function codingSidecarGatewayRequestDeadlineMs(
  config: GatewayConfig,
  modelId: string,
): number {
  // The sidecar reaches the gateway both ways — a buffered `chat()` answer or a `chatStream()`
  // read — so its backstop sits behind the longer of the two budgets, each extended by the outage
  // window these calls ride out (#3873 review): the route must not cut the configured window short.
  return gatewayRouteDeadlineMs(
    config,
    modelId,
    ["buffered", "streamed"],
    CODING_TURN_GATEWAY_POLICY.outagePolicy,
  );
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
  const deadlineMs = codingSidecarGatewayRequestDeadlineMs(config, modelId);
  const deadline = AbortSignal.timeout(deadlineMs);
  const transport = sidecarSseTransport(ctx, deps);
  const runSignal = cancellationRegistry(deps)?.signalFor(runId);
  const signals = [client.signal, deadline, transport.backpressure.signal, runSignal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const signal = AbortSignal.any(signals);
  const sources = { client: client.signal, deadline, backpressure: transport.backpressure.signal };
  return {
    signal,
    deadlineMs,
    transport,
    cause: (): CodingSidecarGatewayCancellationCause | undefined =>
      gatewayCancellationCause(signal, sources),
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
  readonly cancellation: GatewayRequestCancellation;
  readonly promptTokenReservation: PromptTokenReservation;
}

function requestForGatewayDelivery(
  ctx: RouteContext,
  parsed: CodingSidecarGatewayChatCompletionRequest,
  delivery: GatewayChatDelivery,
  signal: AbortSignal,
  retryObserver: GatewayRetryObserver,
): GatewayCallRequest {
  return {
    ...buildChatRequest(
      parsed,
      delivery.modelAlias,
      signal,
      delivery.maxOutputTokens,
      ctx.correlationId,
      delivery.reasoningEffort,
      { coverage: delivery.toolCatalogCoverage, offerLifetimeMs: delivery.offerLifetimeMs },
    ),
    retryObserver,
  };
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
    return await dispatchGatewayChat(ctx, deps, binding, parsed, runId, delivery, cancellation);
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
  cancellation: GatewayRequestCancellation,
): Promise<RouteResult | typeof STREAMING> {
  const { modelAlias, upstreamStreamingSupported } = delivery;
  const request = requestForGatewayDelivery(
    ctx,
    parsed,
    delivery,
    cancellation.signal,
    gatewayRetryObserver(ctx, deps, runId),
  );
  const dispatch = {
    deps,
    binding,
    modelAlias,
    request,
    runId,
    cancellation,
    promptTokenReservation: delivery.promptTokenReservation,
  } satisfies GatewayChatDispatchContext;
  let bufferedStream: BufferedOpenAiStreamSession | undefined;
  try {
    if (parsed.stream && upstreamStreamingSupported) {
      return await streamGatewayChat(ctx, dispatch);
    }
    if (parsed.stream) {
      bufferedStream = beginBufferedOpenAiStream(ctx, modelAlias, cancellation.transport);
      if (bufferedStream === undefined) return settleUndeliverableBufferedStream(ctx, dispatch);
    }
    return await executeBufferedGatewayChat(ctx, dispatch, bufferedStream);
  } catch (error) {
    return settleFailedGatewayChat(ctx, deps, runId, cancellation, error, delivery, bufferedStream);
  }
}

// The opening frame never reached the client — the shared path killed the stream, or the response
// was already gone — so no provider call is started for an answer nobody can receive, exactly as
// `beginGatewayStream` ends the streamed path (#3602 review). The outcome names the abort source.
function settleUndeliverableBufferedStream(
  ctx: RouteContext,
  dispatch: GatewayChatDispatchContext,
): typeof STREAMING {
  const { deps, runId, cancellation, promptTokenReservation } = dispatch;
  // No provider call was started, so no repair can have run.
  recordGatewayOutcome(
    ctx,
    deps,
    runId,
    cancellation,
    "cancelled",
    NO_GATEWAY_OUTPUT,
    settledRepair(undefined),
  );
  releaseUndispatchedPromptBudget(ctx, deps, runId, promptTokenReservation);
  return STREAMING;
}

// A handshake the client would not take leaves no provider call behind, so the reservation is
// released rather than kept as spent, and the usage line records the release (zero prompt tokens,
// `released-unspent`) so the ledger movement is reconstructible from the log.
function releaseUndispatchedPromptBudget(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  runId: string,
  reservation: PromptTokenReservation,
): void {
  const settlement = releasePromptTokenReservation(deps, reservation);
  logGatewayCompletionUsage(
    ctx,
    runId,
    { completionTokens: 0, outputBytes: 0, contentBytes: 0, reasoningBytes: 0 },
    "output-byte-estimate",
    settlement,
  );
}

// Extracted so `executeGatewayChat` stays under AGENTS.md §6's 50-line ceiling.
function settleFailedGatewayChat(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  runId: string,
  cancellation: GatewayRequestCancellation,
  error: unknown,
  delivery: Pick<GatewayChatDelivery, "promptTokenReservation">,
  bufferedStream: BufferedOpenAiStreamSession | undefined,
): RouteResult | typeof STREAMING {
  const cancelled = cancellation.signal.aborted;
  recordGatewayOutcome(
    ctx,
    deps,
    runId,
    cancellation,
    cancelled ? "cancelled" : "failed",
    NO_GATEWAY_OUTPUT,
    settledRepair(outputRepairOf(error)),
  );
  const spendReason = gatewaySpendRejectionReason(error);
  const failureCode = spendReason === undefined ? gatewayTurnFailureCode(error) : "turn-rejected";
  const runtimeRetry = runtimeRetryFor(error, failureCode);
  const turnFailureRecorded =
    !cancelled && reportGatewayTurnFailure(ctx, deps, runId, { failureCode, runtimeRetry, error });
  emitGatewayFailureDiagnostic(ctx, deps, error, runId, turnFailureRecorded);
  settlePromptTokenReservation(deps, delivery.promptTokenReservation);
  if (spendReason !== undefined && bufferedStream === undefined) {
    logGatewayRejection(ctx, runId, 403, spendReason);
    return forbiddenGatewayRequest();
  }
  const refused = !cancelled && runtimeRetry === "refused";
  if (bufferedStream === undefined) return refused ? providerRejectionError() : unavailableError();
  return refused
    ? settleBufferedOpenAiStreamRejection(bufferedStream)
    : settleBufferedOpenAiStreamError(bufferedStream, "error");
}

async function executeBufferedGatewayChat(
  ctx: RouteContext,
  dispatch: GatewayChatDispatchContext,
  stream: BufferedOpenAiStreamSession | undefined,
): Promise<RouteResult | typeof STREAMING> {
  const { deps, binding, modelAlias, request, runId, cancellation, promptTokenReservation } =
    dispatch;
  const response = await chatFactoryFor(deps, binding.gateway)(binding.config, modelAlias)(request);
  const promptSettlement = settlePromptTokenReservation(
    deps,
    promptTokenReservation,
    response.usage.promptTokens,
    discardedPromptTokens(response),
  );
  const output = outputMetrics(response);
  const usage = completionUsage(response, output.outputBytes, 0);
  const metrics = { ...output, completionTokens: usage.completionTokens };
  const settledResponse = {
    ...response,
    usage: { ...response.usage, completionTokens: usage.completionTokens },
  };
  logGatewayCompletionUsage(
    ctx,
    runId,
    { ...metrics, ...answerShares(response) },
    usage.source,
    promptSettlement,
  );
  const record = bufferedOutcomeRecorder(ctx, dispatch, metrics, response);
  if (cancellation.signal.aborted) {
    record("cancelled");
    return stream === undefined
      ? unavailableError()
      : settleBufferedOpenAiStreamError(stream, "error");
  }
  const maxOutputTokens = request.maxOutputTokens ?? 1;
  if (exceedsOutputBudget(metrics, maxOutputTokens)) {
    record("output-limit", { limit: "answer" });
    return stream === undefined
      ? unavailableError()
      : settleBufferedOpenAiStreamError(stream, "length");
  }
  return deliverBufferedGatewayAnswer(
    ctx,
    modelAlias,
    stream,
    withinReasoningBudget(settledResponse, maxOutputTokens),
    record,
  );
}

interface BufferedReasoningDelivery {
  readonly limit?: "answer";
  readonly reasoningFrames?: number;
  readonly forwardedReasoningBytes?: number;
  readonly reasoningWithheld?: true;
}

type RecordBufferedOutcome = (
  outcome: CodingSidecarGatewayRunOutcome,
  delivery?: BufferedReasoningDelivery,
) => void;

// The outcome line of a buffered turn: the answer's counts, the reasoning it carried to the
// runtime (#3878) or withheld, and — from the settled answer — the gateway's steered repair (#3873).
function bufferedOutcomeRecorder(
  ctx: RouteContext,
  dispatch: GatewayChatDispatchContext,
  metrics: Pick<GatewayOutcomeMetrics, "completionTokens" | "outputBytes">,
  response: NormalizedResponse,
): RecordBufferedOutcome {
  const { deps, runId, cancellation } = dispatch;
  return (outcome, delivery = {}): void => {
    recordGatewayOutcome(
      ctx,
      deps,
      runId,
      cancellation,
      outcome,
      { reasoningFrames: 0, forwardedReasoningBytes: 0, ...metrics, ...delivery },
      settledRepair(response.outputRepair),
    );
  };
}

// A buffered answer is complete when it arrives: its own output bound decides whether it may be
// delivered, never the size of the reasoning beside it (#3873 review). A reasoning over the byte
// bound of one model attempt is withheld from the runtime — display-only text — and the answer is
// delivered without it; the outcome line says so (`reasoningWithheld`).
function withinReasoningBudget(
  response: NormalizedResponse,
  maxOutputTokens: number,
): BoundedBufferedAnswer {
  if (!exceedsReasoningBudget(response, maxOutputTokens)) return { response, withheld: false };
  const { reasoning: _withheld, ...withoutReasoning } = response;
  return { response: withoutReasoning, withheld: true };
}

interface BoundedBufferedAnswer {
  readonly response: NormalizedResponse;
  readonly withheld: boolean;
}

function deliverBufferedGatewayAnswer(
  ctx: RouteContext,
  modelAlias: string,
  stream: BufferedOpenAiStreamSession | undefined,
  answer: BoundedBufferedAnswer,
  record: RecordBufferedOutcome,
): RouteResult | typeof STREAMING {
  const { response } = answer;
  const delivery: BufferedReasoningDelivery = {
    reasoningFrames: response.reasoning === undefined ? 0 : 1,
    forwardedReasoningBytes:
      response.reasoning === undefined ? 0 : Buffer.byteLength(response.reasoning, "utf8"),
    ...(answer.withheld ? { reasoningWithheld: true } : {}),
  };
  if (stream === undefined) {
    record("accepted", delivery);
    return openAiResponse(modelAlias, response);
  }
  completeBufferedOpenAiStream(stream, response);
  const delivered = ctx.res.writableEnded && !ctx.res.destroyed;
  record(delivered ? "accepted" : "cancelled", delivered ? delivery : {});
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
    recordGatewayOutcome(
      ctx,
      deps,
      runId,
      dispatch.cancellation,
      "failed",
      NO_GATEWAY_OUTPUT,
      settledRepair(outputRepairOf(error)),
    );
    const failureCode = gatewayTurnFailureCode(error);
    const runtimeRetry = runtimeRetryFor(error, failureCode);
    const turnFailureRecorded = reportGatewayTurnFailure(ctx, deps, runId, {
      failureCode,
      runtimeRetry,
      error,
    });
    emitGatewayFailureDiagnostic(ctx, deps, error, runId, turnFailureRecorded);
    settlePromptTokenReservation(deps, promptTokenReservation);
    return runtimeRetry === "refused" ? providerRejectionError() : unavailableError();
  }
  const session = createGatewayStreamSession(ctx, dispatch, iterator);
  try {
    if (beginGatewayStream(session)) {
      await pumpGatewayStreamWithCancellation(deps, session);
    } else {
      // The gateway's stream is an async generator: nothing was sent before the first pull, and
      // the handshake failed before it, so the reservation is released, not kept as spent.
      releaseUndispatchedPromptBudget(ctx, deps, runId, promptTokenReservation);
    }
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
  const { cancellation, iterator } = session;
  const cancellationSignal = cancellation.signal;
  const cancelIterator = (): void => {
    void iterator.return?.();
  };
  cancellationSignal.addEventListener("abort", cancelIterator, { once: true });
  // A live turn keeps the same keep-alive the buffered answer always had (lab ledger F2): a model
  // that thinks before its first token, or generates a tool call the sidecar forwards only once it
  // is whole, leaves the runtime's connection silent for as long as that takes.
  const stopHeartbeat = sidecarSseHeartbeat(session.ctx, cancellation.transport);
  try {
    await pumpGatewayStream(session);
  } catch (error) {
    const failureCode = gatewayStreamFailureCode(error);
    const runtimeRetry = runtimeRetryFor(error, failureCode);
    const turnFailureRecorded =
      !cancellationSignal.aborted &&
      reportGatewayTurnFailure(session.ctx, deps, session.runId, {
        failureCode,
        runtimeRetry,
        error,
      });
    emitGatewayStreamFailureDiagnostic(
      session.ctx,
      deps,
      error,
      session.runId,
      turnFailureRecorded,
    );
    settleGatewayStreamError(session, runtimeRetry, outputRepairOf(error));
  } finally {
    stopHeartbeat();
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
  readonly cancellation: GatewayRequestCancellation;
  readonly iterator: AsyncIterator<GatewayStreamChunk>;
  readonly promptTokenReservation: PromptTokenReservation;
  readonly metrics: {
    completionTokens: number;
    promptTokens: number;
    outputBytes: number;
    previousDeltaEndedWithHighSurrogate: boolean;
    // #3878: the model reasoning forwarded so far, bounded apart from the answer's output budget.
    reasoningFrames: number;
    forwardedReasoningBytes: number;
    previousReasoningEndedWithHighSurrogate: boolean;
  };
}

function createGatewayStreamSession(
  ctx: RouteContext,
  dispatch: GatewayChatDispatchContext,
  iterator: AsyncIterator<GatewayStreamChunk>,
): GatewayStreamSession {
  const { deps, modelAlias, request, runId, cancellation, promptTokenReservation } = dispatch;
  return {
    ctx,
    deps,
    id: `chatcmpl-${randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
    modelId: modelAlias,
    request,
    runId,
    cancellation,
    iterator,
    promptTokenReservation,
    metrics: {
      completionTokens: 0,
      promptTokens: 0,
      outputBytes: 0,
      previousDeltaEndedWithHighSurrogate: false,
      reasoningFrames: 0,
      forwardedReasoningBytes: 0,
      previousReasoningEndedWithHighSurrogate: false,
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
  const opened = writeOpenAiSse(
    ctx,
    openAiStreamChunk(id, created, modelId, { role: "assistant" }, null),
    session.cancellation.transport,
  );
  if (!opened) {
    ctx.res.destroy();
    // The gateway's generator was never pulled: no provider call, so no repair can have run.
    recordSessionOutcome(session, "cancelled", settledRepair(undefined));
    return false;
  }
  return true;
}

function recordSessionOutcome(
  session: GatewayStreamSession,
  outcome: CodingSidecarGatewayRunOutcome,
  repair: RepairEvidence,
  limit?: "answer" | "reasoning",
): void {
  const { ctx, deps, runId, cancellation, metrics } = session;
  recordGatewayOutcome(
    ctx,
    deps,
    runId,
    cancellation,
    outcome,
    {
      completionTokens: metrics.completionTokens,
      outputBytes: metrics.outputBytes,
      reasoningFrames: metrics.reasoningFrames,
      forwardedReasoningBytes: metrics.forwardedReasoningBytes,
      ...(limit === undefined ? {} : { limit }),
    },
    repair,
  );
}

function writeSessionTerminal(
  session: GatewayStreamSession,
  finishReason: NormalizedResponse["finishReason"],
): void {
  const { ctx, id, created, modelId, metrics, cancellation } = session;
  writeStreamTerminal(
    { ctx, id, created, modelId, transport: cancellation.transport },
    finishReason,
    metrics.promptTokens,
    metrics.completionTokens,
  );
}

async function pumpGatewayStream(session: GatewayStreamSession): Promise<void> {
  const { cancellation, iterator } = session;
  const cancellationSignal = cancellation.signal;
  for (;;) {
    if (isGatewayRequestCancelled(cancellationSignal)) {
      await iterator.return?.();
      recordSessionOutcome(session, "cancelled", REPAIR_NOT_SETTLED);
      return;
    }
    const next = await iterator.next();
    if (cancellationSignal.aborted) {
      recordSessionOutcome(session, "cancelled", REPAIR_NOT_SETTLED);
      return;
    }
    if (next.done) break;
    const chunk = next.value;
    if (chunk.type !== "done") {
      if (await streamGatewayText(session, chunk)) continue;
      return;
    }
    await streamGatewayResponse(session, chunk.response);
    return;
  }
  // A stream without a terminal response must reach the shared diagnostic and turn-event path.
  throw new ProviderError("provider stream ended without a terminal response", 200);
}

/** Returns true when the stream may continue with the next chunk. */
function streamGatewayText(
  session: GatewayStreamSession,
  chunk: Exclude<GatewayStreamChunk, { readonly type: "done" }>,
): Promise<boolean> {
  return chunk.type === "delta"
    ? streamGatewayDelta(session, chunk.token)
    : streamGatewayReasoning(session, chunk.token);
}

/** Returns true when the stream may continue with the next chunk. */
function streamGatewayDelta(session: GatewayStreamSession, token: string): Promise<boolean> {
  const { request, metrics } = session;
  const deltaMetrics = incrementalUtf8ByteCount(token, metrics.previousDeltaEndedWithHighSurrogate);
  metrics.outputBytes += deltaMetrics.bytes;
  metrics.previousDeltaEndedWithHighSurrogate = deltaMetrics.endsWithHighSurrogate;
  metrics.completionTokens = Math.ceil(metrics.outputBytes / OUTPUT_BYTES_PER_TOKEN_LIMIT);
  const budget = { completionTokens: metrics.completionTokens, outputBytes: metrics.outputBytes };
  const overBudget = exceedsOutputBudget(budget, request.maxOutputTokens ?? 1);
  return forwardStreamText(session, { content: token }, overBudget ? "answer" : undefined);
}

// The reasoning passages one turn may carry: the first attempt that forwards reasoning and the
// gateway's one steered repair (#3873 F17, F23, option iii). The gateway forwards no further
// passage — a provider retry after forwarded reasoning streams its reasoning undelivered — so the
// second passage is the repair working, not an overgrown reasoning.
const REASONING_PASSAGES_PER_TURN = 2;

// #3878: the model's reasoning reaches the coding runtime as `delta.reasoning_content`, the field
// OpenCode's OpenAI-compatible provider turns into a reasoning part, as it arrives. It is bounded
// apart from the answer, by the same byte allowance per model attempt for the attempts a turn may
// carry, so a reasoning model keeps its whole answer budget and a provider that ignores its output
// limit still cannot stream without end.
async function streamGatewayReasoning(
  session: GatewayStreamSession,
  token: string,
): Promise<boolean> {
  const { request, metrics } = session;
  const counted = incrementalUtf8ByteCount(token, metrics.previousReasoningEndedWithHighSurrogate);
  const total = metrics.forwardedReasoningBytes + counted.bytes;
  const overBudget =
    total > outputByteBudget(request.maxOutputTokens ?? 1) * REASONING_PASSAGES_PER_TURN;
  const forwarded = await forwardStreamText(
    session,
    { reasoning_content: token },
    overBudget ? "reasoning" : undefined,
  );
  if (forwarded) {
    // Only bytes the runtime actually received count as forwarded (#3873 review).
    metrics.forwardedReasoningBytes = total;
    metrics.previousReasoningEndedWithHighSurrogate = counted.endsWithHighSurrogate;
    metrics.reasoningFrames += 1;
  }
  return forwarded;
}

// One text frame of a live turn, or its end: past a byte bound (`limit`: the answer's or the
// forwarded reasoning's) the turn ends with `length`, and a frame that no longer reaches the client
// ends it as cancelled. The gateway call has not settled at either point, so neither line can say
// whether a steered repair ran. Returns true when the stream may continue with the next chunk.
async function forwardStreamText(
  session: GatewayStreamSession,
  delta: Readonly<Record<string, string>>,
  limit: "answer" | "reasoning" | undefined,
): Promise<boolean> {
  const { ctx, id, created, modelId, iterator } = session;
  if (limit !== undefined) {
    await iterator.return?.();
    recordSessionOutcome(session, "output-limit", REPAIR_NOT_SETTLED, limit);
    writeSessionTerminal(session, "length");
    return false;
  }
  const wrote = writeOpenAiSse(
    ctx,
    openAiStreamChunk(id, created, modelId, delta, null),
    session.cancellation.transport,
  );
  if (!wrote) {
    ctx.res.destroy();
    await iterator.return?.();
    recordSessionOutcome(session, "cancelled", REPAIR_NOT_SETTLED);
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
    discardedPromptTokens(response),
  );
  settleStreamCompletionUsage(session, response, outcome, promptSettlement);
  if (exceedsOutputBudget(metrics, request.maxOutputTokens ?? 1)) {
    await iterator.return?.();
    recordSessionOutcome(session, "output-limit", settledRepair(response.outputRepair), "answer");
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
      session.cancellation.transport,
    );
    if (!wrote) {
      ctx.res.destroy();
      await iterator.return?.();
      recordSessionOutcome(session, "cancelled", settledRepair(response.outputRepair));
      return;
    }
  }
  writeSessionTerminal(session, response.finishReason);
  recordSessionOutcome(
    session,
    ctx.res.writableEnded && !ctx.res.destroyed ? "accepted" : "cancelled",
    settledRepair(response.outputRepair),
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
      ...answerShares(response),
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

/**
 * #3878: the turn's visible text and model reasoning share, as counts only. `reasoningBytes` is the
 * size of the reasoning the provider returned as the gateway measured it, so it stays visible where
 * the reasoning display is off and nothing was forwarded; `reasoningTokens` is the provider's own
 * count and absent unless the provider reports it.
 */
interface AnswerShares {
  readonly contentBytes: number;
  readonly reasoningBytes: number;
  readonly reasoningTokens?: number;
  readonly discardedAttemptCount?: number;
  readonly discardedPromptTokens?: number;
  readonly discardedCompletionTokens?: number;
}

function answerShares(response: NormalizedResponse): AnswerShares {
  const { reasoningBytes, reasoningTokens } = response.usage;
  const discarded = response.discardedAttemptUsage;
  return {
    contentBytes: Buffer.byteLength(response.content, "utf8"),
    reasoningBytes: reasoningBytes ?? 0,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(discarded === undefined
      ? {}
      : {
          discardedAttemptCount: discarded.attemptCount,
          discardedPromptTokens: discarded.promptTokens,
          discardedCompletionTokens: discarded.completionTokens,
        }),
  };
}

// A forwarded reasoning is bounded by the turn's output allowance in bytes, apart from the answer.
function exceedsReasoningBudget(response: NormalizedResponse, maxOutputTokens: number): boolean {
  return (
    response.reasoning !== undefined &&
    Buffer.byteLength(response.reasoning, "utf8") > outputByteBudget(maxOutputTokens)
  );
}

function discardedAttemptFields(shares: AnswerShares): {
  readonly discardedAttemptCount?: number;
  readonly discardedPromptTokens?: number;
  readonly discardedCompletionTokens?: number;
} {
  const { discardedAttemptCount, discardedPromptTokens, discardedCompletionTokens } = shares;
  if (
    discardedAttemptCount === undefined ||
    discardedPromptTokens === undefined ||
    discardedCompletionTokens === undefined
  ) {
    return {};
  }
  return { discardedAttemptCount, discardedPromptTokens, discardedCompletionTokens };
}

function logGatewayCompletionUsage(
  ctx: RouteContext,
  runId: string,
  metrics: { readonly completionTokens: number; readonly outputBytes: number } & AnswerShares,
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
        contentBytes: metrics.contentBytes,
        reasoningBytes: metrics.reasoningBytes,
        ...(metrics.reasoningTokens === undefined
          ? {}
          : { reasoningTokens: metrics.reasoningTokens }),
        ...discardedAttemptFields(metrics),
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}

function settleGatewayStreamError(
  session: GatewayStreamSession,
  runtimeRetry: RuntimeRetry,
  repair?: GatewayOutputRepairOutcome,
): void {
  if (session.cancellation.signal.aborted) {
    recordSessionOutcome(session, "cancelled", settledRepair(repair));
    return;
  }
  recordSessionOutcome(session, "failed", settledRepair(repair));
  if (runtimeRetry === "refused") {
    const { ctx, id, created, modelId, cancellation } = session;
    writeStreamRejection({ ctx, id, created, modelId, transport: cancellation.transport });
  } else {
    writeSessionTerminal(session, "error");
  }
}

function isGatewayRequestCancelled(signal: AbortSignal): boolean {
  return signal.aborted;
}

/** What a terminal chunk needs to know about its stream; both session shapes carry it. */
interface OpenAiSseStreamIdentity {
  readonly ctx: RouteContext;
  readonly id: string;
  readonly created: number;
  readonly modelId: string;
  readonly transport: SidecarSseTransport;
}

interface BufferedOpenAiStreamSession extends OpenAiSseStreamIdentity {
  readonly stopHeartbeat: () => void;
}

/** Returns undefined when the opening SSE frame could not be delivered; the response is destroyed. */
function beginBufferedOpenAiStream(
  ctx: RouteContext,
  modelId: string,
  transport: SidecarSseTransport,
): BufferedOpenAiStreamSession | undefined {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  ctx.res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  const opened = writeOpenAiSse(
    ctx,
    openAiStreamChunk(id, created, modelId, { role: "assistant" }, null),
    transport,
  );
  if (!opened) {
    ctx.res.destroy();
    return undefined;
  }
  return {
    ctx,
    id,
    created,
    modelId,
    transport,
    stopHeartbeat: sidecarSseHeartbeat(ctx, transport),
  };
}

// SSE comments that keep the runtime's connection alive while the model is silent, written through
// the shared protective path so a client that stops draining kills the stream like any frame.
function sidecarSseHeartbeat(ctx: RouteContext, transport: SidecarSseTransport): () => void {
  return startSseHeartbeat(ctx.res, SIDECAR_SSE_HEARTBEAT_MS, undefined, {
    controller: transport.backpressure,
    onBackpressure: transport.onBackpressure,
    correlationId: transport.correlationId,
  });
}

function completeBufferedOpenAiStream(
  session: BufferedOpenAiStreamSession,
  response: NormalizedResponse,
): typeof STREAMING {
  const { ctx, id, created, modelId, transport, stopHeartbeat } = session;
  stopHeartbeat();
  if (
    response.content.length > 0 ||
    response.toolCalls.length > 0 ||
    response.reasoning !== undefined
  ) {
    const wrote = writeOpenAiSse(
      ctx,
      openAiStreamChunk(id, created, modelId, bufferedAnswerDelta(response), null),
      transport,
    );
    if (!wrote) {
      ctx.res.destroy();
      return STREAMING;
    }
  }
  writeStreamTerminal(
    session,
    response.finishReason,
    response.usage.promptTokens,
    response.usage.completionTokens,
  );
  return STREAMING;
}

// The whole buffered answer as one streamed delta: the model's reasoning (#3878), then the answer
// and its tool calls, the order in which the runtime shows them.
function bufferedAnswerDelta(response: NormalizedResponse): Readonly<Record<string, unknown>> {
  return {
    ...(response.reasoning === undefined ? {} : { reasoning_content: response.reasoning }),
    ...(response.content.length === 0 ? {} : { content: response.content }),
    ...(response.toolCalls.length === 0 ? {} : { tool_calls: openAiToolCalls(response.toolCalls) }),
  };
}

function settleBufferedOpenAiStreamError(
  session: BufferedOpenAiStreamSession,
  finishReason: "error" | "length",
): typeof STREAMING {
  session.stopHeartbeat();
  writeStreamTerminal(session, finishReason, 0, 0);
  return STREAMING;
}

function settleBufferedOpenAiStreamRejection(
  session: BufferedOpenAiStreamSession,
): typeof STREAMING {
  session.stopHeartbeat();
  writeStreamRejection(session);
  return STREAMING;
}

// The turn's final answer when the provider rejected it for good: an error chunk the runtime reads
// as HTTP 400, then the stream's end.
function writeStreamRejection(stream: OpenAiSseStreamIdentity): void {
  const { ctx, transport } = stream;
  writeOpenAiSse(ctx, PROVIDER_REJECTION_CHUNK, transport);
  if (!ctx.res.writableEnded && !ctx.res.destroyed) ctx.res.end("data: [DONE]\n\n");
}

function bufferedOpenAiStream(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  modelId: string,
  response: NormalizedResponse,
): typeof STREAMING {
  const session = beginBufferedOpenAiStream(ctx, modelId, sidecarSseTransport(ctx, deps));
  return session === undefined ? STREAMING : completeBufferedOpenAiStream(session, response);
}

// False means the frame did not reach the client: either the response was already gone (the
// client's own `close` is the abort source that names it) or the shared path killed the stream for
// backpressure (its controller is). A caller that sees false stops producing; it never resumes.
function writeOpenAiSse(
  ctx: RouteContext,
  payload: Readonly<Record<string, unknown>>,
  transport: SidecarSseTransport,
): boolean {
  if (ctx.res.writableEnded || ctx.res.destroyed) return false;
  return writeOrDestroy(
    ctx.res,
    `data: ${JSON.stringify(payload)}\n\n`,
    transport.backpressure,
    transport.onBackpressure,
    transport.correlationId,
  );
}

function writeStreamTerminal(
  stream: OpenAiSseStreamIdentity,
  finishReason: NormalizedResponse["finishReason"],
  promptTokens: number,
  completionTokens: number,
): void {
  const { ctx, id, created, modelId, transport } = stream;
  writeOpenAiSse(ctx, openAiStreamChunk(id, created, modelId, {}, finishReason), transport);
  writeOpenAiSse(
    ctx,
    {
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
    },
    transport,
  );
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
  if (codingContextFits(result)) return result;
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

// One owner for the rule a coding run's prompt needs: the readiness projection of the default model
// and the start of a run with a model chosen in the picker both read it (#3603).
function codingContextFits(result: CodingWorkbenchSidecarGatewayResult): boolean {
  return (
    result.status === "available" &&
    Math.min(
      result.runMetadata.maxPromptTokens,
      result.runMetadata.inputTokenLimit ?? Number.POSITIVE_INFINITY,
    ) >= CODING_WORKBENCH_MINIMUM_CODING_CONTEXT_PROMPT_TOKENS
  );
}

/**
 * Why an available coding profile cannot hold a coding run's prompt, or undefined when it can
 * (#3603). While the automatic probe that could raise the window is still running, the shortfall
 * is not a verdict yet; the start then names the pending verification instead.
 */
export function codingContextShortfall(
  config: GatewayConfig | undefined,
  result: Extract<CodingWorkbenchSidecarGatewayResult, { readonly status: "available" }>,
): "model-context-window-insufficient" | "model-verification-pending" | undefined {
  if (codingContextFits(result)) return undefined;
  return config !== undefined && isCodingWorkbenchProbePending(config, result.modelAlias)
    ? "model-verification-pending"
    : "model-context-window-insufficient";
}

/**
 * The profile a coding run starts with, for the model chosen in the picker or the default one. A
 * model the gateway does not admit right now is a typed refusal that names the sidecar's reason
 * (#3565 Observation 17), never a bare Error the orchestrator can only report as
 * `authority-resolution-failed`; so is a model whose window cannot hold the run's prompt (#3603).
 */
export function admitCodingRunModel(
  config: GatewayConfig | undefined,
  modelId: string | undefined,
  reasoningEffort: ModelReasoningEffort | undefined,
): { readonly profileId: string; readonly reasoningEffort?: ModelReasoningEffort } {
  const resolved = resolveCodingSafeSidecarGatewayProfile(config, {
    ...(modelId === undefined ? {} : { modelId }),
  });
  if (resolved.status !== "available" || config === undefined) {
    throw new CodingRuntimeLaunchRejectedError(
      "model-unavailable",
      false,
      resolved.status === "available" ? "missing-config" : resolved.reason,
    );
  }
  const contextShortfall = codingContextShortfall(config, resolved);
  if (contextShortfall !== undefined) {
    throw new CodingRuntimeLaunchRejectedError("model-unavailable", false, contextShortfall);
  }
  return {
    profileId: resolved.modelAlias,
    ...admittedReasoningEffort(config, resolved.modelAlias, reasoningEffort),
  };
}

function admittedReasoningEffort(
  config: GatewayConfig,
  modelAlias: string,
  reasoningEffort: ModelReasoningEffort | undefined,
): { readonly reasoningEffort?: ModelReasoningEffort } {
  if (reasoningEffort === undefined) return {};
  const efforts = findConfiguredCapability(config, modelAlias)?.reasoningEfforts;
  if (efforts?.includes(reasoningEffort) !== true) {
    throw new CodingRuntimeLaunchRejectedError(
      "model-unavailable",
      false,
      "reasoning-effort-unavailable",
    );
  }
  return { reasoningEffort };
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
              ...declaredInputBound(result.runMetadata),
              ...(result.runMetadata.inputTokenLimit === undefined
                ? {}
                : {
                    availablePromptTokens: Math.min(
                      result.runMetadata.maxPromptTokens,
                      result.runMetadata.inputTokenLimit,
                    ),
                  }),
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

// Lab ledger F2 (#3873): a streamed request is answered live wherever the resolved profile streams
// (the model's capability streams and `codingStreaming` is not "off"), so the coding runtime sees
// the answer as the provider produces it instead of only once it exists. An injected stream seam
// streams; an injected buffered seam alone stands in for the whole gateway, which then has no
// stream to read.
function upstreamGatewayStreamingSupported(
  deps: UiHandlerDeps,
  advertisedSupport: boolean,
): boolean {
  if (deps.codingSidecarGatewayChatStreamFactory !== undefined) return true;
  return advertisedSupport && deps.codingSidecarGatewayChatFactory === undefined;
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
  return refuseGatewayToolContract(ctx, deps, authentication.runId, parsed);
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
    return {
      kind: "handled",
      result: refuseGatewayToolContract(ctx, deps, authentication.runId, parsed),
    };
  }
  if (
    isExactManagedToolSet(parsed.tools) &&
    isRuntimeReadinessProbe(parsed) &&
    registry?.claim(authentication.runId) === true
  ) {
    return {
      kind: "handled",
      result: fixedReadinessResponse(ctx, deps, modelAlias, parsed.stream === true),
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
          ...declaredInputBound(observed.bounds),
          admissiblePromptTokens: admissiblePromptTokens(observed.bounds),
          inputMessageCount: observed.parsed.messages.length,
          maxInputMessages: observed.bounds.maxInputMessages,
        }
      : undefined;
  logGatewayRejection(ctx, runId, validationError.status, reason, boundedEvidence);
  refuseReadinessChallenge(deps, runId, observed?.parsed);
  reportGatewayTurnRejection(ctx, deps, runId, validationError);
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
  "maxPromptTokens" | "maxOutputTokens" | "inputTokenLimit"
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
  return Math.min(
    bounds.maxPromptTokens - reservedWindowTokens(bounds),
    bounds.inputTokenLimit ?? Number.POSITIVE_INFINITY,
  );
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
        ...declaredInputBound(bounds),
        ...(bounds.inputTokenLimit === undefined
          ? {}
          : { admissiblePromptTokens: admissiblePromptTokens(bounds) }),
        estimatedPromptTokens,
        maxOutputTokens: admittedOutputTokens(bounds, estimatedPromptTokens),
        inputMessageCount: request.messages.length,
        droppedReasoningMessageCount: request.droppedReasoningMessageCount,
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
    const answer = forbiddenGatewayRequest();
    logGatewayRejection(ctx, authentication.runId, answer.status, "runtime-prompt-budget-denied");
    reportGatewayTurnRejection(ctx, deps, authentication.runId, answer);
    return Promise.resolve(answer);
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
  deps: UiHandlerDeps,
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
  return stream
    ? bufferedOpenAiStream(ctx, deps, modelId, response)
    : openAiResponse(modelId, response);
}
