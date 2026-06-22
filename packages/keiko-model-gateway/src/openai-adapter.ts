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
  type OutboundHttpEgressErrorCode,
} from "./http.js";
import { normalizeChatResponse, textFromContent } from "./normalize.js";
import { redact } from "@oscharko-dev/keiko-security";
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

function buildBody(request: GatewayRequest): ChatRequestBody {
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
      ? { type: "json_schema", json_schema: { schema: request.responseFormat.schema } }
      : undefined;
  return {
    ...base,
    ...(tools ? { tools } : {}),
    ...(responseFormat ? { response_format: responseFormat } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
  };
}

// Streaming body: identical to buildBody plus the OpenAI/Azure streaming flags.
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
  // Redaction is applied to the full accumulated buffer on every delta so that a
  // configured secret straddling two SSE chunk boundaries is still caught.  We track
  // how many characters of the REDACTED output we have already emitted and yield only
  // the new suffix each time.  When a cross-delta match shrinks the redacted string
  // relative to what was emitted, the cursor overshoots and the tail (containing the
  // secret or its replacement) is deferred to the terminal `done` chunk, which always
  // redacts the full `acc.content` independently via redactResponse().
  private async *streamDeltas(
    response: Response,
    config: ModelProviderConfig,
    secrets: readonly string[],
    acc: { content: string; finishReason: FinishReason; prompt: number; completion: number },
  ): AsyncGenerator<string> {
    let emittedRedactedLength = 0;
    try {
      for await (const chunk of readSseStream(response)) {
        const content = deltaFromChunk(chunk);
        if (content !== undefined) {
          acc.content += content;
          const redacted = redact(acc.content, secrets);
          if (redacted.length > emittedRedactedLength) {
            yield redacted.slice(emittedRedactedLength);
            emittedRedactedLength = redacted.length;
          }
        }
        const finish = finishReasonFromChunk(chunk);
        if (finish !== undefined) acc.finishReason = finish;
        const usage = usageFromChunk(chunk);
        if (usage !== undefined) {
          acc.prompt = usage.prompt;
          acc.completion = usage.completion;
        }
      }
    } catch (error) {
      throw this.mapStreamError(error, config, secrets);
    }
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
  private mapStreamError(
    error: unknown,
    config: ModelProviderConfig,
    secrets: readonly string[],
  ): Error {
    if (error instanceof CancelledError || error instanceof TimeoutError) {
      return error;
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
    const url = `${config.baseUrl}/chat/completions`;
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
