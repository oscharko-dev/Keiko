// capsule-lifecycle.ts — typed CRUD over the `capsules` table plus its FK-driven cascade.
//
// Invariants:
//   * Every write runs inside `BEGIN`/`COMMIT` so partial state never lands on disk.
//   * createCapsule rejects duplicate ids via the PRIMARY KEY — raised as KnowledgeStoreError.
//   * Reads compose `sourceIds` from the live `capsule_sources` table — the capsule row
//     does NOT denormalise the source list, so the reverse FK is the single truth.
//   * deleteCapsule relies on the schema's ON DELETE CASCADE chain (#265). Removing the
//     CASCADE clause from any dependent table will either throw an FK violation (when
//     foreign_keys=ON catches a leftover) or leave orphan rows the cascade test catches.

import {
  DELETE_CAPSULE_SQL,
  type CapsuleAnswerGroundingPolicy,
  type CapsuleLifecycleState,
  type CapsuleOutputMode,
  type CapsuleRetrievalEffort,
  type CapsuleSetId,
  type EmbeddingModelIdentity,
  type EmbeddingVectorMetric,
  type KnowledgeCapsule,
  type KnowledgeCapsuleId,
  type KnowledgeSourceId,
  isSafeDisplaySummary,
} from "@oscharko-dev/keiko-contracts";

import { KnowledgeNotFoundError, KnowledgeStoreError } from "./errors.js";
import type { AuditEventSink } from "./privacy/types.js";
import type { KnowledgeStore } from "./store.js";

export interface CreateCapsuleInput {
  readonly id: KnowledgeCapsuleId;
  readonly displayName: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly sourceRoutingInstructions?: string;
  readonly alwaysQuery?: boolean;
  readonly retrievalEffort: CapsuleRetrievalEffort;
  readonly outputMode: CapsuleOutputMode;
  readonly answerGroundingPolicy: CapsuleAnswerGroundingPolicy;
  readonly embeddingModelIdentity: EmbeddingModelIdentity;
  readonly lifecycleState: CapsuleLifecycleState;
  readonly storageReference: string;
}

interface CapsuleRow {
  readonly id: string;
  readonly display_name: string;
  readonly description: string | null;
  readonly tags_json: string;
  readonly source_routing_instructions: string | null;
  readonly always_query: number;
  readonly retrieval_effort: string;
  readonly output_mode: string;
  readonly answer_grounding_policy: string;
  readonly embedding_model_provider: string;
  readonly embedding_model_id: string;
  readonly embedding_model_revision: string | null;
  readonly vector_dimensions: number;
  readonly vector_metric: string;
  readonly lifecycle_state: string;
  readonly storage_reference: string;
  readonly created_at: number;
  readonly updated_at: number;
}

interface SourceIdRow {
  readonly id: string;
}

const INSERT_CAPSULE_SQL = [
  "INSERT INTO capsules (",
  "  id, display_name, description, tags_json, source_routing_instructions, always_query,",
  "  retrieval_effort, output_mode, answer_grounding_policy,",
  "  embedding_model_provider, embedding_model_id, embedding_model_revision,",
  "  vector_dimensions, vector_metric, lifecycle_state, storage_reference,",
  "  created_at, updated_at",
  ") VALUES (",
  "  :id, :display_name, :description, :tags_json, :source_routing_instructions, :always_query,",
  "  :retrieval_effort, :output_mode, :answer_grounding_policy,",
  "  :embedding_model_provider, :embedding_model_id, :embedding_model_revision,",
  "  :vector_dimensions, :vector_metric, :lifecycle_state, :storage_reference,",
  "  :created_at, :updated_at",
  ")",
].join(" ");

const SELECT_CAPSULE_BY_ID_SQL = "SELECT * FROM capsules WHERE id = :id";
const SELECT_ALL_CAPSULES_SQL = "SELECT * FROM capsules ORDER BY created_at ASC, id ASC";
const SELECT_SOURCE_IDS_FOR_CAPSULE_SQL =
  "SELECT id FROM capsule_sources WHERE capsule_id = :c ORDER BY created_at ASC, id ASC";
const UPDATE_STATE_SQL =
  "UPDATE capsules SET lifecycle_state = :state, updated_at = :now WHERE id = :id";
const SELECT_AFFECTED_CAPSULE_SETS_SQL =
  "SELECT set_id FROM capsule_set_members WHERE capsule_id = :c ORDER BY set_id ASC";

const DELETE_VERIFICATION_TABLES = [
  "capsule_sources",
  "capsule_set_members",
  "documents",
  "document_texts",
  "pages",
  "sections",
  "parsed_units",
  "chunks",
  "vectors",
  "parser_diagnostics",
  "indexing_jobs",
] as const;

export interface DeleteCapsuleResult {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly affectedCapsuleSetIds: readonly CapsuleSetId[];
  readonly cleanupVerified: true;
}

function jsonOrEmpty(value: readonly string[]): string {
  return JSON.stringify(value);
}

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

