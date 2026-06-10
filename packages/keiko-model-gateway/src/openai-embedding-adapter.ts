// OpenAI-compatible embeddings adapter. Builds on globalThis.fetch only (no SDK
// dependency), mirroring openai-adapter.ts. Surfaces only structural status
// information; the raw provider body never escapes this module.

import { apiKeyHeaderValue } from "./config.js";
import { gatewayFetch, readJsonCapped } from "./http.js";
import type { OutboundHttpEgressConfig } from "./types.js";

export interface OpenAIEmbeddingRequest {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly apiKeyHeaderName?: string;
  readonly modelId: string;
  readonly input: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly egress?: OutboundHttpEgressConfig | undefined;
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
  | "cancelled"
  | "transport"
  | "invalid-response";

interface ParsedEmbedding {
  readonly embedding: readonly number[];
  readonly model?: string;
  readonly modelRevision?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumberArray(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "number");
}

function extractFirstEmbedding(payload: Record<string, unknown>): readonly number[] | null {
  const data: unknown = payload.data;
  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }
  const first: unknown = data[0];
  if (!isRecord(first)) {
    return null;
  }
  const embedding: unknown = first.embedding;
  if (!isNumberArray(embedding) || embedding.length === 0) {
    return null;
  }
  return embedding;
}

function parseEmbeddingShape(payload: unknown): ParsedEmbedding | null {
  if (!isRecord(payload)) {
    return null;
  }
  const embedding = extractFirstEmbedding(payload);
  if (embedding === null) {
    return null;
  }
  const model = typeof payload.model === "string" ? payload.model : undefined;
  const modelRevision =
    typeof payload.model_revision === "string" ? payload.model_revision : undefined;
  return {
    embedding,
    ...(model !== undefined ? { model } : {}),
    ...(modelRevision !== undefined ? { modelRevision } : {}),
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

function classifyStatus(status: number): OpenAIEmbeddingErrorKind | null {
  if (status === 401 || status === 403) return "wrong-header";
  if (status === 429) return "rate-limited";
  if (status === 404) return "unsupported-model";
  if (status >= 400) return "transport";
  return null;
}

// Distinguishes our own internal-timeout abort from a caller-driven cancellation. If our
// internal `timeoutSignal` is aborted, it's a timeout. Otherwise, if the caller's signal is
// aborted (passed via `callerSignal`), it's a user cancellation. Anything else is a
// transport error. Without this distinction, callers cannot tell whether their user
// pressed Cancel or the server hung. #192 Copilot finding.
function classifyDispatchError(
  error: unknown,
  timeoutSignal: AbortSignal,
  callerSignal: AbortSignal | undefined,
): OpenAIEmbeddingErrorKind {
  if (timeoutSignal.aborted) return "timeout";
  if (callerSignal?.aborted === true) return "cancelled";
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  // A bare AbortError without either of our signals being aborted is a transport error
  // (e.g. the fetch impl tore down its own internal controller). Mapping it to `cancelled`
  // would misattribute the failure to the caller — #192 Copilot follow-up finding.
  return "transport";
}

interface BuiltRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly signal: AbortSignal;
  readonly timeoutSignal: AbortSignal;
  readonly callerSignal: AbortSignal | undefined;
}

function buildRequest(request: OpenAIEmbeddingRequest): BuiltRequest {
  const name = headerName(request.apiKeyHeaderName);
  // Reuse the shared Bearer-prefixing helper from config.ts so this transport handles the
  // same `bearer ` / `x-litellm-key` / `api-key` cases the chat adapter handles, including
  // already-prefixed inputs. #192 Copilot finding.
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [name]: apiKeyHeaderValue(name, request.apiKey),
  };
  const body = JSON.stringify({ model: request.modelId, input: request.input });
  const timeoutSignal = AbortSignal.timeout(request.timeoutMs ?? 30_000);
  const signal =
    request.signal !== undefined ? AbortSignal.any([timeoutSignal, request.signal]) : timeoutSignal;
  return {
    url: joinUrl(request.endpoint),
    headers,
    body,
    signal,
    timeoutSignal,
    callerSignal: request.signal,
  };
}

async function discardBody(response: Response): Promise<void> {
  try {
    await readJsonCapped(response);
  } catch {
    // ignore — body discarded intentionally
  }
}

async function dispatch(
  request: OpenAIEmbeddingRequest,
  built: BuiltRequest,
): Promise<Response | OpenAIEmbeddingErrorKind> {
  try {
    return await gatewayFetch(built.url, {
      method: "POST",
      headers: built.headers,
      body: built.body,
      signal: built.signal,
      ...(request.fetchImpl !== undefined ? { fetchImpl: request.fetchImpl } : {}),
      ...(request.egress !== undefined ? { egress: request.egress } : {}),
    });
  } catch (error) {
    return classifyDispatchError(error, built.timeoutSignal, built.callerSignal);
  }
}

async function decodeSuccess(
  response: Response,
  request: OpenAIEmbeddingRequest,
): Promise<OpenAIEmbeddingOutcome> {
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
  const vector = Float32Array.from(shape.embedding);
  const modelId = shape.model ?? request.modelId;
  const value: OpenAIEmbeddingSuccess =
    shape.modelRevision !== undefined
      ? { vector, modelId, modelRevision: shape.modelRevision }
      : { vector, modelId };
  return { ok: true, value };
}

export async function requestOpenAIEmbedding(
  request: OpenAIEmbeddingRequest,
): Promise<OpenAIEmbeddingOutcome> {
  const built = buildRequest(request);
  const dispatched = await dispatch(request, built);
  if (typeof dispatched === "string") {
    return { ok: false, kind: dispatched };
  }
  if (!dispatched.ok) {
    const kind = classifyStatus(dispatched.status) ?? "transport";
    await discardBody(dispatched);
    return { ok: false, kind };
  }
  return decodeSuccess(dispatched, request);
}
