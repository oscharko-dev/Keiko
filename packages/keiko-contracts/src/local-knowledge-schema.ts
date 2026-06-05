// Persistent on-disk schema for the Local Knowledge Connector capsule store (Epic #189,
// Issue #265). This module is PURE — no `node:sqlite` import, no fs, no clock — so it can
// live in the leaf `keiko-contracts` package without breaking ADR-0019 direction rule 1.
// The runtime that *applies* the DDL ships in issue #193; that runtime owns the
// `DatabaseSync` import, atomic file creation, and the migration runner.
//
// Schema-version model
// --------------------
//   * `LOCAL_KNOWLEDGE_SCHEMA_VERSION` (string `"1"`, from `local-knowledge.ts`) pins the
//     *in-memory* type-contract surface. A breaking type change adds a new literal member.
//   * `LOCAL_KNOWLEDGE_DB_SCHEMA_VERSION` (integer `1`, here) pins the *on-disk* DDL and is
//     stored via `PRAGMA user_version`. The two evolve independently — a new column with a
//     non-breaking JS-side mapping bumps only the DB version; a contract-breaking type
//     addition bumps only the string version.
//
// Lineage invariant
// -----------------
//   Every operational dependent table carries `capsule_id TEXT NOT NULL REFERENCES
//   capsules(id) ON DELETE CASCADE`. Documents, chunks, and vectors additionally carry
//   `source_id`; pages, sections, parsed units, chunks, and vectors additionally carry
//   `document_id`. The DB therefore enforces the Foundry-IQ "no global pool" rule — a
//   chunk or vector cannot exist outside of its capsule + source + document tuple.
//
//   Audit tables intentionally keep only metadata identifiers and do NOT cascade on capsule
//   deletion. A `capsule-deleted` audit event must remain durable after the capsule row and
//   operational index state are removed.
//
// Vector identity is denormalised onto every vector row (provider/modelId/dimensions/
// metric). When the active embedding model changes, stale vectors are detected by a single
// scan against the index `idx_vectors_capsule_identity` without joining back to `capsules`.

export const LOCAL_KNOWLEDGE_DB_SCHEMA_VERSION = 7 as const;

// ─── DDL statements (applied in declared order) ──────────────────────────────────
// node:sqlite from Node 22 ships SQLite ≥ 3.45 which supports `STRICT`. Each statement is
// a single complete top-level statement so the runtime can apply them via either `exec`
// (batch) or one-shot `prepare(...).run()` without re-parsing.

const PRAGMA_FOREIGN_KEYS = "PRAGMA foreign_keys = ON;";

const CREATE_CAPSULES = `
CREATE TABLE capsules (
  id TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  tags_json TEXT NOT NULL,
  source_routing_instructions TEXT,
  always_query INTEGER NOT NULL DEFAULT 0,
  retrieval_effort TEXT NOT NULL,
  output_mode TEXT NOT NULL,
  answer_grounding_policy TEXT NOT NULL,
  embedding_model_provider TEXT NOT NULL,
  embedding_model_id TEXT NOT NULL,
  embedding_model_revision TEXT,
  vector_dimensions INTEGER NOT NULL,
  vector_metric TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL,
  storage_reference TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
`.trim();

// capsule_sources adds UNIQUE (capsule_id, id) so dependent tables can FK against the
// composite (capsule_id, source_id) pair — that enforces the Foundry-IQ lineage invariant
// at the database level: a chunk's source_id cannot belong to a different capsule than the
// chunk itself. Independent single-column FKs would let mismatched capsule/source/document
// IDs co-exist on the same chunk row.
const CREATE_CAPSULE_SOURCES = `
CREATE TABLE capsule_sources (
  id TEXT PRIMARY KEY NOT NULL,
  capsule_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  tags_json TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (capsule_id) REFERENCES capsules(id) ON DELETE CASCADE,
  UNIQUE (capsule_id, id)
) STRICT;
`.trim();

const CREATE_CAPSULE_SET_MEMBERS = `
CREATE TABLE capsule_set_members (
  set_id TEXT NOT NULL,
  capsule_id TEXT NOT NULL REFERENCES capsules(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  composed_at INTEGER NOT NULL,
  PRIMARY KEY (set_id, capsule_id)
) STRICT;
`.trim();

