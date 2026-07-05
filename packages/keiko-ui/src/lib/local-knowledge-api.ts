// Issue #197 — typed BFF helpers for the Local Knowledge connector graph surface.
// Issue #198 — capsule detail, sources, health diagnostics, indexing job history, and
//              destructive actions (delete, refresh changed files, repair failed files).
// All routes hit the same-origin BFF; the CSRF header is added for mutating methods.

import { ApiError } from "./api";
import { bffFetchJson } from "./http";
import type {
  CapsuleSetId,
  CapsuleContextualRetrievalSettings,
  KnowledgeCapsule,
  KnowledgeCapsuleId,
  KnowledgeSourceScope,
  CapsuleHealth,
  CapsuleLargeDocumentHealth,
  CapsuleReindexRequest,
  CapsuleDeleteRequest,
  ParserDiagnostic,
  IndexingJobRecord,
  LocalKnowledgeCapsuleListEntry as CapsuleListEntryBase,
  LocalKnowledgeCapsuleSetListEntry as CapsuleSetListEntryBase,
  LocalKnowledgeCapsuleSetsResponse as CapsuleSetsResponse,
  LocalKnowledgeCapsulesResponse as CapsulesResponse,
  KnowledgePodSummary,
} from "@oscharko-dev/keiko-contracts";

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export interface KnowledgePodUiGuidance {
  readonly label: string;
  readonly description: string;
  readonly tone: "warning" | "danger" | "muted";
}

export interface KnowledgePodUiMetadata {
  readonly readiness: KnowledgePodSummary["readiness"];
  readonly embeddingCompatibilityStatus?: NonNullable<
    KnowledgePodSummary["retrieval"]["embeddingCompatibilityStatus"]
  >;
  readonly embeddingCompatibilityReason?: NonNullable<
    KnowledgePodSummary["retrieval"]["embeddingCompatibilityReason"]
  >;
  readonly reindexRecommended: boolean;
  readonly queryEmbeddingAllowed: boolean;
  readonly guidance?: KnowledgePodUiGuidance;
}

export type CapsuleListEntry = CapsuleListEntryBase & {
  readonly knowledgePod?: KnowledgePodUiMetadata;
};
export type CapsuleSetListEntry = CapsuleSetListEntryBase & {
  readonly knowledgePod?: KnowledgePodUiMetadata;
};
export type { CapsuleSetsResponse, CapsulesResponse };

function summariesById(
  summaries: readonly KnowledgePodSummary[] | undefined,
  kind: KnowledgePodSummary["kind"],
): ReadonlyMap<string, KnowledgePodSummary> {
  const byId = new Map<string, KnowledgePodSummary>();
  for (const summary of summaries ?? []) {
    if (summary.kind === kind) byId.set(String(summary.id), summary);
  }
  return byId;
}

function guidanceForSummary(summary: KnowledgePodSummary): KnowledgePodUiGuidance | undefined {
  const status = summary.retrieval.embeddingCompatibilityStatus;
  if (status === "incompatible") {
    return {
      label: "Embedding mismatch",
      description: "Semantic retrieval is disabled for this pod until it is reindexed locally.",
      tone: "danger",
    };
  }
  if (status === "unavailable") {
    return {
      label: "Embedding unavailable",
      description: "Semantic retrieval cannot run under the current local policy.",
      tone: "danger",
    };
  }
  if (status === "unknown" || summary.retrieval.reindexRecommended === true) {
    return {
      label: "Reindex recommended",
      description: "Compatibility is unverified; lexical fallback remains available.",
      tone: "warning",
    };
  }
  if (status === "opaque") {
    return {
      label: "Embedding opaque",
      description: "Semantic compatibility cannot be verified for this retrieval space.",
      tone: "muted",
    };
  }
  return undefined;
}

