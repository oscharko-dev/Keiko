// Issue #211 — typed BFF helpers for the MemoriaViva surface.
// Wraps the MemoriaViva /api/memory/* routes from packages/keiko-server/src/memory-handlers.ts.
// Browser-safe: imports only from @oscharko-dev/keiko-contracts (ADR-0019 rule 8).
// CSRF header added automatically for all mutating methods.

import { bffFetchJson } from "./http";
import type {
  MemoryId,
  MemoryRecord,
  MemoryScope,
  MemoryScopeKind,
  MemorySensitivity,
  MemoryStatus,
  MemoryType,
  MemoryConsolidationJobStateWire,
  MemoryConsolidationStaleReasonWire,
  MemoryConsolidationStaleFlagWire,
  MemoryConsolidationReviewReasonWire,
  MemoryConsolidationProposedActionWire,
  MemoryConsolidationEvidenceKindWire,
  MemoryConsolidationEvidenceWire,
  MemoryConsolidationReviewItemWire,
  MemoryConsolidationSummaryStatusWire,
  MemoryConsolidationResultWire,
  MemoryConsolidationJobWire,
  MemoryConsolidationJobSelectionWire,
  MemoryConsolidationJobSettingsWire,
  MemoryConsolidationJobEnvelopeWire,
  MemoryConsolidationJobResponseWire,
  MemoryHealthScanResultWire,
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

export type MemoryConsolidationJobState = MemoryConsolidationJobStateWire;
export type MemoryConsolidationStaleReason = MemoryConsolidationStaleReasonWire;
export type MemoryConsolidationStaleFlag = MemoryConsolidationStaleFlagWire;
export type MemoryConsolidationReviewReason = MemoryConsolidationReviewReasonWire;
export type MemoryConsolidationProposedAction = MemoryConsolidationProposedActionWire;
export type MemoryConsolidationEvidenceKind = MemoryConsolidationEvidenceKindWire;
export type MemoryConsolidationEvidence = MemoryConsolidationEvidenceWire;
export type MemoryConsolidationReviewItem = MemoryConsolidationReviewItemWire;
export type MemoryConsolidationSummaryStatus = MemoryConsolidationSummaryStatusWire;
export type MemoryConsolidationResult = MemoryConsolidationResultWire;
export type MemoryConsolidationJob = MemoryConsolidationJobWire;
export type MemoryConsolidationJobSelection = MemoryConsolidationJobSelectionWire;
export type MemoryConsolidationJobSettings = MemoryConsolidationJobSettingsWire;
export type MemoryConsolidationJobEnvelope = MemoryConsolidationJobEnvelopeWire;
export type MemoryConsolidationJobResponse = MemoryConsolidationJobResponseWire;

export interface MemoryForgetResponse {
  readonly forgotten: true;
  readonly memoryId?: string;
  readonly memoryIds: readonly string[];
  readonly count: number;
}

export interface MemoryDeleteResponse {
  readonly deleted: true;
  readonly memoryId: string;
  readonly memoryIds: readonly string[];
  readonly count: number;
}

export interface MemoryCorrectionResponse {
  readonly correction: MemoryRecord;
  readonly originalMemoryId: string;
}

export interface MemoryListFilters {
  readonly query?: string;
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
  readonly maxRecordsPerRun: number;
}

export type ForgetSelector =
  | { readonly kind: "by-id"; readonly memoryId: MemoryId }
  | { readonly kind: "by-scope"; readonly scope: MemoryScope }
  | { readonly kind: "by-type"; readonly scope: MemoryScope; readonly type: MemoryType }
  | {
      readonly kind: "by-source-conversation";
      readonly scope: MemoryScope;
      readonly sourceConversationId: string;
    }
  | { readonly kind: "by-time-window"; readonly scope: MemoryScope; readonly olderThanMs: number };

export interface SelectiveForgetInput {
  readonly selector: ForgetSelector;
  readonly reason?: string;
}

export interface ResolveMemoryConflictInput {
  readonly winner: MemoryId;
  readonly losers: readonly MemoryId[];
  readonly reason?: string;
}

export interface MemoryConflictTransition {
  readonly memoryId: MemoryId;
  readonly from: MemoryStatus;
  readonly to: MemoryStatus;
  readonly transitionedAt: number;
}

export interface ResolveMemoryConflictResponse {
  readonly resolved: true;
  readonly winner: MemoryId;
  readonly losers: readonly MemoryId[];
  readonly supersessionEdgeIds: readonly string[];
  readonly transitions: readonly MemoryConflictTransition[];
}

// ---------------------------------------------------------------------------
// Internal fetch wrapper — thin delegation to the shared BFF scaffold (GEN-DUP-NEAR-004).
// Kept as a named private generic so the `fetchImpl = fetchJson<T>` default-param test seam every
// helper below relies on stays intact. The shared helper applies the same header union (CSRF + JSON
// content-type on state-changing methods AND JSON content-type whenever a body is present) and the
// same machine `HTTP <status>` parse-failure message; it additionally folds in the 204 → undefined
// short-circuit (a safe-forward improvement over the former non-204 path).
// ---------------------------------------------------------------------------

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  return bffFetchJson<T>(path, init);
}

// ---------------------------------------------------------------------------
// List + review queue
// ---------------------------------------------------------------------------

export async function fetchMemories(
  filters: MemoryListFilters = {},
  fetchImpl = fetchJson<MemoryListResponse>,
): Promise<MemoryListResponse> {
  const params = new URLSearchParams();
  if (filters.query !== undefined && filters.query.trim().length > 0) {
    params.set("q", filters.query.trim());
  }
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
// Health scan (Issue #2129)
// ---------------------------------------------------------------------------

export async function fetchMemoryHealthScan(
  fetchImpl = fetchJson<MemoryHealthScanResultWire>,
): Promise<MemoryHealthScanResultWire> {
  return fetchImpl("/api/memory/health-scan");
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
  void reason;
  return fetchImpl(`/api/memory/${encodeURIComponent(id)}/forget`, {
    method: "POST",
    body: JSON.stringify({
      acknowledged: true,
    }),
  });
}

export async function forgetMemories(
  input: SelectiveForgetInput,
  fetchImpl = fetchJson<MemoryForgetResponse>,
): Promise<MemoryForgetResponse> {
  return fetchImpl("/api/memory/forget", {
    method: "POST",
    body: JSON.stringify({
      acknowledged: true,
      selector: input.selector,
    }),
  });
}

// ---------------------------------------------------------------------------
// Delete (governed tombstone delete)
// ---------------------------------------------------------------------------

export async function deleteMemory(
  id: MemoryId,
  reason?: string,
  fetchImpl = fetchJson<MemoryDeleteResponse>,
): Promise<MemoryDeleteResponse> {
  void reason;
  return fetchImpl(`/api/memory/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: JSON.stringify({
      acknowledged: true,
    }),
  });
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

export async function resolveMemoryConflict(
  input: ResolveMemoryConflictInput,
  fetchImpl = fetchJson<ResolveMemoryConflictResponse>,
): Promise<ResolveMemoryConflictResponse> {
  return fetchImpl("/api/memory/conflicts/resolve", {
    method: "POST",
    body: JSON.stringify(input),
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
