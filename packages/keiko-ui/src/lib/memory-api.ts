// Issue #211 — typed BFF helpers for the Memory Center surface.
// Wraps the 12 /api/memory/* routes from packages/keiko-server/src/memory-handlers.ts.
// Browser-safe: imports only from @oscharko-dev/keiko-contracts (ADR-0019 rule 8).
// CSRF header added automatically for all mutating methods.

import { ApiError } from "./api";
import type {
  MemoryEdge,
  MemoryId,
  MemoryRecord,
  MemoryScope,
  MemoryScopeKind,
  MemorySensitivity,
  MemoryStatus,
  MemoryType,
  MemoryUpdate,
} from "@oscharko-dev/keiko-contracts";

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export interface MemoryListResponse {
  readonly memories: readonly MemoryRecord[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface MemoryDetailResponse {
  readonly memory: MemoryRecord;
}

export interface MemoryReviewQueueResponse {
  readonly memories: readonly MemoryRecord[];
  readonly total: number;
}

export interface MemoryActionResponse {
  readonly memory: MemoryRecord;
}

export type MemoryConsolidationJobState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "canceled"
  | "skipped";

export type MemoryConsolidationStaleReason = "expired" | "low-confidence" | "aged-out";

export interface MemoryConsolidationStaleFlag {
  readonly memoryId: MemoryId;
  readonly reason: MemoryConsolidationStaleReason;
  readonly detectedAt: number;
}

export type MemoryConsolidationReviewReason = "multi-way-duplicate" | "potential-conflict";

export type MemoryConsolidationProposedAction =
  | { readonly kind: "merge"; readonly winner: MemoryId; readonly losers: readonly MemoryId[] }
  | { readonly kind: "supersede"; readonly newer: MemoryId; readonly older: MemoryId };

export interface MemoryConsolidationReviewItem {
  readonly id: string;
  readonly reason: MemoryConsolidationReviewReason;
  readonly relatedMemoryIds: readonly MemoryId[];
  readonly proposedAction?: MemoryConsolidationProposedAction;
  readonly detectedAt: number;
}

export interface MemoryConsolidationResult {
  readonly state: "completed" | "canceled" | "skipped" | "failed";
  readonly edgesProposed: readonly MemoryEdge[];
  readonly updatesProposed: readonly MemoryUpdate[];
  readonly staleFlags: readonly MemoryConsolidationStaleFlag[];
  readonly reviewItems: readonly MemoryConsolidationReviewItem[];
  readonly clustersInspected: number;
  readonly elapsedMs: number;
}

export interface MemoryConsolidationJob {
  readonly id: string;
  readonly state: MemoryConsolidationJobState;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly result?: MemoryConsolidationResult;
  readonly error?: string;
}

export interface MemoryConsolidationJobSelection {
  readonly scopes: readonly MemoryScope[];
  readonly types?: readonly MemoryType[];
  readonly statuses?: readonly MemoryStatus[];
  readonly includeExpired: boolean;
}

export interface MemoryConsolidationJobSettings {
  readonly jaccardThreshold: number;
  readonly staleConfidenceThreshold: number;
  readonly maxAgeMs: number;
  readonly maxClustersPerRun: number;
}

export interface MemoryConsolidationJobEnvelope {
  readonly job: MemoryConsolidationJob;
  readonly createdAt: number;
  readonly selection: MemoryConsolidationJobSelection;
  readonly settings: MemoryConsolidationJobSettings;
  readonly memoryCount: number;
  readonly cancelRequested: boolean;
}

export interface MemoryConsolidationJobResponse {
  readonly job: MemoryConsolidationJobEnvelope;
}

export interface MemoryForgetResponse {
  readonly forgotten: true;
  readonly memoryId: string;
}

export interface MemoryDeleteResponse {
  readonly deleted: true;
  readonly memoryId: string;
}

export interface MemoryCorrectionResponse {
  readonly correction: MemoryRecord;
  readonly originalMemoryId: string;
}

export interface MemoryListFilters {
  readonly scope?: readonly MemoryScopeKind[];
  readonly type?: readonly MemoryType[];
  readonly status?: readonly MemoryStatus[];
  readonly sensitivity?: readonly MemorySensitivity[];
  readonly limit?: number;
  readonly offset?: number;
}

export interface StartMemoryConsolidationInput {
  readonly jaccardThreshold: number;
  readonly staleConfidenceThreshold: number;
  readonly maxAgeMs: number;
  readonly maxClustersPerRun: number;
}

// ---------------------------------------------------------------------------
// Internal fetch wrapper (mirrors local-knowledge-api.ts pattern)
// ---------------------------------------------------------------------------

function buildHeaders(method: string, body?: BodyInit | null): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined && body !== null) {
    headers["Content-Type"] = "application/json";
  }
  if (method !== "GET" && method !== "HEAD") {
    headers["X-Keiko-CSRF"] = "1";
  }
  return headers;
}

