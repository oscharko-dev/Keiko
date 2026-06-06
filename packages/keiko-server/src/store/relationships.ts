// Epic #532 / Issue #539 — relationship engine store layer.
//
// Module-scope SQL constants only; NO string interpolation into SQL; every read and write
// is workspace-scoped (storage.md §3.3, audit-events.md §10). Mutations run in a single
// transaction together with their audit row write (storage.md §4); the audit-row writer
// lives in `./relationship-audit.ts` and is invoked by the API layer inside the same
// BEGIN..COMMIT block.
//
// This file owns the lifecycle of the `relationships` and `relationship_lifecycle_history`
// tables only. The validator (#538) is pure and lives in `@oscharko-dev/keiko-contracts`;
// the API layer (`../relationship-handlers.ts`) composes the validator with this store.
//
// Bounded-query caps mirror api-contract.md §7. Hard caps are exported as `const` so the
// handlers cite the same numbers.

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type {
  Relationship,
  RelationshipLifecycleState,
  RelationshipObjectKind,
  RelationshipType,
} from "@oscharko-dev/keiko-contracts";
import {
  RELATIONSHIP_SCHEMA_VERSION,
  RELATIONSHIP_SUPPORTED_OBJECT_KINDS,
} from "@oscharko-dev/keiko-contracts";
import { invalidRequest, notFound, UiStoreError } from "./errors.js";

// ─── Bounded-query caps (api-contract.md §7) ──────────────────────────────────
export const MAX_LIST_LIMIT = 256;
export const DEFAULT_LIST_LIMIT = 64;
export const MAX_IMPACT_DEPTH = 3;
export const DEFAULT_IMPACT_DEPTH = 1;
export const MAX_IMPACT_NODES = 1024;
export const DEFAULT_IMPACT_NODES = 256;
export const MAX_IMPACT_RELATIONSHIPS = 2048;
export const DEFAULT_IMPACT_RELATIONSHIPS = 512;
export const LIFECYCLE_HISTORY_RETAIN = 32;
// Alias used by #542 health surface — counts in every finding category are hard-capped at
// this number. It is the same hard cap as MAX_IMPACT_RELATIONSHIPS; the alias is exported
// so callers can name the contract intent.
export const MAX_RELATIONSHIPS_PER_QUERY = MAX_IMPACT_RELATIONSHIPS;

// ─── Wire types ───────────────────────────────────────────────────────────────
// Scope shapes mirror `MemoryScope` in @oscharko-dev/keiko-contracts (api-contract.md §3.3).
// The store records `scope_kind` + `scope_coordinate` plus a denormalised `workspace_scope_id`
// for index-friendly filtering (storage.md §3.2). We carry a `RelationshipScope` discriminated
// union as the public seam; ad-hoc fields stay private to the SQL boundary.
export type RelationshipScope =
  | { readonly kind: "user"; readonly userId: string; readonly workspaceId: string }
  | { readonly kind: "workspace"; readonly workspaceId: string }
  | { readonly kind: "project"; readonly projectId: string; readonly workspaceId: string }
  | {
      readonly kind: "workflow";
      readonly workflowDefinitionId: string;
      readonly workspaceId: string;
    }
  | { readonly kind: "global"; readonly workspaceId: string };

export interface StoredRelationship extends Relationship {
  readonly confidence?: number | undefined;
  readonly summary?: string | undefined;
  readonly scope: RelationshipScope;
}

export interface NewRelationship {
  readonly id: string;
  readonly workspaceId: string;
  readonly scope: RelationshipScope;
  readonly type: RelationshipType;
  readonly source: {
    readonly kind: RelationshipObjectKind;
    readonly id: string;
    readonly workspaceId: string;
  };
  readonly target: {
    readonly kind: RelationshipObjectKind;
    readonly id: string;
    readonly workspaceId: string;
  };
  readonly lifecycleState: RelationshipLifecycleState;
  readonly confidence?: number | undefined;
  readonly summary?: string | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly etag: string;
}

export interface RelationshipListQuery {
  readonly workspaceId: string;
  readonly sourceKind?: RelationshipObjectKind | undefined;
  readonly sourceId?: string | undefined;
  readonly targetKind?: RelationshipObjectKind | undefined;
  readonly targetId?: string | undefined;
  readonly type?: RelationshipType | undefined;
  readonly lifecycle?: RelationshipLifecycleState | undefined;
  readonly limit: number;
  readonly afterEtag?: string | undefined;
}

export interface RelationshipListResult {
  readonly entries: readonly StoredRelationship[];
  readonly truncated: boolean;
  readonly nextCursor: string | undefined;
}

export interface RelationshipCardinalitySnapshot {
  readonly producesEvidenceForSource: number;
  readonly startsWorkflowForTarget: number;
}

export interface RelationshipLifecycleHistoryRow {
  readonly relationshipId: string;
  readonly fromState: RelationshipLifecycleState;
  readonly toState: RelationshipLifecycleState;
  readonly occurredAt: number;
  readonly summary?: string | undefined;
}

// ─── Issue #542 — categorized health findings ─────────────────────────────────
// Six finding categories surface graph hygiene defects to the inspector. Every list is
// hard-capped at MAX_RELATIONSHIPS_PER_QUERY entries — when the cap is hit the corresponding
// `*Truncated` flag is `true` and the list contains the first N matches in deterministic
// order (lifecycle / endpoint kind / endpoint id ascending). `cycleScanTruncated` covers
// the more expensive cycle pass: when set, the cycle list reflects partial coverage and
// the UI surfaces a "cycle scan incomplete" notice.
export interface RelationshipHealthEndpointRef {
  readonly kind: RelationshipObjectKind;
  readonly id: string;
}

