// LiteLLM/Cohere-compatible rerank adapter. This is a low-level transport seam like
// openai-embedding-adapter.ts: callers pass the already-resolved credential-tier endpoint and get
// structural outcomes only. Raw provider payloads never escape this module.

import { apiKeyHeaderValue } from "./config.js";
import {
  gatewayFetch,
  OutboundHttpEgressError,
  readJsonCapped,
  type OutboundHttpEgressErrorCode,
} from "./http.js";
import type { OutboundHttpEgressConfig } from "./types.js";

export interface RerankRequest {
  readonly modelId: string;
  readonly query: string;
  readonly documents: readonly string[];
  readonly topN: number;
  readonly signal?: AbortSignal;
}

export interface LiteLLMRerankRequest extends RerankRequest {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly apiKeyHeaderName?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly egress?: OutboundHttpEgressConfig | undefined;
}

export interface RerankResult {
  readonly index: number;
  readonly relevanceScore?: number | undefined;
}

export interface RerankSuccess {
  readonly modelId: string;
  readonly results: readonly RerankResult[];
}

export type RerankErrorKind =
  | "disabled"
  | "not-configured"
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

export type RerankOutcome =
  | { readonly ok: true; readonly value: RerankSuccess }
  | { readonly ok: false; readonly kind: RerankErrorKind };

const OUTBOUND_RERANK_KINDS: Record<OutboundHttpEgressErrorCode, RerankErrorKind> = {
  PROXY_UNREACHABLE: "proxy-unreachable",
  PROXY_AUTH_REQUIRED: "proxy-auth-required",
  PROXY_EGRESS_FAILED: "proxy-egress-failed",
  PROXY_BLOCKED_BY_POLICY: "proxy-blocked-by-policy",
  TLS_CA_FAILURE: "tls-ca-failure",
};

interface BuiltRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly signal: AbortSignal;
  readonly timeoutSignal: AbortSignal;
  readonly callerSignal: AbortSignal | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function headerName(name: string | undefined): string {
  if (name === undefined || name.trim().length === 0) {
    return "authorization";
  }
  return name.toLowerCase();
}

function joinUrl(endpoint: string): string {
  const trimmed = endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
  return `${trimmed}/rerank`;
}

function buildRequest(request: LiteLLMRerankRequest): BuiltRequest {
  const name = headerName(request.apiKeyHeaderName);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [name]: apiKeyHeaderValue(name, request.apiKey),
  };
  const body = JSON.stringify({
    model: request.modelId,
    query: request.query,
    documents: request.documents,
    top_n: request.topN,
  });
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

function classifyStatus(status: number): RerankErrorKind | null {
  if (status === 401 || status === 403) return "wrong-header";
  if (status === 429) return "rate-limited";
  if (status === 404) return "unsupported-model";
  if (status >= 400) return "transport";
  return null;
}

function classifyDispatchError(
  error: unknown,
  timeoutSignal: AbortSignal,
  callerSignal: AbortSignal | undefined,
): RerankErrorKind {
  if (callerSignal?.aborted === true) return "cancelled";
  if (error instanceof OutboundHttpEgressError) return OUTBOUND_RERANK_KINDS[error.code];
  if (timeoutSignal.aborted) return "timeout";
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  return "transport";
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
): Promise<Response | RerankErrorKind> {
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

function scoreFrom(item: Record<string, unknown>): number | undefined {
  const raw = item.relevance_score ?? item.relevanceScore ?? item.score;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function documentTextFrom(item: Record<string, unknown>): string | undefined {
  if (typeof item.document === "string") return item.document;
  if (isRecord(item.document) && typeof item.document.text === "string") {
    return item.document.text;
  }
  return typeof item.text === "string" ? item.text : undefined;
}

function uniqueDocumentIndex(text: string, documents: readonly string[]): number {
  let match = -1;
  for (let i = 0; i < documents.length; i += 1) {
    if (documents[i] !== text) continue;
    if (match >= 0) return -1;
    match = i;
  }
  return match;
}

function indexFrom(item: unknown, documents: readonly string[]): number {
  if (typeof item === "number" && Number.isInteger(item)) return item;
  if (!isRecord(item)) return -1;
  const rawIndex = item.index ?? item.document_index;
  if (typeof rawIndex === "number" && Number.isInteger(rawIndex)) return rawIndex;
  const text = documentTextFrom(item);
  return text === undefined ? -1 : uniqueDocumentIndex(text, documents);
}

function resultFrom(item: unknown, documents: readonly string[]): RerankResult | null {
  const index = indexFrom(item, documents);
  if (index < 0 || index >= documents.length) return null;
  if (!isRecord(item)) return { index };
  const relevanceScore = scoreFrom(item);
  return relevanceScore === undefined ? { index } : { index, relevanceScore };
}

function parseResultArray(payload: Record<string, unknown>): readonly unknown[] | null {
  const results = payload.results ?? payload.data;
  return Array.isArray(results) ? results : null;
}

function parseRerankResults(
  payload: unknown,
  documents: readonly string[],
): readonly RerankResult[] | null {
  if (!isRecord(payload)) return null;
  const rawResults = parseResultArray(payload);
  if (rawResults === null) return null;
  const used = new Set<number>();
  const parsed: RerankResult[] = [];
  for (const raw of rawResults) {
    const result = resultFrom(raw, documents);
    if (result === null || used.has(result.index)) return null;
    used.add(result.index);
    parsed.push(result);
  }
  return parsed;
}

async function decodeSuccess(
  response: Response,
  request: LiteLLMRerankRequest,
): Promise<RerankOutcome> {
  let payload: unknown;
  try {
    payload = await readJsonCapped(response);
  } catch {
    return { ok: false, kind: "invalid-response" };
  }
  const results = parseRerankResults(payload, request.documents);
  if (results === null) return { ok: false, kind: "invalid-response" };
  return {
    ok: true,
    value: {
      modelId: request.modelId,
      results,
    },
  };
}

export async function requestLiteLLMRerank(
  request: LiteLLMRerankRequest,
): Promise<RerankOutcome> {
  if (request.documents.length === 0) {
    return { ok: true, value: { modelId: request.modelId, results: [] } };
  }
  if (!Number.isInteger(request.topN) || request.topN <= 0) {
    return { ok: false, kind: "invalid-response" };
  }
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
