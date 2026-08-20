// OpenAI-compatible embeddings adapter. Builds on globalThis.fetch only (no SDK
// dependency), mirroring openai-adapter.ts. Surfaces only structural status
// information; the raw provider body never escapes this module.

import { apiKeyHeaderValue, trimTrailingSlash } from "./config.js";
import {
  gatewayFetch,
  OutboundHttpEgressError,
  readJsonCapped,
  type OutboundHttpEgressErrorCode,
} from "./http.js";
import type { OutboundHttpEgressConfig, ProviderEndpointStyle } from "./types.js";

export interface OpenAIEmbeddingRequest {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly apiKeyHeaderName?: string;
  readonly modelId: string;
  readonly input: string;
  readonly dimensions?: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly egress?: OutboundHttpEgressConfig | undefined;
  // GEN-AI-GATEWAY-002 (RB-4): Azure deployment routing. When "azure-openai-deployment" the request
  // is dispatched to `{endpoint}/openai/deployments/{modelId}/embeddings?api-version=...` instead of
  // being silently misrouted to the OpenAI-compatible `{endpoint}/embeddings` path.
  readonly endpointStyle?: ProviderEndpointStyle | undefined;
  readonly apiVersion?: string | undefined;
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
  readonly dimensions?: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly egress?: OutboundHttpEgressConfig | undefined;
  // GEN-AI-GATEWAY-002 (RB-4): Azure deployment routing (see OpenAIEmbeddingRequest).
  readonly endpointStyle?: ProviderEndpointStyle | undefined;
  readonly apiVersion?: string | undefined;
}

export type OpenAIEmbeddingBatchOutcome =
  // `value` is index-aligned to `inputs`: value[i] is the embedding for inputs[i].
  | { readonly ok: true; readonly value: readonly OpenAIEmbeddingSuccess[] }
  | {
      readonly ok: false;
      readonly kind: OpenAIEmbeddingErrorKind;
      readonly status?: number;
      // Scalar-ladder failures carry the COMPLETED PREFIX (index-aligned to inputs[0..n-1]) so
      // a retry can resume behind it instead of re-embedding from item zero. Without this, a
      // ladder-deadline expiry was classified transient and every retry re-ran an identical
      // doomed full-length trial, discarding all finished work each round — non-convergent
      // whenever inputCount x per-item latency exceeds the ladder cap.
      readonly partial?: readonly OpenAIEmbeddingSuccess[];
    };

export type OpenAIEmbeddingOutcome =
  | { readonly ok: true; readonly value: OpenAIEmbeddingSuccess }
  | { readonly ok: false; readonly kind: OpenAIEmbeddingErrorKind; readonly status?: number };

export type OpenAIEmbeddingErrorKind =
  | "wrong-header"
  | "rate-limited"
  | "unsupported-model"
  | "timeout"
  | "cancelled"
  | "transport"
  // The gateway ANSWERED — with an HTTP error status (carried in `status`). Deliberately
  // distinct from "transport" (no HTTP response at all): collapsing a 400/500 answer into
  // "not reachable" once misdirected a whole connectivity investigation.
  | "http-error"
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
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  );
}