// documents links to capsule_sources via the composite (capsule_id, source_id) so the
// source is required to live in the same capsule as the document. UNIQUE (capsule_id, id)
// exposes the same composite for downstream tables (chunks, vectors, pages, sections,
// parsed_units, parser_diagnostics) to lock document_id to capsule_id.
const CREATE_DOCUMENTS = `
CREATE TABLE documents (
  id TEXT PRIMARY KEY NOT NULL,
  capsule_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  document_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  parser_id TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  last_extracted_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  safe_display_name TEXT NOT NULL,
  FOREIGN KEY (capsule_id) REFERENCES capsules(id) ON DELETE CASCADE,
  FOREIGN KEY (capsule_id, source_id) REFERENCES capsule_sources(capsule_id, id) ON DELETE CASCADE,
  UNIQUE (capsule_id, id)
) STRICT;
`.trim();

const CREATE_DOCUMENT_TEXTS = `
CREATE TABLE document_texts (
  capsule_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  PRIMARY KEY (document_id),
  FOREIGN KEY (capsule_id) REFERENCES capsules(id) ON DELETE CASCADE,
  FOREIGN KEY (capsule_id, document_id) REFERENCES documents(capsule_id, id) ON DELETE CASCADE
) STRICT;
`.trim();

const CREATE_PAGES = `
CREATE TABLE pages (
  capsule_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  page_number INTEGER NOT NULL,
  page_label TEXT,
  character_start INTEGER NOT NULL,
  character_end INTEGER NOT NULL,
  bbox_x REAL,
  bbox_y REAL,
  bbox_w REAL,
  bbox_h REAL,
  PRIMARY KEY (document_id, page_number),
  FOREIGN KEY (capsule_id) REFERENCES capsules(id) ON DELETE CASCADE,
  FOREIGN KEY (capsule_id, document_id) REFERENCES documents(capsule_id, id) ON DELETE CASCADE
) STRICT;
`.trim();

const CREATE_SECTIONS = `
CREATE TABLE sections (
  capsule_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  section_path_json TEXT NOT NULL,
  character_start INTEGER NOT NULL,
  character_end INTEGER NOT NULL,
  PRIMARY KEY (document_id, section_path_json),
  FOREIGN KEY (capsule_id) REFERENCES capsules(id) ON DELETE CASCADE,
  FOREIGN KEY (capsule_id, document_id) REFERENCES documents(capsule_id, id) ON DELETE CASCADE
) STRICT;
`.trim();

const CREATE_PARSED_UNITS = `
CREATE TABLE parsed_units (
  id TEXT PRIMARY KEY NOT NULL,
  capsule_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  page_number INTEGER,
  page_label TEXT,
  section_path_json TEXT,
  json_pointer TEXT,
  table_name TEXT,
  row_index INTEGER,
  heading_path_json TEXT,
  unsupported_reason TEXT,
  character_start INTEGER,
  character_end INTEGER,
  FOREIGN KEY (capsule_id) REFERENCES capsules(id) ON DELETE CASCADE,
  FOREIGN KEY (capsule_id, document_id) REFERENCES documents(capsule_id, id) ON DELETE CASCADE,
  UNIQUE (capsule_id, id)
) STRICT;
`.trim();

const CREATE_CHUNKS = `
CREATE TABLE chunks (
  id TEXT PRIMARY KEY NOT NULL,
  capsule_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  parsed_unit_id TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  token_count INTEGER NOT NULL,
  safe_excerpt_hash TEXT NOT NULL,
  chunking_strategy_version TEXT,
  FOREIGN KEY (capsule_id) REFERENCES capsules(id) ON DELETE CASCADE,
  FOREIGN KEY (capsule_id, source_id) REFERENCES capsule_sources(capsule_id, id) ON DELETE CASCADE,
  FOREIGN KEY (capsule_id, document_id) REFERENCES documents(capsule_id, id) ON DELETE CASCADE,
  FOREIGN KEY (capsule_id, parsed_unit_id) REFERENCES parsed_units(capsule_id, id) ON DELETE CASCADE,
  UNIQUE (capsule_id, id)
) STRICT;
`.trim();

