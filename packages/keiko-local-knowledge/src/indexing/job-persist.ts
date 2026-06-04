// Prepared-statement helpers for the `indexing_jobs` table (Epic #189, Issue #196). The
// orchestrator writes one row per run and updates it through the lifecycle:
//
//   started → progress (per document) → succeeded | failed | cancelled
//
// The schema reserves `cancellation_requested` (INTEGER 0/1) for a future external-cancel
// surface; this layer writes it but does not poll it (the orchestrator drives cancellation
// purely via AbortSignal).
//
// `resume_token` is set to the lexicographically-greatest `chunk_id` embedded so far so a
// subsequent resume can continue past it. The orchestrator's incremental skip still scopes
// to documents — the token is purely diagnostic for now and is consumed by #198 UI later.

import type {
  IndexingJobError,
  IndexingJobRecord,
  IndexingJobStatus,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import type { DatabaseSync } from "node:sqlite";

const INSERT_JOB_SQL = [
  "INSERT INTO indexing_jobs (",
  "  id, capsule_id, source_ids_json, started_at, finished_at, status,",
  "  total_documents, processed_documents, failed_documents, skipped_documents,",
  "  last_error_code, last_error_message, resume_token, cancellation_requested",
  ") VALUES (",
  "  :id, :capsule_id, :source_ids_json, :started_at, NULL, :status,",
  "  0, 0, 0, 0, NULL, NULL, NULL, 0",
  ")",
].join(" ");

const UPDATE_COUNTERS_SQL = [
  "UPDATE indexing_jobs SET",
  "  total_documents = :total,",
  "  processed_documents = :processed,",
  "  failed_documents = :failed,",
  "  skipped_documents = :skipped,",
  "  resume_token = :resume",
  "WHERE id = :id",
].join(" ");

const FINALIZE_JOB_SQL = [
  "UPDATE indexing_jobs SET",
  "  status = :status,",
  "  finished_at = :finished_at,",
  "  total_documents = :total,",
  "  processed_documents = :processed,",
  "  failed_documents = :failed,",
  "  skipped_documents = :skipped,",
  "  last_error_code = :error_code,",
  "  last_error_message = :error_message,",
  "  resume_token = :resume",
  "WHERE id = :id",
].join(" ");

const SELECT_RUNNING_BY_CAPSULE_SQL = [
  "SELECT id, capsule_id, source_ids_json, started_at, finished_at, status,",
  "  total_documents, processed_documents, failed_documents, skipped_documents,",
  "  last_error_code, last_error_message, resume_token",
  "FROM indexing_jobs",
  "WHERE capsule_id = :c AND status = 'running'",
  // started_at DESC so the most recent abandoned run wins. Ties broken by id ASC for
  // deterministic resume behaviour across clocks that issue duplicate ms timestamps.
  "ORDER BY started_at DESC, id ASC",
  "LIMIT 1",
].join(" ");

const SELECT_BY_ID_SQL = [
  "SELECT id, capsule_id, source_ids_json, started_at, finished_at, status,",
  "  total_documents, processed_documents, failed_documents, skipped_documents,",
  "  last_error_code, last_error_message, resume_token",
  "FROM indexing_jobs",
  "WHERE id = :id",
].join(" ");

export interface IndexingJobRow {
  readonly id: string;
  readonly capsule_id: string;
  readonly source_ids_json: string;
  readonly started_at: number;
  readonly finished_at: number | null;
  readonly status: string;
  readonly total_documents: number;
  readonly processed_documents: number;
  readonly failed_documents: number;
  readonly skipped_documents: number;
  readonly last_error_code: string | null;
  readonly last_error_message: string | null;
  readonly resume_token: string | null;
}

export interface InsertJobInput {
  readonly id: string;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceIds: readonly KnowledgeSourceId[];
  readonly startedAt: number;
}

export function insertJobRow(db: DatabaseSync, input: InsertJobInput): void {
  db.prepare(INSERT_JOB_SQL).run({
    id: input.id,
    capsule_id: String(input.capsuleId),
    source_ids_json: JSON.stringify(input.sourceIds.map((s) => String(s))),
    started_at: input.startedAt,
    status: "running" satisfies IndexingJobStatus,
  });
}

export interface JobCounters {
  readonly total: number;
  readonly processed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly resumeToken: string | null;
}

export function updateJobCounters(db: DatabaseSync, id: string, counters: JobCounters): void {
  db.prepare(UPDATE_COUNTERS_SQL).run({
    id,
    total: counters.total,
    processed: counters.processed,
    failed: counters.failed,
    skipped: counters.skipped,
    resume: counters.resumeToken,
  });
}

export interface FinalizeJobInput {
  readonly id: string;
  readonly status: IndexingJobStatus;
  readonly finishedAt: number;
  readonly counters: JobCounters;
  readonly lastError?: IndexingJobError;
}

export function finalizeJobRow(db: DatabaseSync, input: FinalizeJobInput): void {
  db.prepare(FINALIZE_JOB_SQL).run({
    id: input.id,
    status: input.status,
    finished_at: input.finishedAt,
    total: input.counters.total,
    processed: input.counters.processed,
    failed: input.counters.failed,
    skipped: input.counters.skipped,
    error_code: input.lastError?.code ?? null,
    error_message: input.lastError?.message ?? null,
    resume: input.counters.resumeToken,
  });
}

export function selectRunningJobByCapsule(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
): IndexingJobRow | undefined {
  const row = db.prepare(SELECT_RUNNING_BY_CAPSULE_SQL).get({ c: String(capsuleId) });
  return row === undefined ? undefined : (row as unknown as IndexingJobRow);
}

export function selectJobById(db: DatabaseSync, id: string): IndexingJobRow | undefined {
  const row = db.prepare(SELECT_BY_ID_SQL).get({ id });
  return row === undefined ? undefined : (row as unknown as IndexingJobRow);
}

// ─── Row → IndexingJobRecord ──────────────────────────────────────────────────
function parseSourceIds(json: string): readonly KnowledgeSourceId[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry as KnowledgeSourceId);
}

const VALID_STATUSES: ReadonlySet<IndexingJobStatus> = new Set<IndexingJobStatus>([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

function parseStatus(raw: string): IndexingJobStatus {
  // The schema does not CHECK status, so a corrupt row could carry an unexpected string.
  // Default to "failed" so consumers do not silently accept a row that violates the closed
  // union — the row remains visible (operators can recover it manually).
  return VALID_STATUSES.has(raw as IndexingJobStatus) ? (raw as IndexingJobStatus) : "failed";
}

function buildLastError(row: IndexingJobRow): IndexingJobError | undefined {
  if (row.last_error_code === null || row.last_error_message === null) return undefined;
  return { code: row.last_error_code, message: row.last_error_message };
}

interface OptionalJobFields {
  readonly finishedAt?: number;
  readonly lastError?: IndexingJobError;
}

function optionalJobFields(row: IndexingJobRow): OptionalJobFields {
  const lastError = buildLastError(row);
  return {
    ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
    ...(lastError !== undefined ? { lastError } : {}),
  };
}

export function rowToIndexingJobRecord(row: IndexingJobRow): IndexingJobRecord {
  return {
    id: row.id,
    capsuleId: row.capsule_id as KnowledgeCapsuleId,
    sourceIds: parseSourceIds(row.source_ids_json),
    startedAt: row.started_at,
    status: parseStatus(row.status),
    totalDocuments: row.total_documents,
    processedDocuments: row.processed_documents,
    failedDocuments: row.failed_documents,
    skippedDocuments: row.skipped_documents,
    ...optionalJobFields(row),
  };
}
