// Issue #197 — typed BFF helpers for the Local Knowledge connector graph surface.
// Issue #198 — capsule detail, sources, health diagnostics, indexing job history, and
//              destructive actions (delete, refresh changed files, repair failed files).
// All routes hit the same-origin BFF; the CSRF header is added for mutating methods.

import { ApiError } from "./api";
import type {
  KnowledgeCapsule,
  KnowledgeCapsuleId,
  KnowledgeSource,
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

export interface CapsuleDetailResponse {
  readonly capsule: KnowledgeCapsule;
}

export interface CapsuleActionResponse {
  readonly ok: true;
  readonly capsuleId: KnowledgeCapsuleId;
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
    return { code: "INTERNAL", message: `HTTP ${res.status.toString()}` };
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
