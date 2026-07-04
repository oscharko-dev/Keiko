// Prepared SQL for the memories table. Every parameter binds positionally; no template
// concatenation with caller data so SQL injection is structurally impossible at this layer.
// The validator gate sits in vault.ts, BEFORE these functions are called, so this module assumes
// inputs are already shape-valid and only owes the SQL.

import type { DatabaseSync } from "node:sqlite";
import type {
  MemoryId,
  MemoryRecord,
  MemoryScope,
  MemoryScopeKind,
  ProjectId,
  UserId,
  WorkflowDefinitionId,
  WorkspaceId,
} from "@oscharko-dev/keiko-contracts/memory";
import { memoryRecordToRow, rowToMemoryRecord, type MemoryRow } from "./serialize.js";
import { scopeCoordinateOf, scopeKindOf } from "./scope-key.js";
import type { ListMemoriesOptions, MemoryMetadata } from "./types.js";
import type { MemoryContentCipher } from "./cipher.js";
import { MemoryStorageError } from "./errors.js";
import { cachedPrepare } from "./statements.js";

const INSERT_SQL = `
INSERT INTO memories (
  id, schema_version, type, scope_kind, scope_coordinate, body, payload_json,
  status, sensitivity, pinned, confidence, valid_from, valid_until, stale_reason,
  tags_json, source_kind, source_conversation_id, source_workflow_run_id,
  source_evidence_manifest_id, captured_at, capture_rationale, model_provider,
  model_id, model_revision, retention_policy_key, retention_retain_until,
  retention_notes, created_at, updated_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`;

const SELECT_BY_ID_SQL = "SELECT * FROM memories WHERE id = ?";
const DELETE_SQL = "DELETE FROM memories WHERE id = ?";
const LIST_SCOPES_SQL = `
SELECT DISTINCT scope_kind, scope_coordinate
FROM memories
ORDER BY scope_kind ASC, scope_coordinate ASC
`;
const METADATA_COLUMNS = [
  "id",
  "schema_version",
  "type",
  "scope_kind",
  "scope_coordinate",
  "status",
  "sensitivity",
  "pinned",
  "confidence",
  "valid_from",
  "valid_until",
  "created_at",
  "updated_at",
].join(", ");

// UPDATE rewrites every column from the resolved record so a partial patch can land without
// touching SQL per-field. The vault composes the merge in TypeScript (validator-safe) and hands
// us a final record; we just write it.
const UPDATE_SQL = `
UPDATE memories SET
  type = ?,
  body = ?,
  payload_json = ?,
  status = ?,
  sensitivity = ?,
  pinned = ?,
  confidence = ?,
  valid_from = ?,
  valid_until = ?,
  stale_reason = ?,
  tags_json = ?,
  source_kind = ?,
  source_conversation_id = ?,
  source_workflow_run_id = ?,
  source_evidence_manifest_id = ?,
  captured_at = ?,
  capture_rationale = ?,
  model_provider = ?,
  model_id = ?,
  model_revision = ?,
  retention_policy_key = ?,
  retention_retain_until = ?,
  retention_notes = ?,
  updated_at = ?
WHERE id = ?
`;

function bindValues(
  record: MemoryRecord,
  cipher: MemoryContentCipher,
): readonly (string | number | null)[] {
  const r = memoryRecordToRow(record, cipher);
  return [
    r.id,
    r.schema_version,
    r.type,
    r.scope_kind,
    r.scope_coordinate,
    r.body,
    r.payload_json,
    r.status,
    r.sensitivity,
    r.pinned,
    r.confidence,
    r.valid_from,
    r.valid_until,
    r.stale_reason,
    r.tags_json,
    r.source_kind,
    r.source_conversation_id,
    r.source_workflow_run_id,
    r.source_evidence_manifest_id,
    r.captured_at,
    r.capture_rationale,
    r.model_provider,
    r.model_id,
    r.model_revision,
    r.retention_policy_key,
    r.retention_retain_until,
    r.retention_notes,
    r.created_at,
    r.updated_at,
  ];
}

export function insertMemoryRow(
  db: DatabaseSync,
  record: MemoryRecord,
  cipher: MemoryContentCipher,
): void {
  cachedPrepare(db, INSERT_SQL).run(...bindValues(record, cipher));
}

function decodeMemoryRow(row: MemoryRow, cipher: MemoryContentCipher): MemoryRecord {
  try {
    return rowToMemoryRecord(row, cipher);
  } catch {
    throw new MemoryStorageError(
      "internal",
      `Memory row ${row.id} is unreadable; run memory diagnostics or repair before continuing.`,
    );
  }
}

export function getMemoryRow(
  db: DatabaseSync,
  id: MemoryId,
  cipher: MemoryContentCipher,
): MemoryRecord | undefined {
  const row = cachedPrepare(db, SELECT_BY_ID_SQL).get(id) as unknown as MemoryRow | undefined;
  return row === undefined ? undefined : decodeMemoryRow(row, cipher);
}

