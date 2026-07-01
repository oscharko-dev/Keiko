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

type SourceOnlyAuditEvent = Extract<
  CapsuleAuditEvent,
  {
    readonly kind:
      | "indexing-job-started"
      | "indexing-job-completed"
      | "indexing-job-failed"
      | "retention-applied";
  }
>;

type PreviewAuditEvent = Extract<
  CapsuleAuditEvent,
  {
    readonly kind:
      "citation-preview-authorized" | "citation-preview-recoverable" | "citation-preview-blocked";
  }
>;

type PreviewDocumentAccessAuditEvent = Extract<
  CapsuleAuditEvent,
  { readonly kind: "citation-preview-document-accessed" }
>;

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
  return chunkIds.map((chunkId) => createHash("sha256").update(chunkId).digest("hex").slice(0, 16));
}

function sourceOnlyDetails(event: {
  readonly sourceIds: readonly string[];
}): Record<string, unknown> {
  return { sourceIds: [...event.sourceIds] };
}

function retrievalDetails(
  event: Extract<CapsuleAuditEvent, { readonly kind: "retrieval-performed" }>,
): Record<string, unknown> {
  return {
    ...sourceOnlyDetails(event),
    chunkIds: redactChunkIds(event.chunkIds),
    referenceCount: event.referenceCount,
    noEvidence: event.noEvidence,
  };
}

function referenceDetails(
  event:
    | Extract<CapsuleAuditEvent, { readonly kind: "answer-context-assembled" }>
    | Extract<CapsuleAuditEvent, { readonly kind: "model-context-sent" }>,
): Record<string, unknown> {
  return {
    ...sourceOnlyDetails(event),
    chunkIds: redactChunkIds(event.chunkIds),
    referenceCount: event.referenceCount,
    citationCount: event.citationCount,
    ...("modelId" in event ? { modelId: event.modelId } : {}),
  };
}

function previewDetails(event: PreviewAuditEvent): Record<string, unknown> {
  return {
    ...sourceOnlyDetails(event),
    chunkIds: redactChunkIds(event.chunkIds),
    targetQuality: event.targetQuality,
    ...("reasonCode" in event ? { reasonCode: event.reasonCode } : {}),
  };
}

function previewDocumentAccessDetails(
  event: PreviewDocumentAccessAuditEvent,
): Record<string, unknown> {
  return {
    documentId: event.documentId,
    sourceKind: event.sourceKind,
    outcome: event.outcome,
    ...("byteStart" in event && "byteEnd" in event
      ? { byteRange: { start: event.byteStart, end: event.byteEnd } }
      : {}),
    ...("byteCount" in event ? { byteCount: event.byteCount } : {}),
    ...("reasonCode" in event ? { reasonCode: event.reasonCode } : {}),
  };
}

function sourceReboundDetails(
  event: Extract<CapsuleAuditEvent, { readonly kind: "source-rebound" }>,
): Record<string, unknown> {
  return {
    previousScopeKind: event.previousScopeKind,
    currentScopeKind: event.currentScopeKind,
  };
}

function isSourceOnlyAuditEvent(event: CapsuleAuditEvent): event is SourceOnlyAuditEvent {
  return (
    event.kind === "indexing-job-started" ||
    event.kind === "indexing-job-completed" ||
    event.kind === "indexing-job-failed" ||
    event.kind === "retention-applied"
  );
}

function isPreviewAuditEvent(event: CapsuleAuditEvent): event is PreviewAuditEvent {
  return (
    event.kind === "citation-preview-authorized" ||
    event.kind === "citation-preview-recoverable" ||
    event.kind === "citation-preview-blocked"
  );
}

function buildAuditDetails(event: CapsuleAuditEvent): Record<string, unknown> | null {
  if (isSourceOnlyAuditEvent(event)) {
    return sourceOnlyDetails(event);
  }
  if (event.kind === "retrieval-performed") {
    return retrievalDetails(event);
  }
  if (event.kind === "answer-context-assembled" || event.kind === "model-context-sent") {
    return referenceDetails(event);
  }
  if (isPreviewAuditEvent(event)) {
    return previewDetails(event);
  }
  if (event.kind === "citation-preview-document-accessed") {
    return previewDocumentAccessDetails(event);
  }
  if (event.kind === "source-rebound") {
    return sourceReboundDetails(event);
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