function metadataForSummary(
  summary: KnowledgePodSummary | undefined,
): KnowledgePodUiMetadata | undefined {
  if (summary === undefined) return undefined;
  const guidance = guidanceForSummary(summary);
  return {
    readiness: summary.readiness,
    ...(summary.retrieval.embeddingCompatibilityStatus !== undefined
      ? { embeddingCompatibilityStatus: summary.retrieval.embeddingCompatibilityStatus }
      : {}),
    ...(summary.retrieval.embeddingCompatibilityReason !== undefined
      ? { embeddingCompatibilityReason: summary.retrieval.embeddingCompatibilityReason }
      : {}),
    reindexRecommended: summary.retrieval.reindexRecommended === true,
    queryEmbeddingAllowed: summary.retrieval.queryEmbeddingAllowed === true,
    ...(guidance !== undefined ? { guidance } : {}),
  };
}

export function capsulesForKnowledgePodUi(response: CapsulesResponse): readonly CapsuleListEntry[] {
  const summaries = summariesById(response.knowledgePods, "pod");
  return response.capsules.map((capsule) => ({
    ...capsule,
    displayName: summaries.get(String(capsule.id))?.displayName ?? capsule.displayName,
    ...metadataProperty(summaries.get(String(capsule.id))),
  }));
}

export function capsuleSetsForKnowledgePodUi(
  response: CapsuleSetsResponse,
): readonly CapsuleSetListEntry[] {
  const summaries = summariesById(response.knowledgePods, "pod-set");
  return response.capsuleSets.map((set) => ({
    ...set,
    displayName: summaries.get(String(set.id))?.displayName ?? set.displayName,
    ...metadataProperty(summaries.get(String(set.id))),
  }));
}

function metadataProperty(summary: KnowledgePodSummary | undefined): {
  readonly knowledgePod?: KnowledgePodUiMetadata;
} {
  const knowledgePod = metadataForSummary(summary);
  return knowledgePod === undefined ? {} : { knowledgePod };
}

export interface CapsuleDetailResponse {
  readonly capsule: KnowledgeCapsule;
}

export interface CapsuleActionResponse {
  readonly ok: true;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly affectedCapsuleSetIds?: readonly CapsuleSetId[];
  readonly cleanupVerified?: boolean;
}

// ---------------------------------------------------------------------------
// Internal fetch wrapper — thin delegation to the shared BFF scaffold (GEN-DUP-NEAR-004).
// The one divergence this surface preserves is the FRIENDLY parse-failure message (uiux-fix F033,
// C064): when a non-2xx body is not a parseable error envelope the UI shows a human-readable line
// instead of the raw "INTERNAL: HTTP 500" machine string.
// ---------------------------------------------------------------------------

// No parseable error envelope — keep the message human-readable instead of the raw
// "INTERNAL: HTTP 500" machine string (uiux-fix F033, C064).
function friendlyParseFailureMessage(status: number): string {
  return `The server returned an unexpected error (HTTP ${status.toString()}). Try again.`;
}

// Header union used by the injectable-`fetch` `fetchCapsuleDetail` seam below (it drives a
// caller-supplied `fetch` rather than the global one, so it cannot delegate to `bffFetchJson`).
function buildHeaders(method: string, body: BodyInit | null | undefined): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const isStateChanging = method !== "GET" && method !== "HEAD";
  if (isStateChanging || (body !== undefined && body !== null)) {
    headers["Content-Type"] = "application/json";
  }
  if (isStateChanging) {
    headers["X-Keiko-CSRF"] = "1";
  }
  return headers;
}

async function parseError(res: Response): Promise<{ code: string; message: string }> {
  try {
    const envelope = (await res.json()) as { error: { code: string; message: string } };
    return { code: envelope.error.code, message: envelope.error.message };
  } catch {
    return { code: "INTERNAL", message: friendlyParseFailureMessage(res.status) };
  }
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  return bffFetchJson<T>(path, init, { parseFailureMessage: friendlyParseFailureMessage });
}

// ---------------------------------------------------------------------------
// GET /api/local-knowledge/capsules
// ---------------------------------------------------------------------------

export interface LocalKnowledgeListOptions {
  readonly includeKnowledgePods?: boolean;
}

function listPath(path: string, options: LocalKnowledgeListOptions | undefined): string {
  return options?.includeKnowledgePods === true ? `${path}?includeKnowledgePods=1` : path;
}

