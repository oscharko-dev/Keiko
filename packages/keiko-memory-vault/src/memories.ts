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
} from "@oscharko-dev/keiko-contracts/memory";
import { memoryRecordToRow, rowToMemoryRecord, type MemoryRow } from "./serialize.js";
import { scopeCoordinateOf, scopeKindOf } from "./scope-key.js";
import type { ListMemoriesOptions } from "./types.js";
import { MemoryStorageError } from "./errors.js";

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

function bindValues(record: MemoryRecord): readonly (string | number | null)[] {
  const r = memoryRecordToRow(record);
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

export function insertMemoryRow(db: DatabaseSync, record: MemoryRecord): void {
  db.prepare(INSERT_SQL).run(...bindValues(record));
}

export function getMemoryRow(db: DatabaseSync, id: MemoryId): MemoryRecord | undefined {
  const row = db.prepare(SELECT_BY_ID_SQL).get(id) as unknown as MemoryRow | undefined;
  return row === undefined ? undefined : rowToMemoryRecord(row);
}

export function updateMemoryRow(db: DatabaseSync, record: MemoryRecord): void {
  const r = memoryRecordToRow(record);
  const info = db
    .prepare(UPDATE_SQL)
    .run(
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
  const info = db.prepare(DELETE_SQL).run(id);
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

export function listMemoriesByScopeRows(
  db: DatabaseSync,
  scope: MemoryScope,
  options: ListMemoriesOptions,
  nowMs: number,
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
  const { column, dir } = resolveOrderBy(options);
  // `column` and `dir` are validated against ORDER_COLUMN_MAP / a fixed asc|desc enum so they are
  // not caller-controlled strings reaching the SQL surface.
  let sql = `SELECT * FROM memories WHERE ${where.join(" AND ")} ORDER BY ${column} ${dir}`;
  if (typeof options.limit === "number") {
    sql += " LIMIT ?";
    params.push(options.limit);
    if (typeof options.offset === "number") {
      sql += " OFFSET ?";
      params.push(options.offset);
    }
  }
  const rows = db.prepare(sql).all(...params) as unknown as readonly MemoryRow[];
  return rows.map(rowToMemoryRecord);
}
