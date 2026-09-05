import { randomUUID } from "node:crypto";
import {
  resolveCodingSafeSidecarGatewayProfile,
  type Gateway,
  type GatewayCallRequest,
  type GatewayConfig,
  type GatewayRequest,
  type GatewayStreamChunk,
  type ModelCapabilityPricing,
  type NormalizedToolCall,
  type NormalizedResponse,
  type ToolDefinition,
} from "@oscharko-dev/keiko-model-gateway";
import type {
  CodingWorkbenchModelSource,
  CodingWorkbenchSidecarGatewayRunMetadata,
  CodingWorkbenchSidecarGatewayResult,
  CodingWorkbenchSidecarGatewayUnavailableReason,
  ModelReasoningEffort,
} from "@oscharko-dev/keiko-contracts";
import { estimateTokensForSegments } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { CODING_WORKBENCH_MINIMUM_CODING_CONTEXT_PROMPT_TOKENS } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
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
  hasExactOpenCodeVisibleToolContract,
  OPENCODE_MODEL_VISIBLE_TOOL_NAMES,
} from "./coding-runtime/opencodeToolSchemas.js";
import { UNKNOWN_CORRELATION_ID } from "./correlation.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "./diagnostics-log.js";
import { readJsonObject } from "./files.js";
import { getServerLogger } from "./observability/index.js";
import { STREAMING, errorBody, type RouteContext, type RouteResult } from "./routes.js";
import { startSseHeartbeat } from "./sse.js";

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

// live-journey-readiness-1: KEIKO_QUALIFICATION_SPEND_BUDGET_USD previously had no reader anywhere
// in production — it was validated as test/manifest metadata but enforced no real-dollar ceiling
// before dispatch. `cumulativeSpendUsd` is a process-wide, in-memory USD ledger that accumulates
// ONLY from a completed call's REPORTED usage (never the pre-call estimate), so — unlike the
// per-run authority prompt-token budget — it never needs a settle/reconcile step: nothing
// provisional is ever booked into it, only real observed cost. The pre-call check previews
// `cumulative + this call's estimate` against the budget without mutating the ledger.
export const QUALIFICATION_SPEND_BUDGET_USD_ENV = "KEIKO_QUALIFICATION_SPEND_BUDGET_USD";
let cumulativeSpendUsd = 0;

export function _resetCumulativeSpendUsdForTests(): void {
  cumulativeSpendUsd = 0;
}