function normalizedVector(values: readonly number[]): Float32Array {
  const vector = Float32Array.from(values);
  let squared = 0;
  for (const value of vector) {
    squared += value * value;
  }
  if (squared <= 0) return vector;
  const norm = Math.sqrt(squared);
  for (let i = 0; i < vector.length; i += 1) {
    const value = vector[i];
    if (value !== undefined) vector[i] = value / norm;
  }
  return vector;
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

function joinUrl(request: {
  readonly endpoint: string;
  readonly modelId: string;
  readonly endpointStyle?: ProviderEndpointStyle | undefined;
  readonly apiVersion?: string | undefined;
}): string {
  const trimmed = trimTrailingSlash(request.endpoint);
  if (request.endpointStyle === "azure-openai-deployment") {
    return `${trimmed}/openai/deployments/${encodeURIComponent(
      request.modelId,
    )}/embeddings?api-version=${encodeURIComponent(request.apiVersion ?? "")}`;
  }
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
  if (status >= 400) return "http-error";
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

function buildRequest(request: OpenAIEmbeddingRequest, minimalShape = false): BuiltRequest {
  const name = headerName(request.apiKeyHeaderName);
  // Reuse the shared Bearer-prefixing helper from config.ts so this transport handles the
  // same `bearer ` / `x-litellm-key` / `api-key` cases the chat adapter handles, including
  // already-prefixed inputs. #192 Copilot finding.
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [name]: apiKeyHeaderValue(name, request.apiKey),
  };
  // minimalShape: strict OpenAI-compatible gateways (certain LiteLLM routes / TEI backends)
  // answer 400 to the unconditional `encoding_format`, which a plain curl never sends; the
  // float encoding is the OpenAI default anyway. `dimensions` is deliberately KEPT in the
  // minimal shape: it is only ever present when a capsule pinned it, and dropping it would
  // change the vector-space identity of the returned embeddings.
  const body = JSON.stringify({
    model: request.modelId,
    input: request.input,
    ...(minimalShape ? {} : { encoding_format: "float" }),
    ...(request.dimensions !== undefined ? { dimensions: request.dimensions } : {}),
  });
  const timeoutSignal = AbortSignal.timeout(request.timeoutMs ?? 30_000);
  const signal =
    request.signal !== undefined ? AbortSignal.any([timeoutSignal, request.signal]) : timeoutSignal;
  return {
    url: joinUrl(request),
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
  const vector = normalizedVector(shape.embedding);
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
  const built = buildRequest(request, strictShapeEndpoints.has(request.endpoint));
  const dispatched = await dispatch(built, request.fetchImpl, request.egress);
  if (typeof dispatched === "string") {
    return { ok: false, kind: dispatched };
  }
  if (!dispatched.ok) {
    await discardBody(dispatched);
    if (
      isStrictGatewayRejection(dispatched.status) &&
      !strictShapeEndpoints.has(request.endpoint)
    ) {
      return await requestMinimalShapeEmbedding(request);
    }
    const kind = classifyStatus(dispatched.status) ?? "transport";
    return { ok: false, kind, status: dispatched.status };
  }
  return decodeSuccess(dispatched, request);
}

// A validation-shaped rejection (400/422) of a request that carried our optional extras: the
// endpoint ANSWERED, so this is not transport flakiness — retry exactly once in the minimal
// wire shape a plain curl would send. 401/403/404/429/5xx keep their existing semantics.
function isStrictGatewayRejection(status: number): boolean {
  return status === 400 || status === 422;
}

// Once a minimal retry SUCCEEDS after a strict rejection, the endpoint's strictness is
// remembered so subsequent requests skip the doomed extras round trip — Knowledge Pod
// indexing drives many batches, and re-discovering strictness per call would roughly
// triple the request count against a strict gateway. The ladder itself stays in place as
// the safety net; the memo only changes which rung is tried FIRST.
const strictShapeEndpoints = new Set<string>();
const arrayRejectingEndpoints = new Set<string>();

export function resetStrictGatewayMemoForTests(): void {
  strictShapeEndpoints.clear();
  arrayRejectingEndpoints.clear();
}

async function requestMinimalShapeEmbedding(
  request: OpenAIEmbeddingRequest,
): Promise<OpenAIEmbeddingOutcome> {
  const built = buildRequest(request, true);
  const dispatched = await dispatch(built, request.fetchImpl, request.egress);
  if (typeof dispatched === "string") {
    return { ok: false, kind: dispatched };
  }
  if (!dispatched.ok) {
    // kind and status come from the SAME response: a synthetic pair (retry kind + original
    // status) would surface a contradiction in operator-visible readiness diagnostics.
    const kind = classifyStatus(dispatched.status) ?? "transport";
    await discardBody(dispatched);
    return { ok: false, kind, status: dispatched.status };
  }
  strictShapeEndpoints.add(request.endpoint);
  return decodeSuccess(dispatched, request);
}

// ─── Array-batch transport (#189 GRD-004) ────────────────────────────────────
function buildBatchRequest(
  request: OpenAIEmbeddingBatchRequest,
  minimalShape = false,
): BuiltRequest {
  const name = headerName(request.apiKeyHeaderName);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [name]: apiKeyHeaderValue(name, request.apiKey),
  };
  // OpenAI-compatible body: `input` is the array. Identical envelope to the scalar path
  // except the array value, so the same gateway/TLS/egress handling applies.
  const body = JSON.stringify({
    model: request.modelId,
    input: request.inputs,
    ...(minimalShape ? {} : { encoding_format: "float" }),
    ...(request.dimensions !== undefined ? { dimensions: request.dimensions } : {}),
  });
  const timeoutSignal = AbortSignal.timeout(request.timeoutMs ?? 30_000);
  const signal =
    request.signal !== undefined ? AbortSignal.any([timeoutSignal, request.signal]) : timeoutSignal;
  return {
    url: joinUrl(request),
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
    vector: normalizedVector(embedding),
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

// A batch failure that is NOT a clean shape rejection is not proof the gateway is down.
// Field incident (0.3.13, self-hosted LiteLLM): the route answered ONE input in 0.2s and the
// SAME 36 inputs as an array with HTTP 500 after 19s. Degrading only on 400/422 left the
// batcher retrying the identical doomed array — every attempt paid the full 19s, wrote zero
// vectors, and surfaced no error, which is indistinguishable from a hang. One scalar attempt
// decides it: if the items embed one at a time, the ARRAY SHAPE is what this gateway cannot
// serve, and the endpoint is remembered exactly like an explicitly rejecting one. If the
// scalar attempt fails too, the gateway really is unavailable and the ORIGINAL failure is
// returned unchanged — a genuine outage is never dressed up as a shape problem.
async function degradeToScalarAfterBatchFailure(
  request: OpenAIEmbeddingBatchRequest,
  deadlineAt: number,
  failure: Extract<OpenAIEmbeddingBatchOutcome, { readonly ok: false }>,
): Promise<OpenAIEmbeddingBatchOutcome> {
  // A caller-cancelled batch must not fire N more requests, a single-item batch has no array
  // shape to blame, and an exhausted budget has no room left to probe.
  //
  // The signal is checked in ADDITION to the kind: a cancellation that lands after the gateway
  // already answered — while the failed body is being drained — never reaches the error
  // classifier, so the failure still reads "http-error" while the caller is long gone.
  if (
    failure.kind === "cancelled" ||
    request.signal?.aborted === true ||
    request.inputs.length <= 1 ||
    Date.now() >= deadlineAt
  ) {
    return failure;
  }
  const scalar = await requestScalarFallbackBatch(request, deadlineAt);
  // Partial progress is the same evidence as full success: items DID embed one at a time, so
  // the array shape is the problem. Returning the scalar outcome also keeps the completed
  // prefix the batcher resumes behind.
  if (!scalar.ok && (scalar.partial ?? []).length === 0) {
    return failure;
  }
  // A THROTTLED batch is the one failure that says nothing about the shape: "try again later"
  // is not "arrays are unsupported", and a large request can trip a limit the same request
  // clears a minute later. Memoizing it would turn a passing rate limit into a
  // process-lifetime degradation, so this batch is served item by item and the next one is
  // free to try the array again.
  if (failure.kind !== "rate-limited") {
    arrayRejectingEndpoints.add(request.endpoint);
  }
  return scalar;
}

export async function requestOpenAIEmbeddingBatch(
  request: OpenAIEmbeddingBatchRequest,
): Promise<OpenAIEmbeddingBatchOutcome> {
  if (request.inputs.length === 0) {
    return { ok: true, value: [] };
  }
  // One absolute deadline bounds the COMPLETE compatibility ladder — but it must scale with
  // the work: the scalar fallback serves ONE item per request, so a flat per-batch budget
  // (the field incident: 30s for a whole batch against a CPU-served gateway) expires
  // mid-batch, the batcher classifies the timeout as transient, retries DISCARD the partial
  // progress, and indexing spins for hours without an error. Per item the budget stays the
  // request timeout; the sum is capped at 15 minutes as the runaway backstop.
  const deadlineAt = Date.now() + ladderDeadlineMs(request.inputs.length, request.timeoutMs);
  if (arrayRejectingEndpoints.has(request.endpoint)) {
    return await requestScalarFallbackBatch(request, deadlineAt);
  }
  const built = buildBatchRequest(request, strictShapeEndpoints.has(request.endpoint));
  const dispatched = await dispatch(built, request.fetchImpl, request.egress);
  if (typeof dispatched === "string") {
    return await degradeToScalarAfterBatchFailure(request, deadlineAt, {
      ok: false,
      kind: dispatched,
    });
  }
  if (!dispatched.ok) {
    await discardBody(dispatched);
    if (
      isStrictGatewayRejection(dispatched.status) &&
      !strictShapeEndpoints.has(request.endpoint)
    ) {
      return await requestMinimalShapeEmbeddingBatch(request, deadlineAt);
    }
    if (isStrictGatewayRejection(dispatched.status)) {
      // Known strict-shape endpoint that STILL rejects the minimal array: the array shape
      // itself is unsupported — degrade to scalars and remember.
      arrayRejectingEndpoints.add(request.endpoint);
      return await requestScalarFallbackBatch(request, deadlineAt);
    }
    const kind = classifyStatus(dispatched.status) ?? "transport";
    return await degradeToScalarAfterBatchFailure(request, deadlineAt, {
      ok: false,
      kind,
      status: dispatched.status,
    });
  }
  return decodeBatchSuccess(dispatched, request);
}

// Batch compat ladder for strict gateways: first the same array request without the optional
// extras; if the endpoint rejects the ARRAY shape itself, degrade to per-item scalar requests
// (each of which carries its own minimal-shape retry). The first failing item fails the batch.
async function requestMinimalShapeEmbeddingBatch(
  request: OpenAIEmbeddingBatchRequest,
  deadlineAt: number,
): Promise<OpenAIEmbeddingBatchOutcome> {
  const built = buildBatchRequest(request, true);
  const dispatched = await dispatch(built, request.fetchImpl, request.egress);
  if (typeof dispatched === "string") {
    return await degradeToScalarAfterBatchFailure(request, deadlineAt, {
      ok: false,
      kind: dispatched,
    });
  }
  if (dispatched.ok) {
    strictShapeEndpoints.add(request.endpoint);
    return decodeBatchSuccess(dispatched, request);
  }
  await discardBody(dispatched);
  if (!isStrictGatewayRejection(dispatched.status)) {
    // kind and status come from the SAME response (see the scalar helper). This is the rung
    // the field incident actually lands on: the gateway rejects the extras with 400, then
    // answers the minimal ARRAY with 500 — so the scalar probe has to happen here too.
    const kind = classifyStatus(dispatched.status) ?? "transport";
    return await degradeToScalarAfterBatchFailure(request, deadlineAt, {
      ok: false,
      kind,
      status: dispatched.status,
    });
  }
  arrayRejectingEndpoints.add(request.endpoint);
  return await requestScalarFallbackBatch(request, deadlineAt);
}

function perItemTimeoutMs(request: OpenAIEmbeddingBatchRequest): number {
  return request.timeoutMs ?? 30_000;
}

// The routing fields decide the URL itself: an azure-openai-deployment request resolves to
// /openai/deployments/<id>/embeddings?api-version=…. Dropping them on the scalar fallback sent
// every probe to the plain /embeddings path — a DIFFERENT endpoint than the array attempt just
// used, so the probe could only ever fail and report a false outage.
function deploymentRouting(
  request: OpenAIEmbeddingBatchRequest,
): Partial<Pick<OpenAIEmbeddingRequest, "endpointStyle" | "apiVersion">> {
  return {
    ...(request.endpointStyle !== undefined ? { endpointStyle: request.endpointStyle } : {}),
    ...(request.apiVersion !== undefined ? { apiVersion: request.apiVersion } : {}),
  };
}

// The complete-ladder budget scales with the WORK: the scalar fallback serves one item per
// request, so a flat per-batch budget expires mid-batch on slow strict gateways, the batcher
// retries the transient timeout, and every retry discards the partial progress — indexing
// spins for hours without an error (customer field incident, 0.3.11). Capped at 15 minutes
// as the runaway backstop. Exported for the budget-math pin.
export function ladderDeadlineMs(inputCount: number, timeoutMs: number | undefined): number {
  return Math.min((timeoutMs ?? 30_000) * Math.max(1, inputCount), 900_000);
}

// A mid-ladder failure keeps the completed prefix (see OpenAIEmbeddingBatchOutcome.partial):
// the batcher resumes behind it on retry instead of re-paying every finished embedding.
function scalarLadderFailure(
  failure: {
    readonly ok: false;
    readonly kind: OpenAIEmbeddingErrorKind;
    readonly status?: number;
  },
  completed: readonly OpenAIEmbeddingSuccess[],
): OpenAIEmbeddingBatchOutcome {
  return completed.length === 0 ? failure : { ...failure, partial: completed };
}

async function requestScalarFallbackBatch(
  request: OpenAIEmbeddingBatchRequest,
  deadlineAt: number,
): Promise<OpenAIEmbeddingBatchOutcome> {
  const value: OpenAIEmbeddingSuccess[] = [];
  for (const input of request.inputs) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      return scalarLadderFailure({ ok: false, kind: "timeout" }, value);
    }
    const outcome = await requestOpenAIEmbedding({
      endpoint: request.endpoint,
      apiKey: request.apiKey,
      ...(request.apiKeyHeaderName !== undefined
        ? { apiKeyHeaderName: request.apiKeyHeaderName }
        : {}),
      modelId: request.modelId,
      input,
      ...deploymentRouting(request),
      ...(request.dimensions !== undefined ? { dimensions: request.dimensions } : {}),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
      timeoutMs: Math.min(remainingMs, perItemTimeoutMs(request)),
      ...(request.fetchImpl !== undefined ? { fetchImpl: request.fetchImpl } : {}),
      ...(request.egress !== undefined ? { egress: request.egress } : {}),
    });
    if (!outcome.ok) {
      return scalarLadderFailure(outcome, value);
    }
    value.push(outcome.value);
  }
  return { ok: true, value };
}