export async function fetchCapsules(
  options?: LocalKnowledgeListOptions,
): Promise<CapsulesResponse> {
  return fetchJson<CapsulesResponse>(listPath("/api/local-knowledge/capsules", options));
}

export async function fetchCapsuleSets(
  options?: LocalKnowledgeListOptions,
): Promise<CapsuleSetsResponse> {
  return fetchJson<CapsuleSetsResponse>(listPath("/api/local-knowledge/capsule-sets", options));
}

// ---------------------------------------------------------------------------
// POST /api/local-knowledge/capsules
// ---------------------------------------------------------------------------

export interface CreateCapsuleInput {
  readonly displayName: string;
  readonly description?: string;
}

export async function createCapsule(input: CreateCapsuleInput): Promise<CapsuleDetailResponse> {
  return fetchJson<CapsuleDetailResponse>("/api/local-knowledge/capsules", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// ---------------------------------------------------------------------------
// POST /api/local-knowledge/capsule-sets — Issue #189 Slice 4 "zusammenlegen".
// Non-destructive logical composition: groups 1..16 existing capsules into a named
// set by reference (no documents are moved or copied). Returns 201 with the new set.
// Errors 400 (INVALID_REQUEST) for an empty/oversized member list, unknown capsule
// ids, or incompatible embedding identities across members.
// ---------------------------------------------------------------------------

export interface CreateCapsuleSetInput {
  readonly displayName: string;
  readonly description?: string;
  readonly capsuleIds: readonly KnowledgeCapsuleId[];
}

export interface CapsuleSetDetail {
  readonly id: CapsuleSetId;
  readonly displayName: string;
  readonly description?: string;
  readonly capsuleIds: readonly KnowledgeCapsuleId[];
  readonly capsuleCount: number;
  readonly composedAt: number;
}

export async function createCapsuleSet(
  input: CreateCapsuleSetInput,
): Promise<{ readonly capsuleSet: CapsuleSetDetail }> {
  return fetchJson<{ readonly capsuleSet: CapsuleSetDetail }>("/api/local-knowledge/capsule-sets", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// ---------------------------------------------------------------------------
// PATCH /api/local-knowledge/capsules/:id — Issue #189 Slice 4 "beschriften".
// Update capsule metadata-like typed fields. At least one field must be present
// (the BFF rejects an empty patch with 400). Untyped metadata updates are not yet
// supported and are rejected with a clear 400. Returns the full capsule detail so
// the caller can refresh in place.
// ---------------------------------------------------------------------------

export interface RenameCapsulePatch {
  readonly displayName?: string;
  readonly description?: string;
}

export interface UpdateCapsuleSettingsPatch {
  readonly contextualRetrieval?: CapsuleContextualRetrievalSettings;
}

export async function renameCapsule(
  capsuleId: KnowledgeCapsuleId,
  patch: RenameCapsulePatch,
): Promise<CapsuleDetail> {
  return fetchJson<CapsuleDetail>(
    `/api/local-knowledge/capsules/${encodeURIComponent(capsuleId)}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
}

export async function updateCapsuleContextualRetrieval(
  capsuleId: KnowledgeCapsuleId,
  contextualRetrieval: CapsuleContextualRetrievalSettings,
): Promise<CapsuleDetail> {
  return fetchJson<CapsuleDetail>(
    `/api/local-knowledge/capsules/${encodeURIComponent(capsuleId)}`,
    { method: "PATCH", body: JSON.stringify({ contextualRetrieval }) },
  );
}

// ---------------------------------------------------------------------------
// POST /api/local-knowledge/capsules/:id/index
// ---------------------------------------------------------------------------

export async function startIndexing(capsuleId: KnowledgeCapsuleId): Promise<CapsuleActionResponse> {
  return fetchJson<CapsuleActionResponse>(
    `/api/local-knowledge/capsules/${encodeURIComponent(capsuleId)}/index`,
    { method: "POST", body: JSON.stringify({ confirm: true }) },
  );
}

// ---------------------------------------------------------------------------
// DELETE /api/local-knowledge/capsules/:id/index
// ---------------------------------------------------------------------------

export async function cancelIndexing(
  capsuleId: KnowledgeCapsuleId,
): Promise<CapsuleActionResponse> {
  return fetchJson<CapsuleActionResponse>(
    `/api/local-knowledge/capsules/${encodeURIComponent(capsuleId)}/index`,
    { method: "DELETE", body: JSON.stringify({ confirm: true }) },
  );
}

// ---------------------------------------------------------------------------
// POST /api/local-knowledge/capsules/:id/connection
// Issue #189 / #682 — connect a folder, repository, or explicit file set.
// Body: { scope, displayName? }
// Returns 201 with the updated capsule detail (same shape as GET /capsules/:id,
// now including the new source under sources/sourceCount).
// Errors 400 for denied paths (~/.ssh, .git, …), non-existent paths, or non-directories.
// ---------------------------------------------------------------------------

export type ConnectCapsuleSourceScope = KnowledgeSourceScope;

export async function connectCapsuleSource(
  capsuleId: KnowledgeCapsuleId,
  scope: ConnectCapsuleSourceScope,
  displayName?: string,
): Promise<CapsuleDetailResponse> {
  return fetchJson<CapsuleDetailResponse>(
    `/api/local-knowledge/capsules/${encodeURIComponent(capsuleId)}/connection`,
    {
      method: "POST",
      body: JSON.stringify({ scope, displayName }),
    },
  );
}

// ---------------------------------------------------------------------------
// DELETE /api/local-knowledge/capsules/:id/connection
// ---------------------------------------------------------------------------

export async function disconnectCapsule(
  capsuleId: KnowledgeCapsuleId,
): Promise<CapsuleActionResponse> {
  return fetchJson<CapsuleActionResponse>(
    `/api/local-knowledge/capsules/${encodeURIComponent(capsuleId)}/connection`,
    { method: "DELETE", body: JSON.stringify({ confirm: true }) },
  );
}

// ---------------------------------------------------------------------------
// PATCH /api/local-knowledge/capsules/:id/sources/:sourceId/root
// ---------------------------------------------------------------------------

export async function rebindCapsuleSourceRoot(
  capsuleId: KnowledgeCapsuleId,
  sourceId: string,
  rootPath: string,
): Promise<CapsuleDetailResponse> {
  return fetchJson<CapsuleDetailResponse>(
    `/api/local-knowledge/capsules/${encodeURIComponent(capsuleId)}/sources/${encodeURIComponent(sourceId)}/root`,
    {
      method: "PATCH",
      body: JSON.stringify({ rootPath }),
    },
  );
}

// ---------------------------------------------------------------------------
// Issue #198 — CapsuleDetail wire shape
// ---------------------------------------------------------------------------

export interface SourceIndexStats {
  readonly sourceId: string;
  readonly displayName: string;
  readonly scope: KnowledgeSourceScope;
  readonly indexedCount: number;
  readonly failedCount: number;
  readonly skippedCount: number;
}

export interface CapsuleDetail {
  readonly capsule: KnowledgeCapsule;
  readonly health: CapsuleHealth;
  readonly sources: readonly SourceIndexStats[];
  readonly parserDiagnostics: readonly ParserDiagnostic[];
  readonly indexingJobs: readonly IndexingJobRecord[];
  // Bounded large-document ingestion (Epic #1160, Issue #1286). Optional so an older BFF response
  // without it still renders.
  readonly largeDocumentHealth?: CapsuleLargeDocumentHealth;
}

// ---------------------------------------------------------------------------
// GET /api/local-knowledge/capsules/:id — returns CapsuleDetail (mock)
// ---------------------------------------------------------------------------

export async function fetchCapsuleDetail(
  capsuleId: KnowledgeCapsuleId,
  fetchImpl: typeof fetch = fetch,
): Promise<CapsuleDetail> {
  const path = `/api/local-knowledge/capsules/${encodeURIComponent(capsuleId)}`;
  const res = await fetchImpl(path, {
    headers: buildHeaders("GET", undefined),
  });
  if (!res.ok) {
    const { code, message } = await parseError(res);
    throw new ApiError(code, message, res.status);
  }
  return res.json() as Promise<CapsuleDetail>;
}

// ---------------------------------------------------------------------------
// DELETE /api/local-knowledge/capsules/:id — delete capsule + index
// ---------------------------------------------------------------------------

export async function deleteCapsule(capsuleId: KnowledgeCapsuleId): Promise<CapsuleActionResponse> {
  const request: CapsuleDeleteRequest = {
    capsuleId,
    deleteIndex: true,
    deleteSources: false,
  };
  return fetchJson<CapsuleActionResponse>(
    `/api/local-knowledge/capsules/${encodeURIComponent(capsuleId)}`,
    { method: "DELETE", body: JSON.stringify(request) },
  );
}

// ---------------------------------------------------------------------------
// POST /api/local-knowledge/capsules/:id/reindex — incremental refresh for changed files
// ---------------------------------------------------------------------------

export async function refreshCapsuleChangedFiles(
  capsuleId: KnowledgeCapsuleId,
): Promise<CapsuleActionResponse> {
  const request: CapsuleReindexRequest = { capsuleId, mode: "changed-files" };
  return fetchJson<CapsuleActionResponse>(
    `/api/local-knowledge/capsules/${encodeURIComponent(capsuleId)}/reindex`,
    { method: "POST", body: JSON.stringify(request) },
  );
}

// ---------------------------------------------------------------------------
// POST /api/local-knowledge/capsules/:id/reindex — retry failed documents
// ---------------------------------------------------------------------------

export async function repairCapsuleFailedFiles(
  capsuleId: KnowledgeCapsuleId,
): Promise<CapsuleActionResponse> {
  const request: CapsuleReindexRequest = { capsuleId, mode: "repair-failed" };
  return fetchJson<CapsuleActionResponse>(
    `/api/local-knowledge/capsules/${encodeURIComponent(capsuleId)}/reindex`,
    { method: "POST", body: JSON.stringify(request) },
  );
}

// ---------------------------------------------------------------------------
// POST /api/local-knowledge/capsules/:id/reindex — rebuild vectors for the current model
// ---------------------------------------------------------------------------

export async function reembedCapsuleForCurrentModel(
  capsuleId: KnowledgeCapsuleId,
): Promise<CapsuleActionResponse> {
  const request: CapsuleReindexRequest = { capsuleId, mode: "full-reembed", force: true };
  return fetchJson<CapsuleActionResponse>(
    `/api/local-knowledge/capsules/${encodeURIComponent(capsuleId)}/reindex`,
    { method: "POST", body: JSON.stringify(request) },
  );
}

// ---------------------------------------------------------------------------
// POST /api/local-knowledge/capsules/:id/reindex — rebuild chunks, retrieval text, and vectors
// ---------------------------------------------------------------------------

export async function rebuildCapsuleIndex(
  capsuleId: KnowledgeCapsuleId,
): Promise<CapsuleActionResponse> {
  const request: CapsuleReindexRequest = { capsuleId, mode: "full-rebuild", force: true };
  return fetchJson<CapsuleActionResponse>(
    `/api/local-knowledge/capsules/${encodeURIComponent(capsuleId)}/reindex`,
    { method: "POST", body: JSON.stringify(request) },
  );
}

// ---------------------------------------------------------------------------
// POST /api/local-knowledge/capsules/:id/reindex — resume interrupted large-document jobs
// ---------------------------------------------------------------------------

export async function resumeCapsuleLargeDocuments(
  capsuleId: KnowledgeCapsuleId,
): Promise<CapsuleActionResponse> {
  const request: CapsuleReindexRequest = { capsuleId, mode: "resume" };
  return fetchJson<CapsuleActionResponse>(
    `/api/local-knowledge/capsules/${encodeURIComponent(capsuleId)}/reindex`,
    { method: "POST", body: JSON.stringify(request) },
  );
}
