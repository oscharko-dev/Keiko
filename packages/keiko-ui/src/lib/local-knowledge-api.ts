// Issue #197 — typed BFF helpers for the Local Knowledge connector graph surface.
// Issue #198 — capsule detail, sources, health diagnostics, indexing job history, and
//              destructive actions (delete, refresh changed files, repair failed files).
// All routes hit the same-origin BFF; the CSRF header is added for mutating methods.

import { ApiError } from "./api";
import { bffFetchJson } from "./http";
import type {
  CapsuleSetId,
  CapsuleContextualRetrievalSettings,
  HtmlManualPodJob,
  HtmlManualPodCreateRequest,
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
  KnowledgePodSetReadinessReasonCode,
  KnowledgePodModelUseOperation,
  KnowledgePodModelUsePolicy,
  ManualRefreshChangeSummary,
} from "@oscharko-dev/keiko-contracts";
import {
  KNOWLEDGE_POD_MODEL_USE_OPERATIONS,
  resolveKnowledgePodModelUsePolicy,
} from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-model-use-policy";

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

// The guidance a Knowledge Pod or Pod Set surface shows next to its state. It is a closed code plus
// the few facts its copy interpolates, never display text: the lib runs before the locale is known,
// and the wording (English and German) lives in the Local Knowledge catalog, resolved at render
// time by `knowledgePodGuidanceText`.
export type KnowledgePodGuidanceCode =
  | "embedding-mismatch"
  | "embedding-unavailable"
  | "reindex-recommended"
  | "embedding-opaque"
  | "manual-ready"
  | "manual-degraded"
  | "manual-indexing"
  | "manual-unavailable"
  | "future-member-placeholder"
  | "members-unavailable"
  | "members-not-ready"
  | "retrieval-degraded"
  | "embedding-readiness-warning"
  | "policy-denied"
  | "sealed-local-policy";

export interface KnowledgePodUiManualDetail {
  readonly documentCount: number;
  readonly chunkCount: number;
  readonly vectorCount: number;
  readonly readiness: KnowledgePodSummary["readiness"];
}

export interface KnowledgePodUiGuidance {
  readonly code: KnowledgePodGuidanceCode;
  /** Whether the copy speaks of one Knowledge Pod or of the members of a Knowledge Pod Set. */
  readonly scope: KnowledgePodSummary["kind"];
  readonly tone: "warning" | "danger" | "muted";
  /** Present for the `manual-*` codes only: the counts and the state their copy names. */
  readonly manual?: KnowledgePodUiManualDetail;
}

export interface KnowledgePodUiMetadata {
  readonly readiness: KnowledgePodSummary["readiness"];
  readonly counts?: KnowledgePodSummary["counts"];
  readonly setReadiness?: KnowledgePodSummary["setReadiness"];
  readonly sourceKinds?: KnowledgePodSummary["sourceKinds"];
  readonly degradationReasons?: KnowledgePodSummary["degradationReasons"];
  readonly modelUsePolicy?: KnowledgePodSummary["modelUsePolicy"];
  readonly sealed?: boolean;
  readonly deniedModelOperations?: readonly KnowledgePodModelUseOperation[];
  readonly embeddingCompatibilityStatus?: NonNullable<
    KnowledgePodSummary["retrieval"]["embeddingCompatibilityStatus"]
  >;
  readonly embeddingCompatibilityReason?: NonNullable<
    KnowledgePodSummary["retrieval"]["embeddingCompatibilityReason"]
  >;
  readonly reindexRecommended: boolean;
  readonly queryEmbeddingAllowed: boolean;
  readonly guidance?: KnowledgePodUiGuidance;
  // Epic #1856, Issue #1893 — read-only diagnostics for the most recent explicit HTML manual
  // refresh. Absent until the pod has been refreshed at least once, and for every non-manual pod.
  readonly manualRefresh?: ManualRefreshChangeSummary;
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
  const scope = summary.kind;
  if (status === "incompatible") return { code: "embedding-mismatch", scope, tone: "danger" };
  if (status === "unavailable") return { code: "embedding-unavailable", scope, tone: "danger" };
  if (status === "unknown" || summary.retrieval.reindexRecommended === true) {
    return { code: "reindex-recommended", scope, tone: "warning" };
  }
  if (status === "opaque") return { code: "embedding-opaque", scope, tone: "muted" };
  return undefined;
}

function isHtmlManualSourceKind(sourceKind: string): boolean {
  return sourceKind === "html-manual-local" || sourceKind === "html-manual-http";
}

function isHtmlManualSummary(summary: KnowledgePodSummary): boolean {
  return summary.sourceKinds.length > 0 && summary.sourceKinds.every(isHtmlManualSourceKind);
}

