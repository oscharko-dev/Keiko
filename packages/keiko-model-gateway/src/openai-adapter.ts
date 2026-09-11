// Zero-dependency OpenAI-compatible HTTP adapter built on globalThis.fetch and
// AbortSignal. fetch, clock, request-id, and cost class are injected so tests run
// with no network I/O and no real time. The raw provider body is never echoed into
// an error; only a redacted, status-level summary is surfaced.

import {
  AuthenticationError,
  CancelledError,
  ContextOverflowError,
  ERROR_CODES,
  GatewayEgressError,
  GatewayError,
  MalformedToolCallError,
  ModelRefusalError,
  ProviderError,
  RateLimitError,
  TimeoutError,
  TransportError,
  type GatewayEgressErrorCode,
} from "@oscharko-dev/keiko-security/errors/gateway";
import { apiKeyHeaderValue, DEFAULT_API_KEY_HEADER_NAME, trimTrailingSlash } from "./config.js";
import {
  gatewayFetch,
  OutboundHttpEgressError,
  readJsonCapped,
  readSseStream,
  SseIdleTimeoutError,
  type OutboundHttpEgressErrorCode,
} from "./http.js";
import {
  createGatewayToolCatalogBridge,
  retainMeasuredCatalogFailureUsage,
} from "./toolCatalogBridge.js";
import { bindNormalizedToolCalls, normalizeChatResponse, textFromContent } from "./normalize.js";
import { redact } from "@oscharko-dev/keiko-security";
import { assertValidGatewaySamplingParameters } from "./types.js";
import { providerOutputTokenLimit } from "./output-token-limit.js";
import {
  openAiCompatiblePromptMessage,
  openAiCompatiblePromptTools,
  type OpenAiCompatiblePromptMessage,
} from "./prompt-token-accounting.js";
import {
  logEndpointHost,
  logErrorKind,
  logLevelEnabled,
  logTimer,
  resolveLogSink,
  withCorrelationId,
  type ModelGatewayLogContext,
  type ModelGatewayLogSink,
} from "./observability.js";
import type {
  CostClass,
  FinishReason,
  GatewayRequest,
  GatewayStreamChunk,
  ModelProviderConfig,
  NormalizedResponse,
  NormalizedToolCall,
  ProviderAdapter,
  StreamReadBounds,
  ToolDefinition,
} from "./types.js";

const PROVIDER_EMPTY_ASSISTANT_STATUS = 200;
const GATEWAY_EGRESS_CODES: Record<OutboundHttpEgressErrorCode, GatewayEgressErrorCode> = {
  PROXY_UNREACHABLE: ERROR_CODES.PROXY_UNREACHABLE,
  PROXY_AUTH_REQUIRED: ERROR_CODES.PROXY_AUTH_REQUIRED,
  PROXY_EGRESS_FAILED: ERROR_CODES.PROXY_EGRESS_FAILED,
  PROXY_BLOCKED_BY_POLICY: ERROR_CODES.PROXY_BLOCKED_BY_POLICY,
  TLS_CA_FAILURE: ERROR_CODES.TLS_CA_FAILURE,
};

const GATEWAY_EGRESS_MESSAGES: Record<OutboundHttpEgressErrorCode, string> = {
  PROXY_UNREACHABLE: "configured proxy is unreachable",
  PROXY_AUTH_REQUIRED: "configured proxy requires authentication",
  PROXY_EGRESS_FAILED: "configured proxy failed outbound egress",
  PROXY_BLOCKED_BY_POLICY: "configured proxy blocked outbound egress",
  TLS_CA_FAILURE: "TLS certificate verification failed for outbound egress",
};

export interface AdapterDeps {
  readonly fetchImpl?: typeof fetch | undefined;
  readonly requestId: string;
  readonly costClass: CostClass;
  readonly now?: (() => number) | undefined;
  // Activity-log sink (ADR-0019: a local port, see `observability.ts`). Unset means no-op.
  readonly log?: ModelGatewayLogSink | undefined;
  // The enclosing operation's correlation id, stamped on every line this adapter produces —
  // including the transport lines, since the sink handed to `gatewayFetch` is already bound to
  // it. Unset keeps the previous behaviour exactly.
  readonly logContext?: ModelGatewayLogContext | undefined;
}

// THE ATTEMPT LINE for a chat completion, mirroring `EmbeddingDispatchFields` /
// `openai-embedding-adapter.ts`'s `logDispatch` field-for-field: written before the socket work
// starts, so a hung provider call leaves the same evidence the embedding ladder does instead of
// the silence `http.gateway.fetch.*` alone cannot fill for a real chat call (AdapterDeps carried
// no sink at all before this change).
interface ChatDispatchFields {
  readonly endpoint: string | undefined;
  readonly modelId: string;
  readonly messageCount: number;
  // UTF-8 BYTES on the wire, not `String.length`'s UTF-16 code units — see the identical note on
  // `EmbeddingDispatchFields`.
  readonly bodyBytes: number;
  // A read with bounds (ADR-0003): `timeoutMs` is then its silence bound, `readBudgetMs` its budget.
  readonly timeoutMs: number;
  readonly stream: boolean;
  readonly readBudgetMs?: number;
}

// `info`, not `debug`: a line that only appears once the operator has already reproduced the hang
// under a raised threshold is not evidence of the hang.
//
// Named `logChatDispatch`, deliberately NOT `logDispatch`: `scripts/generate-op-catalog.mjs`'s
// POSITIONAL_OP_HELPERS table matches a call site by function name alone and has an existing
// `{ name: "logDispatch", category: "embedding" }` entry for the embedding module's identically
// shaped helper. Reusing that name here would silently mislabel every op this function emits as
// category "embedding" in the generated catalog instead of "gateway".
function logChatDispatch(log: ModelGatewayLogSink, op: string, fields: ChatDispatchFields): void {
  if (!logLevelEnabled(log, "info")) return;
  log.write({ level: "info", category: "gateway", op, extra: { ...fields } });
}