function assertSafeCreateCapsuleInput(input: CreateCapsuleInput): void {
  assertSafeDisplayField("displayName", input.displayName);
  assertSafeOptionalDisplayField("description", input.description);
  assertSafeOptionalDisplayField("sourceRoutingInstructions", input.sourceRoutingInstructions);
  for (const tag of input.tags) {
    assertSafeDisplayField("tag", tag);
  }
}

function listSourceIdsFor(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
): readonly KnowledgeSourceId[] {
  const rows = store._internal.db.prepare(SELECT_SOURCE_IDS_FOR_CAPSULE_SQL).all({ c: capsuleId });
  return rows.map((row) => (row as unknown as SourceIdRow).id as KnowledgeSourceId);
}

function buildEmbeddingIdentity(row: CapsuleRow): EmbeddingModelIdentity {
  const base: EmbeddingModelIdentity = {
    provider: row.embedding_model_provider,
    modelId: row.embedding_model_id,
    vectorDimensions: row.vector_dimensions,
    vectorMetric: row.vector_metric as EmbeddingVectorMetric,
  };
  if (row.embedding_model_revision === null) return base;
  return { ...base, modelRevision: row.embedding_model_revision };
}

function rowToCapsule(row: CapsuleRow, sourceIds: readonly KnowledgeSourceId[]): KnowledgeCapsule {
  const base: KnowledgeCapsule = {
    id: row.id as KnowledgeCapsuleId,
    displayName: row.display_name,
    tags: parseTags(row.tags_json),
    sourceIds,
    retrievalEffort: row.retrieval_effort as CapsuleRetrievalEffort,
    outputMode: row.output_mode as CapsuleOutputMode,
    answerGroundingPolicy: row.answer_grounding_policy as CapsuleAnswerGroundingPolicy,
    embeddingModelIdentity: buildEmbeddingIdentity(row),
    lifecycleState: row.lifecycle_state as CapsuleLifecycleState,
    storageReference: row.storage_reference,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return withOptionalCapsuleFields(base, row);
}

function withOptionalCapsuleFields(base: KnowledgeCapsule, row: CapsuleRow): KnowledgeCapsule {
  // exactOptionalPropertyTypes requires us to OMIT absent optionals rather than set them
  // to undefined. Spread the optionals only when they are present in the row.
  let result: KnowledgeCapsule = base;
  if (row.description !== null) {
    result = { ...result, description: row.description };
  }
  if (row.source_routing_instructions !== null) {
    result = { ...result, sourceRoutingInstructions: row.source_routing_instructions };
  }
  if (row.always_query === 1) {
    result = { ...result, alwaysQuery: true };
  } else if (row.always_query === 0) {
    // alwaysQuery defaults to undefined when stored as 0; we mirror "no" as omitted.
  }
  return result;
}

export function createCapsule(
  store: KnowledgeStore,
  input: CreateCapsuleInput,
  auditSink?: AuditEventSink,
): KnowledgeCapsule {
  assertSafeCreateCapsuleInput(input);
  const now = store._internal.now();
  const params = {
    id: input.id,
    display_name: input.displayName,
    description: input.description ?? null,
    tags_json: jsonOrEmpty(input.tags),
    source_routing_instructions: input.sourceRoutingInstructions ?? null,
    always_query: input.alwaysQuery === true ? 1 : 0,
    retrieval_effort: input.retrievalEffort,
    output_mode: input.outputMode,
    answer_grounding_policy: input.answerGroundingPolicy,
    embedding_model_provider: input.embeddingModelIdentity.provider,
    embedding_model_id: input.embeddingModelIdentity.modelId,
    embedding_model_revision: input.embeddingModelIdentity.modelRevision ?? null,
    vector_dimensions: input.embeddingModelIdentity.vectorDimensions,
    vector_metric: input.embeddingModelIdentity.vectorMetric,
    lifecycle_state: input.lifecycleState,
    storage_reference: input.storageReference,
    created_at: now,
    updated_at: now,
  };
  const db = store._internal.db;
  db.exec("BEGIN");
  try {
    db.prepare(INSERT_CAPSULE_SQL).run(params);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    const msg = error instanceof Error ? error.message : String(error);
    if (/UNIQUE|PRIMARY KEY/i.test(msg)) {
      throw new KnowledgeStoreError("capsule already exists", { cause: error });
    }
    throw new KnowledgeStoreError("failed to create capsule", { cause: error });
  }
  const capsule = getCapsule(store, input.id);
  if (capsule === undefined) {
    // Defensive: a successful INSERT must be readable. This branch indicates a serious
    // store-level inconsistency (e.g. concurrent DELETE) and the caller cannot continue
    // safely with a synthesised value.
    throw new KnowledgeStoreError(
      `createCapsule: insert succeeded but row not found for ${String(input.id)}`,
    );
  }
  auditSink?.emit({ kind: "capsule-created", capsuleId: capsule.id, occurredAt: now });
  return capsule;
}

export function getCapsule(
  store: KnowledgeStore,
  id: KnowledgeCapsuleId,
): KnowledgeCapsule | undefined {
  const row = store._internal.db.prepare(SELECT_CAPSULE_BY_ID_SQL).get({ id });
  if (row === undefined) return undefined;
  const sourceIds = listSourceIdsFor(store, id);
  return rowToCapsule(row as unknown as CapsuleRow, sourceIds);
}

export function listCapsules(store: KnowledgeStore): readonly KnowledgeCapsule[] {
  const rows = store._internal.db.prepare(SELECT_ALL_CAPSULES_SQL).all();
  return rows.map((row) => {
    const typed = row as unknown as CapsuleRow;
    const sourceIds = listSourceIdsFor(store, typed.id as KnowledgeCapsuleId);
    return rowToCapsule(typed, sourceIds);
  });
}

export function updateCapsuleState(
  store: KnowledgeStore,
  id: KnowledgeCapsuleId,
  state: CapsuleLifecycleState,
): KnowledgeCapsule {
  const db = store._internal.db;
  const now = store._internal.now();
  db.exec("BEGIN");
  try {
    const result = db.prepare(UPDATE_STATE_SQL).run({ state, now, id });
    if (Number(result.changes) === 0) {
      db.exec("ROLLBACK");
      throw new KnowledgeNotFoundError(`Capsule not found: ${String(id)}`);
    }
    db.exec("COMMIT");
  } catch (error) {
    if (!(error instanceof KnowledgeNotFoundError)) {
      db.exec("ROLLBACK");
    }
    throw error;
  }
  const capsule = getCapsule(store, id);
  if (capsule === undefined) {
    throw new KnowledgeNotFoundError(`Capsule not found after update: ${String(id)}`);
  }
  return capsule;
}

export interface CapsuleDetailsPatch {
  readonly displayName?: string;
  readonly description?: string;
}

// Slice 4 (#189): update a capsule's display name / description. The SET clause is built only
// from the columns present in the patch; column fragments are fixed literals (no user input),
// so values stay fully parameterised. Metadata persistence is a separate schema migration and is
// intentionally NOT handled here.
export function updateCapsuleDetails(
  store: KnowledgeStore,
  id: KnowledgeCapsuleId,
  patch: CapsuleDetailsPatch,
): KnowledgeCapsule {
  const assignments: string[] = [];
  const params: Record<string, string | number> = { id, now: store._internal.now() };
  if (patch.displayName !== undefined) {
    assertSafeDisplayField("displayName", patch.displayName);
    assignments.push("display_name = :displayName");
    params.displayName = patch.displayName;
  }
  if (patch.description !== undefined) {
    assertSafeOptionalDisplayField("description", patch.description);
    assignments.push("description = :description");
    params.description = patch.description;
  }
  if (assignments.length === 0) {
    throw new KnowledgeStoreError("updateCapsuleDetails requires at least one field to change.");
  }
  const sql = `UPDATE capsules SET ${assignments.join(", ")}, updated_at = :now WHERE id = :id`;
  const db = store._internal.db;
  db.exec("BEGIN");
  try {
    const result = db.prepare(sql).run(params);
    if (Number(result.changes) === 0) {
      db.exec("ROLLBACK");
      throw new KnowledgeNotFoundError(`Capsule not found: ${String(id)}`);
    }
    db.exec("COMMIT");
  } catch (error) {
    if (!(error instanceof KnowledgeNotFoundError)) {
      db.exec("ROLLBACK");
    }
    throw error;
  }
  const capsule = getCapsule(store, id);
  if (capsule === undefined) {
    throw new KnowledgeNotFoundError(`Capsule not found after update: ${String(id)}`);
  }
  return capsule;
}

export function deleteCapsule(
  store: KnowledgeStore,
  id: KnowledgeCapsuleId,
  auditSink?: AuditEventSink,
): DeleteCapsuleResult {
  const db = store._internal.db;
  const occurredAt = store._internal.now();
  const affectedCapsuleSetIds = db
    .prepare(SELECT_AFFECTED_CAPSULE_SETS_SQL)
    .all({ c: id })
    .map((row) => (row as { readonly set_id: string }).set_id as CapsuleSetId);
  db.exec("BEGIN");
  try {
    const result = db.prepare(DELETE_CAPSULE_SQL).run({ capsule_id: id });
    if (Number(result.changes) === 0) {
      db.exec("ROLLBACK");
      throw new KnowledgeNotFoundError(`Capsule not found: ${String(id)}`);
    }
    verifyDeleteCleanup(db, id);
    db.exec("COMMIT");
  } catch (error) {
    if (!(error instanceof KnowledgeNotFoundError)) {
      db.exec("ROLLBACK");
    }
    throw error;
  }
  auditSink?.emit({ kind: "capsule-deleted", capsuleId: id, occurredAt });
  return { capsuleId: id, affectedCapsuleSetIds, cleanupVerified: true };
}

function verifyDeleteCleanup(
  db: KnowledgeStore["_internal"]["db"],
  capsuleId: KnowledgeCapsuleId,
): void {
  for (const table of DELETE_VERIFICATION_TABLES) {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE capsule_id = :c`)
      .get({ c: capsuleId }) as { readonly n: number };
    if (row.n !== 0) {
      throw new KnowledgeStoreError(
        `capsule delete left residual rows in ${table} for ${String(capsuleId)}`,
      );
    }
  }
}