export interface RelationshipHealthRelationshipRef {
  readonly id: string;
  readonly type: RelationshipType;
  readonly source: RelationshipHealthEndpointRef;
  readonly target: RelationshipHealthEndpointRef;
  readonly lifecycle: RelationshipLifecycleState;
}

export interface RelationshipHealthFindings {
  readonly orphanedEndpoints: readonly RelationshipHealthEndpointRef[];
  readonly orphanedEndpointsTruncated: boolean;
  readonly staleRelationships: readonly RelationshipHealthRelationshipRef[];
  readonly staleRelationshipsTruncated: boolean;
  readonly blockedRelationships: readonly RelationshipHealthRelationshipRef[];
  readonly blockedRelationshipsTruncated: boolean;
  readonly failedRelationships: readonly RelationshipHealthRelationshipRef[];
  readonly failedRelationshipsTruncated: boolean;
  readonly invalidReferences: readonly RelationshipHealthRelationshipRef[];
  readonly invalidReferencesTruncated: boolean;
  readonly cycleParticipants: readonly RelationshipHealthRelationshipRef[];
  readonly cycleScanTruncated: boolean;
}

export interface RelationshipHealthSummary {
  readonly checkedAt: number;
  readonly totals: Readonly<Record<RelationshipLifecycleState, number>>;
  readonly truncated: boolean;
  readonly findings: RelationshipHealthFindings;
}

// ─── Row type ─────────────────────────────────────────────────────────────────
interface RelationshipRow {
  readonly id: string;
  readonly schema_version: string;
  readonly workspace_scope_id: string;
  readonly scope_kind: string;
  readonly scope_coordinate: string;
  readonly type: string;
  readonly source_kind: string;
  readonly source_id: string;
  readonly target_kind: string;
  readonly target_id: string;
  readonly lifecycle: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly etag: string;
  readonly confidence: number | null;
  readonly summary: string | null;
}

function rebuildScope(row: RelationshipRow): RelationshipScope {
  const wsId = row.workspace_scope_id;
  switch (row.scope_kind) {
    case "user":
      return { kind: "user", userId: row.scope_coordinate, workspaceId: wsId };
    case "workspace":
      return { kind: "workspace", workspaceId: row.scope_coordinate };
    case "project":
      return { kind: "project", projectId: row.scope_coordinate, workspaceId: wsId };
    case "workflow":
      return {
        kind: "workflow",
        workflowDefinitionId: row.scope_coordinate,
        workspaceId: wsId,
      };
    case "global":
      return { kind: "global", workspaceId: wsId };
    default:
      // STRICT mode + CHECK constraint at the schema layer prevent this; surfaced as a typed
      // error so callers never see a partial row silently.
      throw new UiStoreError("internal", "Unknown relationship scope kind.", 500);
  }
}

function rowToRelationship(row: RelationshipRow): StoredRelationship {
  const stored: StoredRelationship = {
    id: row.id,
    schemaVersion: RELATIONSHIP_SCHEMA_VERSION,
    workspaceId: row.workspace_scope_id,
    source: {
      kind: row.source_kind as RelationshipObjectKind,
      id: row.source_id,
      workspaceId: row.workspace_scope_id,
    },
    target: {
      kind: row.target_kind as RelationshipObjectKind,
      id: row.target_id,
      workspaceId: row.workspace_scope_id,
    },
    type: row.type as RelationshipType,
    lifecycleState: row.lifecycle as RelationshipLifecycleState,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    etag: row.updated_at, // legacy numeric etag in the contract; we expose the opaque string via storedEtag()
    scope: rebuildScope(row),
    ...(row.confidence === null ? {} : { confidence: row.confidence }),
    ...(row.summary === null ? {} : { summary: row.summary }),
  };
  return stored;
}

// The storage column `etag` is the canonical optimistic-concurrency token (storage.md §3.2
// describes `printf('%016x', updated_at) || '-' || lower(hex(randomblob(3)))`). The contract
// also exposes a numeric `etag` field for legacy callers; the helper returns the canonical
// opaque token for `ETag` / `If-Match`.
export function storedEtag(row: StoredRelationship, db: DatabaseSync): string {
  const direct = db.prepare(SQL_GET_ETAG).get(row.id) as { etag?: string } | undefined;
  if (!direct?.etag) throw notFound("Relationship");
  return direct.etag;
}

// ─── SQL ──────────────────────────────────────────────────────────────────────
const SQL_INSERT = `
INSERT INTO relationships(
  id, schema_version, workspace_scope_id, scope_kind, scope_coordinate, type,
  source_kind, source_id, target_kind, target_id, lifecycle,
  created_at, updated_at, etag, confidence, summary
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;
const SQL_GET = `
SELECT id, schema_version, workspace_scope_id, scope_kind, scope_coordinate, type,
       source_kind, source_id, target_kind, target_id, lifecycle,
       created_at, updated_at, etag, confidence, summary
FROM relationships
WHERE id = ? AND workspace_scope_id = ?
`;
const SQL_GET_ETAG = "SELECT etag FROM relationships WHERE id = ?";
const SQL_GET_ETAG_SCOPED =
  "SELECT etag FROM relationships WHERE id = ? AND workspace_scope_id = ?";
const SQL_UPDATE_LIFECYCLE = `
UPDATE relationships
SET lifecycle = ?, updated_at = ?, etag = ?, summary = COALESCE(?, summary)
WHERE id = ? AND workspace_scope_id = ?
`;
const SQL_UPDATE_RECONNECT = `
UPDATE relationships
SET target_kind = ?, target_id = ?, updated_at = ?, etag = ?, summary = COALESCE(?, summary)
WHERE id = ? AND workspace_scope_id = ?
`;
const SQL_COUNT_PRODUCES_EVIDENCE_FOR_SOURCE = `
SELECT COUNT(*) AS n FROM relationships
WHERE workspace_scope_id = ? AND type = 'produces-evidence'
  AND source_kind = ? AND source_id = ?
  AND lifecycle IN ('draft','active','archived')