function cancellationWasDeadline(signal: AbortSignal | undefined): boolean {
  return (
    signal?.aborted === true &&
    signal.reason instanceof DOMException &&
    signal.reason.name === "TimeoutError"
  );
}

function requestAbortError(
  signal: AbortSignal,
  modelId: string,
  secrets: readonly string[],
  phase = "",
): CancelledError | TimeoutError {
  const suffix = phase.length === 0 ? "" : ` ${phase}`;
  return cancellationWasDeadline(signal)
    ? new TimeoutError(`request for '${modelId}' timed out${suffix}`, secrets)
    : new CancelledError(`request for '${modelId}' cancelled${suffix}`, secrets);
}

interface ChatRequestBody {
  readonly model: string;
  readonly messages: readonly OpenAiCompatiblePromptMessage[];
  readonly tools?: unknown;
  readonly response_format?: unknown;
  readonly temperature?: number;
  readonly top_p?: number;
  readonly seed?: number;
  readonly reasoning_effort?: string;
  readonly max_tokens?: number;
  readonly max_completion_tokens?: number;
  readonly stream?: boolean;
  readonly stream_options?: { readonly include_usage: boolean };
}

interface DispatchedResponse {
  readonly response: Response;
  readonly signal: AbortSignal;
  // Clears the timers of the request's deadline; every dispatched request ends with one call.
  readonly dispose: () => void;
}

// A request's deadline. Without read bounds it is the attempt's `timeoutMs` for the whole request,
// as always. With them (ADR-0003) the provider must START its response within `silenceMs` and the
// whole read ends at `budgetMs`, however live: a long generation that keeps producing is no longer
// cut off at `timeoutMs` and generated a second time (coding run 30), and a silent one still ends.
// Both fire a TimeoutError DOMException, which `requestAbortError` maps onto the typed, retryable
// TimeoutError.
interface RequestDeadline {
  readonly signal: AbortSignal;
  readonly responseStarted: () => void;
  readonly dispose: () => void;
}

function noop(): void {
  // A deadline without timers of its own has nothing to settle.
}

function timedAbort(
  ms: number,
  message: string,
): { readonly signal: AbortSignal; readonly dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException(message, "TimeoutError"));
  }, ms);
  return {
    signal: controller.signal,
    dispose: (): void => {
      clearTimeout(timer);
    },
  };
}

function requestDeadline(
  timeoutMs: number,
  bounds: StreamReadBounds | undefined,
  cancel: AbortSignal | undefined,
): RequestDeadline {
  const withCancel = (signals: readonly AbortSignal[]): AbortSignal =>
    AbortSignal.any(cancel === undefined ? [...signals] : [...signals, cancel]);
  if (bounds === undefined) {
    return {
      signal: withCancel([AbortSignal.timeout(timeoutMs)]),
      responseStarted: noop,
      dispose: noop,
    };
  }
  const start = timedAbort(bounds.silenceMs, "the provider did not start its response in time");
  const budget = timedAbort(bounds.budgetMs, "the provider response outlasted its budget");
  return {
    signal: withCancel([start.signal, budget.signal]),
    responseStarted: start.dispose,
    dispose: (): void => {
      start.dispose();
      budget.dispose();
    },
  };
}

// GEN-AI-GATEWAY-002 (RB-4): honor Azure deployment routing for chat providers instead of silently
// misrouting an Azure-configured provider to the OpenAI-compatible path. Mirrors the voice adapters'
// joinAzureDeploymentUrl. `apiVersion` is guaranteed present for the azure style by config-time
// validation (assertProviderEndpointVersion enforces the biconditional). Both branches trim a
// trailing slash first, exactly like the sibling adapters — a file/env-authored base URL ending in
// "/" otherwise yields '//chat/completions', which LiteLLM answers with a 404 (LiteLLM production
// audit).
function chatCompletionsUrl(config: ModelProviderConfig): string {
  const trimmed = trimTrailingSlash(config.baseUrl);
  if (config.endpointStyle === "azure-openai-deployment") {
    return `${trimmed}/openai/deployments/${encodeURIComponent(
      config.modelId,
    )}/chat/completions?api-version=${encodeURIComponent(config.apiVersion ?? "")}`;
  }
  return `${trimmed}/chat/completions`;
}

// Always returns the array shape: the plain-string case is handled at the call site so this
// helper itself never mixes return types (sonarjs/function-return-type).
type ProviderGatewayRequest = GatewayRequest & {
  readonly tools?: readonly ToolDefinition[] | undefined;
};

function toolsField(tools: readonly ToolDefinition[] | undefined): Pick<ChatRequestBody, "tools"> {
  if (tools === undefined) return {};
  return { tools: openAiCompatiblePromptTools(tools) };
}

function responseFormatField(
  request: ProviderGatewayRequest,
): Pick<ChatRequestBody, "response_format"> {
  const format = request.responseFormat;
  if (format?.type !== "json_schema") return {};
  return {
    response_format: {
      type: "json_schema",
      json_schema: {
        schema: format.schema,
        ...(format.name !== undefined ? { name: format.name } : {}),
        ...(format.strict !== undefined ? { strict: format.strict } : {}),
      },
    },
  };
}

