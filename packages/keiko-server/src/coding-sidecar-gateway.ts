import { randomUUID } from "node:crypto";
import {
  Gateway,
  resolveCodingSafeSidecarGatewayProfile,
  type GatewayConfig,
  type GatewayRequest,
  type GatewayStreamChunk,
  type NormalizedToolCall,
  type NormalizedResponse,
  type ToolDefinition,
} from "@oscharko-dev/keiko-model-gateway";
import {
  estimateTokensForSegments,
  validateGatewaySamplingParameters,
  type CodingWorkbenchModelSource,
  type CodingWorkbenchSidecarGatewayRunMetadata,
  type CodingWorkbenchSidecarGatewayResult,
} from "@oscharko-dev/keiko-contracts";
import { currentGatewayConfig, type UiHandlerDeps } from "./deps.js";
import { OPENCODE_RUNTIME_MODEL_ALIAS } from "./coding-runtime/opencodeLaunchProfile.js";
import { hasExactOpenCodeVisibleToolContract } from "./coding-runtime/opencodeToolSchemas.js";
import { emitServerDiagnostic } from "./diagnostics-log.js";
import { readJsonObject } from "./files.js";
import { STREAMING, errorBody, type RouteContext, type RouteResult } from "./routes.js";

const ENABLE_TOKENS = new Set(["1", "true", "on", "yes", "enabled"]);
const CODING_SIDECAR_DISABLED_ENV = "KEIKO_CODING_SIDECAR_DISABLED";
const CODING_SIDECAR_GATEWAY_ERROR_CODE = "CODING_SIDECAR_UNAVAILABLE";
const CODING_SIDECAR_GATEWAY_ROUTE = "POST /api/coding-sidecar/gateway/chat/completions";
const OUTPUT_BYTES_PER_TOKEN_LIMIT = 4;

export interface OpenCodeGatewayReadinessRegistry {
  readonly claim: (runId: string) => boolean;
  readonly waitForObservedRequest: (runId: string, signal: AbortSignal) => Promise<boolean>;
  readonly clear: (runId: string) => void;
}

