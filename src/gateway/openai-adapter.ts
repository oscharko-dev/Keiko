// Zero-dependency OpenAI-compatible HTTP adapter built on globalThis.fetch and
// AbortSignal. fetch, clock, request-id, and cost class are injected so tests run
// with no network I/O and no real time. The raw provider body is never echoed into
// an error; only a redacted, status-level summary is surfaced.

import {
  AuthenticationError,
  CancelledError,
  ProviderError,
  RateLimitError,
  TimeoutError,
  TransportError,
} from "./errors.js";
import { normalizeChatResponse } from "./normalize.js";
import type {
  CostClass,
  GatewayRequest,
  ModelProviderConfig,
  NormalizedResponse,
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
  readonly messages: readonly { role: string; content: string }[];
  readonly tools?: unknown;
  readonly response_format?: unknown;
}

function buildBody(request: GatewayRequest): ChatRequestBody {
  const messages = request.messages.map((m) => ({ role: m.role, content: m.content }));
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

function mapHttpError(response: Response, modelId: string, secrets: readonly string[]): never {
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

export class OpenAiAdapter implements ProviderAdapter {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly deps: AdapterDeps) {
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
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
      mapHttpError(response, config.modelId, secrets);
    }
    const payload = await this.readBody(response, config, secrets);
    return normalizeChatResponse(
      payload,
      config.modelId,
      {
        requestId: this.deps.requestId,
        latencyMs: this.now() - start,
        costClass: this.deps.costClass,
      },
      request.responseFormat?.type === "json_schema",
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
    try {
      return await this.fetchImpl(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(buildBody(request)),
        signal,
      });
    } catch (error) {
      throw this.mapDispatchError(error, config, cancel, secrets);
    }
  }

  private mapDispatchError(
    error: unknown,
    config: ModelProviderConfig,
    cancel: AbortSignal | undefined,
    secrets: readonly string[],
  ): Error {
    if (cancel?.aborted === true) {
      return new CancelledError(`request for '${config.modelId}' cancelled`, secrets);
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
      return await response.json();
    } catch {
      throw new TransportError(`provider sent an unreadable body for '${config.modelId}'`, secrets);
    }
  }
}