// The four scalar sampling knobs the provider accepts unchanged from the gateway request; grouped
// so buildBody's own complexity stays under the repository ceiling (AGENTS.md §6).
function samplingFields(
  request: GatewayRequest,
): Pick<ChatRequestBody, "temperature" | "top_p" | "seed" | "reasoning_effort"> {
  return {
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.topP !== undefined ? { top_p: request.topP } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(request.reasoningEffort !== undefined ? { reasoning_effort: request.reasoningEffort } : {}),
  };
}

function buildBody(request: ProviderGatewayRequest, config: ModelProviderConfig): ChatRequestBody {
  assertValidGatewaySamplingParameters(request);
  return {
    model: request.modelId,
    messages: request.messages.map(openAiCompatiblePromptMessage),
    ...toolsField(request.tools),
    ...responseFormatField(request),
    ...samplingFields(request),
    ...providerOutputTokenLimit(request.maxOutputTokens, config),
  };
}

// Streaming body: identical to buildBody plus the OpenAI/Azure streaming flags.
// A stream read without bounds (a desktop chat stream) that stops producing data events
// (half-open socket, wedged proxy, stalled upstream) ends after this long without one, as a typed,
// retry-classified TimeoutError; its whole read stays bounded by `timeoutMs`. A read with bounds
// uses its own silence bound instead (ADR-0003). Exported for tests.
export const STREAM_IDLE_TIMEOUT_MS = 60_000;

// `include_usage` requests a final usage-only chunk so token accounting survives.
function buildStreamBody(
  request: ProviderGatewayRequest,
  config: ModelProviderConfig,
): ChatRequestBody {
  return {
    ...buildBody(request, config),
    stream: true,
    stream_options: { include_usage: true },
  };
}

const FINISH_REASONS: ReadonlySet<FinishReason> = new Set([
  "stop",
  "tool_calls",
  "length",
  "content_filter",
  "error",
  "cancelled",
]);

function firstStreamChoice(chunk: unknown): Record<string, unknown> | undefined {
  if (!isRecord(chunk) || !Array.isArray(chunk.choices)) {
    return undefined;
  }
  const choices = chunk.choices as readonly unknown[];
  const choice = choices[0];
  return isRecord(choice) ? choice : undefined;
}

// Extracts the assistant content delta from a streaming chunk, when present.
function deltaFromChunk(chunk: unknown): string | undefined {
  const choice = firstStreamChoice(chunk);
  const delta = choice !== undefined && isRecord(choice.delta) ? choice.delta : undefined;
  if (delta === undefined || !("content" in delta)) {
    return undefined;
  }
  const content = textFromContent(delta.content);
  return content.length > 0 ? content : undefined;
}

function finishReasonFromChunk(chunk: unknown): FinishReason | undefined {
  const choice = firstStreamChoice(chunk);
  const raw = choice?.finish_reason;
  return typeof raw === "string" && FINISH_REASONS.has(raw as FinishReason)
    ? (raw as FinishReason)
    : undefined;
}

function nonNegativeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

// Extracts prompt/completion token counts from the include_usage final chunk.
function usageFromChunk(chunk: unknown): { prompt: number; completion: number } | undefined {
  if (!isRecord(chunk) || !isRecord(chunk.usage)) {
    return undefined;
  }
  return {
    prompt: nonNegativeCount(chunk.usage.prompt_tokens),
    completion: nonNegativeCount(chunk.usage.completion_tokens),
  };
}

interface ToolCallDeltaEntry {
  readonly id: string;
  readonly name: string;
  readonly argumentsText: string;
}
type ToolCallAccumulator = Map<number, ToolCallDeltaEntry>;

// Standard OpenAI-compatible streaming shape: `delta.tool_calls` carries one fragment per call,
// indexed by `index`, with `id`/`function.name` arriving once and `function.arguments` arriving as
// concatenated JSON-text fragments across chunks.
function toolCallDeltasFromChunk(chunk: unknown): readonly unknown[] | undefined {
  const choice = firstStreamChoice(chunk);
  const delta = choice !== undefined && isRecord(choice.delta) ? choice.delta : undefined;
  const raw = delta?.tool_calls;
  return Array.isArray(raw) ? raw : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonEmptyOrFallback(value: string | undefined, fallback: string): string {
  return value === undefined || value.length === 0 ? fallback : value;
}

function toolCallDeltaFields(raw: unknown): {
  id: string | undefined;
  name: string | undefined;
  argumentsText: string | undefined;
} {
  const record = isRecord(raw) ? raw : {};
  const fn = isRecord(record.function) ? record.function : undefined;
  return {
    id: stringOrUndefined(record.id),
    name: stringOrUndefined(fn?.name),
    argumentsText: stringOrUndefined(fn?.arguments),
  };
}

function mergedToolCallDelta(
  existing: ToolCallDeltaEntry | undefined,
  raw: unknown,
): ToolCallDeltaEntry {
  const delta = toolCallDeltaFields(raw);
  return {
    id: nonEmptyOrFallback(delta.id, existing?.id ?? ""),
    name: nonEmptyOrFallback(delta.name, existing?.name ?? ""),
    argumentsText: (existing?.argumentsText ?? "") + nonEmptyOrFallback(delta.argumentsText, ""),
  };
}

function applyToolCallDelta(accumulator: ToolCallAccumulator, chunk: unknown): void {
  const deltas = toolCallDeltasFromChunk(chunk);
  if (deltas === undefined) return;
  for (const raw of deltas) {
    if (!isRecord(raw) || typeof raw.index !== "number") continue;
    accumulator.set(raw.index, mergedToolCallDelta(accumulator.get(raw.index), raw));
  }
}

// The accumulated tool-call fragments in the wire shape of a whole answer, ordered by index, so the
// buffered path's own normalizer parses them (normalize.ts `parseNormalizedToolCalls`).
function rawToolCalls(accumulator: ToolCallAccumulator): readonly Record<string, unknown>[] {
  return [...accumulator.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, entry]) => ({
      id: entry.id,
      type: "function",
      function: { name: entry.name, arguments: entry.argumentsText },
    }));
}