const CREATE_CHUNKS_V1 = `
CREATE TABLE chunks (
  id TEXT PRIMARY KEY NOT NULL,
  capsule_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  parsed_unit_id TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  token_count INTEGER NOT NULL,
  safe_excerpt_hash TEXT NOT NULL,
  FOREIGN KEY (capsule_id) REFERENCES capsules(id) ON DELETE CASCADE,
  FOREIGN KEY (capsule_id, source_id) REFERENCES capsule_sources(capsule_id, id) ON DELETE CASCADE,
  FOREIGN KEY (capsule_id, document_id) REFERENCES documents(capsule_id, id) ON DELETE CASCADE,
  FOREIGN KEY (capsule_id, parsed_unit_id) REFERENCES parsed_units(capsule_id, id) ON DELETE CASCADE,
  UNIQUE (capsule_id, id)
) STRICT;
`.trim();

const CREATE_VECTORS = `
CREATE TABLE vectors (
  id TEXT PRIMARY KEY NOT NULL,
  capsule_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  embedding BLOB NOT NULL,
  embedding_model_provider TEXT NOT NULL,
  embedding_model_id TEXT NOT NULL,
  embedding_model_revision TEXT,
  vector_dimensions INTEGER NOT NULL,
  vector_metric TEXT NOT NULL,
  storage_reference TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (capsule_id) REFERENCES capsules(id) ON DELETE CASCADE,
  FOREIGN KEY (capsule_id, source_id) REFERENCES capsule_sources(capsule_id, id) ON DELETE CASCADE,
  FOREIGN KEY (capsule_id, document_id) REFERENCES documents(capsule_id, id) ON DELETE CASCADE,
  FOREIGN KEY (capsule_id, chunk_id) REFERENCES chunks(capsule_id, id) ON DELETE CASCADE
) STRICT;
`.trim();

const CREATE_PARSER_DIAGNOSTICS = `
CREATE TABLE parser_diagnostics (
  id TEXT PRIMARY KEY NOT NULL,
  capsule_id TEXT NOT NULL,
  document_id TEXT,
  severity TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  page_number INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (capsule_id) REFERENCES capsules(id) ON DELETE CASCADE,
  FOREIGN KEY (capsule_id, document_id) REFERENCES documents(capsule_id, id) ON DELETE CASCADE
) STRICT;
`.trim();

const CREATE_INDEXING_JOBS = `
CREATE TABLE indexing_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  capsule_id TEXT NOT NULL REFERENCES capsules(id) ON DELETE CASCADE,
  source_ids_json TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,
  total_documents INTEGER NOT NULL,
  processed_documents INTEGER NOT NULL,
  failed_documents INTEGER NOT NULL,
  skipped_documents INTEGER NOT NULL,
  last_error_code TEXT,
  last_error_message TEXT,
  resume_token TEXT,
  cancellation_requested INTEGER NOT NULL DEFAULT 0
) STRICT;
`.trim();

const CREATE_SCHEMA_META = `
CREATE TABLE schema_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) STRICT;
`.trim();

// capsule_membership_changes — append-only audit trail for composition events on a capsule
// (Issue #263). Recorded inline by `addSourcesToCapsule` and `composeCapsules`; consumed by
// the evidence ledger and the future UI history view. `change_kind` is constrained so a typo
// at the application layer fails at INSERT rather than silently broadens the audit vocabulary.
// `source_id` is nullable because compose-events reference a capsule_set rather than a single
// source — the `details_json` payload carries the structured arguments for that case.
const CREATE_CAPSULE_MEMBERSHIP_CHANGES = `
CREATE TABLE capsule_membership_changes (
  id TEXT PRIMARY KEY NOT NULL,
  capsule_id TEXT NOT NULL,
  change_kind TEXT NOT NULL CHECK (change_kind IN ('add-source', 'remove-source', 'compose-set')),
  source_id TEXT,
  details_json TEXT,
  occurred_at INTEGER NOT NULL
) STRICT;
`.trim();

const CREATE_CAPSULE_MEMBERSHIP_CHANGES_INDEX =
  "CREATE INDEX idx_capsule_membership_changes_capsule_time ON capsule_membership_changes(capsule_id, occurred_at);";

