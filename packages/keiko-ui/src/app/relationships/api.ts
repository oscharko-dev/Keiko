// Issue #540 (Epic #532) — typed BFF client for the 11 relationship engine routes.
//
// All mutating calls carry:
//   • `Idempotency-Key` header (api-contract.md §5)
//   • `If-Match` header (PATCH / DELETE — optimistic concurrency)
//
// Server denial codes and messages are surfaced verbatim (error-and-denial-ux.md
// "Per-denial-code UI treatment" — the UI MUST NOT alter or translate them).
//
// No third-party dependency is introduced. Uses the browser Fetch API only.

import type {
  Relationship,
  RelationshipLifecycleState,
  RelationshipObjectKind,
  RelationshipType,
  RelationshipValidationError,
} from "@oscharko-dev/keiko-contracts";
import { RELATIONSHIP_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts";

// ─── Wire shapes (subset of api-contract.md §3 and §4) ────────────────────────

export interface ApiRelationship {
  readonly id: string;
  readonly schemaVersion: string;
  readonly workspaceId: string;
  readonly type: RelationshipType;
  readonly source: { readonly kind: RelationshipObjectKind; readonly id: string };
  readonly target: { readonly kind: RelationshipObjectKind; readonly id: string };
  readonly lifecycle: RelationshipLifecycleState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly etag: number;
  readonly confidence?: number | undefined;
  readonly summary?: string | undefined;
}

export interface ApiError {
  readonly code: string;
  readonly message: string;
}

export interface ApiDenial {
  readonly error: ApiError;
  readonly reasons: readonly RelationshipValidationError[];
}

export interface ListRelationshipsResult {
  readonly entries: readonly ApiRelationship[];
  readonly truncated: boolean;
  readonly nextCursor: string | null;
}

export interface ValidateResult {
  readonly decision: {
    readonly allowed: boolean;
    readonly reasons: readonly RelationshipValidationError[];
  };
}

export interface ExplainResult {
  readonly decision: {
    readonly allowed: boolean;
    readonly reasons: readonly RelationshipValidationError[];
  };
  readonly lifecycle: ReadonlyArray<{
    readonly from: RelationshipLifecycleState;
    readonly to: RelationshipLifecycleState;
    readonly occurredAt: number;
  }>;
}

export interface DependencyNode {
  readonly kind: RelationshipObjectKind;
  readonly id: string;
}

export interface DependencyReport {
  readonly rootRelationshipId: string;
  readonly depthReached: number;
  readonly truncated: boolean;
  readonly truncationReason?: string | undefined;
  readonly relationships: readonly ApiRelationship[];
  readonly endpoints: readonly DependencyNode[];
}

// ─── Graph health (api-contract.md §4.10) ─────────────────────────────────────
// Mirrors the server's RelationshipHealthSummary / RelationshipHealthFindings. The findings are
// the six categorized defect classes #542 exposes; each carries a `*Truncated` flag so the UI can
// state truncation explicitly (the store bounds every category at MAX_RELATIONSHIPS_PER_QUERY).

export interface HealthEndpointRef {
  readonly kind: RelationshipObjectKind;
  readonly id: string;
}

export interface HealthRelationshipRef {
  readonly id: string;
  readonly type: RelationshipType;
  readonly source: HealthEndpointRef;
  readonly target: HealthEndpointRef;
  readonly lifecycle: RelationshipLifecycleState;
}

export interface HealthFindings {
  readonly orphanedEndpoints: readonly HealthEndpointRef[];
  readonly orphanedEndpointsTruncated: boolean;
  readonly staleRelationships: readonly HealthRelationshipRef[];
  readonly staleRelationshipsTruncated: boolean;
  readonly blockedRelationships: readonly HealthRelationshipRef[];
  readonly blockedRelationshipsTruncated: boolean;
  readonly failedRelationships: readonly HealthRelationshipRef[];
  readonly failedRelationshipsTruncated: boolean;
  readonly invalidReferences: readonly HealthRelationshipRef[];
  readonly invalidReferencesTruncated: boolean;
  readonly cycleParticipants: readonly HealthRelationshipRef[];
  readonly cycleScanTruncated: boolean;
}

export interface HealthResult {
  readonly checkedAt: number;
  readonly totals: Readonly<Record<RelationshipLifecycleState, number>>;
  readonly truncated: boolean;
  readonly findings: HealthFindings;
}

// ─── Bounded impact / dependency walk (api-contract.md §4.4) ───────────────────
// The impact endpoint walks from an OBJECT endpoint; dependencies walk from a RELATIONSHIP. Both
// return the same bounded report shape (endpoints + relationships + truncation), differing only in
// the origin field (`origin` vs `rootRelationshipId`), which the UI does not need to distinguish.
export type ImpactReport = DependencyReport;

// ─── Proposal types ────────────────────────────────────────────────────────────

export interface CreateRelationshipProposal {
  readonly type: RelationshipType;
  readonly source: { readonly kind: RelationshipObjectKind; readonly id: string };
  readonly target: { readonly kind: RelationshipObjectKind; readonly id: string };
  readonly summary?: string | undefined;
}

export interface ListRelationshipsQuery {
  readonly lifecycle?: RelationshipLifecycleState | undefined;
  readonly type?: RelationshipType | undefined;
  readonly sourceKind?: RelationshipObjectKind | undefined;
  readonly targetKind?: RelationshipObjectKind | undefined;
  readonly sourceId?: string | undefined;
  readonly targetId?: string | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

// ─── Error class ──────────────────────────────────────────────────────────────

export class RelationshipApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly reasons: readonly RelationshipValidationError[];

  constructor(
    code: string,
    message: string,
    status: number,
    reasons: readonly RelationshipValidationError[] = [],
  ) {
    super(message);
    this.name = "RelationshipApiError";
    this.code = code;
    this.status = status;
    this.reasons = reasons;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function parseApiResponse<T>(res: Response): Promise<T> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new RelationshipApiError(
      "relationship/parse-error",
      "Response is not valid JSON.",
      res.status,
    );
  }
  if (!res.ok) {
    const b = body as Record<string, unknown>;
    const err = (b["error"] as Record<string, unknown> | undefined) ?? b;
    const code = typeof err["code"] === "string" ? err["code"] : "relationship/unknown-error";
    const message =
      typeof err["message"] === "string" ? err["message"] : "An unknown error occurred.";
    const reasons = Array.isArray(b["reasons"])
      ? (b["reasons"] as RelationshipValidationError[])
      : [];
    throw new RelationshipApiError(code, message, res.status, reasons);
  }
  return body as T;
}

function buildHeaders(opts: {
  readonly idempotencyKey?: string;
  readonly ifMatch?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Keiko-CSRF": "1",
  };
  if (opts.idempotencyKey !== undefined) headers["Idempotency-Key"] = opts.idempotencyKey;
  if (opts.ifMatch !== undefined) headers["If-Match"] = opts.ifMatch;
  return headers;
}

// ─── Route 1: POST /api/relationships/validate ────────────────────────────────
export async function validateRelationshipProposal(
  proposal: CreateRelationshipProposal,
): Promise<ValidateResult> {
  const body = {
    schemaVersion: RELATIONSHIP_SCHEMA_VERSION,
    proposal: {
      type: proposal.type,
      source: { kind: proposal.source.kind, id: proposal.source.id },
      target: { kind: proposal.target.kind, id: proposal.target.id },
      ...(proposal.summary !== undefined ? { summary: proposal.summary } : {}),
    },
  };
  const res = await fetch("/api/relationships/validate", {
    method: "POST",
    headers: buildHeaders({}),
    body: JSON.stringify(body),
  });
  const data = await parseApiResponse<{ decision: ValidateResult["decision"] }>(res);
  return { decision: data.decision };
}

// ─── Route 2: POST /api/relationships ─────────────────────────────────────────
export async function createRelationship(
  proposal: CreateRelationshipProposal,
  idempotencyKey: string,
): Promise<{ relationship: ApiRelationship; etag: string }> {
  const body = {
    schemaVersion: RELATIONSHIP_SCHEMA_VERSION,
    proposal: {
      type: proposal.type,
      source: { kind: proposal.source.kind, id: proposal.source.id },
      target: { kind: proposal.target.kind, id: proposal.target.id },
      ...(proposal.summary !== undefined ? { summary: proposal.summary } : {}),
    },
  };
  const res = await fetch("/api/relationships", {
    method: "POST",
    headers: buildHeaders({ idempotencyKey }),
    body: JSON.stringify(body),
  });
  const data = await parseApiResponse<{ relationship: ApiRelationship; etag: string }>(res);
  return { relationship: data.relationship, etag: data.etag };
}

// ─── Route 3: GET /api/relationships ──────────────────────────────────────────
export async function listRelationships(
  query: ListRelationshipsQuery,
): Promise<ListRelationshipsResult> {
  const params = new URLSearchParams();
  if (query.lifecycle !== undefined) params.set("lifecycle", query.lifecycle);
  if (query.type !== undefined) params.set("type", query.type);
  if (query.sourceKind !== undefined) params.set("sourceKind", query.sourceKind);
  if (query.targetKind !== undefined) params.set("targetKind", query.targetKind);
  if (query.sourceId !== undefined) params.set("sourceId", query.sourceId);
  if (query.targetId !== undefined) params.set("targetId", query.targetId);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor !== undefined) params.set("cursor", query.cursor);
  const res = await fetch(`/api/relationships?${params.toString()}`);
  const data = await parseApiResponse<{
    entries: ApiRelationship[];
    truncated: boolean;
    nextCursor: string | null;
  }>(res);
  return { entries: data.entries, truncated: data.truncated, nextCursor: data.nextCursor };
}

