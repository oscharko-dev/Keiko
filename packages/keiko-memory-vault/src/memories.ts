// Prepared SQL for the memories table. Every parameter binds positionally; no template
// concatenation with caller data so SQL injection is structurally impossible at this layer.
// The validator gate sits in vault.ts, BEFORE these functions are called, so this module assumes
// inputs are already shape-valid and only owes the SQL.

import type { DatabaseSync } from "node:sqlite";
import { toUSVString } from "node:util";
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
import { STANDING_FACT_RETENTION_POLICY_KEY } from "@oscharko-dev/keiko-contracts/memory";
import { memoryRecordToRow, rowToMemoryRecord, type MemoryRow } from "./serialize.js";
import { scopeCoordinateOf, scopeKindOf } from "./scope-key.js";
import type { ListMemoriesOptions, MemoryMetadata, MemoryVaultStore } from "./types.js";
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
  retention_notes, evidence_span, source_message_ids_json, created_at, updated_at, body_hash
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`;

const SELECT_BY_ID_SQL = "SELECT * FROM memories WHERE id = ?";
const DELETE_SQL = "DELETE FROM memories WHERE id = ?";
const LIST_SCOPES_SQL = `
SELECT DISTINCT scope_kind, scope_coordinate
FROM (
  SELECT scope_kind, scope_coordinate FROM memories
  UNION
  SELECT scope_kind, scope_coordinate FROM memory_tombstones
)
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
  evidence_span = ?,
  source_message_ids_json = ?,
  updated_at = ?,
  body_hash = ?