const CREATE_CAPSULE_AUDIT_EVENTS = `
CREATE TABLE capsule_audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  capsule_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (
    kind IN (
      'capsule-created',
      'capsule-deleted',
      'source-added',
      'source-removed',
      'indexing-job-started',
      'indexing-job-completed',
      'indexing-job-failed',
      'retention-applied',
      'retrieval-performed',
      'answer-context-assembled',
      'model-context-sent'
    )
  ),
  source_id TEXT,
  job_id TEXT,
  error_code TEXT,
  processed_documents INTEGER,
  failed_documents INTEGER,
  deleted_vector_count INTEGER,
  deleted_extracted_text_count INTEGER,
  details_json TEXT,
  occurred_at INTEGER NOT NULL
) STRICT;
`.trim();

const CREATE_CAPSULE_AUDIT_EVENTS_INDEX =
  "CREATE INDEX idx_capsule_audit_events_capsule_time ON capsule_audit_events(capsule_id, occurred_at);";

// Statements must be applied in this exact order: PRAGMA first (so child-table NOT NULL
// foreign-key constraints are enforced as the rows arrive), then parents before children.
export const KNOWLEDGE_CAPSULE_DDL: readonly string[] = [
  PRAGMA_FOREIGN_KEYS,
  CREATE_CAPSULES,
  CREATE_CAPSULE_SOURCES,
  CREATE_CAPSULE_SET_MEMBERS,
  CREATE_DOCUMENTS,
  CREATE_DOCUMENT_TEXTS,
  CREATE_PAGES,
  CREATE_SECTIONS,
  CREATE_PARSED_UNITS,
  CREATE_CHUNKS,
  CREATE_VECTORS,
  CREATE_PARSER_DIAGNOSTICS,
  CREATE_INDEXING_JOBS,
  CREATE_SCHEMA_META,
  CREATE_CAPSULE_MEMBERSHIP_CHANGES,
  CREATE_CAPSULE_AUDIT_EVENTS,
] as const;

// ─── Indexes (scoped-query patterns only — no full-table scans) ──────────────────
export const KNOWLEDGE_CAPSULE_INDEXES: readonly string[] = [
  "CREATE INDEX idx_documents_capsule_source ON documents(capsule_id, source_id, status);",
  "CREATE INDEX idx_documents_content_hash ON documents(capsule_id, content_hash);",
  "CREATE INDEX idx_chunks_capsule_document_order ON chunks(capsule_id, document_id, order_index);",
  "CREATE INDEX idx_vectors_capsule ON vectors(capsule_id);",
  "CREATE INDEX idx_vectors_capsule_identity ON vectors(capsule_id, embedding_model_provider, embedding_model_id, vector_dimensions);",
  "CREATE INDEX idx_parser_diagnostics_capsule_doc ON parser_diagnostics(capsule_id, document_id);",
  "CREATE INDEX idx_indexing_jobs_capsule_status ON indexing_jobs(capsule_id, status);",
  CREATE_CAPSULE_MEMBERSHIP_CHANGES_INDEX,
  CREATE_CAPSULE_AUDIT_EVENTS_INDEX,
] as const;

// Runtime deletion primitive (#193 uses this inside a transaction). The cascade chain in
// the DDL above removes every dependent row atomically when this single statement runs.
export const DELETE_CAPSULE_SQL = "DELETE FROM capsules WHERE id = :capsule_id;" as const;

// ─── Migration manifest ──────────────────────────────────────────────────────────
// Forward-only. Each entry's `up` is a list of complete statements applied in order. The
// runtime applies entries whose `version` is greater than the current `PRAGMA user_version`
// inside a transaction and updates `user_version` after a successful apply.
export interface KnowledgeCapsuleMigration {
  readonly version: number;
  readonly reason: string;
  readonly up: readonly string[];
}