// ─── Route 4: GET /api/relationships/:id ──────────────────────────────────────
export async function getRelationship(id: string): Promise<ApiRelationship> {
  const res = await fetch(`/api/relationships/${encodeURIComponent(id)}`);
  const data = await parseApiResponse<{ relationship: ApiRelationship }>(res);
  return data.relationship;
}

// ─── Route 5: PATCH /api/relationships/:id ────────────────────────────────────
export async function patchRelationship(
  id: string,
  patch:
    | { transition: { to: RelationshipLifecycleState; summary?: string } }
    | { reconnect: { target: { kind: RelationshipObjectKind; id: string }; summary?: string } },
  ifMatch: string,
  idempotencyKey: string,
): Promise<{ relationship: ApiRelationship; etag: string }> {
  const res = await fetch(`/api/relationships/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: buildHeaders({ idempotencyKey, ifMatch }),
    body: JSON.stringify({ schemaVersion: RELATIONSHIP_SCHEMA_VERSION, ...patch }),
  });
  const data = await parseApiResponse<{ relationship: ApiRelationship; etag: string }>(res);
  return { relationship: data.relationship, etag: data.etag };
}

// ─── Route 6: DELETE /api/relationships/:id ───────────────────────────────────
export async function deleteRelationship(
  id: string,
  ifMatch: string,
  idempotencyKey: string,
): Promise<ApiRelationship> {
  const res = await fetch(`/api/relationships/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: buildHeaders({ idempotencyKey, ifMatch }),
  });
  const data = await parseApiResponse<{ relationship: ApiRelationship }>(res);
  return data.relationship;
}