`;
const SQL_COUNT_STARTS_WORKFLOW_FOR_TARGET = `
SELECT COUNT(*) AS n FROM relationships
WHERE workspace_scope_id = ? AND type = 'starts-workflow'
  AND target_kind = ? AND target_id = ?
  AND lifecycle IN ('draft','active','archived')
`;
const SQL_INSERT_HISTORY = `
INSERT INTO relationship_lifecycle_history(id, relationship_id, from_state, to_state, occurred_at, summary)
VALUES (?, ?, ?, ?, ?, ?)
`;
const SQL_LIST_HISTORY = `
SELECT relationship_id, from_state, to_state, occurred_at, summary
FROM relationship_lifecycle_history
WHERE relationship_id = ?
ORDER BY occurred_at DESC
LIMIT ?
`;
const SQL_FIND_BY_SOURCE = `
SELECT id, schema_version, workspace_scope_id, scope_kind, scope_coordinate, type,
       source_kind, source_id, target_kind, target_id, lifecycle,
       created_at, updated_at, etag, confidence, summary
FROM relationships
WHERE workspace_scope_id = ? AND source_kind = ? AND source_id = ?
ORDER BY updated_at DESC, id ASC
LIMIT ?
`;
const SQL_FIND_BY_TARGET = `
SELECT id, schema_version, workspace_scope_id, scope_kind, scope_coordinate, type,
       source_kind, source_id, target_kind, target_id, lifecycle,
       created_at, updated_at, etag, confidence, summary