// Version 1 originally applied the entire DDL+indexes set as a single migration. To preserve
// forward-only semantics we split v2 out as a *delta*: existing v1 databases run only the
// new CREATE TABLE + CREATE INDEX. Fresh installs apply v1 followed by v2 and end at the
// same on-disk shape. Each `up` entry stays a single complete statement.
const V1_DDL_WITHOUT_V2: readonly string[] = [
  PRAGMA_FOREIGN_KEYS,
  CREATE_CAPSULES,
  CREATE_CAPSULE_SOURCES,
  CREATE_CAPSULE_SET_MEMBERS,
  CREATE_DOCUMENTS,
  CREATE_PAGES,
  CREATE_SECTIONS,
  CREATE_PARSED_UNITS,
  CREATE_CHUNKS_V1,
  CREATE_VECTORS,
  CREATE_PARSER_DIAGNOSTICS,
  CREATE_INDEXING_JOBS,
  CREATE_SCHEMA_META,
] as const;

const V1_INDEXES_WITHOUT_V2: readonly string[] = [
  "CREATE INDEX idx_documents_capsule_source ON documents(capsule_id, source_id, status);",
  "CREATE INDEX idx_documents_content_hash ON documents(capsule_id, content_hash);",
  "CREATE INDEX idx_chunks_capsule_document_order ON chunks(capsule_id, document_id, order_index);",
  "CREATE INDEX idx_vectors_capsule ON vectors(capsule_id);",
  "CREATE INDEX idx_vectors_capsule_identity ON vectors(capsule_id, embedding_model_provider, embedding_model_id, vector_dimensions);",
  "CREATE INDEX idx_parser_diagnostics_capsule_doc ON parser_diagnostics(capsule_id, document_id);",
  "CREATE INDEX idx_indexing_jobs_capsule_status ON indexing_jobs(capsule_id, status);",
] as const;

const CREATE_CAPSULE_MEMBERSHIP_CHANGES_V5 = CREATE_CAPSULE_MEMBERSHIP_CHANGES.replace(
  "capsule_membership_changes",
  "capsule_membership_changes_v5",
);

const CREATE_CAPSULE_AUDIT_EVENTS_V5 = CREATE_CAPSULE_AUDIT_EVENTS.replace(
  "capsule_audit_events",
  "capsule_audit_events_v5",
);

const COPY_CAPSULE_MEMBERSHIP_CHANGES_TO_V5 = `
INSERT INTO capsule_membership_changes_v5 (
  id, capsule_id, change_kind, source_id, details_json, occurred_at
)
SELECT id, capsule_id, change_kind, source_id, details_json, occurred_at
FROM capsule_membership_changes;
`.trim();

const COPY_CAPSULE_AUDIT_EVENTS_TO_V5 = `
INSERT INTO capsule_audit_events_v5 (
  id, capsule_id, kind, source_id, job_id, error_code, processed_documents, failed_documents,
  deleted_vector_count, deleted_extracted_text_count, occurred_at
)
SELECT id, capsule_id, kind, source_id, job_id, error_code, processed_documents, failed_documents,
  deleted_vector_count, deleted_extracted_text_count, occurred_at
FROM capsule_audit_events;
`.trim();

const CREATE_CAPSULE_AUDIT_EVENTS_V7 = CREATE_CAPSULE_AUDIT_EVENTS.replace(
  "capsule_audit_events",
  "capsule_audit_events_v7",
);

const COPY_CAPSULE_AUDIT_EVENTS_TO_V7 = `
INSERT INTO capsule_audit_events_v7 (
  id, capsule_id, kind, source_id, job_id, error_code, processed_documents, failed_documents,
  deleted_vector_count, deleted_extracted_text_count, details_json, occurred_at
)
SELECT id, capsule_id, kind, source_id, job_id, error_code, processed_documents, failed_documents,
  deleted_vector_count, deleted_extracted_text_count, NULL, occurred_at
FROM capsule_audit_events;
`.trim();

const REBUILD_AUDIT_TABLES_FOR_DELETE_DURABILITY: readonly string[] = [
  CREATE_CAPSULE_MEMBERSHIP_CHANGES_V5,
  COPY_CAPSULE_MEMBERSHIP_CHANGES_TO_V5,
  "DROP TABLE capsule_membership_changes;",
  "ALTER TABLE capsule_membership_changes_v5 RENAME TO capsule_membership_changes;",
  CREATE_CAPSULE_MEMBERSHIP_CHANGES_INDEX,
  CREATE_CAPSULE_AUDIT_EVENTS_V5,
  COPY_CAPSULE_AUDIT_EVENTS_TO_V5,
  "DROP TABLE capsule_audit_events;",
  "ALTER TABLE capsule_audit_events_v5 RENAME TO capsule_audit_events;",
  CREATE_CAPSULE_AUDIT_EVENTS_INDEX,
] as const;

