// Zero-dependency OpenAI-compatible HTTP adapter built on globalThis.fetch and
// AbortSignal. fetch, clock, request-id, and cost class are injected so tests run
// with no network I/O and no real time. The raw provider body is never echoed into
// an error; only a redacted, status-level summary is surfaced.

import {
  AuthenticationError,
  CancelledError,
  ContextOverflowError,
  ModelRefusalError,
  ProviderError,
  RateLimitError,
  TimeoutError,
  TransportError,
} from "./errors.js";
import { apiKeyHeaderValue, DEFAULT_API_KEY_HEADER_NAME } from "./config.js";
import { gatewayFetch, readJsonCapped } from "./http.js";
import { normalizeChatResponse } from "./normalize.js";
import { redact } from "./redaction.js";
import type {
  CostClass,
  GatewayRequest,
  ModelProviderConfig,
  NormalizedResponse,
  NormalizedToolCall,
  ProviderAdapter,
} from "./types.js";

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
    readonly content: string | null;
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
        : message.content,
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
    return redactResponse(
      normalizeChatResponse(
        payload,
        config.modelId,
        {
          requestId: this.deps.requestId,
          latencyMs: this.now() - start,
          costClass: this.deps.costClass,
        },
        request.responseFormat?.type === "json_schema",
      ),
      secrets,
    );
  };

  private async dispatch(
    request: GatewayRequest,
    config: ModelProviderConfig,
    secrets: readonly string[],
  ): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
    const cancel = request.cancellationSignal;
    const signal = cancel ? AbortSignal.any([timeoutSignal, cancel]) : timeoutSignal;
    const url = `${config.baseUrl}/chat/completions`;
    const body = JSON.stringify(buildBody(request));
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