FROM relationships
WHERE workspace_scope_id = ? AND target_kind = ? AND target_id = ?
ORDER BY updated_at DESC, id ASC
LIMIT ?
`;
const SQL_HEALTH_COUNTS = `
SELECT lifecycle, COUNT(*) AS n FROM relationships
WHERE workspace_scope_id = ?
GROUP BY lifecycle
`;
// Stale / blocked / revoked / invalid SQL — each is workspace-scoped, hard-capped, and
// deterministically ordered by (lifecycle, source_kind, source_id, target_kind, target_id).
// The limit is bound at execute-time; no user input enters SQL text.
const SQL_HEALTH_FINDINGS_BY_LIFECYCLE = `
SELECT id, type, source_kind, source_id, target_kind, target_id, lifecycle
FROM relationships
WHERE workspace_scope_id = ? AND lifecycle = ?
ORDER BY source_kind ASC, source_id ASC, target_kind ASC, target_id ASC, id ASC
LIMIT ?
`;
// Active relationships used for cycle detection + invalid-reference detection. Bounded by
// the same cap; we cap both the scan input and the result list at MAX_RELATIONSHIPS_PER_QUERY
// so an oversized graph degrades gracefully via `cycleScanTruncated = true`.
const SQL_HEALTH_ACTIVE_RELATIONSHIPS = `
SELECT id, type, source_kind, source_id, target_kind, target_id, lifecycle
FROM relationships
WHERE workspace_scope_id = ? AND lifecycle IN ('draft','active','archived')
ORDER BY source_kind ASC, source_id ASC, target_kind ASC, target_id ASC, id ASC
LIMIT ?
`;
// Endpoint participation count. Used to detect orphans: an endpoint that previously
// participated in a relationship (so it appears in the relationships table) but is no
// longer referenced by any active relationship. Bounded.
const SQL_HEALTH_ENDPOINT_PARTICIPATION = `
SELECT kind, id, SUM(active_count) AS active_total, SUM(any_count) AS any_total FROM (
  SELECT source_kind AS kind, source_id AS id,
         CASE WHEN lifecycle IN ('draft','active','archived') THEN 1 ELSE 0 END AS active_count,
         1 AS any_count
  FROM relationships WHERE workspace_scope_id = ?
  UNION ALL
  SELECT target_kind AS kind, target_id AS id,
         CASE WHEN lifecycle IN ('draft','active','archived') THEN 1 ELSE 0 END AS active_count,
         1 AS any_count
  FROM relationships WHERE workspace_scope_id = ?
)
GROUP BY kind, id
ORDER BY kind ASC, id ASC
LIMIT ?
`;

// ─── Public mutating + reading API ────────────────────────────────────────────
export function insertRelationship(db: DatabaseSync, rel: NewRelationship): StoredRelationship {
  // Validator runs at the API layer before this is reached (storage.md §4); the store is the
  // structural barrier. CHECK constraints + the partial unique indexes catch the rest.
  const scopeCoordinate = relationshipScopeCoordinate(rel.scope);
  try {
    db.prepare(SQL_INSERT).run(
      rel.id,
      RELATIONSHIP_SCHEMA_VERSION,
      rel.workspaceId,
      rel.scope.kind,
      scopeCoordinate,
      rel.type,
      rel.source.kind,
      rel.source.id,
      rel.target.kind,
      rel.target.id,
      rel.lifecycleState,
      rel.createdAt,
      rel.updatedAt,
      rel.etag,
      rel.confidence ?? null,
      rel.summary ?? null,
    );
  } catch (error) {
    if (error instanceof Error && /UNIQUE/i.test(error.message)) {
      throw new UiStoreError("invalid_request", "Cardinality constraint violated.", 409);
    }
    throw error;
  }
  // History row for the initial state (draft → active is one common case; for any other
  // initial lifecycle the row records draft → <initial> per lifecycle.md §3). The PK pairs the
  // relationship id with a `randomUUID` suffix so re-creation under a recycled id (or two events
  // arriving at the same `Date.now()` millisecond) cannot collide on the history PK.
  insertHistoryRow(db, {
    id: nextHistoryRowId(rel.id),
    relationshipId: rel.id,
    fromState: "draft",
    toState: rel.lifecycleState,
    occurredAt: rel.createdAt,
    summary: rel.summary,
  });
  const row = db.prepare(SQL_GET).get(rel.id, rel.workspaceId) as RelationshipRow | undefined;
  if (row === undefined) {
    throw new UiStoreError("internal", "Insert returned no row.", 500);
  }
  return rowToRelationship(row);
}

export function getRelationship(
  db: DatabaseSync,
  id: string,
  workspaceId: string,
): StoredRelationship | undefined {
  const row = db.prepare(SQL_GET).get(id, workspaceId) as RelationshipRow | undefined;
  return row === undefined ? undefined : rowToRelationship(row);
}

export function getRelationshipEtag(
  db: DatabaseSync,
  id: string,
  workspaceId: string,
): string | undefined {
  const row = db.prepare(SQL_GET_ETAG_SCOPED).get(id, workspaceId) as { etag?: string } | undefined;
  return row?.etag;
}

export interface UpdateLifecycleArgs {
  readonly id: string;
  readonly workspaceId: string;
  readonly to: RelationshipLifecycleState;
  readonly previous: RelationshipLifecycleState;
  readonly newEtag: string;
  readonly updatedAt: number;
  readonly summary?: string | undefined;
}

export function updateRelationshipLifecycle(
  db: DatabaseSync,
  args: UpdateLifecycleArgs,
): StoredRelationship {
  const info = db
    .prepare(SQL_UPDATE_LIFECYCLE)
    .run(args.to, args.updatedAt, args.newEtag, args.summary ?? null, args.id, args.workspaceId);
  if (info.changes === 0) throw notFound("Relationship");
  // Issue #539 audit: a deterministic `${id}-h-${updatedAt}` PK collides when two transitions
  // share a `Date.now()` millisecond (frequent in tests with a pinned clock; possible in
  // production at fast clock ticks). UNIQUE-violation would roll back the entire UPDATE — a
  // silent lifecycle revert. The randomUUID-suffixed PK below stays unique within a workspace.
  insertHistoryRow(db, {
    id: nextHistoryRowId(args.id),
    relationshipId: args.id,
    fromState: args.previous,
    toState: args.to,
    occurredAt: args.updatedAt,
    summary: args.summary,
  });
  const row = db.prepare(SQL_GET).get(args.id, args.workspaceId) as RelationshipRow | undefined;
  if (row === undefined) throw notFound("Relationship");
  return rowToRelationship(row);
}

export interface ReconnectArgs {
  readonly id: string;
  readonly workspaceId: string;
  readonly target: { readonly kind: RelationshipObjectKind; readonly id: string };
  readonly newEtag: string;
  readonly updatedAt: number;
  readonly summary?: string | undefined;
}

export function reconnectRelationship(db: DatabaseSync, args: ReconnectArgs): StoredRelationship {
  const info = db
    .prepare(SQL_UPDATE_RECONNECT)
    .run(
      args.target.kind,
      args.target.id,
      args.updatedAt,
      args.newEtag,
      args.summary ?? null,
      args.id,
      args.workspaceId,
    );
  if (info.changes === 0) throw notFound("Relationship");
  const row = db.prepare(SQL_GET).get(args.id, args.workspaceId) as RelationshipRow | undefined;
  if (row === undefined) throw notFound("Relationship");
  return rowToRelationship(row);
}

export function relationshipCardinalitySnapshot(
  db: DatabaseSync,
  workspaceId: string,
  source: { readonly kind: RelationshipObjectKind; readonly id: string },
  target: { readonly kind: RelationshipObjectKind; readonly id: string },
): RelationshipCardinalitySnapshot {
  const sourceCount = (
    db.prepare(SQL_COUNT_PRODUCES_EVIDENCE_FOR_SOURCE).get(workspaceId, source.kind, source.id) as {
      n: number;
    }
  ).n;
  const targetCount = (
    db.prepare(SQL_COUNT_STARTS_WORKFLOW_FOR_TARGET).get(workspaceId, target.kind, target.id) as {
      n: number;
    }
  ).n;
  return {
    producesEvidenceForSource: sourceCount,
    startsWorkflowForTarget: targetCount,
  };
}

// Closed-set predicate fragments. Each fragment is a STATIC `column = ?` string;
// only the parameter values are bound at execution time. No user input enters SQL text.
const LIST_FILTER_FRAGMENTS = [
  { key: "sourceKind", clause: "source_kind = ?" },
  { key: "sourceId", clause: "source_id = ?" },
  { key: "targetKind", clause: "target_kind = ?" },
  { key: "targetId", clause: "target_id = ?" },
  { key: "type", clause: "type = ?" },
  { key: "lifecycle", clause: "lifecycle = ?" },
  { key: "afterEtag", clause: "etag < ?" },
] as const;

function buildListClauses(q: RelationshipListQuery): {
  readonly clauses: readonly string[];
  readonly params: readonly (string | number)[];
} {
  const clauses: string[] = ["workspace_scope_id = ?"];
  const params: (string | number)[] = [q.workspaceId];
  for (const fragment of LIST_FILTER_FRAGMENTS) {
    const value = q[fragment.key];
    if (value !== undefined) {
      clauses.push(fragment.clause);
      params.push(value);
    }
  }
  return { clauses, params };
}

export function listRelationships(
  db: DatabaseSync,
  q: RelationshipListQuery,
): RelationshipListResult {
  if (q.limit <= 0 || q.limit > MAX_LIST_LIMIT) {
    throw invalidRequest("Limit out of bounds.");
  }
  const { clauses, params: filterParams } = buildListClauses(q);
  const params: (string | number)[] = [...filterParams, q.limit + 1];
  const sql =
    "SELECT id, schema_version, workspace_scope_id, scope_kind, scope_coordinate, type," +
    " source_kind, source_id, target_kind, target_id, lifecycle, created_at, updated_at," +
    " etag, confidence, summary FROM relationships WHERE " +
    clauses.join(" AND ") +
    " ORDER BY etag DESC, id ASC LIMIT ?";
  const rows = db.prepare(sql).all(...params) as unknown as RelationshipRow[];
  const truncated = rows.length > q.limit;
  const slice = truncated ? rows.slice(0, q.limit) : rows;
  const entries = slice.map(rowToRelationship);
  const last = slice[slice.length - 1];
  const nextCursor = truncated && last !== undefined ? last.etag : undefined;
  // Always return undefined when not truncated; `nextCursor` is `string | undefined` so
  // exactOptionalPropertyTypes-safe.
  return nextCursor === undefined
    ? { entries, truncated, nextCursor: undefined }
    : { entries, truncated, nextCursor };
}

export function findRelationshipsBySource(
  db: DatabaseSync,
  workspaceId: string,
  source: { readonly kind: RelationshipObjectKind; readonly id: string },
  limit: number,
): readonly StoredRelationship[] {
  if (limit <= 0 || limit > MAX_LIST_LIMIT) throw invalidRequest("Limit out of bounds.");
  const rows = db
    .prepare(SQL_FIND_BY_SOURCE)
    .all(workspaceId, source.kind, source.id, limit) as unknown as RelationshipRow[];
  return rows.map(rowToRelationship);
}

export function findRelationshipsByTarget(
  db: DatabaseSync,
  workspaceId: string,
  target: { readonly kind: RelationshipObjectKind; readonly id: string },
  limit: number,
): readonly StoredRelationship[] {
  if (limit <= 0 || limit > MAX_LIST_LIMIT) throw invalidRequest("Limit out of bounds.");
  const rows = db
    .prepare(SQL_FIND_BY_TARGET)
    .all(workspaceId, target.kind, target.id, limit) as unknown as RelationshipRow[];
  return rows.map(rowToRelationship);
}

export function listRelationshipLifecycleHistory(
  db: DatabaseSync,
  relationshipId: string,
  limit: number = LIFECYCLE_HISTORY_RETAIN,
): readonly RelationshipLifecycleHistoryRow[] {
  if (limit <= 0 || limit > LIFECYCLE_HISTORY_RETAIN) {
    throw invalidRequest("History limit out of bounds.");
  }
  const rows = db.prepare(SQL_LIST_HISTORY).all(relationshipId, limit) as {
    relationship_id: string;
    from_state: string;
    to_state: string;
    occurred_at: number;
    summary: string | null;
  }[];
  return rows.map((r) => {
    const base: RelationshipLifecycleHistoryRow = {
      relationshipId: r.relationship_id,
      fromState: r.from_state as RelationshipLifecycleState,
      toState: r.to_state as RelationshipLifecycleState,
      occurredAt: r.occurred_at,
      ...(r.summary === null ? {} : { summary: r.summary }),
    };
    return base;
  });
}

export interface DependencyWalkOptions {
  readonly workspaceId: string;
  readonly originId: string;
  readonly direction: "outgoing" | "incoming" | "both";
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxRelationships: number;
}

export interface DependencyWalkResult {
  readonly relationships: readonly StoredRelationship[];
  readonly nodes: readonly {
    readonly kind: RelationshipObjectKind;
    readonly id: string;
  }[];
  readonly truncated: boolean;
  readonly truncationReason: "max-depth" | "max-nodes" | "max-relationships" | null;
  readonly depthReached: number;
}

export function walkDependencies(
  db: DatabaseSync,
  options: DependencyWalkOptions,
): DependencyWalkResult {
  validateWalkBounds(options);
  const origin = getRelationship(db, options.originId, options.workspaceId);
  if (origin === undefined) throw notFound("Relationship");
  return runWalkFromOrigin(db, origin, options);
}

export interface ImpactWalkOptions {
  readonly workspaceId: string;
  readonly endpoint: { readonly kind: RelationshipObjectKind; readonly id: string };
  readonly direction: "outgoing" | "incoming" | "both";
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxRelationships: number;
}

export function computeImpact(db: DatabaseSync, options: ImpactWalkOptions): DependencyWalkResult {
  validateWalkBounds(options);
  return runWalk(db, options.workspaceId, [options.endpoint], options);
}

export function graphHealth(db: DatabaseSync, workspaceId: string): RelationshipHealthSummary {
  const totals = computeLifecycleTotals(db, workspaceId);
  const findings = computeHealthFindings(db, workspaceId);
  return { checkedAt: Date.now(), totals, truncated: false, findings };
}

function computeLifecycleTotals(
  db: DatabaseSync,
  workspaceId: string,
): Record<RelationshipLifecycleState, number> {
  const rows = db.prepare(SQL_HEALTH_COUNTS).all(workspaceId) as {
    lifecycle: string;
    n: number;
  }[];
  const totals: Record<RelationshipLifecycleState, number> = {
    draft: 0,
    active: 0,
    archived: 0,
    superseded: 0,
    revoked: 0,
    blocked: 0,
    stale: 0,
  };
  for (const r of rows) {
    if (r.lifecycle in totals) {
      totals[r.lifecycle as RelationshipLifecycleState] = r.n;
    }
  }
  return totals;
}

interface RawHealthRow {
  readonly id: string;
  readonly type: string;
  readonly source_kind: string;
  readonly source_id: string;
  readonly target_kind: string;
  readonly target_id: string;
  readonly lifecycle: string;
}

function rawRowToRef(r: RawHealthRow): RelationshipHealthRelationshipRef {
  return {
    id: r.id,
    type: r.type as RelationshipType,
    source: { kind: r.source_kind as RelationshipObjectKind, id: r.source_id },
    target: { kind: r.target_kind as RelationshipObjectKind, id: r.target_id },
    lifecycle: r.lifecycle as RelationshipLifecycleState,
  };
}

function selectFindingsByLifecycle(
  db: DatabaseSync,
  workspaceId: string,
  lifecycle: RelationshipLifecycleState,
): { rows: readonly RelationshipHealthRelationshipRef[]; truncated: boolean } {
  // Over-fetch by one to detect truncation without a separate COUNT round-trip.
  const cap = MAX_RELATIONSHIPS_PER_QUERY;
  const raw = db
    .prepare(SQL_HEALTH_FINDINGS_BY_LIFECYCLE)
    .all(workspaceId, lifecycle, cap + 1) as unknown as RawHealthRow[];
  const truncated = raw.length > cap;
  const sliced = truncated ? raw.slice(0, cap) : raw;
  return { rows: sliced.map(rawRowToRef), truncated };
}

const SUPPORTED_OBJECT_KIND_SET: ReadonlySet<string> = new Set(
  RELATIONSHIP_SUPPORTED_OBJECT_KINDS as readonly string[],
);

function selectInvalidReferences(
  db: DatabaseSync,
  workspaceId: string,
): { rows: readonly RelationshipHealthRelationshipRef[]; truncated: boolean } {
  const cap = MAX_RELATIONSHIPS_PER_QUERY;
  // Scan up to cap+1 rows; an endpoint kind not in the supported set marks the
  // relationship as referencing an unsupported object kind.
  const raw = db
    .prepare(SQL_HEALTH_ACTIVE_RELATIONSHIPS)
    .all(workspaceId, cap + 1) as unknown as RawHealthRow[];
  const scanTruncated = raw.length > cap;
  const sliced = scanTruncated ? raw.slice(0, cap) : raw;
  const out: RelationshipHealthRelationshipRef[] = [];
  for (const row of sliced) {
    if (
      !SUPPORTED_OBJECT_KIND_SET.has(row.source_kind) ||
      !SUPPORTED_OBJECT_KIND_SET.has(row.target_kind)
    ) {
      out.push(rawRowToRef(row));
    }
  }
  return { rows: out, truncated: scanTruncated };
}

function selectCycleParticipants(
  db: DatabaseSync,
  workspaceId: string,
): { rows: readonly RelationshipHealthRelationshipRef[]; scanTruncated: boolean } {
  const cap = MAX_RELATIONSHIPS_PER_QUERY;
  const raw = db
    .prepare(SQL_HEALTH_ACTIVE_RELATIONSHIPS)
    .all(workspaceId, cap + 1) as unknown as RawHealthRow[];
  const scanTruncated = raw.length > cap;
  const sliced = scanTruncated ? raw.slice(0, cap) : raw;
  // Build adjacency keyed by endpoint, then DFS to find back-edges. Detection is
  // O(V + E) over the bounded scan input.
  const refs = sliced.map(rawRowToRef);
  const participantIds = detectCycleParticipantIds(refs);
  const rows = refs.filter((r) => participantIds.has(r.id));
  return { rows, scanTruncated };
}

function detectCycleParticipantIds(
  refs: readonly RelationshipHealthRelationshipRef[],
): Set<string> {
  // Adjacency: node-key -> list of {nextNodeKey, relId}. Self-loops are cycles too.
  const adjacency = new Map<string, { nextKey: string; relId: string }[]>();
  for (const ref of refs) {
    const fromKey = nodeKey(ref.source);
    const toKey = nodeKey(ref.target);
    const list = adjacency.get(fromKey) ?? [];
    list.push({ nextKey: toKey, relId: ref.id });
    adjacency.set(fromKey, list);
  }
  const participants = new Set<string>();
  const state = new Map<string, "visiting" | "done">();
  // Iterative DFS to avoid stack blow-up on deep graphs.
  for (const startKey of adjacency.keys()) {
    if (state.get(startKey) !== undefined) continue;
    dfsFromStart(startKey, adjacency, state, participants);
  }
  return participants;
}

interface DfsFrame {
  readonly key: string;
  index: number;
  readonly viaRelId: string | null;
}

function dfsFromStart(
  startKey: string,
  adjacency: Map<string, { nextKey: string; relId: string }[]>,
  state: Map<string, "visiting" | "done">,
  participants: Set<string>,
): void {
  const stack: DfsFrame[] = [{ key: startKey, index: 0, viaRelId: null }];
  state.set(startKey, "visiting");
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame === undefined) break;
    const neighbours = adjacency.get(frame.key) ?? [];
    if (frame.index >= neighbours.length) {
      state.set(frame.key, "done");
      stack.pop();
      continue;
    }
    const edge = neighbours[frame.index];
    frame.index += 1;
    if (edge === undefined) continue;
    const neighbourState = state.get(edge.nextKey);
    if (neighbourState === "visiting") {
      // Back-edge: every relationship on the current path from edge.nextKey down
      // is a cycle participant.
      markBackEdgeParticipants(stack, edge, participants);
      continue;
    }
    if (neighbourState === "done") continue;
    state.set(edge.nextKey, "visiting");
    stack.push({ key: edge.nextKey, index: 0, viaRelId: edge.relId });
  }
}

function markBackEdgeParticipants(
  stack: readonly DfsFrame[],
  closingEdge: { nextKey: string; relId: string },
  participants: Set<string>,
): void {
  // Walk the stack from top down to the frame whose key matches closingEdge.nextKey,
  // marking the relationship that brought us into each frame as a participant.
  participants.add(closingEdge.relId);
  for (let i = stack.length - 1; i >= 0; i--) {
    const frame = stack[i];
    if (frame === undefined) break;
    if (frame.viaRelId !== null) participants.add(frame.viaRelId);
    if (frame.key === closingEdge.nextKey) break;
  }
}

function selectOrphanedEndpoints(
  db: DatabaseSync,
  workspaceId: string,
): { rows: readonly RelationshipHealthEndpointRef[]; truncated: boolean } {
  const cap = MAX_RELATIONSHIPS_PER_QUERY;
  const raw = db
    .prepare(SQL_HEALTH_ENDPOINT_PARTICIPATION)
    .all(workspaceId, workspaceId, cap + 1) as unknown as {
    kind: string;
    id: string;
    active_total: number;
    any_total: number;
  }[];
  const truncated = raw.length > cap;
  const sliced = truncated ? raw.slice(0, cap) : raw;
  const out: RelationshipHealthEndpointRef[] = [];
  for (const r of sliced) {
    if (r.active_total === 0 && r.any_total > 0) {
      out.push({ kind: r.kind as RelationshipObjectKind, id: r.id });
    }
  }
  return { rows: out, truncated };
}

function computeHealthFindings(db: DatabaseSync, workspaceId: string): RelationshipHealthFindings {
  const stale = selectFindingsByLifecycle(db, workspaceId, "stale");
  const blocked = selectFindingsByLifecycle(db, workspaceId, "blocked");
  // `failedRelationships` is the public field name on the health response; the underlying query
  // selects `lifecycle='revoked'` rows (the lifecycle.md "failure" terminal state). The field
  // alias is intentional — the public health surface speaks "failed" / the lifecycle state is
  // `revoked`.
  const failed = selectFindingsByLifecycle(db, workspaceId, "revoked");
  const invalid = selectInvalidReferences(db, workspaceId);
  const cycle = selectCycleParticipants(db, workspaceId);
  const orphan = selectOrphanedEndpoints(db, workspaceId);
  return {
    orphanedEndpoints: orphan.rows,
    orphanedEndpointsTruncated: orphan.truncated,
    staleRelationships: stale.rows,
    staleRelationshipsTruncated: stale.truncated,
    blockedRelationships: blocked.rows,
    blockedRelationshipsTruncated: blocked.truncated,
    failedRelationships: failed.rows,
    failedRelationshipsTruncated: failed.truncated,
    invalidReferences: invalid.rows,
    invalidReferencesTruncated: invalid.truncated,
    cycleParticipants: cycle.rows,
    cycleScanTruncated: cycle.scanTruncated,
  };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────
function relationshipScopeCoordinate(scope: RelationshipScope): string {
  switch (scope.kind) {
    case "user":
      return scope.userId;
    case "workspace":
      return scope.workspaceId;
    case "project":
      return scope.projectId;
    case "workflow":
      return scope.workflowDefinitionId;
    case "global":
      return "global";
  }
}

function insertHistoryRow(
  db: DatabaseSync,
  row: {
    readonly id: string;
    readonly relationshipId: string;
    readonly fromState: RelationshipLifecycleState;
    readonly toState: RelationshipLifecycleState;
    readonly occurredAt: number;
    readonly summary?: string | undefined;
  },
): void {
  db.prepare(SQL_INSERT_HISTORY).run(
    row.id,
    row.relationshipId,
    row.fromState,
    row.toState,
    row.occurredAt,
    row.summary ?? null,
  );
}

// Stable history-row PK builder: `<relationshipId>-h-<8 hex chars>`. The relationship id is the
// owning row; the random suffix avoids same-millisecond collisions that a deterministic clock
// (test fixtures, fast production clock ticks) would otherwise produce.
function nextHistoryRowId(relationshipId: string): string {
  return `${relationshipId}-h-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function validateWalkBounds(o: {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxRelationships: number;
}): void {
  if (o.maxDepth <= 0 || o.maxDepth > MAX_IMPACT_DEPTH) {
    throw invalidRequest("maxDepth out of bounds.");
  }
  if (o.maxNodes <= 0 || o.maxNodes > MAX_IMPACT_NODES) {
    throw invalidRequest("maxNodes out of bounds.");
  }
  if (o.maxRelationships <= 0 || o.maxRelationships > MAX_IMPACT_RELATIONSHIPS) {
    throw invalidRequest("maxRelationships out of bounds.");
  }
}

