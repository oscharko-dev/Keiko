// source-lifecycle.ts — typed CRUD over `capsule_sources`. Every read is capsule-scoped:
// there is intentionally no `listAllSources(store)`. Deletion verifies the (capsuleId,
// sourceId) tuple matches a row BEFORE issuing DELETE so a wrong-tuple call cannot succeed
// by chance (a plain DELETE with COUNT-on-changes still races with concurrent CASCADE
// deletes of the parent capsule, but the verify+delete sequence is correct under WAL's
// single-writer semantics).

import {
  isSafeDisplaySummary,
  validateKnowledgeSourceScope,
  type KnowledgeCapsuleId,
  type KnowledgeSource,
  type KnowledgeSourceId,
  type KnowledgeSourceScope,
} from "@oscharko-dev/keiko-contracts";

import { KnowledgeNotFoundError, KnowledgeStoreError } from "./errors.js";
import type { AuditEventSink } from "./privacy/types.js";
import type { KnowledgeStore } from "./store.js";

export interface AddCapsuleSourceInput {
  readonly id: KnowledgeSourceId;
  readonly displayName: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly scope: KnowledgeSourceScope;
}

interface CapsuleSourceRow {
  readonly id: string;
  readonly capsule_id: string;
  readonly display_name: string;
  readonly description: string | null;
  readonly tags_json: string;
  readonly scope_kind: string;
  readonly scope_json: string;
  readonly created_at: number;
  readonly updated_at: number;
}

interface SourceParams extends Readonly<Record<string, string | number | null>> {
  readonly id: KnowledgeSourceId;
  readonly display_name: string;
  readonly description: string | null;
  readonly tags_json: string;
  readonly scope_kind: string;
  readonly scope_json: string;
  readonly created_at: number;
  readonly updated_at: number;
}

const INSERT_SQL =
  "INSERT INTO capsule_sources (id, capsule_id, display_name, description, tags_json, scope_kind, scope_json, created_at, updated_at) VALUES (:id, :capsule_id, :display_name, :description, :tags_json, :scope_kind, :scope_json, :created_at, :updated_at)";

const INSERT_KNOWLEDGE_SOURCE_SQL =
  "INSERT INTO knowledge_sources (id, display_name, description, tags_json, scope_kind, scope_json, created_at, updated_at) VALUES (:id, :display_name, :description, :tags_json, :scope_kind, :scope_json, :created_at, :updated_at) ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, description = excluded.description, tags_json = excluded.tags_json, scope_kind = excluded.scope_kind, scope_json = excluded.scope_json, updated_at = excluded.updated_at";

const SELECT_BY_CAPSULE_SQL =
  "SELECT ks.* FROM capsule_sources AS cs JOIN knowledge_sources AS ks ON ks.id = cs.id WHERE cs.capsule_id = :c ORDER BY cs.created_at ASC, cs.id ASC";

const SELECT_BY_TUPLE_SQL = "SELECT id FROM capsule_sources WHERE capsule_id = :c AND id = :s";

const DELETE_BY_TUPLE_SQL = "DELETE FROM capsule_sources WHERE capsule_id = :c AND id = :s";

function parseTags(json: string): readonly string[] {
  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === "string");
}

function assertSafeDisplayField(field: string, value: string): void {
  if (value.trim().length === 0 || !isSafeDisplaySummary(value)) {
    throw new KnowledgeStoreError(`${field} must be a browser-safe non-empty string`);
  }
}

function assertSafeOptionalDisplayField(field: string, value: string | undefined): void {
  if (value !== undefined && !isSafeDisplaySummary(value)) {
    throw new KnowledgeStoreError(`${field} must be browser-safe when set`);
  }
}

function assertSafeScope(scope: KnowledgeSourceScope): void {
  const result = validateKnowledgeSourceScope(scope);
  if (result.ok) return;
  throw new KnowledgeStoreError(result.errors.join(" "));
}

function parseScope(kind: string, json: string): KnowledgeSourceScope {
  const parsed = JSON.parse(json) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new KnowledgeStoreError(`Corrupt capsule_sources.scope_json (kind=${kind}).`);
  }
  // The contract validators in keiko-contracts shape these on write; we trust the row.
  return { kind, ...parsed } as KnowledgeSourceScope;
}