WHERE id = ?
`;

// How a row is written: its content sealed, its body also kept as the vault's keyed fingerprint so an
// exact repeat is found by index however old the stored fact is (v17).
export interface MemoryRowSealing {
  readonly cipher: MemoryContentCipher;
  readonly bodyHash: (body: string) => string;
}

function bindValues(
  record: MemoryRecord,
  sealing: MemoryRowSealing,
): readonly (string | number | null)[] {
  const cipher = sealing.cipher;
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
    r.evidence_span,
    r.source_message_ids_json,
    r.created_at,
    r.updated_at,
    sealing.bodyHash(record.body),
  ];
}

export function insertMemoryRow(
  db: DatabaseSync,
  record: MemoryRecord,
  sealing: MemoryRowSealing,
): void {
  cachedPrepare(db, INSERT_SQL).run(...bindValues(record, sealing));
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

export function getMemoryRowsByIds(
  db: DatabaseSync,
  ids: readonly MemoryId[],
  cipher: MemoryContentCipher,
): readonly MemoryRecord[] {
  if (ids.length === 0) return [];
  const rows = cachedPrepare(
    db,
    "SELECT * FROM memories WHERE id IN (SELECT value FROM json_each(?))",
  ).all(JSON.stringify(ids)) as unknown as readonly MemoryRow[];
  return rows.map((row) => decodeMemoryRow(row, cipher));
}

export function updateMemoryRow(
  db: DatabaseSync,
  record: MemoryRecord,
  sealing: MemoryRowSealing,
): void {
  const r = memoryRecordToRow(record, sealing.cipher);
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
    r.evidence_span,
    r.source_message_ids_json,
    r.updated_at,
    sealing.bodyHash(record.body),
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

function enumPredicate(column: string, values: readonly string[]): string {
  return `${column} IN (${values.map(() => "?").join(",")})`;
}

function buildEnumClause(
  column: string,
  values: readonly string[] | undefined,
): ListClauseBuild | undefined {
  if (values === undefined || values.length === 0) return undefined;
  return { clauses: [enumPredicate(column, values)], params: values };
}

function buildStatusClause(options: ListMemoriesOptions): ListClauseBuild | undefined {
  const { status, includeStaleStatuses } = options;
  if (!includeStaleStatuses?.length) return buildEnumClause("status", status);
  const stale = `(stale_reason IS NOT NULL AND ${enumPredicate("status", includeStaleStatuses)})`;
  if (!status?.length) return { clauses: [stale], params: includeStaleStatuses };
  return {
    clauses: [`(${enumPredicate("status", status)} OR ${stale})`],
    params: [...status, ...includeStaleStatuses],
  };
}

function buildExpiryClause(
  includeExpired: boolean | undefined,
  nowMs: number,
): ListClauseBuild | undefined {
  if (includeExpired === true) return undefined;
  return { clauses: ["(valid_until IS NULL OR valid_until > ?)"], params: [nowMs] };
}

function buildRetentionPolicyClause(policyKey: string | undefined): ListClauseBuild | undefined {
  if (policyKey === undefined) return undefined;
  return { clauses: ["retention_policy_key = ?"], params: [policyKey] };
}

function buildSourceMessageClause(
  sourceMessageId: string | undefined,
): ListClauseBuild | undefined {
  if (sourceMessageId === undefined) return undefined;
  return {
    clauses: [
      `((membership.unreadable = 0 AND membership.source_message_id = ?) OR (membership.unreadable = 1 AND
        EXISTS (SELECT 1 FROM json_each(source_message_ids_json) source_message
          WHERE source_message.type = 'text' AND source_message.value = ?)))`,
    ],
    params: [sourceMessageId, sourceMessageId],
  };
}

// The filters every list query shares, then its paging parameters.
function appendListFilters(
  where: string[],
  params: (string | number)[],
  options: ListMemoriesOptions,
  nowMs: number,
): void {
  for (const built of [
    buildEnumClause("type", options.type),
    buildStatusClause(options),
    buildEnumClause("sensitivity", options.sensitivity),
    buildPinnedClause(options.pinned),
    buildRetentionPolicyClause(options.retentionPolicyKey),
    buildSourceMessageClause(options.sourceMessageId),
    buildExpiryClause(options.includeExpired, nowMs),
  ]) {
    if (built === undefined) continue;
    where.push(...built.clauses);
    params.push(...built.params);
  }
  appendPagingParams(params, options);
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
  // Seek the source first, then the memory PK, even when a scope index could satisfy ORDER BY.
  const from =
    options.sourceMessageId === undefined
      ? "memories"
      : "memory_message_sources membership CROSS JOIN memories ON memories.id = membership.memory_id";
  const projection =
    options.sourceMessageId !== undefined && select === "*" ? "memories.*" : select;
  let sql = `SELECT ${projection} FROM ${from}`;
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
  const [first] = uniqueScopes;
  if (first === undefined) return undefined;
  if (uniqueScopes.length === 1) {
    return {
      clauses: ["scope_kind = ?", "scope_coordinate = ?"],
      params: [scopeKindOf(first), scopeCoordinateOf(first)],
    };
  }
  // A JSON parameter keeps the SQL expression and placeholder count independent of vault size.
  // Tuple membership preserves exact scope pairs and lets SQLite use the composite scope index.
  // Match SQLite text bindings when a coordinate contains a lone UTF-16 surrogate.
  return {
    clauses: [
      `(scope_kind, scope_coordinate) IN (
        SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)
      )`,
    ],
    params: [
      JSON.stringify(
        uniqueScopes.map((scope) => [scopeKindOf(scope), toUSVString(scopeCoordinateOf(scope))]),
      ),
    ],
  };
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
  appendListFilters(where, params, options, nowMs);
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
  appendListFilters(where, params, options, nowMs);
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
  appendListFilters(where, params, options, nowMs);
  const rows = cachedPrepare(db, buildListSql(where, options, METADATA_COLUMNS)).all(
    ...params,
  ) as unknown as readonly MemoryMetadataRow[];
  return rows.map(metadataRowToMemoryMetadata);
}

// The stored memories of one scope whose body is the given one, found by the keyed fingerprint index
// rather than by reading a window of bodies, so an exact repeat is recognised however many newer
// facts the scope holds. The list filters apply as for any scope read.
export function listMemoryMetadataByBodyHashRows(
  db: DatabaseSync,
  scope: MemoryScope,
  bodyHash: string,
  options: ListMemoriesOptions,
  nowMs: number,
): readonly MemoryMetadata[] {
  const params: (string | number)[] = [scopeKindOf(scope), scopeCoordinateOf(scope), bodyHash];
  const where: string[] = ["scope_kind = ?", "scope_coordinate = ?", "body_hash = ?"];
  appendListFilters(where, params, options, nowMs);
  const rows = cachedPrepare(db, buildListSql(where, options, METADATA_COLUMNS)).all(
    ...params,
  ) as unknown as readonly MemoryMetadataRow[];
  return rows.map(metadataRowToMemoryMetadata);
}

export interface BodyHashBackfill {
  readonly filled: number;
  readonly unreadable: number;
}

const BODY_HASH_PENDING_SQL = "SELECT id, body FROM memories WHERE body_hash IS NULL";
const BODY_HASH_FILL_SQL = "UPDATE memories SET body_hash = ? WHERE id = ? AND body_hash IS NULL";

// A vault written before v17 holds no fingerprints. They are filled once, in one transaction, when the
// vault opens with its key. A body that cannot be opened keeps no fingerprint: that row is only absent
// from the exact lookup, and it is counted, never guessed.
export function backfillMemoryBodyHashes(
  db: DatabaseSync,
  sealing: MemoryRowSealing,
): BodyHashBackfill {
  const pending = cachedPrepare(db, BODY_HASH_PENDING_SQL).all() as unknown as readonly {
    readonly id: string;
    readonly body: string;
  }[];
  if (pending.length === 0) return { filled: 0, unreadable: 0 };
  let filled = 0;
  let unreadable = 0;
  const recordUnreadableBody = (): void => {
    unreadable += 1;
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    const fill = cachedPrepare(db, BODY_HASH_FILL_SQL);
    for (const row of pending) {
      const body = openedBody(row.body, sealing.cipher, recordUnreadableBody);
      if (body !== undefined) filled += Number(fill.run(sealing.bodyHash(body), row.id).changes);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { filled, unreadable };
}

// An unreadable body is counted; the vault reports the count on its open line as a diagnostic.
function openedBody(
  sealed: string,
  cipher: MemoryContentCipher,
  recordUnreadableBody: () => void,
): string | undefined {
  try {
    return cipher.openString(sealed);
  } catch {
    recordUnreadableBody();
    return undefined;
  }
}

// Only profile IDs and counters leave this query. The body and its sealed exclusion tags are
// inspected later under the same read bound as the selector. SQLite's UTF-8 BINARY collation
// disagrees with the selector's JavaScript ordering for supplementary vs. high BMP characters.
export function prepareStandingProfileReader(
  db: DatabaseSync,
): MemoryVaultStore["listStandingProfileCandidates"] {
  db.function("keiko_profile_id_key", { deterministic: true, directOnly: true }, (id) => {
    if (typeof id !== "string") throw new TypeError("Expected a stored profile ID.");
    return Buffer.from(id, "utf16le").swap16();
  });
  const sql = `
    SELECT m.id, coalesce(a.access_count, 0) AS confirmations
    FROM memories m LEFT JOIN memory_access a ON a.memory_id = m.id
    WHERE m.scope_kind = 'user' AND m.scope_coordinate = ?
      AND m.status = 'accepted' AND m.sensitivity = 'public'
      AND m.valid_from <= ? AND (m.valid_until IS NULL OR m.valid_until > ?)
      AND m.confidence > ?
      AND (m.pinned = 1 OR m.retention_policy_key = ? OR m.type IN (SELECT value FROM json_each(?)))
    ORDER BY m.pinned DESC, confirmations DESC, m.created_at DESC, keiko_profile_id_key(m.id) ASC
    LIMIT ?`;
  return (userId, { types, minConfidenceExclusive, nowMs, limit }) => {
    // A negative SQLite LIMIT means "unbounded".
    if (!Number.isSafeInteger(limit) || limit <= 0) return [];
    return cachedPrepare(db, sql).all(
      userId,
      nowMs,
      nowMs,
      minConfidenceExclusive,
      STANDING_FACT_RETENTION_POLICY_KEY,
      JSON.stringify(types),
      limit,
    ) as unknown as ReturnType<MemoryVaultStore["listStandingProfileCandidates"]>;
  };
}

export function listMemoryMetadataAcrossScopeRows(
  db: DatabaseSync,
  scopes: readonly MemoryScope[],
  options: ListMemoriesOptions,
  nowMs: number,
): readonly MemoryMetadata[] {
  const scopeClause = buildScopesClause(scopes);
  if (scopeClause === undefined) return [];
  const params: (string | number)[] = [...scopeClause.params];
  const where: string[] = [...scopeClause.clauses];
  appendListFilters(where, params, options, nowMs);
  const rows = cachedPrepare(db, buildListSql(where, options, METADATA_COLUMNS)).all(
    ...params,
  ) as unknown as readonly MemoryMetadataRow[];
  return rows.map(metadataRowToMemoryMetadata);
}