function runWalkFromOrigin(
  db: DatabaseSync,
  origin: StoredRelationship,
  options: DependencyWalkOptions,
): DependencyWalkResult {
  // Seed from the relationship's endpoints — the walk includes the origin row itself plus
  // its neighbours, expanding by `direction` per hop.
  const seedEndpoints: {
    readonly kind: RelationshipObjectKind;
    readonly id: string;
  }[] = [];
  if (options.direction !== "incoming") {
    seedEndpoints.push({ kind: origin.target.kind, id: origin.target.id });
  }
  if (options.direction !== "outgoing") {
    seedEndpoints.push({ kind: origin.source.kind, id: origin.source.id });
  }
  const walkResult = runWalk(db, options.workspaceId, seedEndpoints, {
    direction: options.direction,
    maxDepth: options.maxDepth,
    maxNodes: options.maxNodes,
    maxRelationships: options.maxRelationships,
  });
  // Always include the origin relationship + endpoints.
  const seenRels = new Set(walkResult.relationships.map((r) => r.id));
  const relationships: StoredRelationship[] = seenRels.has(origin.id)
    ? [...walkResult.relationships]
    : [origin, ...walkResult.relationships];
  const seenNodes = new Set(walkResult.nodes.map(nodeKey));
  const nodes: { kind: RelationshipObjectKind; id: string }[] = [...walkResult.nodes];
  for (const n of [origin.source, origin.target]) {
    if (!seenNodes.has(nodeKey(n))) {
      seenNodes.add(nodeKey(n));
      nodes.push({ kind: n.kind, id: n.id });
    }
  }
  return {
    relationships,
    nodes,
    truncated: walkResult.truncated,
    truncationReason: walkResult.truncationReason,
    depthReached: walkResult.depthReached,
  };
}