export function createOpenCodeGatewayReadinessRegistry(): OpenCodeGatewayReadinessRegistry {
  const observed = new Set<string>();
  const armed = new Set<string>();
  const waiters = new Map<string, (result: boolean) => void>();
  return {
    claim: (runId): boolean => {
      if (!armed.delete(runId)) return false;
      observed.add(runId);
      waiters.get(runId)?.(true);
      return true;
    },
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
    clear: (runId): void => {
      observed.delete(runId);
      armed.delete(runId);
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

/** Content-free, run-scoped accounting only; it must never be a durable request log. */
export interface CodingSidecarGatewayEvidenceAggregator {
  readonly record: (event: {
    readonly runId: string;
    readonly outcome: "accepted" | "cancelled" | "failed" | "output-limit";
    readonly completionTokens: number;
    readonly outputBytes: number;
  }) => void | Promise<void>;
}

interface ResolvedGatewayProfile {
  readonly config: GatewayConfig | undefined;
  readonly modelSource: CodingWorkbenchModelSource;
  readonly result: CodingWorkbenchSidecarGatewayResult;
}

type AvailableGatewayProfile = ResolvedGatewayProfile & {
  readonly config: GatewayConfig;
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

function chatFactoryFor(deps: UiHandlerDeps): CodingSidecarGatewayChatFactory {
  return deps.codingSidecarGatewayChatFactory ?? defaultChatFactory;
}

function defaultChatFactory(
  config: GatewayConfig,
  modelId: string,
): (request: GatewayRequest) => Promise<NormalizedResponse> {
  const gateway = new Gateway(config);
  return (request: GatewayRequest) => gateway.chat({ ...request, modelId });
}

function defaultChatStreamFactory(
  config: GatewayConfig,
  modelId: string,
): (request: GatewayRequest) => AsyncIterable<GatewayStreamChunk> {
  const gateway = new Gateway(config);
  return (request: GatewayRequest) => gateway.chatStream({ ...request, modelId });
}

function chatStreamFactoryFor(deps: UiHandlerDeps): CodingSidecarGatewayChatStreamFactory {
  return deps.codingSidecarGatewayChatStreamFactory ?? defaultChatStreamFactory;
}

function unavailableError(): RouteResult {
  return {
    status: 503,
    body: errorBody(CODING_SIDECAR_GATEWAY_ERROR_CODE, "Coding sidecar gateway is unavailable."),
  };
}

function parseMessageEntry(value: unknown): CodingSidecarGatewayChatMessage | undefined {
  const base = parseMessageBase(value);
  if (base === undefined) return undefined;
  const continuation = parseMessageContinuation(value, base.role);
  if (continuation === undefined) return undefined;
  return {
    ...base,
    ...continuation,
  };
}

function parseMessageBase(
  value: unknown,
): Pick<CodingSidecarGatewayChatMessage, "role" | "content"> | undefined {
  if (!isRecord(value) || typeof value.role !== "string" || typeof value.content !== "string") {
    return undefined;
  }
  return isCodingSidecarGatewayChatRole(value.role)
    ? { role: value.role, content: value.content }
    : undefined;
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

function parseMessages(value: unknown): readonly CodingSidecarGatewayChatMessage[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const messages: CodingSidecarGatewayChatMessage[] = [];
  for (const entry of value) {
    const message = parseMessageEntry(entry);
    if (message === undefined) {
      return undefined;
    }
    messages.push(message);
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

function buildChatRequest(
  parsed: CodingSidecarGatewayChatCompletionRequest,
  modelAlias: string,
  cancellationSignal: AbortSignal,
  maxOutputTokens: number,
): GatewayRequest {
  return {
    modelId: modelAlias,
    messages: parsed.messages,
    ...(parsed.tools === undefined ? {} : { tools: parsed.tools }),
    ...(parsed.temperature === undefined ? {} : { temperature: parsed.temperature }),
    ...(parsed.top_p === undefined ? {} : { topP: parsed.top_p }),
    cancellationSignal,
    maxOutputTokens,
  };
}

function parseChatRequest(
  body: Record<string, unknown>,
): CodingSidecarGatewayChatCompletionRequest | RouteResult | undefined {
  const messages = parseMessages(body.messages);
  if (messages === undefined) {
    return undefined;
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

function sidecarPolicyDisabled(deps: UiHandlerDeps): boolean {
  return envEnabled(deps.env[CODING_SIDECAR_DISABLED_ENV]);
}

function currentModelSource(deps: UiHandlerDeps): CodingWorkbenchModelSource {
  return (
    deps.codingSidecarGatewayModelSourceResolver?.() ??
    deps.codingSidecarGatewayModelSource ??
    "keiko-model-gateway"
  );
}

function resolveGatewayProfile(deps: UiHandlerDeps): ResolvedGatewayProfile {
  const config = currentGatewayConfig(deps);
  const modelSource = currentModelSource(deps);
  const result = resolveCodingSafeSidecarGatewayProfile(config, {
    deploymentPolicyDisabled: sidecarPolicyDisabled(deps),
    modelSource,
  });
  return { config, modelSource, result };
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
  outcome: "accepted" | "cancelled" | "failed" | "output-limit",
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
  const firstCodeUnit = token.charCodeAt(0);
  const lastCodeUnit = token.charCodeAt(token.length - 1);
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

function emitGatewayFailureDiagnostic(ctx: RouteContext, deps: UiHandlerDeps): void {
  emitServerDiagnostic(deps.diagnostics, {
    correlationId: ctx.correlationId ?? "unknown",
    timestamp: new Date(Date.now()).toISOString(),
    operation: CODING_SIDECAR_GATEWAY_ROUTE,
    source: "coding-sidecar-gateway.chat",
    errorClass: "CodingSidecarGatewayFailure",
    message: "sidecar-gateway-failed",
  });
}

interface RuntimeCapabilityAuthenticator {
  readonly authenticate: (capability: string, audience: "model-gateway" | "tool-facade") => unknown;
}

function runtimeCapabilityAuthenticator(
  deps: UiHandlerDeps,
): RuntimeCapabilityAuthenticator | undefined {
  return deps.runtimeCapabilityAuthenticator;
}

function authenticatedRuntimeRunId(value: unknown): string | undefined {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.binding)) return undefined;
  return typeof value.binding.runId === "string" && value.binding.runId.length > 0
    ? value.binding.runId
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

function forbiddenGatewayRequest(): RouteResult {
  return { status: 403, body: errorBody("FORBIDDEN", "Coding sidecar gateway request is denied.") };
}

function unauthorizedGatewayRequest(): RouteResult {
  return {
    status: 401,
    body: errorBody("UNAUTHORIZED", "Coding sidecar gateway authentication failed."),
  };
}

function authenticateGatewayRequest(
  ctx: RouteContext,
  deps: UiHandlerDeps,
):
  | { readonly runtimeAuthenticated: false; readonly runId: string }
  | { readonly runtimeAuthenticated: true; readonly runId: string }
  | RouteResult {
  if (hasOrigin(ctx)) return forbiddenGatewayRequest();
  const authenticator = runtimeCapabilityAuthenticator(deps);
  const capability = bearerCapability(ctx);
  if (authenticator === undefined || capability === undefined) return unauthorizedGatewayRequest();
  const runId = authenticatedRuntimeRunId(authenticator.authenticate(capability, "model-gateway"));
  if (runId === undefined) {
    return unauthorizedGatewayRequest();
  }
  // Runtime launch wires the readiness registry. Other callers still require the
  // same bound bearer, but do not claim the one-shot OpenCode readiness challenge.
  return { runtimeAuthenticated: gatewayReadinessRegistry(deps) !== undefined, runId };
}

function isAvailableGatewayProfile(
  resolved: ResolvedGatewayProfile,
): resolved is AvailableGatewayProfile {
  return resolved.result.status === "available" && resolved.config !== undefined;
}

function unavailableGatewayProfile(
  _ctx: RouteContext,
  _deps: UiHandlerDeps,
  _resolved: ResolvedGatewayProfile,
): RouteResult {
  return unavailableError();
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

async function executeGatewayChat(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  config: GatewayConfig,
  modelAlias: string,
  parsed: CodingSidecarGatewayChatCompletionRequest,
  runId: string,
  maxOutputTokens: number,
): Promise<RouteResult | typeof STREAMING> {
  const cancellation = gatewayRequestCancellation(ctx, deps, config, modelAlias, runId);
  const request = buildChatRequest(parsed, modelAlias, cancellation.signal, maxOutputTokens);
  try {
    if (parsed.stream) {
      return await streamGatewayChat(
        ctx,
        deps,
        config,
        modelAlias,
        request,
        runId,
        cancellation.signal,
      );
    }
    return await executeBufferedGatewayChat(
      deps,
      config,
      modelAlias,
      request,
      runId,
      cancellation.signal,
    );
  } catch (error) {
    void error;
    recordGatewayOutcome(deps, runId, cancellation.signal.aborted ? "cancelled" : "failed", 0, 0);
    emitGatewayFailureDiagnostic(ctx, deps);
    return unavailableError();
  } finally {
    cancellation.dispose();
  }
}

async function executeBufferedGatewayChat(
  deps: UiHandlerDeps,
  config: GatewayConfig,
  modelAlias: string,
  request: GatewayRequest,
  runId: string,
  cancellationSignal: AbortSignal,
): Promise<RouteResult> {
  const response = await chatFactoryFor(deps)(config, modelAlias)(request);
  const metrics = outputMetrics(response);
  if (cancellationSignal.aborted) {
    recordGatewayOutcome(deps, runId, "cancelled", metrics.completionTokens, metrics.outputBytes);
    return unavailableError();
  }
  if (exceedsOutputBudget(metrics, request.maxOutputTokens ?? 1)) {
    recordGatewayOutcome(
      deps,
      runId,
      "output-limit",
      metrics.completionTokens,
      metrics.outputBytes,
    );
    return unavailableError();
  }
  recordGatewayOutcome(deps, runId, "accepted", metrics.completionTokens, metrics.outputBytes);
  return openAiResponse(modelAlias, response);
}

// Closed stream state machine keeps iterator, cancellation, and SSE backpressure transitions together.
// eslint-disable-next-line complexity, max-lines-per-function
async function streamGatewayChat(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  config: GatewayConfig,
  modelId: string,
  request: GatewayRequest,
  runId: string,
  cancellationSignal: AbortSignal,
): Promise<RouteResult | typeof STREAMING> {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let iterator: AsyncIterator<GatewayStreamChunk>;
  try {
    iterator = chatStreamFactoryFor(deps)(config, modelId)(request)[Symbol.asyncIterator]();
  } catch {
    recordGatewayOutcome(deps, runId, "failed", 0, 0);
    emitGatewayFailureDiagnostic(ctx, deps);
    return unavailableError();
  }
  ctx.res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  if (!writeOpenAiSse(ctx, openAiStreamChunk(id, created, modelId, { role: "assistant" }, null))) {
    ctx.res.destroy();
    recordGatewayOutcome(deps, runId, "cancelled", 0, 0);
    return STREAMING;
  }
  const cancelIterator = (): void => {
    void iterator.return?.();
  };
  cancellationSignal.addEventListener("abort", cancelIterator, { once: true });
  let completionTokens = 0;
  let promptTokens = 0;
  let outputBytes = 0;
  let previousDeltaEndedWithHighSurrogate = false;
  try {
    for (;;) {
      if (isGatewayRequestCancelled(cancellationSignal)) {
        await iterator.return?.();
        recordGatewayOutcome(deps, runId, "cancelled", completionTokens, outputBytes);
        return STREAMING;
      }
      const next = await iterator.next();
      if (cancellationSignal.aborted) {
        recordGatewayOutcome(deps, runId, "cancelled", completionTokens, outputBytes);
        return STREAMING;
      }
      if (next.done) break;
      const chunk = next.value;
      if (chunk.type === "delta") {
        const deltaMetrics = incrementalUtf8ByteCount(
          chunk.token,
          previousDeltaEndedWithHighSurrogate,
        );
        outputBytes += deltaMetrics.bytes;
        previousDeltaEndedWithHighSurrogate = deltaMetrics.endsWithHighSurrogate;
        completionTokens = Math.ceil(outputBytes / OUTPUT_BYTES_PER_TOKEN_LIMIT);
        if (exceedsOutputBudget({ completionTokens, outputBytes }, request.maxOutputTokens ?? 1)) {
          await iterator.return?.();
          recordGatewayOutcome(deps, runId, "output-limit", completionTokens, outputBytes);
          writeStreamTerminal(ctx, id, created, modelId, "length", promptTokens, completionTokens);
          return STREAMING;
        }
        if (
          !writeOpenAiSse(
            ctx,
            openAiStreamChunk(id, created, modelId, { content: chunk.token }, null),
          )
        ) {
          ctx.res.destroy();
          await iterator.return?.();
          recordGatewayOutcome(deps, runId, "cancelled", completionTokens, outputBytes);
          return STREAMING;
        }
        continue;
      }
      const metrics = outputMetrics(chunk.response);
      completionTokens = metrics.completionTokens;
      outputBytes = metrics.outputBytes;
      promptTokens = chunk.response.usage.promptTokens;
      if (exceedsOutputBudget(metrics, request.maxOutputTokens ?? 1)) {
        await iterator.return?.();
        recordGatewayOutcome(deps, runId, "output-limit", completionTokens, outputBytes);
        writeStreamTerminal(ctx, id, created, modelId, "length", promptTokens, completionTokens);
        return STREAMING;
      }
      if (chunk.response.toolCalls.length > 0) {
        writeOpenAiSse(
          ctx,
          openAiStreamChunk(
            id,
            created,
            modelId,
            { tool_calls: openAiToolCalls(chunk.response.toolCalls) },
            null,
          ),
        );
      }
      recordGatewayOutcome(deps, runId, "accepted", completionTokens, outputBytes);
      writeStreamTerminal(
        ctx,
        id,
        created,
        modelId,
        chunk.response.finishReason,
        promptTokens,
        completionTokens,
      );
      return STREAMING;
    }
    recordGatewayOutcome(deps, runId, "failed", completionTokens, outputBytes);
    writeStreamTerminal(ctx, id, created, modelId, "error", promptTokens, completionTokens);
  } catch {
    if (!cancellationSignal.aborted) {
      recordGatewayOutcome(deps, runId, "failed", completionTokens, outputBytes);
      writeStreamTerminal(ctx, id, created, modelId, "error", promptTokens, completionTokens);
    } else {
      recordGatewayOutcome(deps, runId, "cancelled", completionTokens, outputBytes);
    }
  } finally {
    cancellationSignal.removeEventListener("abort", cancelIterator);
  }
  return STREAMING;
}

function isGatewayRequestCancelled(signal: AbortSignal): boolean {
  return signal.aborted;
}

function bufferedOpenAiStream(
  ctx: RouteContext,
  modelId: string,
  response: NormalizedResponse,
): typeof STREAMING {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  ctx.res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  writeOpenAiSse(ctx, openAiStreamChunk(id, created, modelId, { role: "assistant" }, null));
  if (response.content.length > 0 || response.toolCalls.length > 0) {
    writeOpenAiSse(
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

export function handleCodingSidecarGatewayProfile(
  _ctx: RouteContext,
  deps: UiHandlerDeps,
): RouteResult {
  return { status: 200, body: resolveGatewayProfile(deps).result };
}

export async function handleCodingSidecarGatewayChatCompletions(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult | typeof STREAMING> {
  const resolved = resolveGatewayProfile(deps);
  if (!isAvailableGatewayProfile(resolved)) return unavailableGatewayProfile(ctx, deps, resolved);
  const authentication = authenticateGatewayRequest(ctx, deps);
  if (isRouteResult(authentication)) return authentication;
  const parsed = await readChatCompletionRequest(ctx, resolved.result.runMetadata.maxRequestBytes);
  const validationError = validationErrorForChatRequest(
    parsed,
    resolved.result.modelAlias,
    resolved.result.runMetadata,
    authentication.runtimeAuthenticated,
  );
  if (validationError !== undefined) {
    return validationError;
  }
  if (isRouteResult(parsed)) {
    return parsed;
  }
  if (authentication.runtimeAuthenticated && !isExactManagedToolSet(parsed.tools)) {
    return forbiddenGatewayRequest();
  }
  if (authentication.runtimeAuthenticated) {
    const registry = gatewayReadinessRegistry(deps);
    if (registry?.claim(authentication.runId) === true) {
      return fixedReadinessResponse(ctx, resolved.result.modelAlias, parsed.stream === true);
    }
  }
  return executeGatewayChat(
    ctx,
    deps,
    resolved.config,
    resolved.result.modelAlias,
    parsed,
    authentication.runId,
    resolved.result.runMetadata.maxOutputTokens,
  );
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