// ─── Route 7: GET /api/relationships/:id/dependencies ─────────────────────────
export async function getDependencies(
  id: string,
  opts: {
    direction?: "outgoing" | "incoming" | "both";
    maxDepth?: number;
    maxNodes?: number;
    maxRelationships?: number;
  } = {},
): Promise<DependencyReport> {
  const params = new URLSearchParams();
  if (opts.direction !== undefined) params.set("direction", opts.direction);
  if (opts.maxDepth !== undefined) params.set("maxDepth", String(opts.maxDepth));
  if (opts.maxNodes !== undefined) params.set("maxNodes", String(opts.maxNodes));
  if (opts.maxRelationships !== undefined)
    params.set("maxRelationships", String(opts.maxRelationships));
  const res = await fetch(
    `/api/relationships/${encodeURIComponent(id)}/dependencies?${params.toString()}`,
  );
  const data = await parseApiResponse<{ report: DependencyReport }>(res);
  return data.report;
}

// ─── Route 8: GET /api/relationships/impact ───────────────────────────────────
export async function getImpact(
  endpointKind: RelationshipObjectKind,
  endpointId: string,
  opts: {
    direction?: "outgoing" | "incoming" | "both";
    maxDepth?: number;
    maxNodes?: number;
    maxRelationships?: number;
  } = {},
): Promise<DependencyReport> {
  const params = new URLSearchParams({ endpointKind, endpointId });
  if (opts.direction !== undefined) params.set("direction", opts.direction);
  if (opts.maxDepth !== undefined) params.set("maxDepth", String(opts.maxDepth));
  if (opts.maxNodes !== undefined) params.set("maxNodes", String(opts.maxNodes));
  if (opts.maxRelationships !== undefined)
    params.set("maxRelationships", String(opts.maxRelationships));
  const res = await fetch(`/api/relationships/impact?${params.toString()}`);
  const data = await parseApiResponse<{ report: DependencyReport }>(res);
  return data.report;
}

// ─── Route 9: GET /api/relationships/:id/explain ──────────────────────────────
export async function getExplain(id: string): Promise<ExplainResult> {
  const res = await fetch(`/api/relationships/${encodeURIComponent(id)}/explain`);
  return parseApiResponse<ExplainResult>(res);
}

// ─── Route 10: GET /api/relationships/health ──────────────────────────────────
export async function getHealth(): Promise<HealthResult> {
  const res = await fetch("/api/relationships/health");
  return parseApiResponse<HealthResult>(res);
}

// Re-export Relationship type for consumers of this module
export type { Relationship, RelationshipLifecycleState, RelationshipType, RelationshipObjectKind };
