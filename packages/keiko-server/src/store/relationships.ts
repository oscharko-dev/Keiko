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
import type {
  Relationship,
  RelationshipLifecycleState,
  RelationshipObjectKind,
  RelationshipType,
} from "@oscharko-dev/keiko-contracts";
import { RELATIONSHIP_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts";
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

export interface RelationshipHealthSummary {
  readonly checkedAt: number;
  readonly totals: Readonly<Record<RelationshipLifecycleState, number>>;
  readonly truncated: boolean;
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
  // initial lifecycle the row records draft → <initial> per lifecycle.md §3).
  insertHistoryRow(db, {
    id: `${rel.id}-h-0`,
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
  insertHistoryRow(db, {
    id: `${args.id}-h-${String(args.updatedAt)}`,
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

export function listRelationships(
  db: DatabaseSync,
  q: RelationshipListQuery,
): RelationshipListResult {
  if (q.limit <= 0 || q.limit > MAX_LIST_LIMIT) {
    throw invalidRequest("Limit out of bounds.");
  }
  // Build a parameterised WHERE list dynamically by appending closed-set predicates. Each
  // predicate is a STATIC fragment; the dynamic part is only the count and the bound values.
  // No string interpolation of user-supplied content into SQL.
  const clauses: string[] = ["workspace_scope_id = ?"];
  const params: Array<string | number> = [q.workspaceId];
  if (q.sourceKind !== undefined) {
    clauses.push("source_kind = ?");
    params.push(q.sourceKind);
  }
  if (q.sourceId !== undefined) {
    clauses.push("source_id = ?");
    params.push(q.sourceId);
  }
  if (q.targetKind !== undefined) {
    clauses.push("target_kind = ?");
    params.push(q.targetKind);
  }
  if (q.targetId !== undefined) {
    clauses.push("target_id = ?");
    params.push(q.targetId);
  }
  if (q.type !== undefined) {
    clauses.push("type = ?");
    params.push(q.type);
  }
  if (q.lifecycle !== undefined) {
    clauses.push("lifecycle = ?");
    params.push(q.lifecycle);
  }
  if (q.afterEtag !== undefined) {
    clauses.push("etag < ?");
    params.push(q.afterEtag);
  }
  const sql =
    "SELECT id, schema_version, workspace_scope_id, scope_kind, scope_coordinate, type," +
    " source_kind, source_id, target_kind, target_id, lifecycle, created_at, updated_at," +
    " etag, confidence, summary FROM relationships WHERE " +
    clauses.join(" AND ") +
    " ORDER BY etag DESC, id ASC LIMIT ?";
  params.push(q.limit + 1);
  const rows = db.prepare(sql).all(...params) as unknown as RelationshipRow[];
  const truncated = rows.length > q.limit;
  const slice = truncated ? rows.slice(0, q.limit) : rows;
  const entries = slice.map(rowToRelationship);
  const last = slice[slice.length - 1];
  const nextCursor = truncated && last !== undefined ? last.etag.toString() : undefined;
  // Always return undefined when not truncated; `nextCursor` is `string | undefined` so
  // exactOptionalPropertyTypes-safe.
  const result: RelationshipListResult =
    nextCursor === undefined
      ? { entries, truncated, nextCursor: undefined }
      : { entries, truncated, nextCursor };
  return result;
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
  const rows = db.prepare(SQL_LIST_HISTORY).all(relationshipId, limit) as Array<{
    relationship_id: string;
    from_state: string;
    to_state: string;
    occurred_at: number;
    summary: string | null;
  }>;
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
  readonly nodes: ReadonlyArray<{
    readonly kind: RelationshipObjectKind;
    readonly id: string;
  }>;
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
  const rows = db.prepare(SQL_HEALTH_COUNTS).all(workspaceId) as Array<{
    lifecycle: string;
    n: number;
  }>;
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
  return { checkedAt: Date.now(), totals, truncated: false };
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
  const seedEndpoints: Array<{
    readonly kind: RelationshipObjectKind;
    readonly id: string;
  }> = [];
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
  const nodeKey = (n: { kind: string; id: string }): string => `${n.kind}/${n.id}`;
  const seenRels = new Set(walkResult.relationships.map((r) => r.id));
  const relationships: StoredRelationship[] = seenRels.has(origin.id)
    ? [...walkResult.relationships]
    : [origin, ...walkResult.relationships];
  const seenNodes = new Set(walkResult.nodes.map(nodeKey));
  const nodes: Array<{ kind: RelationshipObjectKind; id: string }> = [...walkResult.nodes];
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

function runWalk(
  db: DatabaseSync,
  workspaceId: string,
  seed: ReadonlyArray<{ readonly kind: RelationshipObjectKind; readonly id: string }>,
  options: {
    readonly direction: "outgoing" | "incoming" | "both";
    readonly maxDepth: number;
    readonly maxNodes: number;
    readonly maxRelationships: number;
  },
): DependencyWalkResult {
  const nodeKey = (n: { kind: string; id: string }): string => `${n.kind}/${n.id}`;
  const visitedNodes = new Set<string>();
  const collectedNodes: Array<{ kind: RelationshipObjectKind; id: string }> = [];
  for (const s of seed) {
    if (!visitedNodes.has(nodeKey(s))) {
      visitedNodes.add(nodeKey(s));
      collectedNodes.push({ kind: s.kind, id: s.id });
    }
  }
  const seenRelationships = new Map<string, StoredRelationship>();
  let truncated = false;
  let truncationReason: "max-depth" | "max-nodes" | "max-relationships" | null = null;
  let depthReached = 0;
  let frontier: Array<{ kind: RelationshipObjectKind; id: string }> = [...collectedNodes];

  for (let depth = 0; depth < options.maxDepth; depth++) {
    const nextFrontier: Array<{ kind: RelationshipObjectKind; id: string }> = [];
    depthReached = depth + 1;
    for (const node of frontier) {
      const neighbours = expandNeighbours(db, workspaceId, node, options.direction);
      for (const rel of neighbours) {
        if (!seenRelationships.has(rel.id)) {
          if (seenRelationships.size >= options.maxRelationships) {
            truncated = true;
            truncationReason = "max-relationships";
            return {
              relationships: [...seenRelationships.values()],
              nodes: collectedNodes,
              truncated,
              truncationReason,
              depthReached,
            };
          }
          seenRelationships.set(rel.id, rel);
        }
        for (const endpoint of [rel.source, rel.target]) {
          const key = nodeKey(endpoint);
          if (!visitedNodes.has(key)) {
            if (collectedNodes.length >= options.maxNodes) {
              truncated = true;
              truncationReason = "max-nodes";
              return {
                relationships: [...seenRelationships.values()],
                nodes: collectedNodes,
                truncated,
                truncationReason,
                depthReached,
              };
            }
            visitedNodes.add(key);
            collectedNodes.push({ kind: endpoint.kind, id: endpoint.id });
            nextFrontier.push({ kind: endpoint.kind, id: endpoint.id });
          }
        }
      }
    }
    if (nextFrontier.length === 0) break;
    frontier = nextFrontier;
  }
  // depth-bounded normal completion is not a truncation per se; we only mark `max-depth`
  // when the frontier was non-empty after the last hop (more work to do).
  if (frontier.length > 0 && truncationReason === null && depthReached === options.maxDepth) {
    truncated = true;
    truncationReason = "max-depth";
  }
  return {
    relationships: [...seenRelationships.values()],
    nodes: collectedNodes,
    truncated,
    truncationReason,
    depthReached,
  };
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