interface WalkNode {
  readonly kind: RelationshipObjectKind;
  readonly id: string;
}
type WalkTruncation = "max-depth" | "max-nodes" | "max-relationships";

interface WalkState {
  readonly visitedNodes: Set<string>;
  readonly collectedNodes: WalkNode[];
  readonly seenRelationships: Map<string, StoredRelationship>;
  readonly maxNodes: number;
  readonly maxRelationships: number;
  truncationReason: WalkTruncation | null;
}

function nodeKey(n: { readonly kind: string; readonly id: string }): string {
  return `${n.kind}/${n.id}`;
}

function admitEndpoint(state: WalkState, endpoint: WalkNode, nextFrontier: WalkNode[]): boolean {
  const key = nodeKey(endpoint);
  if (state.visitedNodes.has(key)) return true;
  if (state.collectedNodes.length >= state.maxNodes) {
    state.truncationReason = "max-nodes";
    return false;
  }
  state.visitedNodes.add(key);
  const admitted: WalkNode = { kind: endpoint.kind, id: endpoint.id };
  state.collectedNodes.push(admitted);
  nextFrontier.push(admitted);
  return true;
}

function admitRelationship(state: WalkState, rel: StoredRelationship): boolean {
  if (state.seenRelationships.has(rel.id)) return true;
  if (state.seenRelationships.size >= state.maxRelationships) {
    state.truncationReason = "max-relationships";
    return false;
  }
  state.seenRelationships.set(rel.id, rel);
  return true;
}

