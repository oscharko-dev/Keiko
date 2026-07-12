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
  ModelRefusalError,
  ProviderError,
  RateLimitError,
  TimeoutError,
  TransportError,
  type GatewayEgressErrorCode,
} from "@oscharko-dev/keiko-security/errors/gateway";
import { apiKeyHeaderValue, DEFAULT_API_KEY_HEADER_NAME } from "./config.js";
import {
  gatewayFetch,
  OutboundHttpEgressError,
  readJsonCapped,
  readSseStream,
  SseIdleTimeoutError,
  type OutboundHttpEgressErrorCode,
} from "./http.js";
import { normalizeChatResponse, textFromContent } from "./normalize.js";
import { redact } from "@oscharko-dev/keiko-security";
import { assertValidGatewaySamplingParameters } from "./types.js";
import type {
  ChatMessageContentPart,
  CostClass,
  FinishReason,
  GatewayRequest,
  GatewayStreamChunk,
  ModelProviderConfig,
  NormalizedResponse,
  NormalizedToolCall,
  ProviderAdapter,
  UsageMetadata,
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
}

interface ChatRequestBody {
  readonly model: string;
  readonly messages: readonly {
    readonly role: string;
    readonly content: ChatRequestMessageContent | null;
    readonly tool_call_id?: string | undefined;
    readonly tool_calls?:
      | readonly {
          readonly id: string;
          readonly type: "function";
          readonly function: { readonly name: string; readonly arguments: string };
        }[]
      | undefined;
  }[];
  readonly tools?: unknown;
  readonly response_format?: unknown;
  readonly temperature?: number;
  readonly top_p?: number;
  readonly seed?: number;
  readonly stream?: boolean;
  readonly stream_options?: { readonly include_usage: boolean };
}

type ChatRequestMessageContent =
  | string
  | readonly (
      | { readonly type: "text"; readonly text: string }
      | { readonly type: "image_url"; readonly image_url: { readonly url: string } }
    )[];

// GEN-AI-GATEWAY-002 (RB-4): honor Azure deployment routing for chat providers instead of silently
// misrouting an Azure-configured provider to the OpenAI-compatible path. Mirrors the voice adapters'
// joinAzureDeploymentUrl. `apiVersion` is guaranteed present for the azure style by config-time
// validation (assertProviderEndpointVersion enforces the biconditional).
function chatCompletionsUrl(config: ModelProviderConfig): string {
  if (config.endpointStyle === "azure-openai-deployment") {
    const trimmed = config.baseUrl.endsWith("/") ? config.baseUrl.slice(0, -1) : config.baseUrl;
    return `${trimmed}/openai/deployments/${encodeURIComponent(
      config.modelId,
    )}/chat/completions?api-version=${encodeURIComponent(config.apiVersion ?? "")}`;
  }
  return `${config.baseUrl}/chat/completions`;
}

function buildMessageContent(
  content: string,
  parts: readonly ChatMessageContentPart[] | undefined,
): ChatRequestMessageContent {
  if (parts === undefined) return content;
  return parts.map((part) =>
    part.type === "text"
      ? { type: "text" as const, text: part.text }
      : { type: "image_url" as const, image_url: { url: part.image_url.url } },
  );
}

