// Prepared-statement helpers for the `extraction_checkpoints` table (Epic #1160, Issue #1286).
//
// One row per (capsule_id, document_id). The progressive large-document path upserts the row as a
// document advances through extraction → chunking → embedding so an interrupted job resumes from
// durable progress. The row is content-free: hashes, cursors, counts, and redacted diagnostics —
// never raw extracted text. The compatibility fingerprint columns let a resumed run refuse a
// checkpoint produced under an incompatible source, parser, policy, chunking strategy, or
// embedding identity.

import type {
  CoverageQuality,
  EmbeddingModelIdentity,
  ExtractionCheckpointRecord,
  ExtractionPhase,
  KnowledgeCapsuleId,
  LargeDocumentExtractionStrategy,
  ParserDiagnostic,
} from "@oscharko-dev/keiko-contracts";
import type { ChunkId, DocumentId } from "@oscharko-dev/keiko-contracts";
import type { DatabaseSync } from "node:sqlite";

const UPSERT_SQL = [
  "INSERT INTO extraction_checkpoints (",
  "  capsule_id, document_id, job_id, strategy, phase, page_cursor, section_cursor,",
  "  object_cursor, extracted_text_bytes, chunk_cursor, embedded_chunk_cursor,",
  "  last_embedded_chunk_id, retry_count, coverage, source_content_hash, parser_version,",
  "  policy_fingerprint, chunking_strategy_version, embedding_identity_json,",
  "  terminal_diagnostics_json, created_at, updated_at",
  ") VALUES (",
  "  :capsule_id, :document_id, :job_id, :strategy, :phase, :page_cursor, :section_cursor,",
  "  :object_cursor, :extracted_text_bytes, :chunk_cursor, :embedded_chunk_cursor,",
  "  :last_embedded_chunk_id, :retry_count, :coverage, :source_content_hash, :parser_version,",
  "  :policy_fingerprint, :chunking_strategy_version, :embedding_identity_json,",
  "  :terminal_diagnostics_json, :created_at, :updated_at",
  ") ON CONFLICT(capsule_id, document_id) DO UPDATE SET",
  "  job_id = excluded.job_id,",
  "  strategy = excluded.strategy,",
  "  phase = excluded.phase,",
  "  page_cursor = excluded.page_cursor,",
  "  section_cursor = excluded.section_cursor,",
  "  object_cursor = excluded.object_cursor,",
  "  extracted_text_bytes = excluded.extracted_text_bytes,",
  "  chunk_cursor = excluded.chunk_cursor,",
  "  embedded_chunk_cursor = excluded.embedded_chunk_cursor,",
  "  last_embedded_chunk_id = excluded.last_embedded_chunk_id,",
  "  retry_count = excluded.retry_count,",
  "  coverage = excluded.coverage,",
  "  source_content_hash = excluded.source_content_hash,",
  "  parser_version = excluded.parser_version,",
  "  policy_fingerprint = excluded.policy_fingerprint,",
  "  chunking_strategy_version = excluded.chunking_strategy_version,",
  "  embedding_identity_json = excluded.embedding_identity_json,",
  "  terminal_diagnostics_json = excluded.terminal_diagnostics_json,",
  "  updated_at = excluded.updated_at",
].join(" ");

const SELECT_ONE_SQL = [
  "SELECT * FROM extraction_checkpoints",
  "WHERE capsule_id = :c AND document_id = :d",
].join(" ");

const SELECT_BY_CAPSULE_SQL = [
  "SELECT * FROM extraction_checkpoints",
  "WHERE capsule_id = :c",
  "ORDER BY updated_at DESC, document_id ASC",
].join(" ");

const DELETE_ONE_SQL =
  "DELETE FROM extraction_checkpoints WHERE capsule_id = :c AND document_id = :d";

interface CheckpointRow {
  readonly capsule_id: string;
  readonly document_id: string;
  readonly job_id: string;
  readonly strategy: string;
  readonly phase: string;
  readonly page_cursor: number;
  readonly section_cursor: number;
  readonly object_cursor: number;
  readonly extracted_text_bytes: number;
  readonly chunk_cursor: number;
  readonly embedded_chunk_cursor: number;
  readonly last_embedded_chunk_id: string | null;
  readonly retry_count: number;
  readonly coverage: string;
  readonly source_content_hash: string;
  readonly parser_version: string;
  readonly policy_fingerprint: string;
  readonly chunking_strategy_version: string;
  readonly embedding_identity_json: string;
  readonly terminal_diagnostics_json: string;
  readonly created_at: number;
  readonly updated_at: number;
}