function manualDetail(summary: KnowledgePodSummary): KnowledgePodUiManualDetail {
  return {
    documentCount: summary.counts.documentCount,
    chunkCount: summary.counts.chunkCount,
    vectorCount: summary.counts.vectorCount,
    readiness: summary.readiness,
  };
}

function guidanceForHtmlManual(summary: KnowledgePodSummary): KnowledgePodUiGuidance | undefined {
  if (!isHtmlManualSummary(summary)) return undefined;
  const scope = summary.kind;
  const manual = manualDetail(summary);
  if (summary.readiness === "ready") {
    return { code: "manual-ready", scope, tone: "muted", manual };
  }
  if (summary.readiness === "degraded") {
    return { code: "manual-degraded", scope, tone: "warning", manual };
  }
  if (
    summary.readiness === "draft" ||
    summary.readiness === "indexing" ||
    summary.readiness === "stale"
  ) {
    return { code: "manual-indexing", scope, tone: "warning", manual };
  }
  return { code: "manual-unavailable", scope, tone: "danger", manual };
}

function hasSetReadinessReason(
  reasonCodes: ReadonlySet<KnowledgePodSetReadinessReasonCode>,
  candidates: readonly KnowledgePodSetReadinessReasonCode[],
): boolean {
  return candidates.some((candidate) => reasonCodes.has(candidate));
}

function guidanceForSetReadiness(summary: KnowledgePodSummary): KnowledgePodUiGuidance | undefined {
  if (summary.kind !== "pod-set" || summary.setReadiness === undefined) return undefined;

  const reasonCodes = new Set(summary.setReadiness.reasonCodes);
  const scope = summary.kind;
  if (
    hasSetReadinessReason(reasonCodes, [
      "future-remote-member",
      "future-federated-member",
      "future-ephemeral-member",
    ])
  ) {
    return { code: "future-member-placeholder", scope, tone: "warning" };
  }
  if (
    hasSetReadinessReason(reasonCodes, ["missing-member", "member-error", "member-unavailable"])
  ) {
    return { code: "members-unavailable", scope, tone: "danger" };
  }
  if (hasSetReadinessReason(reasonCodes, ["member-indexing", "member-stale", "member-draft"])) {
    return { code: "members-not-ready", scope, tone: "warning" };
  }
  if (hasSetReadinessReason(reasonCodes, ["member-degraded", "no-sources", "no-vectors"])) {
    return { code: "retrieval-degraded", scope, tone: "warning" };
  }
  if (
    hasSetReadinessReason(reasonCodes, [
      "embedding-unknown",
      "embedding-incompatible",
      "embedding-unavailable",
      "embedding-opaque",
    ])
  ) {
    return { code: "embedding-readiness-warning", scope, tone: "warning" };
  }
  return undefined;
}

function deniedModelOperations(
  modelUsePolicy: KnowledgePodSummary["modelUsePolicy"],
): readonly KnowledgePodModelUseOperation[] {
  return KNOWLEDGE_POD_MODEL_USE_OPERATIONS.filter(
    (operation) => modelUsePolicy.operations[operation] === "deny",
  );
}

function isSealedPolicy(
  summary: KnowledgePodSummary,
  modelUsePolicy: KnowledgePodSummary["modelUsePolicy"],
): boolean {
  return (
    summary.governance.sealingPosture === "sealed-pod-policy" ||
    modelUsePolicy.mode === "sealed-local"
  );
}

// This independently derives the same "is this pod policy-denied" fact that
// capsuleDegradationReasons() (single-pod path) and addPolicyReadinessReason() (pod-set path) in
// keiko-local-knowledge/src/knowledge-pods.ts compute. Keep this in sync with those if either
// changes (see AUDIT-E1819-003).
function guidanceForPolicy(
  summary: KnowledgePodSummary,
  modelUsePolicy: KnowledgePodSummary["modelUsePolicy"],
): KnowledgePodUiGuidance | undefined {
  const operations = modelUsePolicy.operations;
  const scope = summary.kind;
  if (operations.answerSynthesis === "deny" || operations.rawContentRelease === "deny") {
    return { code: "policy-denied", scope, tone: "danger" };
  }
  if (operations.externalEmbeddings === "deny" || operations.externalReranking === "deny") {
    return { code: "sealed-local-policy", scope, tone: "warning" };
  }
  return undefined;
}

function resolvedModelUsePolicyForSummary(
  summary: KnowledgePodSummary,
): KnowledgePodSummary["modelUsePolicy"] {
  const raw = (summary as { readonly modelUsePolicy?: KnowledgePodSummary["modelUsePolicy"] })
    .modelUsePolicy;
  return raw ?? resolveKnowledgePodModelUsePolicy(undefined);
}