async function parseError(res: Response): Promise<{ code: string; message: string }> {
  try {
    const envelope = (await res.json()) as { error: { code: string; message: string } };
    return { code: envelope.error.code, message: envelope.error.message };
  } catch {
    return { code: "INTERNAL", message: `HTTP ${res.status.toString()}` };
  }
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const body = init?.body;
  const res = await fetch(path, {
    ...init,
    headers: buildHeaders(method, body),
  });
  if (!res.ok) {
    const { code, message } = await parseError(res);
    throw new ApiError(code, message, res.status);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// List + review queue
// ---------------------------------------------------------------------------

export async function fetchMemories(
  filters: MemoryListFilters = {},
  fetchImpl = fetchJson<MemoryListResponse>,
): Promise<MemoryListResponse> {
  const params = new URLSearchParams();
  if (filters.scope !== undefined && filters.scope.length > 0) {
    params.set("scope", filters.scope.join(","));
  }
  if (filters.type !== undefined && filters.type.length > 0) {
    params.set("type", filters.type.join(","));
  }
  if (filters.status !== undefined && filters.status.length > 0) {
    params.set("status", filters.status.join(","));
  }
  if (filters.sensitivity !== undefined && filters.sensitivity.length > 0) {
    params.set("sensitivity", filters.sensitivity.join(","));
  }
  if (filters.limit !== undefined) params.set("limit", filters.limit.toString());
  if (filters.offset !== undefined) params.set("offset", filters.offset.toString());
  const qs = params.toString();
  return fetchImpl(`/api/memory${qs.length > 0 ? `?${qs}` : ""}` as string);
}

export async function fetchMemoryReviewQueue(
  fetchImpl = fetchJson<MemoryReviewQueueResponse>,
): Promise<MemoryReviewQueueResponse> {
  return fetchImpl("/api/memory/review-queue");
}

// ---------------------------------------------------------------------------
// Consolidation jobs
// ---------------------------------------------------------------------------

export async function startMemoryConsolidation(
  input: StartMemoryConsolidationInput,
  fetchImpl = fetchJson<MemoryConsolidationJobResponse>,
): Promise<MemoryConsolidationJobResponse> {
  return fetchImpl("/api/memory/consolidation/jobs", {
    method: "POST",
    body: JSON.stringify({ settings: input }),
  });
}

export async function fetchMemoryConsolidationJob(
  jobId: string,
  fetchImpl = fetchJson<MemoryConsolidationJobResponse>,
): Promise<MemoryConsolidationJobResponse> {
  return fetchImpl(`/api/memory/consolidation/jobs/${encodeURIComponent(jobId)}`);
}

export async function cancelMemoryConsolidationJob(
  jobId: string,
  fetchImpl = fetchJson<MemoryConsolidationJobResponse>,
): Promise<MemoryConsolidationJobResponse> {
  return fetchImpl(`/api/memory/consolidation/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
    body: "{}",
  });
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export async function fetchMemory(
  id: MemoryId,
  fetchImpl = fetchJson<MemoryDetailResponse>,
): Promise<MemoryDetailResponse> {
  return fetchImpl(`/api/memory/${encodeURIComponent(id)}`);
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

export interface EditMemoryInput {
  readonly body?: string;
  readonly tags?: readonly string[];
  readonly sensitivity?: MemorySensitivity;
}

export async function editMemory(
  id: MemoryId,
  input: EditMemoryInput,
  fetchImpl = fetchJson<MemoryActionResponse>,
): Promise<MemoryActionResponse> {
  return fetchImpl(`/api/memory/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

// ---------------------------------------------------------------------------
// Pin / unpin / archive
// ---------------------------------------------------------------------------

export async function pinMemory(
  id: MemoryId,
  fetchImpl = fetchJson<MemoryActionResponse>,
): Promise<MemoryActionResponse> {
  return fetchImpl(`/api/memory/${encodeURIComponent(id)}/pin`, { method: "POST", body: "{}" });
}

export async function unpinMemory(
  id: MemoryId,
  fetchImpl = fetchJson<MemoryActionResponse>,
): Promise<MemoryActionResponse> {
  return fetchImpl(`/api/memory/${encodeURIComponent(id)}/unpin`, { method: "POST", body: "{}" });
}

export async function archiveMemory(
  id: MemoryId,
  reason?: string,
  fetchImpl = fetchJson<MemoryActionResponse>,
): Promise<MemoryActionResponse> {
  return fetchImpl(`/api/memory/${encodeURIComponent(id)}/archive`, {
    method: "POST",
    body: JSON.stringify({ ...(reason !== undefined ? { reason } : {}) }),
  });
}

// ---------------------------------------------------------------------------
// Forget (destructive — requires acknowledged: true)
// ---------------------------------------------------------------------------

export async function forgetMemory(
  id: MemoryId,
  reason?: string,
  fetchImpl = fetchJson<MemoryForgetResponse>,
): Promise<MemoryForgetResponse> {
  return fetchImpl(`/api/memory/${encodeURIComponent(id)}/forget`, {
    method: "POST",
    body: JSON.stringify({
      acknowledged: true,
      ...(reason !== undefined ? { reason } : {}),
    }),
  });
}

// ---------------------------------------------------------------------------
// Delete (hard delete)
// ---------------------------------------------------------------------------

export async function deleteMemory(
  id: MemoryId,
  fetchImpl = fetchJson<MemoryDeleteResponse>,
): Promise<MemoryDeleteResponse> {
  return fetchImpl(`/api/memory/${encodeURIComponent(id)}`, { method: "DELETE", body: "{}" });
}

// ---------------------------------------------------------------------------
// Correct
// ---------------------------------------------------------------------------

export async function correctMemory(
  id: MemoryId,
  correctedBody: string,
  fetchImpl = fetchJson<MemoryCorrectionResponse>,
): Promise<MemoryCorrectionResponse> {
  return fetchImpl(`/api/memory/${encodeURIComponent(id)}/correct`, {
    method: "POST",
    body: JSON.stringify({ body: correctedBody }),
  });
}

// ---------------------------------------------------------------------------
// Accept / reject proposal
// ---------------------------------------------------------------------------

// `id` is the proposal/record identifier the route encodes into the path. It is typed as a
// plain string because both call sites supply a branded id (chat: MemoryProposalId, review
// queue: MemoryId) and this HTTP boundary only needs the URL path segment, not the brand.
export async function acceptMemoryProposal(
  id: string,
  fetchImpl = fetchJson<MemoryActionResponse>,
): Promise<MemoryActionResponse> {
  return fetchImpl(`/api/memory/proposals/${encodeURIComponent(id)}/accept`, {
    method: "POST",
    body: "{}",
  });
}

export async function rejectMemoryProposal(
  id: string,
  reason?: string,
  fetchImpl = fetchJson<MemoryActionResponse>,
): Promise<MemoryActionResponse> {
  return fetchImpl(`/api/memory/proposals/${encodeURIComponent(id)}/reject`, {
    method: "POST",
    body: JSON.stringify({ ...(reason !== undefined ? { reason } : {}) }),
  });
}