function expandFrontier(
  db: DatabaseSync,
  workspaceId: string,
  frontier: readonly WalkNode[],
  direction: "outgoing" | "incoming" | "both",
  state: WalkState,
): WalkNode[] {
  const nextFrontier: WalkNode[] = [];
  for (const node of frontier) {
    const neighbours = expandNeighbours(db, workspaceId, node, direction);
    for (const rel of neighbours) {
      if (!admitRelationship(state, rel)) return nextFrontier;
      if (!admitEndpoint(state, rel.source, nextFrontier)) return nextFrontier;
      if (!admitEndpoint(state, rel.target, nextFrontier)) return nextFrontier;
    }
  }
  return nextFrontier;
}

interface WalkOptions {
  readonly direction: "outgoing" | "incoming" | "both";
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxRelationships: number;
}

function seedWalkState(seed: readonly WalkNode[], options: WalkOptions): WalkState {
  const state: WalkState = {
    visitedNodes: new Set<string>(),
    collectedNodes: [],
    seenRelationships: new Map<string, StoredRelationship>(),
    maxNodes: options.maxNodes,
    maxRelationships: options.maxRelationships,
    truncationReason: null,
  };
  for (const s of seed) {
    if (!state.visitedNodes.has(nodeKey(s))) {
      state.visitedNodes.add(nodeKey(s));
      state.collectedNodes.push({ kind: s.kind, id: s.id });
    }
  }
  return state;
}