export function updateMemoryRow(
  db: DatabaseSync,
  record: MemoryRecord,
  cipher: MemoryContentCipher,
): void {
  const r = memoryRecordToRow(record, cipher);
  const info = cachedPrepare(db, UPDATE_SQL).run(
    r.type,
    r.body,
    r.payload_json,
    r.status,
    r.sensitivity,
    r.pinned,
    r.confidence,
    r.valid_from,
    r.valid_until,
    r.stale_reason,
    r.tags_json,
    r.source_kind,
    r.source_conversation_id,
    r.source_workflow_run_id,
    r.source_evidence_manifest_id,
    r.captured_at,
    r.capture_rationale,
    r.model_provider,
    r.model_id,
    r.model_revision,
    r.retention_policy_key,
    r.retention_retain_until,
    r.retention_notes,
    r.updated_at,
    r.id,
  );
  if (info.changes === 0) {
    throw new MemoryStorageError("not-found", "Memory not found.");
  }
}

export function deleteMemoryRow(db: DatabaseSync, id: MemoryId): boolean {
  const info = cachedPrepare(db, DELETE_SQL).run(id);
  return info.changes > 0;
}

interface ListClauseBuild {
  readonly clauses: readonly string[];
  readonly params: readonly (string | number)[];
}

function buildEnumClause(
  column: string,
  values: readonly string[] | undefined,
): ListClauseBuild | undefined {
  if (values === undefined || values.length === 0) return undefined;
  const placeholders = values.map(() => "?").join(",");
  return { clauses: [`${column} IN (${placeholders})`], params: values };
}

function buildExpiryClause(
  includeExpired: boolean | undefined,
  nowMs: number,
): ListClauseBuild | undefined {
  if (includeExpired === true) return undefined;
  return { clauses: ["(valid_until IS NULL OR valid_until > ?)"], params: [nowMs] };
}

function buildPinnedClause(pinned: boolean | undefined): ListClauseBuild | undefined {
  if (pinned === undefined) return undefined;
  return { clauses: ["pinned = ?"], params: [pinned ? 1 : 0] };
}

const ORDER_COLUMN_MAP: Readonly<Record<NonNullable<ListMemoriesOptions["orderBy"]>, string>> = {
  createdAt: "created_at",
  updatedAt: "updated_at",
  validFrom: "valid_from",
};

function resolveOrderBy(options: ListMemoriesOptions): { column: string; dir: "ASC" | "DESC" } {
  const column = ORDER_COLUMN_MAP[options.orderBy ?? "createdAt"];
  const dir = options.orderDir === "asc" ? "ASC" : "DESC";
  return { column, dir };
}

function buildListSql(
  where: readonly string[],
  options: ListMemoriesOptions,
  select = "*",
): string {
  const { column, dir } = resolveOrderBy(options);
  let sql = `SELECT ${select} FROM memories`;
  if (where.length > 0) {
    sql += ` WHERE ${where.join(" AND ")}`;
  }
  sql += ` ORDER BY ${column} ${dir}`;
  if (typeof options.limit === "number") {
    sql += " LIMIT ?";
    if (typeof options.offset === "number") {
      sql += " OFFSET ?";
    }
  }
  return sql;
}