function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (header === null) {
    return null;
  }
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Locally defined (not in @oscharko-dev/keiko-security's gateway error taxonomy) for the same
// reason GatewayToolCatalogError lives in toolCatalogBridge.ts rather than there: it is
// gateway-internal, thrown and caught entirely within this package. Never the provider's fault —
// the gateway's OWN redaction pass refused to keep walking a pathologically deep response body —
// so recordProviderFailure (gateway.ts) excludes it from circuit breaker accounting the same way
// it already excludes CancelledError/ConfigInvalidError (review findings on PR #3394 against
// gateway.ts:161 and openai-adapter.ts:444: an untyped RangeError from this recursion used to slip
// through both). Extends MalformedToolCallError so it carries a real, already-catalogued
// GATEWAY_MALFORMED_TOOL_CALL code and is redacted/retryable=false like every sibling GatewayError,
// without minting a new ERROR_CODES entry for one call site. Deterministic on the payload shape, so
// retrying the identical response can never succeed.
export class ResponseRedactionError extends MalformedToolCallError {}

// KEIKO-0778 sibling (see qualityIntelligence/redaction.ts and promptEnhancement/redaction.ts,
// which already fix the identical defect for their own deepRedact): without a ceiling, a
// pathologically deep tool-call-arguments or JSON-mode structured-output payload drives this
// recursion into an uncaught, untyped RangeError instead of the typed GatewayError every other
// gateway failure surfaces. No cycle guard is needed here: this value always originates from
// JSON.parse (normalize.ts), whose output is a tree, never a graph. 32 mirrors the sibling ceiling
// exactly — it comfortably covers any real tool schema or structured-output shape while
// empirically staying well clear of the engine's own stack limit (this repeatedly overflowed at
// ~3,000 levels of nesting in this runtime; a well-formed production payload is nowhere near even
// this constant, let alone that limit).
const MAX_REDACT_DEPTH = 32;

function redactUnknown(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (depth >= MAX_REDACT_DEPTH) {
    throw new ResponseRedactionError(
      "gateway response payload exceeds the maximum redaction depth",
      secrets,
    );
  }
  if (typeof value === "string") {
    return redact(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item, secrets, depth + 1));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactUnknown(item, secrets, depth + 1)]),
    );
  }
  return value;
}

function redactRecord(
  value: Record<string, unknown> | null,
  secrets: readonly string[],
): Record<string, unknown> | null {
  return value === null ? null : (redactUnknown(value, secrets) as Record<string, unknown>);
}

function redactToolCall(call: NormalizedToolCall, secrets: readonly string[]): NormalizedToolCall {
  return {
    ...call,
    name: redact(call.name, secrets),
    arguments: redactUnknown(call.arguments, secrets) as Record<string, unknown>,
  };
}

function redactResponse(
  response: NormalizedResponse,
  secrets: readonly string[],
): NormalizedResponse {
  return {
    ...response,
    content: redact(response.content, secrets),
    toolCalls: response.toolCalls.map((call) => redactToolCall(call, secrets)),
    structuredOutput: redactRecord(response.structuredOutput, secrets),
  };
}

