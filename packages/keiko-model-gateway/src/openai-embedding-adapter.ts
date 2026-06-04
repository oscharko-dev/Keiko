// OpenAI-compatible embeddings adapter. Builds on globalThis.fetch only (no SDK
// dependency), mirroring openai-adapter.ts. Surfaces only structural status
// information; the raw provider body never escapes this module.

import { gatewayFetch, readJsonCapped } from "./http.js";

export interface OpenAIEmbeddingRequest {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly apiKeyHeaderName?: string;
  readonly modelId: string;
  readonly input: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface OpenAIEmbeddingSuccess {
  readonly vector: Float32Array;
  readonly modelId: string;
  readonly modelRevision?: string;
}

export type OpenAIEmbeddingOutcome =
  | { readonly ok: true; readonly value: OpenAIEmbeddingSuccess }
  | { readonly ok: false; readonly kind: OpenAIEmbeddingErrorKind };

export type OpenAIEmbeddingErrorKind =
  | "wrong-header"
  | "rate-limited"
  | "unsupported-model"
  | "timeout"
  | "transport"
  | "invalid-response";

interface EmbeddingResponseShape {
  readonly data: ReadonlyArray<{ readonly embedding: readonly number[] }>;
  readonly model?: string;
  readonly model_revision?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumberArray(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "number");
}

function parseEmbeddingShape(payload: unknown): EmbeddingResponseShape | null {
  if (!isRecord(payload)) {
    return null;
  }
  const { data } = payload;
  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }
  const first = data[0];
  if (!isRecord(first) || !isNumberArray(first.embedding) || first.embedding.length === 0) {
    return null;
  }
  const model = typeof payload.model === "string" ? payload.model : undefined;
  const modelRevision =
    typeof payload.model_revision === "string" ? payload.model_revision : undefined;
  return {
    data: [{ embedding: first.embedding }],
    ...(model !== undefined ? { model } : {}),
    ...(modelRevision !== undefined ? { model_revision: modelRevision } : {}),
  };
}

function joinUrl(endpoint: string): string {
  const trimmed = endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
  return `${trimmed}/embeddings`;
}

function headerName(name: string | undefined): string {
  if (name === undefined || name.trim().length === 0) {
    return "authorization";
  }
  return name.toLowerCase();
}

function headerValue(name: string, apiKey: string): string {
  return name === "authorization" ? `Bearer ${apiKey}` : apiKey;
}

function classifyStatus(status: number): OpenAIEmbeddingErrorKind | null {
  if (status === 401 || status === 403) return "wrong-header";
  if (status === 429) return "rate-limited";
  if (status === 404) return "unsupported-model";
  if (status >= 400) return "transport";
  return null;
}

function classifyDispatchError(error: unknown, timeout: AbortSignal): OpenAIEmbeddingErrorKind {
  if (timeout.aborted) return "timeout";
  if (error instanceof DOMException && error.name === "AbortError") return "timeout";
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  return "transport";
}

export async function requestOpenAIEmbedding(
  request: OpenAIEmbeddingRequest,
): Promise<OpenAIEmbeddingOutcome> {
  const name = headerName(request.apiKeyHeaderName);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [name]: headerValue(name, request.apiKey),
  };
  const body = JSON.stringify({ model: request.modelId, input: request.input });
  const timeoutMs = request.timeoutMs ?? 30_000;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal =
    request.signal !== undefined ? AbortSignal.any([timeoutSignal, request.signal]) : timeoutSignal;

  let response: Response;
  try {
    response = await gatewayFetch(joinUrl(request.endpoint), {
      method: "POST",
      headers,
      body,
      signal,
      ...(request.fetchImpl !== undefined ? { fetchImpl: request.fetchImpl } : {}),
    });
  } catch (error) {
    return { ok: false, kind: classifyDispatchError(error, timeoutSignal) };
  }

  if (!response.ok) {
    const kind = classifyStatus(response.status) ?? "transport";
    try {
      await readJsonCapped(response);
    } catch {
      // ignore — body discarded intentionally
    }
    return { ok: false, kind };
  }

  let payload: unknown;
  try {
    payload = await readJsonCapped(response);
  } catch {
    return { ok: false, kind: "invalid-response" };
  }
  const shape = parseEmbeddingShape(payload);
  if (shape === null) {
    return { ok: false, kind: "invalid-response" };
  }
  const first = shape.data[0];
  if (first === undefined) {
    return { ok: false, kind: "invalid-response" };
  }
  const vector = Float32Array.from(first.embedding);
  const modelId = shape.model ?? request.modelId;
  return {
    ok: true,
    value:
      shape.model_revision !== undefined
        ? { vector, modelId, modelRevision: shape.model_revision }
        : { vector, modelId },
  };
}