function metadataForSummary(
  summary: KnowledgePodSummary | undefined,
): KnowledgePodUiMetadata | undefined {
  if (summary === undefined) return undefined;
  const modelUsePolicy = resolvedModelUsePolicyForSummary(summary);
  const guidance = guidanceForSummary(summary);
  const policyGuidance = guidanceForPolicy(summary, modelUsePolicy);
  const setReadinessGuidance = guidanceForSetReadiness(summary);
  const manualGuidance = guidanceForHtmlManual(summary);
  const selectedGuidance = policyGuidance ?? guidance ?? setReadinessGuidance ?? manualGuidance;
  const deniedOperations = deniedModelOperations(modelUsePolicy);
  return {
    readiness: summary.readiness,
    counts: summary.counts,
    ...(summary.setReadiness !== undefined ? { setReadiness: summary.setReadiness } : {}),
    sourceKinds: summary.sourceKinds,
    degradationReasons: summary.degradationReasons,
    modelUsePolicy,
    sealed: isSealedPolicy(summary, modelUsePolicy),
    deniedModelOperations: deniedOperations,
    ...(summary.retrieval.embeddingCompatibilityStatus !== undefined
      ? { embeddingCompatibilityStatus: summary.retrieval.embeddingCompatibilityStatus }
      : {}),
    ...(summary.retrieval.embeddingCompatibilityReason !== undefined
      ? { embeddingCompatibilityReason: summary.retrieval.embeddingCompatibilityReason }
      : {}),
    reindexRecommended: summary.retrieval.reindexRecommended === true,
    queryEmbeddingAllowed: summary.retrieval.queryEmbeddingAllowed === true,
    ...(selectedGuidance !== undefined ? { guidance: selectedGuidance } : {}),
    ...(summary.manualRefresh !== undefined ? { manualRefresh: summary.manualRefresh } : {}),
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
  /** Job id a 202 indexing admission pinned; the panel settles its watch on this identity. */
  readonly jobId?: string;
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
  readonly modelUsePolicy?: KnowledgePodModelUsePolicy;
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
// DELETE /api/local-knowledge/capsule-sets/:id — remove a Knowledge Pod Set's
// membership metadata (#1929 audit fix). Member capsules are never touched.
// ---------------------------------------------------------------------------

export interface CapsuleSetActionResponse {
  readonly ok: true;
  readonly capsuleSetId: CapsuleSetId;
}

export async function deleteCapsuleSet(
  capsuleSetId: CapsuleSetId,
): Promise<CapsuleSetActionResponse> {
  return fetchJson<CapsuleSetActionResponse>(
    `/api/local-knowledge/capsule-sets/${encodeURIComponent(capsuleSetId)}`,
    { method: "DELETE" },
  );
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

export async function updateCapsuleModelUsePolicy(
  capsuleId: KnowledgeCapsuleId,
  modelUsePolicy: KnowledgePodModelUsePolicy,
): Promise<CapsuleDetail> {
  return fetchJson<CapsuleDetail>(
    `/api/local-knowledge/capsules/${encodeURIComponent(capsuleId)}`,
    { method: "PATCH", body: JSON.stringify({ modelUsePolicy }) },
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
// POST /api/local-knowledge/manual-pods/create  — start a live HTML-manual create (Issue #2063)
// POST /api/local-knowledge/manual-pods/refresh — start a live HTML-manual refresh (Issue #2063)
// GET  /api/local-knowledge/manual-pods/jobs/:jobId — poll the live create/refresh job
// ---------------------------------------------------------------------------

export async function startHtmlManualPodCreate(
  request: HtmlManualPodCreateRequest,
): Promise<HtmlManualPodJob> {
  return fetchJson<HtmlManualPodJob>("/api/local-knowledge/manual-pods/create", {
    method: "POST",
    body: JSON.stringify(request),
  });
}

export async function startHtmlManualPodRefresh(
  capsuleId: KnowledgeCapsuleId,
  sourceId: string,
): Promise<HtmlManualPodJob> {
  return fetchJson<HtmlManualPodJob>("/api/local-knowledge/manual-pods/refresh", {
    method: "POST",
    body: JSON.stringify({ capsuleId, sourceId }),
  });
}

export async function getHtmlManualPodJob(jobId: string): Promise<HtmlManualPodJob> {
  return fetchJson<HtmlManualPodJob>(
    `/api/local-knowledge/manual-pods/jobs/${encodeURIComponent(jobId)}`,
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
  resumeJobId?: string,
): Promise<CapsuleActionResponse> {
  const request: CapsuleReindexRequest = {
    capsuleId,
    mode: "resume",
    ...(resumeJobId !== undefined ? { resumeJobId } : {}),
  };
  return fetchJson<CapsuleActionResponse>(
    `/api/local-knowledge/capsules/${encodeURIComponent(capsuleId)}/reindex`,
    { method: "POST", body: JSON.stringify(request) },
  );
}