export const KNOWLEDGE_CAPSULE_MIGRATIONS: readonly KnowledgeCapsuleMigration[] = [
  {
    version: 1,
    reason: "Initial schema for Local Knowledge Connector capsule store (Issue #265).",
    up: [...V1_DDL_WITHOUT_V2, ...V1_INDEXES_WITHOUT_V2],
  },
  {
    version: 2,
    reason:
      "Audit trail for capsule composition events (add-source, remove-source, compose-set) for Issue #263.",
    up: [CREATE_CAPSULE_MEMBERSHIP_CHANGES, CREATE_CAPSULE_MEMBERSHIP_CHANGES_INDEX],
  },
  {
    version: 3,
    reason: "Persist metadata-only capsule lifecycle and retention audit events for Issue #201.",
    up: [CREATE_CAPSULE_AUDIT_EVENTS, CREATE_CAPSULE_AUDIT_EVENTS_INDEX],
  },
  {
    version: 4,
    reason:
      "Persist normalized extracted text for binary parsers so chunk offsets project against extracted content.",
    up: [CREATE_DOCUMENT_TEXTS],
  },
  {
    version: 5,
    reason: "Keep metadata-only capsule audit rows durable after capsule deletion for Issue #201.",
    up: REBUILD_AUDIT_TABLES_FOR_DELETE_DURABILITY,
  },
  {
    version: 6,
    reason:
      "Persist chunking strategy version so stale chunks and vectors are re-emitted after Issue #195 strategy changes.",
    up: ["ALTER TABLE chunks ADD COLUMN chunking_strategy_version TEXT;"],
  },
  {
    version: 7,
    reason:
      "Persist retrieval, answer-context, and model-bound chunk usage audit metadata for Issue #201.",
    up: [
      CREATE_CAPSULE_AUDIT_EVENTS_V7,
      COPY_CAPSULE_AUDIT_EVENTS_TO_V7,
      "DROP TABLE capsule_audit_events;",
      "ALTER TABLE capsule_audit_events_v7 RENAME TO capsule_audit_events;",
      CREATE_CAPSULE_AUDIT_EVENTS_INDEX,
    ],
  },
] as const;

// Expected table/index names; consumers can iterate to assert presence without re-parsing
// the DDL strings. Mirrors the order of KNOWLEDGE_CAPSULE_DDL after the leading PRAGMA.
//
// `KNOWLEDGE_CAPSULE_V1_TABLES` lists only the tables that exist after a v1-only migration
// (i.e. the original 12 tables without the v2 audit table). The store uses this narrower
// set for the pre-migration check so that an existing v1 database is not falsely treated
// as corrupt before migrations run.
export const KNOWLEDGE_CAPSULE_V1_TABLES: readonly string[] = [
  "capsules",
  "capsule_sources",
  "capsule_set_members",
  "documents",
  "pages",
  "sections",
  "parsed_units",
  "chunks",
  "vectors",
  "parser_diagnostics",
  "indexing_jobs",
  "schema_meta",
] as const;

export const KNOWLEDGE_CAPSULE_TABLES: readonly string[] = [
  ...KNOWLEDGE_CAPSULE_V1_TABLES,
  "document_texts",
  "capsule_membership_changes",
  "capsule_audit_events",
] as const;

export const KNOWLEDGE_CAPSULE_INDEX_NAMES: readonly string[] = [
  "idx_documents_capsule_source",
  "idx_documents_content_hash",
  "idx_chunks_capsule_document_order",
  "idx_vectors_capsule",
  "idx_vectors_capsule_identity",
  "idx_parser_diagnostics_capsule_doc",
  "idx_indexing_jobs_capsule_status",
  "idx_capsule_membership_changes_capsule_time",
  "idx_capsule_audit_events_capsule_time",
] as const;