interface MemoryMetadataRow {
  readonly id: string;
  readonly schema_version: string;
  readonly type: string;
  readonly scope_kind: string;
  readonly scope_coordinate: string;
  readonly status: string;
  readonly sensitivity: string;
  readonly pinned: number;
  readonly confidence: number;
  readonly valid_from: number;
  readonly valid_until: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

interface ScopeRow {
  readonly scope_kind: string;
  readonly scope_coordinate: string;
}

function scopeFromRow(kind: string, coordinate: string): MemoryScope {
  switch (kind as MemoryScopeKind) {
    case "user":
      return { kind: "user", userId: coordinate as UserId };
    case "workspace":
      return { kind: "workspace", workspaceId: coordinate as WorkspaceId };
    case "project":
      return { kind: "project", projectId: coordinate as ProjectId };
    case "workflow":
      return { kind: "workflow", workflowDefinitionId: coordinate as WorkflowDefinitionId };
    case "global":
      return { kind: "global" };
    default:
      throw new MemoryStorageError(
        "schema-mismatch",
        "Stored memory scope kind is not recognized.",
      );
  }
}

function metadataRowToMemoryMetadata(row: MemoryMetadataRow): MemoryMetadata {
  return {
    id: row.id as MemoryId,
    schemaVersion: "1",
    scope: scopeFromRow(row.scope_kind, row.scope_coordinate),
    type: row.type as MemoryMetadata["type"],
    status: row.status as MemoryMetadata["status"],
    sensitivity: row.sensitivity as MemoryMetadata["sensitivity"],
    pinned: row.pinned === 1,
    confidence: row.confidence,
    validity:
      row.valid_until === null
        ? { validFrom: row.valid_from }
        : { validFrom: row.valid_from, validUntil: row.valid_until },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function dedupeScopes(scopes: readonly MemoryScope[]): readonly MemoryScope[] {
  const seen = new Set<string>();
  const out: MemoryScope[] = [];
  for (const scope of scopes) {
    const kind = scopeKindOf(scope);
    const coordinate = scopeCoordinateOf(scope);
    const key = `${kind}\u0000${coordinate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(scope);
  }
  return out;
}

function buildScopesClause(scopes: readonly MemoryScope[]): ListClauseBuild | undefined {
  const uniqueScopes = dedupeScopes(scopes);
  if (uniqueScopes.length === 0) return undefined;
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  for (const scope of uniqueScopes) {
    clauses.push("(scope_kind = ? AND scope_coordinate = ?)");
    params.push(scopeKindOf(scope), scopeCoordinateOf(scope));
  }
  return { clauses: [`(${clauses.join(" OR ")})`], params };
}

function appendPagingParams(params: (string | number)[], options: ListMemoriesOptions): void {
  if (typeof options.limit !== "number") return;
  params.push(options.limit);
  if (typeof options.offset === "number") {
    params.push(options.offset);
  }
}

export function listMemoryScopeRows(db: DatabaseSync): readonly MemoryScope[] {
  const rows = cachedPrepare(db, LIST_SCOPES_SQL).all() as unknown as readonly ScopeRow[];
  return rows.map((row) => scopeFromRow(row.scope_kind, row.scope_coordinate));
}

export function listMemoriesAcrossScopeRows(
  db: DatabaseSync,
  scopes: readonly MemoryScope[],
  options: ListMemoriesOptions,
  nowMs: number,
  cipher: MemoryContentCipher,
): readonly MemoryRecord[] {
  const scopeClause = buildScopesClause(scopes);
  if (scopeClause === undefined) return [];
  const params: (string | number)[] = [...scopeClause.params];
  const where: string[] = [...scopeClause.clauses];
  for (const built of [
    buildEnumClause("type", options.type),
    buildEnumClause("status", options.status),
    buildPinnedClause(options.pinned),
    buildExpiryClause(options.includeExpired, nowMs),
  ]) {
    if (built === undefined) continue;
    where.push(...built.clauses);
    params.push(...built.params);
  }
  appendPagingParams(params, options);
  const rows = cachedPrepare(db, buildListSql(where, options)).all(
    ...params,
  ) as unknown as readonly MemoryRow[];
  return rows.map((row) => decodeMemoryRow(row, cipher));
}

export function listMemoriesByScopeRows(
  db: DatabaseSync,
  scope: MemoryScope,
  options: ListMemoriesOptions,
  nowMs: number,
  cipher: MemoryContentCipher,
): readonly MemoryRecord[] {
  const kind: MemoryScopeKind = scopeKindOf(scope);
  const coordinate = scopeCoordinateOf(scope);
  const params: (string | number)[] = [kind, coordinate];
  const where: string[] = ["scope_kind = ?", "scope_coordinate = ?"];
  for (const built of [
    buildEnumClause("type", options.type),
    buildEnumClause("status", options.status),
    buildPinnedClause(options.pinned),
    buildExpiryClause(options.includeExpired, nowMs),
  ]) {
    if (built === undefined) continue;
    where.push(...built.clauses);
    params.push(...built.params);
  }
  appendPagingParams(params, options);
  const rows = cachedPrepare(db, buildListSql(where, options)).all(
    ...params,
  ) as unknown as readonly MemoryRow[];
  return rows.map((row) => decodeMemoryRow(row, cipher));
}

export function listMemoryMetadataByScopeRows(
  db: DatabaseSync,
  scope: MemoryScope,
  options: ListMemoriesOptions,
  nowMs: number,
): readonly MemoryMetadata[] {
  const kind: MemoryScopeKind = scopeKindOf(scope);
  const coordinate = scopeCoordinateOf(scope);
  const params: (string | number)[] = [kind, coordinate];
  const where: string[] = ["scope_kind = ?", "scope_coordinate = ?"];
  for (const built of [
    buildEnumClause("type", options.type),
    buildEnumClause("status", options.status),
    buildPinnedClause(options.pinned),
    buildExpiryClause(options.includeExpired, nowMs),
  ]) {
    if (built === undefined) continue;
    where.push(...built.clauses);
    params.push(...built.params);
  }
  appendPagingParams(params, options);
  const rows = cachedPrepare(db, buildListSql(where, options, METADATA_COLUMNS)).all(
    ...params,
  ) as unknown as readonly MemoryMetadataRow[];
  return rows.map(metadataRowToMemoryMetadata);
}