function qualificationSpendBudgetUsd(env: UiHandlerDeps["env"]): number | undefined {
  const raw = env[QUALIFICATION_SPEND_BUDGET_USD_ENV];
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function capabilityPricingFor(
  config: GatewayConfig,
  modelId: string,
): ModelCapabilityPricing | undefined {
  return config.capabilities?.find((capability) => capability.id === modelId)?.pricing;
}

function callCostUsd(
  pricing: ModelCapabilityPricing,
  promptTokens: number,
  completionTokens: number,
): number {
  return (
    (promptTokens / 1_000_000) * pricing.inputUsdPerMillionTokens +
    (completionTokens / 1_000_000) * pricing.outputUsdPerMillionTokens
  );
}

/** Body-free spend-ledger update: no prompt/response content, only the two token counts. */
function accumulateActualSpend(
  config: GatewayConfig,
  modelId: string,
  usage: Pick<NormalizedResponse["usage"], "promptTokens" | "completionTokens">,
): void {
  const pricing = capabilityPricingFor(config, modelId);
  if (pricing === undefined) return;
  cumulativeSpendUsd += callCostUsd(pricing, usage.promptTokens, usage.completionTokens);
}

type SpendBudgetRejectionReason = "spend-pricing-unavailable" | "spend-budget-exceeded";

/**
 * Fail-closed pre-call monetary ceiling. Absent when no budget is configured. A budget configured
 * against a model with no declared `pricing` fails closed before the first call rather than
 * silently treating the model as free.
 */
function spendBudgetRejectionFor(
  env: UiHandlerDeps["env"],
  config: GatewayConfig,
  modelId: string,
  estimatedPromptTokens: number,
  maxOutputTokens: number,
): SpendBudgetRejectionReason | undefined {
  const budget = qualificationSpendBudgetUsd(env);
  if (budget === undefined) return undefined;
  const pricing = capabilityPricingFor(config, modelId);
  if (pricing === undefined) return "spend-pricing-unavailable";
  const estimatedCostUsd = callCostUsd(pricing, estimatedPromptTokens, maxOutputTokens);
  return cumulativeSpendUsd + estimatedCostUsd > budget ? "spend-budget-exceeded" : undefined;
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

// #3390 closeout (AGENTS.md §8): every rejection this route can hand back gets ONE body-free
// activity-log line carrying the REASON, so a defect is reconstructable from the log alone instead
// of only the opaque HTTP status the client saw. `reason` is this closed vocabulary — never a raw
// message — and is threaded through every 400/403 rejection path below via `logGatewayRejection`.
const CODING_SIDECAR_GATEWAY_REJECTED_OP = "coding-sidecar.gateway.rejected";
// The readiness projection (`/api/coding-sidecar/gateway/profile`) demoting an otherwise
// "available" profile because its context window cannot survive a real request gets its own op:
// it is not a per-request rejection, it is a standing state of the profile itself.
const CODING_SIDECAR_GATEWAY_READINESS_OP = "coding-sidecar.gateway.readiness-insufficient";

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
  | "spend-pricing-unavailable"
  | "spend-budget-exceeded"
  | "unclassified-rejection";

/** Body-free: `reason` is closed, `runId` and every `extra` field are counts/ids, never text. */
function logGatewayRejection(
  ctx: RouteContext,
  runId: string | undefined,
  status: number,
  reason: CodingSidecarGatewayRejectionReason,
  extra?: Readonly<Record<string, unknown>>,
): void {
  getServerLogger().warn({
    category: "gateway",
    op: CODING_SIDECAR_GATEWAY_REJECTED_OP,
    correlationId: ctx.correlationId ?? UNKNOWN_CORRELATION_ID,
    status,
    extra: { reason, ...(runId === undefined ? {} : { runId }), ...extra },
  });
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
    return (request: GatewayRequest) => gateway.chat({ ...request, modelId });
  };
}

function defaultChatStreamFactoryFor(gateway: Gateway): CodingSidecarGatewayChatStreamFactory {
  return (_config, modelId) => {
    return (request: GatewayRequest) => gateway.chatStream({ ...request, modelId });
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
  const content = parseMessageContent(value.content);
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
function toolCatalogFor(
  tools: readonly ToolDefinition[] | undefined,
): GatewayCallRequest["toolCatalog"] {
  return isExactManagedToolSet(tools)
    ? createOpenCodeGatewayToolCatalogAdvertisement(Date.now())
    : undefined;
}

function toolRequestFields(
  parsed: CodingSidecarGatewayChatCompletionRequest,
): Pick<GatewayCallRequest, "toolCatalog"> {
  const toolCatalog = toolCatalogFor(parsed.tools);
  if (toolCatalog !== undefined) return { toolCatalog };
  return {};
}

function buildChatRequest(
  parsed: CodingSidecarGatewayChatCompletionRequest,
  modelAlias: string,
  cancellationSignal: AbortSignal,
  maxOutputTokens: number,
  correlationId: string | undefined,
  reasoningEffort: ModelReasoningEffort | undefined,
): GatewayCallRequest {
  return {
    modelId: modelAlias,
    messages: parsed.messages,
    ...toolRequestFields(parsed),
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
  deps: UiHandlerDeps,
  runId: string,
  outcome: CodingSidecarGatewayRunOutcome,
  completionTokens: number,
  outputBytes: number,
): void {
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

function promptTokenEstimate(parsed: CodingSidecarGatewayChatCompletionRequest): number {
  const segments = parsed.messages.map((message) => `${message.role}\n${message.content}`);
  if (parsed.tools === undefined) {
    return estimateTokensForSegments(segments);
  }
  return estimateTokensForSegments([...segments, JSON.stringify(parsed.tools)]);
}

function budgetValidationMessage(
  parsed: CodingSidecarGatewayChatCompletionRequest,
  runMetadata: CodingWorkbenchSidecarGatewayRunMetadata,
): string | undefined {
  if (parsed.messages.length > runMetadata.maxInputMessages) {
    return `Request body messages exceed profile maxInputMessages (${String(runMetadata.maxInputMessages)}).`;
  }
  const estimatedPromptTokens = promptTokenEstimate(parsed);
  if (estimatedPromptTokens > runMetadata.maxPromptTokens) {
    return `Request body estimated prompt tokens exceed profile maxPromptTokens (${String(runMetadata.maxPromptTokens)}).`;
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
): RouteResult | undefined {
  if (isRouteResult(parsed)) {
    return parsed;
  }
  const invalidSamplingMessage = samplingValidationMessage(parsed);
  if (invalidSamplingMessage !== undefined) {
    return badRequest(invalidSamplingMessage);
  }
  const invalidBudgetMessage = budgetValidationMessage(parsed, runMetadata);
  if (invalidBudgetMessage !== undefined) {
    return badRequest(invalidBudgetMessage);
  }
  if (!isMatchingModelAlias(parsed.model, modelAlias, runtimeAuthenticated)) {
    return {
      status: 400,
      body: errorBody("INVALID_MODEL", "Request model does not match the selected profile."),
    };
  }
  return undefined;
}

function emitGatewayFailureDiagnostic(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  error: unknown,
): void {
  emitServerDiagnostic(
    deps.diagnostics,
    serverDiagnosticFromError({
      correlationId: ctx.correlationId ?? UNKNOWN_CORRELATION_ID,
      operation: CODING_SIDECAR_GATEWAY_ROUTE,
      source: "coding-sidecar-gateway.chat",
      error,
      redact: (message) => String(deps.redactor(message)),
    }),
  );
}

/**
 * A mid-stream failure aborts an in-flight coding turn. Before this the cause went into a bare
 * `catch {}` — the pattern AGENTS.md §7 forbids — leaving `settleGatewayStreamError` to emit the SSE
 * error frame with nothing recorded anywhere, on the coding path. The frame and the run outcome are
 * unchanged; only the redacted cause is added, keyed by the request correlation id and separated from
 * the pre-stream failure by `source` so an operator can tell "the stream never opened" from "the
 * stream died after N deltas". `partialUsage` rides along through `serverDiagnosticFromError`, so an
 * interrupted turn's accumulated token counts stay visible instead of vanishing with the error.
 */
function emitGatewayStreamFailureDiagnostic(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  error: unknown,
): void {
  emitServerDiagnostic(
    deps.diagnostics,
    serverDiagnosticFromError({
      correlationId: ctx.correlationId ?? UNKNOWN_CORRELATION_ID,
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
}

type RuntimeAdapterKind = "model-gateway-sidecar" | "codex-cli-adapter";

function runtimeCapabilityAuthenticator(
  deps: UiHandlerDeps,
): RuntimeCapabilityAuthenticator | undefined {
  return deps.runtimeCapabilityAuthenticator;
}

function authenticatedRuntimeBinding(value: unknown):
  | {
      readonly runId: string;
      readonly adapterKind?: RuntimeAdapterKind | undefined;
      readonly modelProfileId?: string | undefined;
      readonly reasoningEffort?: ModelReasoningEffort | undefined;
    }
  | undefined {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.binding)) return undefined;
  if (typeof value.binding.runId !== "string" || value.binding.runId.length === 0) return undefined;
  const adapterKind = runtimeAdapterKind(value.binding.adapterKind);
  const effort = value.binding.reasoningEffort;
  return {
    runId: value.binding.runId,
    ...(adapterKind === undefined ? {} : { adapterKind }),
    ...(typeof value.binding.modelProfileId === "string"
      ? { modelProfileId: value.binding.modelProfileId }
      : {}),
    ...(isModelReasoningEffort(effort) ? { reasoningEffort: effort } : {}),
  };
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
  return (
    parsed.messages.length === 1 &&
    parsed.messages[0]?.role === "user" &&
    parsed.messages[0].content === OPENCODE_RUNTIME_READINESS_PROMPT
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
function toolContractMismatch(
  tools: readonly ToolDefinition[] | undefined,
): Readonly<Record<string, unknown>> {
  const expected = new Set<string>(OPENCODE_MODEL_VISIBLE_TOOL_NAMES);
  const received = new Set(tools?.map((tool) => tool.name) ?? []);
  return {
    expectedToolCount: expected.size,
    receivedToolCount: received.size,
    unexpectedToolNames: [...received].filter((name) => !expected.has(name)),
    missingToolNames: [...expected].filter((name) => !received.has(name)),
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
    timestamp: new Date(Date.now()).toISOString(),
    operation: CODING_SIDECAR_GATEWAY_ROUTE,
    source: "coding-sidecar-gateway.tool-contract",
    errorClass: "CodingSidecarGatewayToolContractRejection",
    message: "coding-sidecar-gateway-tool-contract-rejected",
    code,
  });
  logGatewayRejection(ctx, runId, 403, reason, toolContractMismatch(tools));
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
    ...(binding.adapterKind === undefined ? {} : { adapterKind: binding.adapterKind }),
    ...(binding.modelProfileId === undefined ? {} : { modelProfileId: binding.modelProfileId }),
    ...(binding.reasoningEffort === undefined ? {} : { reasoningEffort: binding.reasoningEffort }),
  };
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
  parsed: CodingSidecarGatewayChatCompletionRequest,
): boolean {
  const reserved = runtimeCapabilityAuthenticator(deps)?.reservePromptTokens?.(
    capability,
    promptTokenEstimate(parsed),
  );
  return promptReservationRunId(reserved) === runId;
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

function requestDeadlineMs(config: GatewayConfig, modelId: string): number {
  return config.providers.find((provider) => provider.modelId === modelId)?.timeoutMs ?? 30_000;
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
  const deadline = AbortSignal.timeout(requestDeadlineMs(config, modelId));
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
}

interface PinnedGatewayBinding {
  readonly config: GatewayConfig;
  readonly gateway: Gateway;
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
  const { modelAlias, upstreamStreamingSupported } = delivery;
  const cancellation = gatewayRequestCancellation(ctx, deps, binding.config, modelAlias, runId);
  const request = requestForGatewayDelivery(ctx, parsed, delivery, cancellation.signal);
  let bufferedStream: BufferedOpenAiStreamSession | undefined;
  try {
    if (parsed.stream && upstreamStreamingSupported) {
      return await streamGatewayChat(
        ctx,
        deps,
        binding,
        modelAlias,
        request,
        runId,
        cancellation.signal,
      );
    }
    if (parsed.stream) bufferedStream = beginBufferedOpenAiStream(ctx, modelAlias);
    return await executeBufferedGatewayChat(
      deps,
      binding,
      modelAlias,
      request,
      runId,
      cancellation.signal,
      bufferedStream,
    );
  } catch (error) {
    recordGatewayOutcome(deps, runId, cancellation.signal.aborted ? "cancelled" : "failed", 0, 0);
    emitGatewayFailureDiagnostic(ctx, deps, error);
    return bufferedStream === undefined
      ? unavailableError()
      : settleBufferedOpenAiStreamError(bufferedStream, "error");
  } finally {
    cancellation.dispose();
  }
}

async function executeBufferedGatewayChat(
  deps: UiHandlerDeps,
  binding: PinnedGatewayBinding,
  modelAlias: string,
  request: GatewayRequest,
  runId: string,
  cancellationSignal: AbortSignal,
  stream: BufferedOpenAiStreamSession | undefined,
): Promise<RouteResult | typeof STREAMING> {
  const response = await chatFactoryFor(deps, binding.gateway)(binding.config, modelAlias)(request);
  accumulateActualSpend(binding.config, modelAlias, response.usage);
  const metrics = outputMetrics(response);
  if (cancellationSignal.aborted) {
    recordGatewayOutcome(deps, runId, "cancelled", metrics.completionTokens, metrics.outputBytes);
    return stream === undefined
      ? unavailableError()
      : settleBufferedOpenAiStreamError(stream, "error");
  }
  if (exceedsOutputBudget(metrics, request.maxOutputTokens ?? 1)) {
    recordGatewayOutcome(
      deps,
      runId,
      "output-limit",
      metrics.completionTokens,
      metrics.outputBytes,
    );
    return stream === undefined
      ? unavailableError()
      : settleBufferedOpenAiStreamError(stream, "length");
  }
  recordGatewayOutcome(deps, runId, "accepted", metrics.completionTokens, metrics.outputBytes);
  return stream === undefined
    ? openAiResponse(modelAlias, response)
    : completeBufferedOpenAiStream(stream, response);
}

// Closed stream state machine keeps iterator, cancellation, and SSE backpressure transitions together.
async function streamGatewayChat(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  binding: PinnedGatewayBinding,
  modelId: string,
  request: GatewayRequest,
  runId: string,
  cancellationSignal: AbortSignal,
): Promise<RouteResult | typeof STREAMING> {
  let iterator: AsyncIterator<GatewayStreamChunk>;
  try {
    iterator = chatStreamFactoryFor(deps, binding.gateway)(
      binding.config,
      modelId,
    )(request)[Symbol.asyncIterator]();
  } catch (error) {
    recordGatewayOutcome(deps, runId, "failed", 0, 0);
    emitGatewayFailureDiagnostic(ctx, deps, error);
    return unavailableError();
  }
  const session = createGatewayStreamSession(
    ctx,
    deps,
    binding.config,
    modelId,
    request,
    runId,
    cancellationSignal,
    iterator,
  );
  if (!beginGatewayStream(session)) return STREAMING;
  const cancelIterator = (): void => {
    void iterator.return?.();
  };
  cancellationSignal.addEventListener("abort", cancelIterator, { once: true });
  try {
    await pumpGatewayStream(session);
  } catch (error) {
    emitGatewayStreamFailureDiagnostic(ctx, deps, error);
    settleGatewayStreamError(session);
  } finally {
    cancellationSignal.removeEventListener("abort", cancelIterator);
  }
  return STREAMING;
}

interface GatewayStreamSession {
  readonly ctx: RouteContext;
  readonly deps: UiHandlerDeps;
  readonly id: string;
  readonly created: number;
  readonly modelId: string;
  /** live-journey-readiness-1: carries pricing lookup through to the final usage-bearing chunk. */
  readonly config: GatewayConfig;
  readonly request: GatewayRequest;
  readonly runId: string;
  readonly cancellationSignal: AbortSignal;
  readonly iterator: AsyncIterator<GatewayStreamChunk>;
  readonly metrics: {
    completionTokens: number;
    promptTokens: number;
    outputBytes: number;
    previousDeltaEndedWithHighSurrogate: boolean;
  };
}

function createGatewayStreamSession(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  config: GatewayConfig,
  modelId: string,
  request: GatewayRequest,
  runId: string,
  cancellationSignal: AbortSignal,
  iterator: AsyncIterator<GatewayStreamChunk>,
): GatewayStreamSession {
  return {
    ctx,
    deps,
    id: `chatcmpl-${randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
    modelId,
    config,
    request,
    runId,
    cancellationSignal,
    iterator,
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
  const { deps, runId, metrics } = session;
  recordGatewayOutcome(deps, runId, outcome, metrics.completionTokens, metrics.outputBytes);
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
  recordSessionOutcome(session, "failed");
  writeSessionTerminal(session, "error");
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
  const { ctx, id, created, modelId, config, request, iterator, metrics } = session;
  const outcome = outputMetrics(response);
  metrics.completionTokens = outcome.completionTokens;
  metrics.outputBytes = outcome.outputBytes;
  metrics.promptTokens = response.usage.promptTokens;
  accumulateActualSpend(config, modelId, response.usage);
  if (exceedsOutputBudget(outcome, request.maxOutputTokens ?? 1)) {
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
  recordSessionOutcome(session, "accepted");
  writeSessionTerminal(session, response.finishReason);
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
    result.status !== "available" ||
    result.runMetadata.maxPromptTokens >= CODING_WORKBENCH_MINIMUM_CODING_CONTEXT_PROMPT_TOKENS
  ) {
    return result;
  }
  getServerLogger().warn({
    category: "gateway",
    op: CODING_SIDECAR_GATEWAY_READINESS_OP,
    correlationId: ctx.correlationId ?? UNKNOWN_CORRELATION_ID,
    extra: {
      reason: "model-context-window-insufficient",
      maxPromptTokens: result.runMetadata.maxPromptTokens,
      minimumRequiredPromptTokens: CODING_WORKBENCH_MINIMUM_CODING_CONTEXT_PROMPT_TOKENS,
    },
  });
  return { status: "unavailable", reason: "model-context-window-insufficient" };
}

export function handleCodingSidecarGatewayProfile(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): RouteResult {
  return { status: 200, body: gatewayReadinessProjection(ctx, deps) };
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
  runId: string,
  validationError: RouteResult,
): void {
  logGatewayRejection(
    ctx,
    runId,
    validationError.status,
    classifyBadRequestReason(validationError),
  );
}

async function runHandleCodingSidecarGatewayChatCompletions(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult | typeof STREAMING> {
  const authentication = authenticateGatewayRequest(ctx, deps);
  if (isRouteResult(authentication)) return authentication;
  const resolved = resolveGatewayProfile(
    deps,
    gatewayProfileModelIdForAuthentication(authentication),
  );
  if (!isAvailableGatewayProfile(resolved)) {
    return unavailableGatewayProfile(ctx, deps, resolved, authentication);
  }
  const parsed = await readChatCompletionRequest(ctx, resolved.result.runMetadata.maxRequestBytes);
  const validationError = validationErrorForChatRequest(
    parsed,
    resolved.result.modelAlias,
    resolved.result.runMetadata,
    authentication.runtimeAuthenticated,
  );
  if (validationError !== undefined) {
    logChatRequestRejection(ctx, authentication.runId, validationError);
    return validationError;
  }
  if (isRouteResult(parsed)) {
    return parsed;
  }
  const admission = runtimeGatewayAdmissionResponse(
    ctx,
    deps,
    parsed,
    authentication,
    resolved.result.modelAlias,
  );
  if (admission.kind === "handled") return admission.result;
  return executeBudgetedGatewayChat(ctx, deps, resolved, parsed, authentication, {
    modelAlias: resolved.result.modelAlias,
    maxOutputTokens: resolved.result.runMetadata.maxOutputTokens,
    upstreamStreamingSupported: upstreamGatewayStreamingSupported(
      deps,
      resolved.result.supportsStreaming,
    ),
    ...(authentication.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: authentication.reasoningEffort }),
  });
}

function executeBudgetedGatewayChat(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  binding: PinnedGatewayBinding,
  parsed: CodingSidecarGatewayChatCompletionRequest,
  authentication: { readonly capability: string; readonly runId: string },
  profile: {
    readonly modelAlias: string;
    readonly maxOutputTokens: number;
    readonly upstreamStreamingSupported: boolean;
  },
): Promise<RouteResult | typeof STREAMING> {
  const spendRejection = spendBudgetRejectionFor(
    deps.env,
    binding.config,
    profile.modelAlias,
    promptTokenEstimate(parsed),
    profile.maxOutputTokens,
  );
  if (spendRejection !== undefined) {
    logGatewayRejection(ctx, authentication.runId, 403, spendRejection);
    return Promise.resolve(forbiddenGatewayRequest());
  }
  if (!reserveGatewayPromptBudget(deps, authentication.capability, authentication.runId, parsed)) {
    logGatewayRejection(ctx, authentication.runId, 403, "runtime-prompt-budget-denied");
    return Promise.resolve(forbiddenGatewayRequest());
  }
  return executeGatewayChat(ctx, deps, binding, parsed, authentication.runId, profile);
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