function rowToSource(row: CapsuleSourceRow): KnowledgeSource {
  const base: KnowledgeSource = {
    id: row.id as KnowledgeSourceId,
    displayName: row.display_name,
    tags: parseTags(row.tags_json),
    scope: parseScope(row.scope_kind, row.scope_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return row.description === null ? base : { ...base, description: row.description };
}

function scopeToJson(scope: KnowledgeSourceScope): string {
  // We persist only the fields beyond `kind` (kind lives in its own column). Build a
  // plain object copy without `kind` rather than destructuring + discarding, which the
  // lint config flags as an unused binding.
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(scope)) {
    if (key === "kind") continue;
    copy[key] = value;
  }
  return JSON.stringify(copy);
}

function sourceParams(input: AddCapsuleSourceInput, now: number): SourceParams {
  return {
    id: input.id,
    display_name: input.displayName,
    description: input.description ?? null,
    tags_json: JSON.stringify(input.tags),
    scope_kind: input.scope.kind,
    scope_json: scopeToJson(input.scope),
    created_at: now,
    updated_at: now,
  };
}

function insertSourceLink(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  params: SourceParams,
): void {
  const db = store._internal.db;
  db.exec("BEGIN");
  try {
    db.prepare(INSERT_KNOWLEDGE_SOURCE_SQL).run(params);
    db.prepare(INSERT_SQL).run({ ...params, capsule_id: capsuleId });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    const msg = error instanceof Error ? error.message : String(error);
    if (/UNIQUE|PRIMARY KEY/i.test(msg)) {
      throw new KnowledgeStoreError("source already exists", { cause: error });
    }
    throw new KnowledgeStoreError("failed to add source", { cause: error });
  }
}

export function addSourceToCapsule(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  input: AddCapsuleSourceInput,
  auditSink?: AuditEventSink,
): KnowledgeSource {
  assertSafeDisplayField("displayName", input.displayName);
  assertSafeOptionalDisplayField("description", input.description);
  for (const tag of input.tags) {
    assertSafeDisplayField("tag", tag);
  }
  assertSafeScope(input.scope);
  const now = store._internal.now();
  insertSourceLink(store, capsuleId, sourceParams(input, now));
  const fetched = store._internal.db.prepare(SELECT_BY_TUPLE_SQL).get({ c: capsuleId, s: input.id });
  if (fetched === undefined) {
    throw new KnowledgeStoreError(
      `addSourceToCapsule: insert succeeded but row not found for ${String(input.id)}`,
    );
  }
  const source = readSource(store, capsuleId, input.id);
  auditSink?.emit({
    kind: "source-added",
    capsuleId,
    sourceId: input.id,
    occurredAt: now,
  });
  return source;
}

function readSource(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  sourceId: KnowledgeSourceId,
): KnowledgeSource {
  const row = store._internal.db
    .prepare(
      "SELECT ks.* FROM capsule_sources AS cs JOIN knowledge_sources AS ks ON ks.id = cs.id WHERE cs.capsule_id = :c AND cs.id = :s",
    )
    .get({ c: capsuleId, s: sourceId });
  if (row === undefined) {
    throw new KnowledgeNotFoundError(
      `Source not found: capsule=${String(capsuleId)} source=${String(sourceId)}`,
    );
  }
  return rowToSource(row as unknown as CapsuleSourceRow);
}

export function listCapsuleSources(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
): readonly KnowledgeSource[] {
  const rows = store._internal.db.prepare(SELECT_BY_CAPSULE_SQL).all({ c: capsuleId });
  return rows.map((row) => rowToSource(row as unknown as CapsuleSourceRow));
}

export function removeSourceFromCapsule(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  sourceId: KnowledgeSourceId,
  auditSink?: AuditEventSink,
): void {
  const db = store._internal.db;
  const occurredAt = store._internal.now();
  db.exec("BEGIN");
  try {
    // Verify the (capsule, source) tuple exists. Deleting on a non-matching tuple would
    // silently succeed with 0 changes; we want the caller to learn about typos.
    const probe = db.prepare(SELECT_BY_TUPLE_SQL).get({ c: capsuleId, s: sourceId });
    if (probe === undefined) {
      db.exec("ROLLBACK");
      throw new KnowledgeNotFoundError(
        `Source not found for tuple capsule=${String(capsuleId)} source=${String(sourceId)}`,
      );
    }
    db.prepare(DELETE_BY_TUPLE_SQL).run({ c: capsuleId, s: sourceId });
    db.exec("COMMIT");
  } catch (error) {
    if (!(error instanceof KnowledgeNotFoundError)) {
      db.exec("ROLLBACK");
    }
    throw error;
  }
  auditSink?.emit({ kind: "source-removed", capsuleId, sourceId, occurredAt });
}
