// OpenAI-compatible embeddings adapter. Builds on globalThis.fetch only (no SDK
// dependency), mirroring openai-adapter.ts. Surfaces only structural status
// information; the raw provider body never escapes this module.

import { apiKeyHeaderValue } from "./config.js";
import {
  gatewayFetch,
  OutboundHttpEgressError,
  readJsonCapped,
  type OutboundHttpEgressErrorCode,
} from "./http.js";
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

// Array-batch embedding request (#189 GRD-004). OpenAI-compatible `/embeddings` accepts an
// array `input` and returns one `data[]` entry per item, each carrying its `index`. Batching
// collapses N per-chunk HTTPS round-trips (each re-paying TLS + retry backoff) into
// ceil(N / itemCap) calls — the dominant indexing-throughput win for large corpora. The
// scalar `requestOpenAIEmbedding` path is left untouched for the capability probe and the
// query-time single-embedding path.
export interface OpenAIEmbeddingBatchRequest {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly apiKeyHeaderName?: string;
  readonly modelId: string;
  readonly inputs: readonly string[];
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly egress?: OutboundHttpEgressConfig | undefined;
}

export type OpenAIEmbeddingBatchOutcome =
  // `value` is index-aligned to `inputs`: value[i] is the embedding for inputs[i].
  | { readonly ok: true; readonly value: readonly OpenAIEmbeddingSuccess[] }
  | { readonly ok: false; readonly kind: OpenAIEmbeddingErrorKind };

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
  | "proxy-unreachable"
  | "proxy-auth-required"
  | "proxy-egress-failed"
  | "proxy-blocked-by-policy"
  | "tls-ca-failure"
  | "invalid-response";

const OUTBOUND_EMBEDDING_KINDS: Record<OutboundHttpEgressErrorCode, OpenAIEmbeddingErrorKind> = {
  PROXY_UNREACHABLE: "proxy-unreachable",
  PROXY_AUTH_REQUIRED: "proxy-auth-required",
  PROXY_EGRESS_FAILED: "proxy-egress-failed",
  PROXY_BLOCKED_BY_POLICY: "proxy-blocked-by-policy",
  TLS_CA_FAILURE: "tls-ca-failure",
};

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
  if (callerSignal?.aborted === true) return "cancelled";
  if (error instanceof OutboundHttpEgressError) return OUTBOUND_EMBEDDING_KINDS[error.code];
  if (timeoutSignal.aborted) return "timeout";
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
  built: BuiltRequest,
  fetchImpl: typeof fetch | undefined,
  egress: OutboundHttpEgressConfig | undefined,
): Promise<Response | OpenAIEmbeddingErrorKind> {
  try {
    return await gatewayFetch(built.url, {
      method: "POST",
      headers: built.headers,
      body: built.body,
      signal: built.signal,
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
      ...(egress !== undefined ? { egress } : {}),
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
  const dispatched = await dispatch(built, request.fetchImpl, request.egress);
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

// ─── Array-batch transport (#189 GRD-004) ────────────────────────────────────
function buildBatchRequest(request: OpenAIEmbeddingBatchRequest): BuiltRequest {
  const name = headerName(request.apiKeyHeaderName);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [name]: apiKeyHeaderValue(name, request.apiKey),
  };
  // OpenAI-compatible body: `input` is the array. Identical envelope to the scalar path
  // except the array value, so the same gateway/TLS/egress handling applies.
  const body = JSON.stringify({ model: request.modelId, input: request.inputs });
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

interface BatchItemContext {
  readonly count: number;
  readonly topModel: string | undefined;
  readonly topRevision: string | undefined;
  readonly requestModelId: string;
}

// Resolve the slot index for one `data[]` entry, or -1 if its index is missing, non-integer,
// out of range, or already filled (duplicate).
function batchSlotIndex(
  item: Record<string, unknown>,
  count: number,
  slots: readonly (OpenAIEmbeddingSuccess | undefined)[],
): number {
  const index = typeof item.index === "number" ? item.index : -1;
  if (!Number.isInteger(index) || index < 0 || index >= count) return -1;
  return slots[index] === undefined ? index : -1;
}

function buildBatchSuccess(
  item: Record<string, unknown>,
  embedding: readonly number[],
  ctx: BatchItemContext,
): OpenAIEmbeddingSuccess {
  const modelId =
    (typeof item.model === "string" ? item.model : undefined) ?? ctx.topModel ?? ctx.requestModelId;
  return {
    vector: Float32Array.from(embedding),
    modelId,
    ...(ctx.topRevision !== undefined ? { modelRevision: ctx.topRevision } : {}),
  };
}

// Validate one `data[]` entry and place it at its declared `index`. Returns false on any
// malformed/duplicate/out-of-range item so the caller can fail the whole batch.
function placeBatchItem(
  item: unknown,
  ctx: BatchItemContext,
  slots: (OpenAIEmbeddingSuccess | undefined)[],
): boolean {
  if (!isRecord(item)) return false;
  const index = batchSlotIndex(item, ctx.count, slots);
  if (index < 0) return false;
  const embedding: unknown = item.embedding;
  if (!isNumberArray(embedding) || embedding.length === 0) return false;
  slots[index] = buildBatchSuccess(item, embedding, ctx);
  return true;
}

function buildBatchContext(
  payload: Record<string, unknown>,
  request: OpenAIEmbeddingBatchRequest,
): BatchItemContext {
  return {
    count: request.inputs.length,
    topModel: typeof payload.model === "string" ? payload.model : undefined,
    topRevision: typeof payload.model_revision === "string" ? payload.model_revision : undefined,
    requestModelId: request.modelId,
  };
}

async function decodeBatchSuccess(
  response: Response,
  request: OpenAIEmbeddingBatchRequest,
): Promise<OpenAIEmbeddingBatchOutcome> {
  let payload: unknown;
  try {
    payload = await readJsonCapped(response);
  } catch {
    return { ok: false, kind: "invalid-response" };
  }
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    return { ok: false, kind: "invalid-response" };
  }
  const ctx = buildBatchContext(payload, request);
  if (payload.data.length !== ctx.count) {
    return { ok: false, kind: "invalid-response" };
  }
  // Place each item at its declared `index` so the result is strictly aligned to `inputs`
  // regardless of provider ordering. Any missing/duplicate/out-of-range index → invalid.
  const slots = new Array<OpenAIEmbeddingSuccess | undefined>(ctx.count);
  for (const item of payload.data) {
    if (!placeBatchItem(item, ctx, slots)) {
      return { ok: false, kind: "invalid-response" };
    }
  }
  const value: OpenAIEmbeddingSuccess[] = [];
  for (const slot of slots) {
    if (slot === undefined) return { ok: false, kind: "invalid-response" };
    value.push(slot);
  }
  return { ok: true, value };
}

export async function requestOpenAIEmbeddingBatch(
  request: OpenAIEmbeddingBatchRequest,
): Promise<OpenAIEmbeddingBatchOutcome> {
  if (request.inputs.length === 0) {
    return { ok: true, value: [] };
  }
  const built = buildBatchRequest(request);
  const dispatched = await dispatch(built, request.fetchImpl, request.egress);
  if (typeof dispatched === "string") {
    return { ok: false, kind: dispatched };
  }
  if (!dispatched.ok) {
    const kind = classifyStatus(dispatched.status) ?? "transport";
    await discardBody(dispatched);
    return { ok: false, kind };
  }
  return decodeBatchSuccess(dispatched, request);
}