function buildMessage(
  message: GatewayRequest["messages"][number],
): ChatRequestBody["messages"][number] {
  const toolCalls = message.toolCalls?.map((call) => ({
    id: call.id,
    type: "function" as const,
    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  }));
  return {
    role: message.role,
    content:
      message.role === "assistant" && toolCalls !== undefined && toolCalls.length > 0
        ? null
        : buildMessageContent(message.content, message.contentParts),
    ...(message.role === "tool" && message.toolCallId !== undefined
      ? { tool_call_id: message.toolCallId }
      : {}),
    ...(toolCalls !== undefined && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

// eslint-disable-next-line complexity
function buildBody(request: GatewayRequest): ChatRequestBody {
  assertValidGatewaySamplingParameters(request);
  const messages = request.messages.map(buildMessage);
  const base: ChatRequestBody = { model: request.modelId, messages };
  const tools =
    request.tools === undefined
      ? undefined
      : request.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
  const responseFormat =
    request.responseFormat?.type === "json_schema"
      ? {
          type: "json_schema",
          json_schema: {
            schema: request.responseFormat.schema,
            ...(request.responseFormat.name !== undefined
              ? { name: request.responseFormat.name }
              : {}),
            ...(request.responseFormat.strict !== undefined
              ? { strict: request.responseFormat.strict }
              : {}),
          },
        }
      : undefined;
  return {
    ...base,
    ...(tools ? { tools } : {}),
    ...(responseFormat ? { response_format: responseFormat } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.topP !== undefined ? { top_p: request.topP } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
  };
}

// Streaming body: identical to buildBody plus the OpenAI/Azure streaming flags.
// A provider stream that stops producing chunks (half-open socket, wedged proxy,
// stalled upstream) previously hung until the CLIENT disconnected: the wall-clock
// deadline bounds only the buffered path's total call. 60s without a single SSE
// chunk is far beyond any healthy inter-token gap, so treat it as a typed,
// retry-classified TimeoutError. Exported for tests.
export const STREAM_IDLE_TIMEOUT_MS = 60_000;

// `include_usage` requests a final usage-only chunk so token accounting survives.
function buildStreamBody(request: GatewayRequest): ChatRequestBody {
  return {
    ...buildBody(request),
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

function redactUnknown(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return redact(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item, secrets));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactUnknown(item, secrets)]),
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

function isContextOverflow(response: Response, payload: unknown): boolean {
  if (response.status !== 400 && response.status !== 413 && response.status !== 422) {
    return false;
  }
  return /context[_ -]?length[_ -]?exceeded|context window|context.*exceed|maximum context|too many tokens|prompt too long|context overflow/.test(
    errorSignal(payload),
  );
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
  if (isContextOverflow(response, payload)) {
    throw new ContextOverflowError(`provider reported context overflow for '${modelId}'`, secrets);
  }
  if (isModelRefusal(payload)) {
    throw new ModelRefusalError(`provider refused the request for '${modelId}'`, secrets);
  }
  if (response.status === 401 || response.status === 403) {
    throw new AuthenticationError(`provider rejected credentials for '${modelId}'`, secrets);
  }
  if (response.status === 429) {
    throw new RateLimitError(`provider rate limited '${modelId}'`, retryAfterMs(response), secrets);
  }
  throw new ProviderError(
    `provider returned HTTP ${String(response.status)} for '${modelId}'`,
    response.status,
    secrets,
  );
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

// Records the finish-reason/usage carried on a streaming chunk onto the
// in-flight response accumulator, when present.
function applyChunkMetadata(
  chunk: unknown,
  acc: { finishReason: FinishReason; prompt: number; completion: number },
): void {
  const finish = finishReasonFromChunk(chunk);
  if (finish !== undefined) acc.finishReason = finish;
  const usage = usageFromChunk(chunk);
  if (usage !== undefined) {
    acc.prompt = usage.prompt;
    acc.completion = usage.completion;
  }
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

  constructor(private readonly deps: AdapterDeps) {
    this.now = deps.now ?? Date.now;
  }

  call = async (
    request: GatewayRequest,
    config: ModelProviderConfig,
  ): Promise<NormalizedResponse> => {
    const secrets = [config.apiKey, config.baseUrl];
    if (request.cancellationSignal?.aborted === true) {
      throw new CancelledError(
        `request for '${config.modelId}' cancelled before dispatch`,
        secrets,
      );
    }
    const start = this.now();
    const response = await this.dispatch(request, config, secrets);
    if (!response.ok) {
      const errorPayload = await this.readErrorBody(response);
      mapHttpError(response, config.modelId, secrets, errorPayload);
    }
    const payload = await this.readBody(response, config, secrets);
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
    return redactResponse(normalized, secrets);
  };

  // Streaming chat path (Layer 1): yields redacted content-delta tokens as they
  // arrive, then a terminal `done` with the assembled, redacted NormalizedResponse.
  // Tool-call streaming is out of scope — only `choices[0].delta.content` is surfaced.
  callStream = async function* (
    this: OpenAiAdapter,
    request: GatewayRequest,
    config: ModelProviderConfig,
  ): AsyncGenerator<GatewayStreamChunk> {
    const secrets = [config.apiKey, config.baseUrl];
    if (request.cancellationSignal?.aborted === true) {
      throw new CancelledError(
        `request for '${config.modelId}' cancelled before dispatch`,
        secrets,
      );
    }
    const start = this.now();
    const response = await this.dispatch(request, config, secrets, true);
    if (!response.ok) {
      const errorPayload = await this.readErrorBody(response);
      mapHttpError(response, config.modelId, secrets, errorPayload);
    }
    const acc = { content: "", finishReason: "stop" as FinishReason, prompt: 0, completion: 0 };
    for await (const token of this.streamDeltas(response, config, secrets, acc)) {
      yield { type: "delta", token };
    }
    const assembled = this.assembleResponse(config, start, acc);
    assertUsableAssistantResponse(assembled, config.modelId, secrets);
    yield { type: "done", response: redactResponse(assembled, secrets) };
  };

  // Iterates the SSE stream, yielding redacted content tokens while mutating `acc`.
  // A suffix that matches the start of a configured secret is held until the next
  // delta proves it safe or completes the secret so redaction can match it.
  // Every chunk read races the idle-stream timeout: the total wall-clock deadline
  // only bounds the whole call, so a provider stream that silently hangs
  // mid-response previously held the BFF response (and its SSE client) forever.
  private async *streamDeltas(
    response: Response,
    config: ModelProviderConfig,
    secrets: readonly string[],
    acc: { content: string; finishReason: FinishReason; prompt: number; completion: number },
  ): AsyncGenerator<string> {
    const buffer = { pending: "" };
    const activeSecrets = configuredSecrets(secrets);
    try {
      for await (const chunk of readSseStream(response, undefined, STREAM_IDLE_TIMEOUT_MS)) {
        const content = deltaFromChunk(chunk);
        if (content !== undefined) {
          yield* emitRedactedDelta(content, buffer, activeSecrets, secrets, acc);
        }
        applyChunkMetadata(chunk, acc);
      }
      yield* flushPendingBuffer(buffer, secrets);
    } catch (error) {
      throw this.withPartialUsage(this.mapStreamError(error, config, secrets), acc);
    }
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

  private assembleResponse(
    config: ModelProviderConfig,
    start: number,
    acc: { content: string; finishReason: FinishReason; prompt: number; completion: number },
  ): NormalizedResponse {
    const usage: UsageMetadata = {
      requestId: this.deps.requestId,
      promptTokens: acc.prompt,
      completionTokens: acc.completion,
      latencyMs: this.now() - start,
      costClass: this.deps.costClass,
    };
    return {
      modelId: config.modelId,
      content: acc.content,
      finishReason: acc.finishReason,
      toolCalls: [],
      structuredOutput: null,
      usage,
    };
  }

  // A mid-stream read failure surfaces as a TransportError; an already-typed
  // cancellation/timeout (e.g. raised by the underlying reader) passes through.
  // The transport-layer idle marker maps onto the typed, secret-redacting
  // TimeoutError so the retry/breaker classification sees a timeout, not an
  // anonymous transport fault.
  private mapStreamError(
    error: unknown,
    config: ModelProviderConfig,
    secrets: readonly string[],
  ): Error {
    if (error instanceof CancelledError || error instanceof TimeoutError) {
      return error;
    }
    if (error instanceof SseIdleTimeoutError) {
      return new TimeoutError(
        `provider stream for '${config.modelId}' produced no chunk for ${String(
          STREAM_IDLE_TIMEOUT_MS,
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
    request: GatewayRequest,
    config: ModelProviderConfig,
    secrets: readonly string[],
    stream = false,
  ): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
    const cancel = request.cancellationSignal;
    const signal = cancel ? AbortSignal.any([timeoutSignal, cancel]) : timeoutSignal;
    const url = chatCompletionsUrl(config);
    const body = JSON.stringify(stream ? buildStreamBody(request) : buildBody(request));
    const headers = {
      "content-type": "application/json",
      ...apiKeyHeaders(config),
    };
    try {
      return await gatewayFetch(url, {
        method: "POST",
        headers,
        body,
        signal,
        fetchImpl: this.deps.fetchImpl,
        ...(config.egress !== undefined ? { egress: config.egress } : {}),
      });
    } catch (error) {
      throw this.mapDispatchError(error, config, cancel, timeoutSignal, secrets);
    }
  }

  private mapDispatchError(
    error: unknown,
    config: ModelProviderConfig,
    cancel: AbortSignal | undefined,
    timeout: AbortSignal,
    secrets: readonly string[],
  ): Error {
    if (cancel?.aborted === true) {
      return new CancelledError(`request for '${config.modelId}' cancelled`, secrets);
    }
    const egressError = mapOutboundEgressError(error, secrets);
    if (egressError !== undefined) {
      return egressError;
    }
    if (timeout.aborted) {
      return new TimeoutError(`request for '${config.modelId}' timed out`, secrets);
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
  ): Promise<unknown> {
    try {
      return await readJsonCapped(response);
    } catch {
      throw new TransportError(`provider sent an unreadable body for '${config.modelId}'`, secrets);
    }
  }

  private async readErrorBody(response: Response): Promise<unknown> {
    try {
      return await readJsonCapped(response);
    } catch {
      return null;
    }
  }
}