function diagnosticsToJson(diagnostics: readonly ParserDiagnostic[]): string {
  return JSON.stringify(diagnostics);
}

export function upsertExtractionCheckpoint(
  db: DatabaseSync,
  checkpoint: ExtractionCheckpointRecord,
): void {
  db.prepare(UPSERT_SQL).run({
    capsule_id: String(checkpoint.capsuleId),
    document_id: String(checkpoint.documentId),
    job_id: checkpoint.jobId,
    strategy: checkpoint.strategy,
    phase: checkpoint.phase,
    page_cursor: checkpoint.pageCursor,
    section_cursor: checkpoint.sectionCursor,
    object_cursor: checkpoint.objectCursor,
    extracted_text_bytes: checkpoint.extractedTextBytes,
    chunk_cursor: checkpoint.chunkCursor,
    embedded_chunk_cursor: checkpoint.embeddedChunkCursor,
    last_embedded_chunk_id:
      checkpoint.lastEmbeddedChunkId === undefined ? null : String(checkpoint.lastEmbeddedChunkId),
    retry_count: checkpoint.retryCount,
    coverage: checkpoint.coverage,
    source_content_hash: checkpoint.fingerprint.sourceContentHash,
    parser_version: checkpoint.fingerprint.parserVersion,
    policy_fingerprint: checkpoint.fingerprint.policyFingerprint,
    chunking_strategy_version: checkpoint.fingerprint.chunkingStrategyVersion,
    embedding_identity_json: JSON.stringify(checkpoint.fingerprint.embeddingIdentity),
    terminal_diagnostics_json: diagnosticsToJson(checkpoint.terminalDiagnostics),
    created_at: checkpoint.createdAt,
    updated_at: checkpoint.updatedAt,
  });
}

function parseDiagnostics(json: string): readonly ParserDiagnostic[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as readonly ParserDiagnostic[]) : [];
  } catch {
    return [];
  }
}

function parseEmbeddingIdentity(json: string): EmbeddingModelIdentity {
  const parsed: unknown = JSON.parse(json);
  return parsed as EmbeddingModelIdentity;
}

function rowToCheckpoint(row: CheckpointRow): ExtractionCheckpointRecord {
  return {
    capsuleId: row.capsule_id as KnowledgeCapsuleId,
    documentId: row.document_id as DocumentId,
    jobId: row.job_id,
    strategy: row.strategy as LargeDocumentExtractionStrategy,
    phase: row.phase as ExtractionPhase,
    pageCursor: row.page_cursor,
    sectionCursor: row.section_cursor,
    objectCursor: row.object_cursor,
    extractedTextBytes: row.extracted_text_bytes,
    chunkCursor: row.chunk_cursor,
    embeddedChunkCursor: row.embedded_chunk_cursor,
    ...(row.last_embedded_chunk_id === null
      ? {}
      : { lastEmbeddedChunkId: row.last_embedded_chunk_id as ChunkId }),
    retryCount: row.retry_count,
    coverage: row.coverage as CoverageQuality,
    fingerprint: {
      sourceContentHash: row.source_content_hash,
      parserVersion: row.parser_version,
      policyFingerprint: row.policy_fingerprint,
      chunkingStrategyVersion: row.chunking_strategy_version,
      embeddingIdentity: parseEmbeddingIdentity(row.embedding_identity_json),
    },
    terminalDiagnostics: parseDiagnostics(row.terminal_diagnostics_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function selectExtractionCheckpoint(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
): ExtractionCheckpointRecord | undefined {
  const row = db.prepare(SELECT_ONE_SQL).get({ c: String(capsuleId), d: String(documentId) });
  return row === undefined ? undefined : rowToCheckpoint(row as unknown as CheckpointRow);
}

export function listExtractionCheckpoints(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
): readonly ExtractionCheckpointRecord[] {
  const rows = db.prepare(SELECT_BY_CAPSULE_SQL).all({ c: String(capsuleId) });
  return rows.map((row) => rowToCheckpoint(row as unknown as CheckpointRow));
}

export function deleteExtractionCheckpoint(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
): void {
  db.prepare(DELETE_ONE_SQL).run({ c: String(capsuleId), d: String(documentId) });
}
