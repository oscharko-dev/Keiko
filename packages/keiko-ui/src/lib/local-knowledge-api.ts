// Issue #197 — typed BFF helpers for the Local Knowledge connector graph surface.
// Issue #198 — capsule detail, sources, health diagnostics, indexing job history, and
//              destructive actions (delete, refresh changed files, repair failed files).
// All routes hit the same-origin BFF; the CSRF header is added for mutating methods.

import { ApiError } from "./api";
import type {
  CapsuleSetId,
  KnowledgeCapsule,
  KnowledgeCapsuleId,
  KnowledgeSource,
  KnowledgeSourceScope,
  CapsuleLifecycleState,
  CapsuleHealth,
  ParserDiagnostic,
  IndexingJobRecord,
} from "@oscharko-dev/keiko-contracts";

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export interface CapsuleListEntry {
  readonly id: KnowledgeCapsuleId;
  readonly displayName: string;
  readonly lifecycleState: CapsuleLifecycleState;
  readonly sourceCount: number;
  readonly updatedAt: number;
}

export interface CapsulesResponse {
  readonly capsules: readonly CapsuleListEntry[];
}

export interface CapsuleSetListEntry {
  readonly id: CapsuleSetId;
  readonly displayName: string;
  readonly capsuleCount: number;
  readonly composedAt: number;
}

export interface CapsuleSetsResponse {
  readonly capsuleSets: readonly CapsuleSetListEntry[];
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
// Internal fetch wrapper (mirrors api.ts pattern; no external CSRF token dep)
// ---------------------------------------------------------------------------

function buildHeaders(method: string, body: BodyInit | null | undefined): Record<string, string> {
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
    // No parseable error envelope — keep the message human-readable instead of
    // the raw "INTERNAL: HTTP 500" machine string (uiux-fix F033, C064).
    return {
      code: "INTERNAL",
      message: `The server returned an unexpected error (HTTP ${res.status.toString()}). Try again.`,
    };
  }
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const res = await fetch(path, {
    ...init,
    headers: buildHeaders(method, init?.body),
  });

  if (!res.ok) {
    const { code, message } = await parseError(res);
    throw new ApiError(code, message, res.status);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// GET /api/local-knowledge/capsules
// ---------------------------------------------------------------------------

export async function fetchCapsules(): Promise<CapsulesResponse> {
  return fetchJson<CapsulesResponse>("/api/local-knowledge/capsules");
}

export async function fetchCapsuleSets(): Promise<CapsuleSetsResponse> {
  return fetchJson<CapsuleSetsResponse>("/api/local-knowledge/capsule-sets");
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
// Rename a capsule's display name and/or edit its description. At least one field
// must be present (the BFF rejects an empty patch with 400). Metadata updates are
// not yet supported and are rejected with a clear 400. Returns the full capsule
// detail so the caller can refresh in place.
// ---------------------------------------------------------------------------

export interface RenameCapsulePatch {
  readonly displayName?: string;
  readonly description?: string;
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
// Issue #198 — CapsuleDetail wire shape
// ---------------------------------------------------------------------------

export interface SourceIndexStats {
  readonly sourceId: string;
  readonly displayName: string;
  readonly scope: KnowledgeSource["scope"];
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
  return fetchJson<CapsuleActionResponse>(
    `/api/local-knowledge/capsules/${encodeURIComponent(capsuleId)}`,
    { method: "DELETE", body: JSON.stringify({ deleteIndex: true, deleteSources: false }) },
  );
}

// ---------------------------------------------------------------------------
// POST /api/local-knowledge/capsules/:id/reindex — incremental refresh for changed files
// ---------------------------------------------------------------------------

export async function refreshCapsuleChangedFiles(
  capsuleId: KnowledgeCapsuleId,
): Promise<CapsuleActionResponse> {
  return fetchJson<CapsuleActionResponse>(
    `/api/local-knowledge/capsules/${encodeURIComponent(capsuleId)}/reindex`,
    { method: "POST", body: JSON.stringify({ mode: "changed-files" }) },
  );
}

// ---------------------------------------------------------------------------
// POST /api/local-knowledge/capsules/:id/reindex — retry failed documents
// ---------------------------------------------------------------------------

export async function repairCapsuleFailedFiles(
  capsuleId: KnowledgeCapsuleId,
): Promise<CapsuleActionResponse> {
  return fetchJson<CapsuleActionResponse>(
    `/api/local-knowledge/capsules/${encodeURIComponent(capsuleId)}/reindex`,
    { method: "POST", body: JSON.stringify({ mode: "repair-failed" }) },
  );
}
