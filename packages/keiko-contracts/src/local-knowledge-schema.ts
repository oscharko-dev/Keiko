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
//   * `LOCAL_KNOWLEDGE_DB_SCHEMA_VERSION` (integer `26`, here) pins the *on-disk* DDL and is
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

export const LOCAL_KNOWLEDGE_DB_SCHEMA_VERSION = 26 as const;

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
  contextual_retrieval_enabled INTEGER,
  contextual_retrieval_model_id TEXT,
  contextual_retrieval_prompt_version TEXT,
  contextual_retrieval_strict INTEGER,
  contextual_retrieval_max_context_chars INTEGER,
  contextual_retrieval_document_context_max_chars INTEGER,
  model_use_policy_json TEXT,
  embedding_model_provider TEXT NOT NULL,
  embedding_model_id TEXT NOT NULL,
  embedding_model_revision TEXT,
  embedding_normalization TEXT,
  embedding_instruction_version TEXT,
  embedding_space_fingerprint TEXT,
  embedding_dimensions_param INTEGER,
  vector_dimensions INTEGER NOT NULL,
  vector_metric TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL,
  storage_reference TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
`.trim();

const CREATE_KNOWLEDGE_SOURCES = `
CREATE TABLE knowledge_sources (
  id TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  tags_json TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
`.trim();

// capsule_sources adds UNIQUE (capsule_id, id) so dependent tables can FK against the
// composite (capsule_id, source_id) pair — that enforces the Foundry-IQ lineage invariant
// at the database level: a chunk's source_id cannot belong to a different capsule than the
// chunk itself. It also links to `knowledge_sources`, the independent source metadata table
// used by lifecycle reads; existing stores gain that table through the v10 backfill.
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
  FOREIGN KEY (id) REFERENCES knowledge_sources(id) ON DELETE RESTRICT,
  UNIQUE (capsule_id, id)
) STRICT;
`.trim();

const CREATE_CAPSULE_SOURCES_V1 = `
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

const CREATE_HTML_MANUAL_SOURCES = `
CREATE TABLE html_manual_sources (
  capsule_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('html-manual-local', 'html-manual-http')),
  source_fingerprint TEXT NOT NULL,
  root_path TEXT,
  entry_path TEXT,
  origin TEXT,
  path_prefix TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (capsule_id, source_id),
  FOREIGN KEY (capsule_id) REFERENCES capsules(id) ON DELETE CASCADE,
  FOREIGN KEY (capsule_id, source_id) REFERENCES capsule_sources(capsule_id, id) ON DELETE CASCADE
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
const CREATE_DOCUMENTS_V14 = `
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
  blob_ref TEXT,
  FOREIGN KEY (capsule_id) REFERENCES capsules(id) ON DELETE CASCADE,
  FOREIGN KEY (capsule_id, source_id) REFERENCES capsule_sources(capsule_id, id) ON DELETE CASCADE,
  UNIQUE (capsule_id, id)
) STRICT;
`.trim();

const CREATE_DOCUMENT_BLOBS = `
CREATE TABLE document_blobs (
  capsule_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  storage_kind TEXT NOT NULL CHECK (storage_kind IN ('plaintext', 'sealed')),
  seal_version TEXT,
  blob_bytes BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  created_source_id TEXT NOT NULL,
  created_document_id TEXT NOT NULL,
  PRIMARY KEY (capsule_id, content_hash),
  FOREIGN KEY (capsule_id) REFERENCES capsules(id) ON DELETE CASCADE
) STRICT;
`.trim();

const CREATE_DOCUMENT_BLOBS_DOCUMENT_INDEX =
  "CREATE INDEX idx_document_blobs_created_document ON document_blobs(capsule_id, created_document_id);";

const CREATE_DOCUMENT_BLOBS_V23 = CREATE_DOCUMENT_BLOBS.replace(
  "CREATE TABLE document_blobs",
  "CREATE TABLE document_blobs_v23",
);

const COPY_DOCUMENT_BLOBS_TO_V23 = `
INSERT INTO document_blobs_v23 (
  capsule_id,
  content_hash,
  byte_length,
  media_type,
  storage_kind,
  seal_version,
  blob_bytes,
  created_at,
  created_source_id,
  created_document_id
)
SELECT
  capsule_id,
  content_hash,
  byte_length,
  media_type,
  storage_kind,
  seal_version,
  blob_bytes,
  created_at,
  created_source_id,
  created_document_id
FROM document_blobs;
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
  section_path_hash TEXT,
  character_start INTEGER NOT NULL,
  character_end INTEGER NOT NULL,
  PRIMARY KEY (document_id, section_path_json),
  FOREIGN KEY (capsule_id) REFERENCES capsules(id) ON DELETE CASCADE,
  FOREIGN KEY (capsule_id, document_id) REFERENCES documents(capsule_id, id) ON DELETE CASCADE
) STRICT;
`.trim();

const CREATE_SECTIONS_V1 = `
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

// Fresh-install DDL for parsed_units, carrying the full current column set including the
// v25 additive `anchor_id`. Applied via KNOWLEDGE_CAPSULE_DDL. `CREATE_PARSED_UNITS_V1`
// below is the frozen v1 shape (no `anchor_id`) used by the v1 migration; the v25 migration
// then `ALTER TABLE ... ADD COLUMN anchor_id` so a migrated store converges to this shape.
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
  anchor_id TEXT,
  unsupported_reason TEXT,
  character_start INTEGER,
  character_end INTEGER,
  FOREIGN KEY (capsule_id) REFERENCES capsules(id) ON DELETE CASCADE,
  FOREIGN KEY (capsule_id, document_id) REFERENCES documents(capsule_id, id) ON DELETE CASCADE,
  UNIQUE (capsule_id, id)
) STRICT;
`.trim();

// Frozen v1 shape of parsed_units (no `anchor_id`). The v1 migration must reproduce the
// original on-disk shape exactly; the v25 migration is the delta that adds `anchor_id`, so an
// existing v1 store upgrades to the same shape a fresh install gets from CREATE_PARSED_UNITS.
const CREATE_PARSED_UNITS_V1 = `
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
  character_start INTEGER,
  character_end INTEGER,
  contextual_retrieval_key TEXT,
  context_prefix TEXT,
  augmented_text TEXT,
  context_status TEXT,
  context_updated_at INTEGER,
  FOREIGN KEY (capsule_id) REFERENCES capsules(id) ON DELETE CASCADE,
  FOREIGN KEY (capsule_id, source_id) REFERENCES capsule_sources(capsule_id, id) ON DELETE CASCADE,
  FOREIGN KEY (capsule_id, document_id) REFERENCES documents(capsule_id, id) ON DELETE CASCADE,
  FOREIGN KEY (capsule_id, parsed_unit_id) REFERENCES parsed_units(capsule_id, id) ON DELETE CASCADE,
  UNIQUE (capsule_id, id)
) STRICT;
`.trim();

// `context_prefix` and `augmented_text` are reconstructive retrieval-index content and are sealed
// by the Local Knowledge runtime when content encryption is enabled. Character offsets and
// safe_excerpt_hash continue to point at the original source slice used for citations/previews.

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

// chunk_lexical_index + chunk_lexical_fts — index-time lexical retrieval for hybrid RAG.
//
// The normal table keeps lineage columns and FK cascades; the FTS5 table is an external-content
// projection synchronized by triggers below. `text`/`exact_text` are intentionally plaintext even
// when the store encrypts document_texts/vectors: SQLite FTS5 cannot index sealed randomized
// envelopes. This is the narrow plaintext exception for retrieval indexing; it stores only bounded
// chunk text already used as retrievable evidence, and lifecycle cascades remove it with the chunk.
const CREATE_CHUNK_LEXICAL_INDEX = `
CREATE TABLE chunk_lexical_index (
  capsule_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  text TEXT NOT NULL,
  exact_text TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (capsule_id, chunk_id),
  FOREIGN KEY (capsule_id) REFERENCES capsules(id) ON DELETE CASCADE,
  FOREIGN KEY (capsule_id, source_id) REFERENCES capsule_sources(capsule_id, id) ON DELETE CASCADE,
  FOREIGN KEY (capsule_id, document_id) REFERENCES documents(capsule_id, id) ON DELETE CASCADE,
  FOREIGN KEY (capsule_id, chunk_id) REFERENCES chunks(capsule_id, id) ON DELETE CASCADE
) STRICT;
`.trim();

const CREATE_CHUNK_LEXICAL_FTS = `
CREATE VIRTUAL TABLE chunk_lexical_fts USING fts5(
  text,
  exact_text,
  content='chunk_lexical_index',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 0'
);
`.trim();

const CREATE_CHUNK_LEXICAL_INDEX_AI = `
CREATE TRIGGER chunk_lexical_index_ai AFTER INSERT ON chunk_lexical_index BEGIN
  INSERT INTO chunk_lexical_fts(rowid, text, exact_text)
  VALUES (new.rowid, new.text, new.exact_text);
END;
`.trim();

const CREATE_CHUNK_LEXICAL_INDEX_AD = `
CREATE TRIGGER chunk_lexical_index_ad AFTER DELETE ON chunk_lexical_index BEGIN
  INSERT INTO chunk_lexical_fts(chunk_lexical_fts, rowid, text, exact_text)
  VALUES ('delete', old.rowid, old.text, old.exact_text);
END;
`.trim();

const CREATE_CHUNK_LEXICAL_INDEX_AU = `
CREATE TRIGGER chunk_lexical_index_au AFTER UPDATE ON chunk_lexical_index BEGIN
  INSERT INTO chunk_lexical_fts(chunk_lexical_fts, rowid, text, exact_text)
  VALUES ('delete', old.rowid, old.text, old.exact_text);
  INSERT INTO chunk_lexical_fts(rowid, text, exact_text)
  VALUES (new.rowid, new.text, new.exact_text);
END;
`.trim();

const CREATE_CHUNK_LEXICAL_CAPSULE_SOURCE_INDEX =
  "CREATE INDEX idx_chunk_lexical_capsule_source ON chunk_lexical_index(capsule_id, source_id);";

const CREATE_CHUNK_LEXICAL_CAPSULE_DOCUMENT_INDEX =
  "CREATE INDEX idx_chunk_lexical_capsule_document ON chunk_lexical_index(capsule_id, document_id);";

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
  embedding_normalization TEXT,
  embedding_instruction_version TEXT,
  embedding_space_fingerprint TEXT,
  embedding_dimensions_param INTEGER,
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

// vector_index_state records runtime vector-index materialization for optional local
// sqlite-vec search. The actual sqlite-vec table is TEMP/runtime-local so encrypted stores do not
// gain a second plaintext vector copy, but this durable state lets reindex/delete flows invalidate
// an index and lets diagnostics explain whether the active dense path is indexed or fallback.
const CREATE_VECTOR_INDEX_STATE = `
CREATE TABLE vector_index_state (
  capsule_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  index_name TEXT NOT NULL,
  vector_dimensions INTEGER NOT NULL,
  vector_metric TEXT NOT NULL,
  embedding_identity_key TEXT NOT NULL,
  vector_count INTEGER NOT NULL DEFAULT 0,
  vector_max_created_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('dirty', 'ready', 'unavailable')),
  reason TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (
    capsule_id,
    provider,
    index_name,
    vector_dimensions,
    vector_metric,
    embedding_identity_key
  ),
  FOREIGN KEY (capsule_id) REFERENCES capsules(id) ON DELETE CASCADE
) STRICT;
`.trim();

const CREATE_VECTOR_INDEX_STATE_STATUS_INDEX =
  "CREATE INDEX idx_vector_index_state_capsule_status ON vector_index_state(capsule_id, status);";

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
      'source-rebound',
      'indexing-job-started',
      'indexing-job-completed',
      'indexing-job-failed',
      'retention-applied',
      'retrieval-performed',
      'answer-context-assembled',
      'model-context-sent',
      'citation-preview-authorized',
      'citation-preview-recoverable',
      'citation-preview-blocked',
      'citation-preview-document-accessed'
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

const CREATE_CAPSULE_AUDIT_EVENTS_V14 = `
CREATE TABLE capsule_audit_events_v14 (
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
      'model-context-sent',
      'citation-preview-authorized',
      'citation-preview-recoverable',
      'citation-preview-blocked'
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

const COPY_CAPSULE_AUDIT_EVENTS_TO_V14 = `
INSERT INTO capsule_audit_events_v14 (
  id, capsule_id, kind, source_id, job_id, error_code, processed_documents, failed_documents,
  deleted_vector_count, deleted_extracted_text_count, details_json, occurred_at
)
SELECT id, capsule_id, kind, source_id, job_id, error_code, processed_documents, failed_documents,
  deleted_vector_count, deleted_extracted_text_count, details_json, occurred_at
FROM capsule_audit_events;
`.trim();

const CREATE_CAPSULE_AUDIT_EVENTS_V15 = CREATE_CAPSULE_AUDIT_EVENTS.replace(
  "      'source-rebound',\n",
  "",
).replace("capsule_audit_events", "capsule_audit_events_v15");

const COPY_CAPSULE_AUDIT_EVENTS_TO_V15 = `
INSERT INTO capsule_audit_events_v15 (
  id, capsule_id, kind, source_id, job_id, error_code, processed_documents, failed_documents,
  deleted_vector_count, deleted_extracted_text_count, details_json, occurred_at
)
SELECT id, capsule_id, kind, source_id, job_id, error_code, processed_documents, failed_documents,
  deleted_vector_count, deleted_extracted_text_count, details_json, occurred_at
FROM capsule_audit_events;
`.trim();

const CREATE_CAPSULE_AUDIT_EVENTS_V19 = CREATE_CAPSULE_AUDIT_EVENTS.replace(
  "capsule_audit_events",
  "capsule_audit_events_v19",
);

const COPY_CAPSULE_AUDIT_EVENTS_TO_V19 = `
INSERT INTO capsule_audit_events_v19 (
  id, capsule_id, kind, source_id, job_id, error_code, processed_documents, failed_documents,
  deleted_vector_count, deleted_extracted_text_count, details_json, occurred_at
)
SELECT id, capsule_id, kind, source_id, job_id, error_code, processed_documents, failed_documents,
  deleted_vector_count, deleted_extracted_text_count, details_json, occurred_at
FROM capsule_audit_events;
`.trim();

// extraction_checkpoints — durable per-document progress for the bounded large-document
// ingestion path (Epic #1160, Issue #1286). One row per (capsule_id, document_id); the row is
// REPLACEd as a document advances through extraction → chunking → embedding so an interrupted
// large-document job can resume from durable progress instead of restarting. The compatibility
// fingerprint columns (source_content_hash, parser_version, policy_fingerprint,
// chunking_strategy_version, embedding_identity_json) let a resumed run refuse a checkpoint that
// was produced under an incompatible source, parser, policy, chunking strategy, or embedding
// identity. The table is content-free: it carries hashes, cursors, counts, and redacted
// diagnostics, never raw extracted text. capsule_id cascades on capsule deletion; document_id is
// a lineage column rather than an FK so a checkpoint can be written before the document row is
// persisted during progressive extraction.
const CREATE_EXTRACTION_CHECKPOINTS = `
CREATE TABLE extraction_checkpoints (
  capsule_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  strategy TEXT NOT NULL,
  phase TEXT NOT NULL,
  page_cursor INTEGER NOT NULL DEFAULT 0,
  section_cursor INTEGER NOT NULL DEFAULT 0,
  object_cursor INTEGER NOT NULL DEFAULT 0,
  extracted_text_bytes INTEGER NOT NULL DEFAULT 0,
  chunk_cursor INTEGER NOT NULL DEFAULT 0,
  embedded_chunk_cursor INTEGER NOT NULL DEFAULT 0,
  last_embedded_chunk_id TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  coverage TEXT NOT NULL,
  source_content_hash TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  policy_fingerprint TEXT NOT NULL,
  chunking_strategy_version TEXT NOT NULL,
  embedding_identity_json TEXT NOT NULL,
  terminal_diagnostics_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (capsule_id, document_id),
  FOREIGN KEY (capsule_id) REFERENCES capsules(id) ON DELETE CASCADE
) STRICT;
`.trim();

const CREATE_EXTRACTION_CHECKPOINTS_PHASE_INDEX =
  "CREATE INDEX idx_extraction_checkpoints_capsule_phase ON extraction_checkpoints(capsule_id, phase);";

const CREATE_EXTRACTION_CHECKPOINTS_JOB_INDEX =
  "CREATE INDEX idx_extraction_checkpoints_job ON extraction_checkpoints(capsule_id, job_id);";

// document_text_windows — bounded per-window extracted text for the progressive large-document
// ingestion path (Epic #1160, Issue #1286). Small files keep a single document_texts row; a
// progressively-extracted document instead persists its normalized text as one bounded row per
// extraction window so the JS working set never holds the whole document text and the on-disk text
// is stored exactly once (linear storage). Every chunk lies inside one page → inside one window, so
// a chunk's document-relative span maps to exactly one window row; the unified text-span reader
// resolves it via the (character_start, character_end) bounds. capsule_id cascades on capsule
// deletion; document_id is a lineage column (no FK) so windows can be written before the document
// row is finalized during progressive extraction.
const CREATE_DOCUMENT_TEXT_WINDOWS = `
CREATE TABLE document_text_windows (
  capsule_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  window_index INTEGER NOT NULL,
  character_start INTEGER NOT NULL,
  character_end INTEGER NOT NULL,
  normalized_text TEXT NOT NULL,
  PRIMARY KEY (capsule_id, document_id, window_index),
  FOREIGN KEY (capsule_id) REFERENCES capsules(id) ON DELETE CASCADE
) STRICT;
`.trim();

const CREATE_DOCUMENT_TEXT_WINDOWS_SPAN_INDEX =
  "CREATE INDEX idx_document_text_windows_span ON document_text_windows(capsule_id, document_id, character_start);";
const CREATE_PAGES_CAPSULE_DOC_SPAN_INDEX =
  "CREATE INDEX idx_pages_capsule_doc_span ON pages(capsule_id, document_id, character_start, character_end, page_number, page_label);";
const CREATE_HTML_MANUAL_SOURCES_FINGERPRINT_INDEX =
  "CREATE INDEX idx_html_manual_sources_fingerprint ON html_manual_sources(source_fingerprint);";

const CREATE_SECTIONS_SECTION_PATH_HASH_INDEX =
  "CREATE UNIQUE INDEX idx_sections_document_section_path_hash ON sections(document_id, section_path_hash) WHERE section_path_hash IS NOT NULL;";

// Statements must be applied in this exact order: PRAGMA first (so child-table NOT NULL
// foreign-key constraints are enforced as the rows arrive), then parents before children.
export const KNOWLEDGE_CAPSULE_DDL: readonly string[] = [
  PRAGMA_FOREIGN_KEYS,
  CREATE_CAPSULES,
  CREATE_KNOWLEDGE_SOURCES,
  CREATE_CAPSULE_SOURCES,
  CREATE_HTML_MANUAL_SOURCES,
  CREATE_CAPSULE_SET_MEMBERS,
  CREATE_DOCUMENTS,
  CREATE_DOCUMENT_BLOBS,
  CREATE_DOCUMENT_TEXTS,
  CREATE_PAGES,
  CREATE_SECTIONS,
  CREATE_PARSED_UNITS,
  CREATE_CHUNKS,
  CREATE_CHUNK_LEXICAL_INDEX,
  CREATE_CHUNK_LEXICAL_FTS,
  CREATE_CHUNK_LEXICAL_INDEX_AI,
  CREATE_CHUNK_LEXICAL_INDEX_AD,
  CREATE_CHUNK_LEXICAL_INDEX_AU,
  CREATE_VECTORS,
  CREATE_VECTOR_INDEX_STATE,
  CREATE_PARSER_DIAGNOSTICS,
  CREATE_INDEXING_JOBS,
  CREATE_SCHEMA_META,
  CREATE_CAPSULE_MEMBERSHIP_CHANGES,
  CREATE_CAPSULE_AUDIT_EVENTS,
  CREATE_EXTRACTION_CHECKPOINTS,
  CREATE_DOCUMENT_TEXT_WINDOWS,
] as const;

// ─── Indexes (scoped-query patterns only — no full-table scans) ──────────────────
export const KNOWLEDGE_CAPSULE_INDEXES: readonly string[] = [
  "CREATE INDEX idx_knowledge_sources_updated ON knowledge_sources(updated_at DESC, id ASC);",
  CREATE_HTML_MANUAL_SOURCES_FINGERPRINT_INDEX,
  "CREATE INDEX idx_capsule_set_members_capsule ON capsule_set_members(capsule_id);",
  "CREATE INDEX idx_document_texts_capsule ON document_texts(capsule_id);",
  "CREATE INDEX idx_pages_capsule ON pages(capsule_id);",
  CREATE_PAGES_CAPSULE_DOC_SPAN_INDEX,
  "CREATE INDEX idx_sections_capsule ON sections(capsule_id);",
  CREATE_SECTIONS_SECTION_PATH_HASH_INDEX,
  "CREATE INDEX idx_documents_capsule_source ON documents(capsule_id, source_id, status);",
  "CREATE INDEX idx_documents_capsule_status ON documents(capsule_id, status);",
  "CREATE INDEX idx_documents_content_hash ON documents(capsule_id, content_hash);",
  "CREATE INDEX idx_documents_capsule_last_extracted ON documents(capsule_id, last_extracted_at);",
  "CREATE INDEX idx_chunks_capsule_document_order ON chunks(capsule_id, document_id, order_index);",
  CREATE_CHUNK_LEXICAL_CAPSULE_SOURCE_INDEX,
  CREATE_CHUNK_LEXICAL_CAPSULE_DOCUMENT_INDEX,
  "CREATE INDEX idx_vectors_capsule ON vectors(capsule_id);",
  "CREATE INDEX idx_vectors_capsule_source ON vectors(capsule_id, source_id);",
  "CREATE INDEX idx_vectors_capsule_document ON vectors(capsule_id, document_id);",
  "CREATE INDEX idx_vectors_capsule_created ON vectors(capsule_id, created_at);",
  "CREATE INDEX idx_vectors_capsule_identity ON vectors(capsule_id, embedding_model_provider, embedding_model_id, vector_dimensions);",
  CREATE_VECTOR_INDEX_STATE_STATUS_INDEX,
  "CREATE INDEX idx_parsed_units_capsule_document ON parsed_units(capsule_id, document_id);",
  "CREATE INDEX idx_parser_diagnostics_capsule_doc ON parser_diagnostics(capsule_id, document_id);",
  "CREATE INDEX idx_parser_diagnostics_capsule_created ON parser_diagnostics(capsule_id, created_at DESC, id DESC);",
  "CREATE INDEX idx_indexing_jobs_capsule_status ON indexing_jobs(capsule_id, status);",
  "CREATE INDEX idx_indexing_jobs_capsule_started ON indexing_jobs(capsule_id, started_at DESC, id DESC);",
  CREATE_CAPSULE_MEMBERSHIP_CHANGES_INDEX,
  CREATE_CAPSULE_AUDIT_EVENTS_INDEX,
  CREATE_EXTRACTION_CHECKPOINTS_PHASE_INDEX,
  CREATE_EXTRACTION_CHECKPOINTS_JOB_INDEX,
  CREATE_DOCUMENT_TEXT_WINDOWS_SPAN_INDEX,
  CREATE_DOCUMENT_BLOBS_DOCUMENT_INDEX,
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
const CREATE_CAPSULES_PRE_V24 = CREATE_CAPSULES.replace("  model_use_policy_json TEXT,\n", "");

const CREATE_CAPSULES_V18 = CREATE_CAPSULES_PRE_V24.replace(
  [
    "  contextual_retrieval_enabled INTEGER,",
    "  contextual_retrieval_model_id TEXT,",
    "  contextual_retrieval_prompt_version TEXT,",
    "  contextual_retrieval_strict INTEGER,",
    "  contextual_retrieval_max_context_chars INTEGER,",
    "  contextual_retrieval_document_context_max_chars INTEGER,",
  ].join("\n"),
  "",
);

const CREATE_CAPSULES_V17 = CREATE_CAPSULES_V18.replace(
  [
    "  embedding_normalization TEXT,",
    "  embedding_instruction_version TEXT,",
    "  embedding_space_fingerprint TEXT,",
    "  embedding_dimensions_param INTEGER,",
    "",
  ].join("\n"),
  "",
);

const CREATE_VECTORS_V17 = CREATE_VECTORS.replace(
  [
    "  embedding_normalization TEXT,",
    "  embedding_instruction_version TEXT,",
    "  embedding_space_fingerprint TEXT,",
    "  embedding_dimensions_param INTEGER,",
    "",
  ].join("\n"),
  "",
);

const V1_DDL_WITHOUT_V2: readonly string[] = [
  PRAGMA_FOREIGN_KEYS,
  CREATE_CAPSULES_V17,
  CREATE_CAPSULE_SOURCES_V1,
  CREATE_CAPSULE_SET_MEMBERS,
  CREATE_DOCUMENTS_V14,
  CREATE_PAGES,
  CREATE_SECTIONS_V1,
  CREATE_PARSED_UNITS_V1,
  CREATE_CHUNKS_V1,
  CREATE_VECTORS_V17,
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

const V9_PERFORMANCE_INDEXES: readonly string[] = [
  "CREATE INDEX idx_documents_capsule_status ON documents(capsule_id, status);",
  "CREATE INDEX idx_documents_capsule_last_extracted ON documents(capsule_id, last_extracted_at);",
  "CREATE INDEX idx_vectors_capsule_source ON vectors(capsule_id, source_id);",
  "CREATE INDEX idx_vectors_capsule_document ON vectors(capsule_id, document_id);",
  "CREATE INDEX idx_vectors_capsule_created ON vectors(capsule_id, created_at);",
  "CREATE INDEX idx_parsed_units_capsule_document ON parsed_units(capsule_id, document_id);",
  "CREATE INDEX idx_parser_diagnostics_capsule_created ON parser_diagnostics(capsule_id, created_at DESC, id DESC);",
  "CREATE INDEX idx_indexing_jobs_capsule_started ON indexing_jobs(capsule_id, started_at DESC, id DESC);",
] as const;

const V10_SOURCE_AND_DELETE_INDEXES: readonly string[] = [
  CREATE_KNOWLEDGE_SOURCES,
  `
INSERT INTO knowledge_sources (
  id, display_name, description, tags_json, scope_kind, scope_json, created_at, updated_at
)
SELECT id, display_name, description, tags_json, scope_kind, scope_json, MIN(created_at), MAX(updated_at)
FROM capsule_sources
GROUP BY id;
`.trim(),
  "CREATE INDEX idx_knowledge_sources_updated ON knowledge_sources(updated_at DESC, id ASC);",
  "CREATE INDEX idx_capsule_set_members_capsule ON capsule_set_members(capsule_id);",
  "CREATE INDEX idx_document_texts_capsule ON document_texts(capsule_id);",
  "CREATE INDEX idx_pages_capsule ON pages(capsule_id);",
  "CREATE INDEX idx_sections_capsule ON sections(capsule_id);",
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
  {
    version: 8,
    reason:
      "Persist per-chunk character offsets so each chunk embeds its own bounded sub-span " +
      "instead of re-deriving the full parsed-unit span at index time (Epic #189, Issue #195). " +
      "Columns are nullable; chunks indexed before this migration fall back to the parsed-unit " +
      "span until the capsule is reindexed.",
    up: [
      "ALTER TABLE chunks ADD COLUMN character_start INTEGER;",
      "ALTER TABLE chunks ADD COLUMN character_end INTEGER;",
    ],
  },
  {
    version: 9,
    reason:
      "Add large-capsule scoped indexes for retrieval filters, health counts, bounded history reads, and retention cleanup (Issue #265 audit).",
    up: V9_PERFORMANCE_INDEXES,
  },
  {
    version: 10,
    reason:
      "Persist KnowledgeSources independently from capsule membership and index capsule-delete verification paths (Issue #193 audit).",
    up: V10_SOURCE_AND_DELETE_INDEXES,
  },
  {
    version: 11,
    reason:
      "Persist durable per-document extraction checkpoints for bounded large-document ingestion " +
      "so interrupted large-document jobs resume from progress instead of restarting (Epic #1160, Issue #1286).",
    up: [
      CREATE_EXTRACTION_CHECKPOINTS,
      CREATE_EXTRACTION_CHECKPOINTS_PHASE_INDEX,
      CREATE_EXTRACTION_CHECKPOINTS_JOB_INDEX,
    ],
  },
  {
    version: 12,
    reason:
      "Persist bounded per-window extracted text so progressive large-document extraction never " +
      "holds the whole document text in memory and stores it once with linear growth (Epic #1160, Issue #1286).",
    up: [CREATE_DOCUMENT_TEXT_WINDOWS, CREATE_DOCUMENT_TEXT_WINDOWS_SPAN_INDEX],
  },
  {
    version: 13,
    reason:
      "Persist a deterministic, non-reversible section path hash so encrypted randomized section " +
      "labels retain duplicate-section uniqueness without storing labels in plaintext (Issue #1322 audit).",
    up: [
      "ALTER TABLE sections ADD COLUMN section_path_hash TEXT;",
      CREATE_SECTIONS_SECTION_PATH_HASH_INDEX,
    ],
  },
  {
    version: 14,
    reason:
      "Persist metadata-only PDF citation preview audit events for authorization, recoverable, " +
      "and blocked outcomes (Issue #1632).",
    up: [
      CREATE_CAPSULE_AUDIT_EVENTS_V14,
      COPY_CAPSULE_AUDIT_EVENTS_TO_V14,
      "DROP TABLE capsule_audit_events;",
      "ALTER TABLE capsule_audit_events_v14 RENAME TO capsule_audit_events;",
      CREATE_CAPSULE_AUDIT_EVENTS_INDEX,
    ],
  },
  {
    version: 15,
    reason:
      "Persist content-addressed PDF preview blobs and metadata-only byte-delivery audit events.",
    up: [
      "ALTER TABLE documents ADD COLUMN blob_ref TEXT;",
      CREATE_DOCUMENT_BLOBS,
      CREATE_DOCUMENT_BLOBS_DOCUMENT_INDEX,
      CREATE_CAPSULE_AUDIT_EVENTS_V15,
      COPY_CAPSULE_AUDIT_EVENTS_TO_V15,
      "DROP TABLE capsule_audit_events;",
      "ALTER TABLE capsule_audit_events_v15 RENAME TO capsule_audit_events;",
      CREATE_CAPSULE_AUDIT_EVENTS_INDEX,
    ],
  },
  {
    version: 16,
    reason:
      "Persist SQLite FTS5/BM25 chunk lexical index for true dense+lexical hybrid retrieval with RRF fusion.",
    up: [
      CREATE_CHUNK_LEXICAL_INDEX,
      CREATE_CHUNK_LEXICAL_FTS,
      CREATE_CHUNK_LEXICAL_INDEX_AI,
      CREATE_CHUNK_LEXICAL_INDEX_AD,
      CREATE_CHUNK_LEXICAL_INDEX_AU,
      CREATE_CHUNK_LEXICAL_CAPSULE_SOURCE_INDEX,
      CREATE_CHUNK_LEXICAL_CAPSULE_DOCUMENT_INDEX,
    ],
  },
  {
    version: 17,
    reason:
      "Persist encrypted contextual-retrieval chunk prefixes and augmented/indexed text while preserving original citation offsets.",
    up: [
      "ALTER TABLE chunks ADD COLUMN contextual_retrieval_key TEXT;",
      "ALTER TABLE chunks ADD COLUMN context_prefix TEXT;",
      "ALTER TABLE chunks ADD COLUMN augmented_text TEXT;",
      "ALTER TABLE chunks ADD COLUMN context_status TEXT;",
      "ALTER TABLE chunks ADD COLUMN context_updated_at INTEGER;",
    ],
  },
  {
    version: 18,
    reason:
      "Persist hardened embedding identity fields for normalization, instruction version, dimensions parameter, and embedding-space fingerprint.",
    up: [
      "ALTER TABLE capsules ADD COLUMN embedding_normalization TEXT;",
      "ALTER TABLE capsules ADD COLUMN embedding_instruction_version TEXT;",
      "ALTER TABLE capsules ADD COLUMN embedding_space_fingerprint TEXT;",
      "ALTER TABLE capsules ADD COLUMN embedding_dimensions_param INTEGER;",
      "ALTER TABLE vectors ADD COLUMN embedding_normalization TEXT;",
      "ALTER TABLE vectors ADD COLUMN embedding_instruction_version TEXT;",
      "ALTER TABLE vectors ADD COLUMN embedding_space_fingerprint TEXT;",
      "ALTER TABLE vectors ADD COLUMN embedding_dimensions_param INTEGER;",
    ],
  },
  {
    version: 19,
    reason: "Persist metadata-only source rebind audit events for local-knowledge root repair.",
    up: [
      CREATE_CAPSULE_AUDIT_EVENTS_V19,
      COPY_CAPSULE_AUDIT_EVENTS_TO_V19,
      "DROP TABLE capsule_audit_events;",
      "ALTER TABLE capsule_audit_events_v19 RENAME TO capsule_audit_events;",
      CREATE_CAPSULE_AUDIT_EVENTS_INDEX,
    ],
  },
  {
    version: 20,
    reason:
      "Persist per-capsule contextual retrieval settings so index-time context generation is controlled by capsule configuration.",
    up: [
      "ALTER TABLE capsules ADD COLUMN contextual_retrieval_enabled INTEGER;",
      "ALTER TABLE capsules ADD COLUMN contextual_retrieval_model_id TEXT;",
      "ALTER TABLE capsules ADD COLUMN contextual_retrieval_prompt_version TEXT;",
      "ALTER TABLE capsules ADD COLUMN contextual_retrieval_strict INTEGER;",
      "ALTER TABLE capsules ADD COLUMN contextual_retrieval_max_context_chars INTEGER;",
      "ALTER TABLE capsules ADD COLUMN contextual_retrieval_document_context_max_chars INTEGER;",
    ],
  },
  {
    version: 21,
    reason:
      "Persist optional runtime vector-index state so sqlite-vec dense search can be invalidated by reindex/delete flows and diagnosed independently from the vectors table.",
    up: [CREATE_VECTOR_INDEX_STATE, CREATE_VECTOR_INDEX_STATE_STATUS_INDEX],
  },
  {
    version: 22,
    reason: "Add a covering page-span index for citation page hops during scoped vector retrieval.",
    up: [CREATE_PAGES_CAPSULE_DOC_SPAN_INDEX],
  },
  {
    version: 23,
    reason:
      "Make content-addressed PDF preview blobs capsule-owned so deleting the first source/document does not destroy bytes still referenced by duplicate documents.",
    up: [
      CREATE_DOCUMENT_BLOBS_V23,
      COPY_DOCUMENT_BLOBS_TO_V23,
      "DROP TABLE document_blobs;",
      "ALTER TABLE document_blobs_v23 RENAME TO document_blobs;",
      CREATE_DOCUMENT_BLOBS_DOCUMENT_INDEX,
    ],
  },
  {
    version: 24,
    reason: "Persist additive Knowledge Pod model-use policy JSON for sealed local pod behavior.",
    up: ["ALTER TABLE capsules ADD COLUMN model_use_policy_json TEXT;"],
  },
  {
    version: 25,
    reason:
      "Persist additive html-block anchor_id (in-document fragment id) for high-quality technical HTML manual retrieval and anchor-precise citations (#1855).",
    up: ["ALTER TABLE parsed_units ADD COLUMN anchor_id TEXT;"],
  },
  {
    version: 26,
    reason:
      "Persist approved HTML manual source metadata for governed citation reopen without exposing raw roots on browser wires (#1854).",
    up: [CREATE_HTML_MANUAL_SOURCES, CREATE_HTML_MANUAL_SOURCES_FINGERPRINT_INDEX],
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
  "knowledge_sources",
  "html_manual_sources",
  "document_texts",
  "capsule_membership_changes",
  "capsule_audit_events",
  "extraction_checkpoints",
  "document_text_windows",
  "document_blobs",
  "vector_index_state",
  "chunk_lexical_index",
  "chunk_lexical_fts",
] as const;

export const KNOWLEDGE_CAPSULE_INDEX_NAMES: readonly string[] = [
  "idx_knowledge_sources_updated",
  "idx_html_manual_sources_fingerprint",
  "idx_capsule_set_members_capsule",
  "idx_document_texts_capsule",
  "idx_pages_capsule",
  "idx_pages_capsule_doc_span",
  "idx_sections_capsule",
  "idx_sections_document_section_path_hash",
  "idx_documents_capsule_source",
  "idx_documents_capsule_status",
  "idx_documents_content_hash",
  "idx_documents_capsule_last_extracted",
  "idx_chunks_capsule_document_order",
  "idx_chunk_lexical_capsule_source",
  "idx_chunk_lexical_capsule_document",
  "idx_vectors_capsule",
  "idx_vectors_capsule_source",
  "idx_vectors_capsule_document",
  "idx_vectors_capsule_created",
  "idx_vectors_capsule_identity",
  "idx_vector_index_state_capsule_status",
  "idx_parsed_units_capsule_document",
  "idx_parser_diagnostics_capsule_doc",
  "idx_parser_diagnostics_capsule_created",
  "idx_indexing_jobs_capsule_status",
  "idx_indexing_jobs_capsule_started",
  "idx_capsule_membership_changes_capsule_time",
  "idx_capsule_audit_events_capsule_time",
  "idx_extraction_checkpoints_capsule_phase",
  "idx_extraction_checkpoints_job",
  "idx_document_text_windows_span",
  "idx_document_blobs_created_document",
] as const;