function providerReportedUsage(payload: unknown): boolean {
  if (!isRecord(payload) || !isRecord(payload.usage)) return false;
  return [payload.usage.prompt_tokens, payload.usage.completion_tokens].every(
    (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
  );
}

function bindCatalogResponse(
  response: NormalizedResponse,
  secrets: readonly string[],
  bind: (calls: readonly NormalizedToolCall[]) => readonly NormalizedToolCall[],
  usageReported: boolean,
): NormalizedResponse {
  try {
    return bindNormalizedToolCalls(redactResponse(response, secrets), bind);
  } catch (error) {
    if (usageReported) retainMeasuredCatalogFailureUsage(error, response.usage);
    throw error;
  }
}

function configuredSecrets(secrets: readonly string[]): readonly string[] {
  return secrets.filter((secret) => secret.length > 0);
}

function longestSecretPrefixSuffix(value: string, secrets: readonly string[]): number {
  let longest = 0;
  for (const secret of secrets) {
    const maxLength = Math.min(value.length, secret.length - 1);
    for (let length = maxLength; length > longest; length -= 1) {
      if (value.endsWith(secret.slice(0, length))) {
        longest = length;
        break;
      }
    }
  }
  return longest;
}

function assertUsableAssistantResponse(
  response: NormalizedResponse,
  modelId: string,
  secrets: readonly string[],
): void {
  if (response.content.trim().length > 0 || response.toolCalls.length > 0) {
    return;
  }
  throw new ProviderError(
    `provider returned an empty assistant response for '${modelId}'`,
    PROVIDER_EMPTY_ASSISTANT_STATUS,
    secrets,
  );
}

function errorSignal(payload: unknown): string {
  const error = isRecord(payload) && isRecord(payload.error) ? payload.error : payload;
  if (!isRecord(error)) {
    return "";
  }
  return [error.code, error.type, error.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

const CONTEXT_OVERFLOW_SIGNAL =
  /context[_ -]?length[_ -]?exceeded|context window|context.*exceed|maximum context|too many tokens|prompt too long|context overflow/;

function isContextOverflow(status: number, payload: unknown): boolean {
  if (status !== 400 && status !== 413 && status !== 422) {
    return false;
  }
  return CONTEXT_OVERFLOW_SIGNAL.test(errorSignal(payload));
}

function isModelRefusal(payload: unknown): boolean {
  return /content[_ -]?filter|refus|safety|policy/.test(errorSignal(payload));
}

function mapHttpError(
  response: Response,
  modelId: string,
  secrets: readonly string[],
  payload: unknown,
): never {
  mapProviderFailure(response.status, retryAfterMs(response), modelId, secrets, payload, false);
}

// One mapping for a provider failure, whether it arrived as the response's HTTP status or as an
// error frame inside a stream that had already started.
function mapProviderFailure(
  status: number,
  retryAfter: number | null,
  modelId: string,
  secrets: readonly string[],
  payload: unknown,
  streamed: boolean,
): never {
  if (isContextOverflow(status, payload)) {
    throw new ContextOverflowError(`provider reported context overflow for '${modelId}'`, secrets);
  }
  if (isModelRefusal(payload)) {
    throw new ModelRefusalError(`provider refused the request for '${modelId}'`, secrets);
  }
  if (status === 401 || status === 403) {
    throw new AuthenticationError(`provider rejected credentials for '${modelId}'`, secrets);
  }
  if (status === 429) {
    throw new RateLimitError(`provider rate limited '${modelId}'`, retryAfter, secrets, status);
  }
  const reported = streamed
    ? `reported status ${String(status)} mid-stream`
    : `returned HTTP ${String(status)}`;
  throw new ProviderError(`provider ${reported} for '${modelId}'`, status, secrets);
}

// A failure the provider, or a proxy such as LiteLLM, writes into a stream it has already started:
// `data: {"error": {"message", "type", "param", "code"}}`, where LiteLLM's `code` is the upstream
// HTTP status as a string. It maps exactly like the same failure at the start of the response, so
// a rate limit mid-stream stays a retryable RateLimitError instead of reading as an empty answer.
function throwOnStreamedFailure(chunk: unknown, modelId: string, secrets: readonly string[]): void {
  if (!isRecord(chunk) || !isRecord(chunk.error)) return;
  mapProviderFailure(
    streamedFailureStatus(chunk, chunk.error),
    null,
    modelId,
    secrets,
    chunk,
    true,
  );
}

// What a failure frame without a status says, first match wins: the terminal failures before the
// rate limit, so an overflow, a rejected key or a malformed request is never retried as an upstream
// failure and generated again (PR #3452 review). OpenAI and Azure name a failure in `code`, `type`
// and `message`; only a proxy such as LiteLLM writes its HTTP status.
const STREAMED_FAILURE_SIGNALS: readonly (readonly [RegExp, number])[] = [
  [CONTEXT_OVERFLOW_SIGNAL, 400],
  [/invalid[_ -]?api[_ -]?key|authentication/, 401],
  [/permission/, 403],
  [/rate[_ -]?limit|too many requests/, 429],
  [/invalid[_ -]?request/, 400],
];

// The status a failure frame reports: LiteLLM's `code` is the upstream HTTP status as a string. A
// frame without one is classified by what it says, and one that says nothing known reports an
// upstream failure (502).
function streamedFailureStatus(chunk: unknown, error: Record<string, unknown>): number {
  const code = typeof error.code === "number" ? error.code : Number(error.code);
  if (Number.isInteger(code) && code >= 400 && code <= 599) return code;
  const signal = errorSignal(chunk);
  return STREAMED_FAILURE_SIGNALS.find(([pattern]) => pattern.test(signal))?.[1] ?? 502;
}

function apiKeyHeaders(config: ModelProviderConfig): Record<string, string> {
  const headerName = config.apiKeyHeaderName ?? DEFAULT_API_KEY_HEADER_NAME;
  return { [headerName]: apiKeyHeaderValue(headerName, config.apiKey) };
}

function mapOutboundEgressError(
  error: unknown,
  secrets: readonly string[],
): GatewayEgressError | undefined {
  if (!(error instanceof OutboundHttpEgressError)) return undefined;
  return new GatewayEgressError(
    GATEWAY_EGRESS_CODES[error.code],
    GATEWAY_EGRESS_MESSAGES[error.code],
    secrets,
  );
}

// Appends a chunk's content delta onto the accumulated response and the
// held-back suffix buffer, then yields the prefix that is now provably safe
// to emit (i.e. no longer a possible prefix of a configured secret).
function* emitRedactedDelta(
  content: string,
  buffer: { pending: string },
  activeSecrets: readonly string[],
  secrets: readonly string[],
  acc: { content: string },
): Generator<string> {
  acc.content += content;
  buffer.pending += content;
  const holdLength = longestSecretPrefixSuffix(buffer.pending, activeSecrets);
  if (buffer.pending.length === holdLength) {
    return;
  }
  const emitLength = buffer.pending.length - holdLength;
  const emitNow = buffer.pending.slice(0, emitLength);
  buffer.pending = buffer.pending.slice(emitLength);
  yield redact(emitNow, secrets);
}

interface StreamAccumulator {
  content: string;
  refusal: string;
  finishReason: FinishReason;
  prompt: number;
  completion: number;
  // The provider's own usage record, kept as it came, so the streamed answer is normalized exactly
  // like a whole one.
  usage: Record<string, unknown> | undefined;
  readonly toolCalls: ToolCallAccumulator;
}

function newStreamAccumulator(): StreamAccumulator {
  return {
    content: "",
    refusal: "",
    finishReason: "stop",
    prompt: 0,
    completion: 0,
    usage: undefined,
    toolCalls: new Map(),
  };
}

// A streamed refusal arrives as `delta.refusal` text; the answer is refused when any arrived.
function refusalFromChunk(chunk: unknown): string {
  const choice = firstStreamChoice(chunk);
  const delta = choice !== undefined && isRecord(choice.delta) ? choice.delta : undefined;
  return typeof delta?.refusal === "string" ? delta.refusal : "";
}

// The streamed answer in the shape of a whole chat completion, so it runs through exactly the
// normalization a buffered answer does: refusal, content filter, structured output and tool calls.
function streamedPayload(acc: StreamAccumulator): Record<string, unknown> {
  const toolCalls = rawToolCalls(acc.toolCalls);
  const message = {
    role: "assistant",
    content: acc.content,
    ...(acc.refusal.length > 0 ? { refusal: acc.refusal } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
  return {
    choices: [{ message, finish_reason: acc.finishReason }],
    ...(acc.usage === undefined ? {} : { usage: acc.usage }),
  };
}

// An endpoint that answers a streamed request with the whole body at once (a proxy route that
// ignores `stream`) is read as the whole answer it is.
function answeredWholeBody(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").toLowerCase().includes("application/json");
}

// The timing of one streamed read, for its outcome line: when its first data event came and the
// longest wait for one, on the log clock (never the injected clock, which usage latency uses).
interface StreamReport {
  readonly elapsed: () => number;
  dataEvents: number;
  firstDataMs: number | undefined;
  maxGapMs: number;
  lastDataMs: number;
}

function newStreamReport(): StreamReport {
  return { elapsed: logTimer(), dataEvents: 0, firstDataMs: undefined, maxGapMs: 0, lastDataMs: 0 };
}

function recordDataEvent(report: StreamReport): void {
  const now = report.elapsed();
  report.firstDataMs ??= now;
  report.maxGapMs = Math.max(report.maxGapMs, now - report.lastDataMs);
  report.lastDataMs = now;
  report.dataEvents += 1;
}

type StreamReadOutcome = "completed" | "whole-body" | "stalled" | "failed";

function streamReadOutcome(error: unknown): StreamReadOutcome {
  return error instanceof TimeoutError ? "stalled" : "failed";
}

// What one streamed read needs from its call.
interface StreamRead {
  readonly request: GatewayRequest;
  readonly config: ModelProviderConfig;
  readonly secrets: readonly string[];
  readonly signal: AbortSignal;
  readonly bounds: StreamReadBounds | undefined;
  readonly bindCalls: (calls: readonly NormalizedToolCall[]) => readonly NormalizedToolCall[];
  readonly start: number;
}

function streamReadFields(
  read: StreamRead,
  report: StreamReport,
  outcome: StreamReadOutcome,
): Readonly<Record<string, unknown>> {
  return {
    modelId: read.config.modelId,
    outcome,
    dataEvents: report.dataEvents,
    ...(report.firstDataMs === undefined ? {} : { firstDataMs: report.firstDataMs }),
    maxGapMs: report.maxGapMs,
    silenceMs: read.bounds?.silenceMs ?? STREAM_IDLE_TIMEOUT_MS,
    ...(read.bounds === undefined ? {} : { readBudgetMs: read.bounds.budgetMs }),
  };
}

// Records the finish-reason/usage/refusal/tool-call deltas carried on a streaming chunk onto the
// in-flight response accumulator, when present.
function applyChunkMetadata(chunk: unknown, acc: StreamAccumulator): void {
  const finish = finishReasonFromChunk(chunk);
  if (finish !== undefined) acc.finishReason = finish;
  const usage = usageFromChunk(chunk);
  if (usage !== undefined && isRecord(chunk) && isRecord(chunk.usage)) {
    acc.prompt = usage.prompt;
    acc.completion = usage.completion;
    acc.usage = chunk.usage;
  }
  acc.refusal += refusalFromChunk(chunk);
  applyToolCallDelta(acc.toolCalls, chunk);
}

// Emits whatever content is still held in the buffer once the stream ends —
// nothing further can arrive to complete a held-back secret prefix.
function* flushPendingBuffer(
  buffer: { pending: string },
  secrets: readonly string[],
): Generator<string> {
  if (buffer.pending.length === 0) {
    return;
  }
  yield redact(buffer.pending, secrets);
}

export class OpenAiAdapter implements ProviderAdapter {
  private readonly now: () => number;
  private readonly log: ModelGatewayLogSink;

  constructor(private readonly deps: AdapterDeps) {
    this.now = deps.now ?? Date.now;
    this.log = withCorrelationId(resolveLogSink(deps.log), deps.logContext?.correlationId);
  }

  call = async (
    request: GatewayRequest,
    config: ModelProviderConfig,
  ): Promise<NormalizedResponse> => {
    const secrets = [config.apiKey, config.baseUrl];
    if (request.cancellationSignal?.aborted === true) {
      throw requestAbortError(
        request.cancellationSignal,
        config.modelId,
        secrets,
        "before dispatch",
      );
    }
    const start = this.now();
    const catalog = createGatewayToolCatalogBridge(request, this.now, this.log);
    const dispatched = await this.dispatch(
      { ...request, tools: catalog.tools.length === 0 ? undefined : catalog.tools },
      config,
      secrets,
    );
    try {
      const { response } = dispatched;
      if (!response.ok) {
        const errorPayload = await this.readErrorBody(response, config, secrets, dispatched.signal);
        mapHttpError(response, config.modelId, secrets, errorPayload);
      }
      const payload = await this.readBody(response, config, secrets, dispatched.signal);
      return this.finishedResponse(payload, request, config, secrets, catalog.bindCalls, start);
    } finally {
      dispatched.dispose();
    }
  };

  // Streaming chat path (Layer 1): yields redacted content-delta tokens as they arrive, then a
  // terminal `done` with the assembled, redacted, catalog-bound NormalizedResponse. Tool calls are
  // accumulated from `choices[0].delta.tool_calls` fragments across chunks and bound against the
  // advertised catalog only once fully assembled at `done` — never exposed mid-stream, and never
  // reaching the caller unbound if the catalog rejects them (catalog.bindCalls throws, so this
  // generator throws before yielding `done`). With `bounds` it is the read of a buffered attempt
  // (ADR-0003): their silence and budget bound the read instead of one `timeoutMs`.
  callStream = async function* (
    this: OpenAiAdapter,
    request: GatewayRequest,
    config: ModelProviderConfig,
    bounds?: StreamReadBounds,
  ): AsyncGenerator<GatewayStreamChunk> {
    const secrets = [config.apiKey, config.baseUrl];
    if (request.cancellationSignal?.aborted === true) {
      throw requestAbortError(
        request.cancellationSignal,
        config.modelId,
        secrets,
        "before dispatch",
      );
    }
    const start = this.now();
    const catalog = createGatewayToolCatalogBridge(request, this.now, this.log);
    const dispatched = await this.dispatch(
      { ...request, tools: catalog.tools.length === 0 ? undefined : catalog.tools },
      config,
      secrets,
      true,
      bounds,
    );
    try {
      const { response } = dispatched;
      if (!response.ok) {
        const errorPayload = await this.readErrorBody(response, config, secrets, dispatched.signal);
        mapHttpError(response, config.modelId, secrets, errorPayload);
      }
      const read: StreamRead = {
        request,
        config,
        secrets,
        signal: dispatched.signal,
        bounds,
        bindCalls: catalog.bindCalls,
        start,
      };
      yield* answeredWholeBody(response)
        ? this.wholeBodyChunks(response, read)
        : this.streamedChunks(response, read);
    } finally {
      dispatched.dispose();
    }
  };

  // Reads the SSE stream into `acc`, yielding redacted content tokens. A suffix that matches the
  // start of a configured secret is held until the next delta proves it safe or completes the
  // secret so redaction can match it. The wait for every data event is bounded (the read's silence
  // bound, or STREAM_IDLE_TIMEOUT_MS without bounds), and an error frame inside the stream ends it
  // with the failure it reports.
  private async *streamDeltas(
    response: Response,
    read: StreamRead,
    acc: StreamAccumulator,
    report: StreamReport,
  ): AsyncGenerator<string> {
    const buffer = { pending: "" };
    const activeSecrets = configuredSecrets(read.secrets);
    const silenceMs = read.bounds?.silenceMs ?? STREAM_IDLE_TIMEOUT_MS;
    try {
      for await (const chunk of readSseStream(response, undefined, silenceMs, read.signal)) {
        recordDataEvent(report);
        throwOnStreamedFailure(chunk, read.config.modelId, read.secrets);
        const content = deltaFromChunk(chunk);
        if (content !== undefined) {
          yield* emitRedactedDelta(content, buffer, activeSecrets, read.secrets, acc);
        }
        applyChunkMetadata(chunk, acc);
      }
      yield* flushPendingBuffer(buffer, read.secrets);
    } catch (error) {
      throw this.withPartialUsage(
        this.mapStreamError(error, read.config, read.secrets, read.signal),
        acc,
      );
    }
  }

  private async *streamedChunks(
    response: Response,
    read: StreamRead,
  ): AsyncGenerator<GatewayStreamChunk> {
    const acc = newStreamAccumulator();
    const report = newStreamReport();
    try {
      for await (const token of this.streamDeltas(response, read, acc, report)) {
        yield { type: "delta", token };
      }
    } catch (error) {
      this.logStreamRead(read, report, streamReadOutcome(error), error);
      throw error;
    }
    const answer = this.settledAnswer(read, report, "completed", streamedPayload(acc));
    yield { type: "done", response: answer };
  }

  private async *wholeBodyChunks(
    response: Response,
    read: StreamRead,
  ): AsyncGenerator<GatewayStreamChunk> {
    const report = newStreamReport();
    let payload: unknown;
    try {
      payload = await this.readBody(response, read.config, read.secrets, read.signal);
    } catch (error) {
      this.logStreamRead(read, report, streamReadOutcome(error), error);
      throw error;
    }
    const answer = this.settledAnswer(read, report, "whole-body", payload);
    if (answer.content.length > 0) yield { type: "delta", token: answer.content };
    yield { type: "done", response: answer };
  }

  // The answer a read settled on, logged as settled only once it is one: normalization can still
  // refuse it (a refusal, a content filter, an empty answer, a catalog bind failure), and a refused
  // answer is a failed read with its error kind, never a completed one (PR #3452 review).
  private settledAnswer(
    read: StreamRead,
    report: StreamReport,
    outcome: "completed" | "whole-body",
    payload: unknown,
  ): NormalizedResponse {
    let answer: NormalizedResponse;
    try {
      answer = this.finishedResponse(
        payload,
        read.request,
        read.config,
        read.secrets,
        read.bindCalls,
        read.start,
      );
    } catch (error) {
      this.logStreamRead(read, report, streamReadOutcome(error), error);
      throw error;
    }
    this.logStreamRead(read, report, outcome);
    return answer;
  }

  // The one normalization every answer goes through, read whole or over the stream: refusal and
  // content filter, structured output, the usable-answer check, redaction and catalog binding.
  private finishedResponse(
    payload: unknown,
    request: GatewayRequest,
    config: ModelProviderConfig,
    secrets: readonly string[],
    bindCalls: StreamRead["bindCalls"],
    start: number,
  ): NormalizedResponse {
    const normalized = normalizeChatResponse(
      payload,
      config.modelId,
      {
        requestId: this.deps.requestId,
        latencyMs: this.now() - start,
        costClass: this.deps.costClass,
      },
      request.responseFormat?.type === "json_schema",
    );
    assertUsableAssistantResponse(normalized, config.modelId, secrets);
    return bindCatalogResponse(normalized, secrets, bindCalls, providerReportedUsage(payload));
  }

  // One line per streamed read, body-free (ADR-0003): how it ended, how many data events it had,
  // when the first came, the longest wait for one and, for a read that did not settle, how long the
  // provider had been silent, against the bounds it ran under.
  private logStreamRead(
    read: StreamRead,
    report: StreamReport,
    outcome: StreamReadOutcome,
    error?: unknown,
  ): void {
    const settled = outcome === "completed" || outcome === "whole-body";
    if (settled && !logLevelEnabled(this.log, "info")) return;
    const durationMs = report.elapsed();
    this.log.write({
      level: settled ? "info" : "warn",
      category: "gateway",
      op: "chat.response.streamed",
      durationMs,
      ...(error === undefined ? {} : { errorKind: logErrorKind(error) }),
      extra: {
        ...streamReadFields(read, report, outcome),
        ...(settled ? {} : { silentForMs: durationMs - report.lastDataMs }),
      },
    });
  }

  // Retain the usage the stream had already accumulated (counts only, never
  // content) so a mid-stream failure does not silently discard cost data.
  private withPartialUsage(
    mapped: Error,
    acc: { content: string; prompt: number; completion: number },
  ): Error {
    if (mapped instanceof GatewayError && mapped.partialUsage === undefined) {
      mapped.partialUsage = {
        promptTokens: acc.prompt,
        completionTokens: acc.completion,
        streamedChars: acc.content.length,
      };
    }
    return mapped;
  }

  // A mid-stream failure keeps its gateway type (a failure frame the provider sent, a timeout, a
  // cancellation); an aborted request maps through its signal's reason; the transport-layer idle
  // marker maps onto the typed, secret-redacting TimeoutError, so retry and breaker see a timeout
  // rather than an anonymous transport fault; anything else is a TransportError.
  private mapStreamError(
    error: unknown,
    config: ModelProviderConfig,
    secrets: readonly string[],
    signal: AbortSignal,
  ): Error {
    if (error instanceof GatewayError) {
      return error;
    }
    if (signal.aborted) {
      return requestAbortError(signal, config.modelId, secrets, "while reading stream");
    }
    if (error instanceof SseIdleTimeoutError) {
      return new TimeoutError(
        `provider stream for '${config.modelId}' produced no data event for ${String(
          error.idleTimeoutMs,
        )}ms`,
        secrets,
      );
    }
    const egressError = mapOutboundEgressError(error, secrets);
    if (egressError !== undefined) {
      return egressError;
    }
    return new TransportError(`stream read failed for '${config.modelId}'`, secrets);
  }

  private async dispatch(
    request: ProviderGatewayRequest,
    config: ModelProviderConfig,
    secrets: readonly string[],
    stream = false,
    bounds?: StreamReadBounds,
  ): Promise<DispatchedResponse> {
    const url = chatCompletionsUrl(config);
    const body = JSON.stringify(
      stream ? buildStreamBody(request, config) : buildBody(request, config),
    );
    const headers = {
      "content-type": "application/json",
      ...apiKeyHeaders(config),
    };
    logChatDispatch(this.log, "chat.request.dispatch", {
      endpoint: logEndpointHost(url),
      modelId: config.modelId,
      messageCount: request.messages.length,
      bodyBytes: Buffer.byteLength(body, "utf8"),
      timeoutMs: bounds?.silenceMs ?? config.timeoutMs,
      stream,
      ...(bounds === undefined ? {} : { readBudgetMs: bounds.budgetMs }),
    });
    const deadline = requestDeadline(config.timeoutMs, bounds, request.cancellationSignal);
    try {
      const response = await gatewayFetch(url, {
        method: "POST",
        headers,
        body,
        signal: deadline.signal,
        fetchImpl: this.deps.fetchImpl,
        log: this.log,
        ...(config.egress !== undefined ? { egress: config.egress } : {}),
      });
      deadline.responseStarted();
      return { response, signal: deadline.signal, dispose: deadline.dispose };
    } catch (error) {
      deadline.dispose();
      throw this.mapDispatchError(error, config, deadline.signal, secrets);
    }
  }

  private mapDispatchError(
    error: unknown,
    config: ModelProviderConfig,
    signal: AbortSignal,
    secrets: readonly string[],
  ): Error {
    if (signal.aborted) {
      return requestAbortError(signal, config.modelId, secrets);
    }
    const egressError = mapOutboundEgressError(error, secrets);
    if (egressError !== undefined) {
      return egressError;
    }
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return new TimeoutError(`request for '${config.modelId}' timed out`, secrets);
    }
    return new TransportError(`transport failure contacting '${config.modelId}'`, secrets);
  }

  private async readBody(
    response: Response,
    config: ModelProviderConfig,
    secrets: readonly string[],
    signal: AbortSignal,
  ): Promise<unknown> {
    try {
      return await readJsonCapped(response);
    } catch {
      if (signal.aborted) {
        throw requestAbortError(signal, config.modelId, secrets, "while reading body");
      }
      throw new TransportError(`provider sent an unreadable body for '${config.modelId}'`, secrets);
    }
  }

  private async readErrorBody(
    response: Response,
    config: ModelProviderConfig,
    secrets: readonly string[],
    signal: AbortSignal,
  ): Promise<unknown> {
    try {
      return await readJsonCapped(response);
    } catch {
      if (signal.aborted) {
        throw requestAbortError(signal, config.modelId, secrets, "while reading error body");
      }
      return null;
    }
  }
}