function walkResult(
  state: WalkState,
  depthReached: number,
  truncationReason: WalkTruncation | null,
): DependencyWalkResult {
  return {
    relationships: [...state.seenRelationships.values()],
    nodes: state.collectedNodes,
    truncated: truncationReason !== null,
    truncationReason,
    depthReached,
  };
}

function runWalk(
  db: DatabaseSync,
  workspaceId: string,
  seed: readonly WalkNode[],
  options: WalkOptions,
): DependencyWalkResult {
  const state = seedWalkState(seed, options);
  let depthReached = 0;
  let frontier: readonly WalkNode[] = [...state.collectedNodes];
  for (let depth = 0; depth < options.maxDepth; depth++) {
    depthReached = depth + 1;
    const nextFrontier = expandFrontier(db, workspaceId, frontier, options.direction, state);
    if (state.truncationReason !== null) {
      return walkResult(state, depthReached, state.truncationReason);
    }
    if (nextFrontier.length === 0) break;
    frontier = nextFrontier;
  }
  // depth-bounded normal completion is not a truncation per se; we only mark `max-depth`
  // when the frontier was non-empty after the last hop (more work to do).
  const exhaustedDepth = frontier.length > 0 && depthReached === options.maxDepth;
  return walkResult(state, depthReached, exhaustedDepth ? "max-depth" : null);
}

function expandNeighbours(
  db: DatabaseSync,
  workspaceId: string,
  node: { readonly kind: RelationshipObjectKind; readonly id: string },
  direction: "outgoing" | "incoming" | "both",
): readonly StoredRelationship[] {
  const out: StoredRelationship[] = [];
  if (direction !== "incoming") {
    for (const r of findRelationshipsBySource(db, workspaceId, node, MAX_LIST_LIMIT)) {
      out.push(r);
    }
  }
  if (direction !== "outgoing") {
    for (const r of findRelationshipsByTarget(db, workspaceId, node, MAX_LIST_LIMIT)) {
      out.push(r);
    }
  }
  return out;
}
