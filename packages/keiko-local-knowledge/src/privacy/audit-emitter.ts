// emitCapsuleAuditEvent — pure forwarder onto an `AuditEventSink`. The shape lets a caller
// compose the default node-sqlite sink (writes the schema-compatible event kinds to
// `capsule_membership_changes`) with any number of additional sinks (external evidence
// ledger, in-memory test capture, future sibling-table writer) by constructing their own
// `AuditEventSink` and chaining the calls.
//
// The default sink writes every metadata-only event to `capsule_audit_events` and also
// mirrors the source membership variants into the narrower `capsule_membership_changes`
// table that #263 already introduced for composition history.

import { createHash, randomUUID } from "node:crypto";

import type { KnowledgeStore } from "../store.js";

import type {
  AuditEventSink,
  CapsuleAuditEvent,
  CapsuleSourceAddedEvent,
  CapsuleSourceRemovedEvent,
} from "./types.js";

const INSERT_MEMBERSHIP_SQL =
  "INSERT INTO capsule_membership_changes (id, capsule_id, change_kind, source_id, details_json, occurred_at) VALUES (:id, :capsule_id, :change_kind, :source_id, :details_json, :occurred_at)";
const INSERT_AUDIT_SQL =
  "INSERT INTO capsule_audit_events (id, capsule_id, kind, source_id, job_id, error_code, processed_documents, failed_documents, deleted_vector_count, deleted_extracted_text_count, details_json, occurred_at) VALUES (:id, :capsule_id, :kind, :source_id, :job_id, :error_code, :processed_documents, :failed_documents, :deleted_vector_count, :deleted_extracted_text_count, :details_json, :occurred_at)";

type SqlValue = string | number | null;
type SqlParams = Record<string, SqlValue>;

interface RunStatement {
  readonly run: (params?: SqlParams) => unknown;
}

export function emitCapsuleAuditEvent(event: CapsuleAuditEvent, sink: AuditEventSink): void {
  sink.emit(event);
}

export function createSqliteAuditSink(store: KnowledgeStore): AuditEventSink {
  const insertAudit = store._internal.db.prepare(INSERT_AUDIT_SQL) as RunStatement;
  const insertMembership = store._internal.db.prepare(INSERT_MEMBERSHIP_SQL) as RunStatement;
  return {
    emit: (event: CapsuleAuditEvent): void => {
      insertAuditEventRow(insertAudit, event);
      if (event.kind === "source-added") {
        insertMembershipRow(insertMembership, event, "add-source");
        return;
      }
      if (event.kind === "source-removed") {
        insertMembershipRow(insertMembership, event, "remove-source");
        return;
      }
    },
  };
}

function insertAuditEventRow(statement: RunStatement, event: CapsuleAuditEvent): void {
  statement.run({
    id: randomUUID(),
    capsule_id: event.capsuleId,
    kind: event.kind,
    source_id: "sourceId" in event ? event.sourceId : null,
    job_id: "jobId" in event ? event.jobId : null,
    error_code: "errorCode" in event ? event.errorCode : null,
    processed_documents: "processedDocuments" in event ? event.processedDocuments : null,
    failed_documents: "failedDocuments" in event ? event.failedDocuments : null,
    deleted_vector_count: "deletedVectorCount" in event ? event.deletedVectorCount : null,
    deleted_extracted_text_count:
      "deletedExtractedTextCount" in event ? event.deletedExtractedTextCount : null,
    details_json: buildAuditDetailsJson(event),
    occurred_at: event.occurredAt,
  });
}

function redactChunkIds(chunkIds: readonly string[]): readonly string[] {
  return chunkIds.map((chunkId) =>
    createHash("sha256").update(chunkId).digest("hex").slice(0, 16),
  );
}

function buildAuditDetails(event: CapsuleAuditEvent): Record<string, unknown> | null {
  if (
    event.kind === "indexing-job-started" ||
    event.kind === "indexing-job-completed" ||
    event.kind === "indexing-job-failed" ||
    event.kind === "retention-applied"
  ) {
    return {
      sourceIds: [...event.sourceIds],
    };
  }
  if (event.kind === "retrieval-performed") {
    return {
      sourceIds: [...event.sourceIds],
      chunkIds: redactChunkIds(event.chunkIds),
      referenceCount: event.referenceCount,
      noEvidence: event.noEvidence,
    };
  }
  if (event.kind === "answer-context-assembled" || event.kind === "model-context-sent") {
    return {
      sourceIds: [...event.sourceIds],
      chunkIds: redactChunkIds(event.chunkIds),
      referenceCount: event.referenceCount,
      citationCount: event.citationCount,
      ...("modelId" in event ? { modelId: event.modelId } : {}),
    };
  }
  return null;
}

function buildAuditDetailsJson(event: CapsuleAuditEvent): string | null {
  const details = buildAuditDetails(event);
  return details === null ? null : JSON.stringify(details);
}

function insertMembershipRow(
  statement: RunStatement,
  event: CapsuleSourceAddedEvent | CapsuleSourceRemovedEvent,
  changeKind: "add-source" | "remove-source",
): void {
  statement.run({
    id: randomUUID(),
    capsule_id: event.capsuleId,
    change_kind: changeKind,
    source_id: event.sourceId,
    details_json: null,
    occurred_at: event.occurredAt,
  });
}
