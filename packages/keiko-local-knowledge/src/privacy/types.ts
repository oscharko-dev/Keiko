// Public privacy / retention / audit types for the Local Knowledge Connector (Epic #189,
// Issue #201). Kept type-only so importing this module costs nothing at runtime. The audit
// event union deliberately carries ONLY metadata (ids, counts, error codes) — no
// `excerpt`, `message`, or `text` field that could leak raw extracted content into the
// audit ledger. Diagnostic-shaped strings (parser errors) flow through `redactDiagnosticMessage`
// in `./diagnostic-redactor.ts` BEFORE they reach a `parser_diagnostics` row; they are
// intentionally not part of `CapsuleAuditEvent`.
//
// `CapsuleRetentionPolicy` uses optional `readonly` fields so `undefined` (or the absence
// of the field) means "retain indefinitely". This is enforced by `applyRetentionToCapsule`:
// a missing field skips the corresponding DELETE entirely.

import type { KnowledgeCapsuleId, KnowledgeSourceId } from "@oscharko-dev/keiko-contracts";

export interface CapsuleRetentionPolicy {
  readonly retainExtractedTextDays?: number;
  readonly retainVectorsDays?: number;
}

export interface RetentionApplyResult {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly deletedVectorCount: number;
  readonly deletedExtractedTextCount: number;
  readonly appliedAt: number;
}

// CapsuleAuditEvent — discriminated union for every lifecycle event in scope of #201.
// Each variant carries metadata only. The `indexing-job-*` variants are also metadata-only
// because the job row in `indexing_jobs` already records the document counts and the
// connector layer is responsible for emitting the event with the redacted error code.

export type CapsuleAuditEvent =
  | CapsuleCreatedEvent
  | CapsuleDeletedEvent
  | CapsuleSourceAddedEvent
  | CapsuleSourceRemovedEvent
  | IndexingJobStartedEvent
  | IndexingJobCompletedEvent
  | IndexingJobFailedEvent
  | RetentionAppliedEvent
  | RetrievalPerformedEvent
  | AnswerContextAssembledEvent
  | ModelContextSentEvent;

export interface CapsuleCreatedEvent {
  readonly kind: "capsule-created";
  readonly capsuleId: KnowledgeCapsuleId;
  readonly occurredAt: number;
}

export interface CapsuleDeletedEvent {
  readonly kind: "capsule-deleted";
  readonly capsuleId: KnowledgeCapsuleId;
  readonly occurredAt: number;
}

export interface CapsuleSourceAddedEvent {
  readonly kind: "source-added";
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly occurredAt: number;
}

export interface CapsuleSourceRemovedEvent {
  readonly kind: "source-removed";
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly occurredAt: number;
}

export interface IndexingJobStartedEvent {
  readonly kind: "indexing-job-started";
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceIds: readonly KnowledgeSourceId[];
  readonly jobId: string;
  readonly occurredAt: number;
}

export interface IndexingJobCompletedEvent {
  readonly kind: "indexing-job-completed";
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceIds: readonly KnowledgeSourceId[];
  readonly jobId: string;
  readonly processedDocuments: number;
  readonly failedDocuments: number;
  readonly occurredAt: number;
}

export interface IndexingJobFailedEvent {
  readonly kind: "indexing-job-failed";
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceIds: readonly KnowledgeSourceId[];
  readonly jobId: string;
  readonly errorCode: string;
  readonly occurredAt: number;
}

export interface RetentionAppliedEvent {
  readonly kind: "retention-applied";
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceIds: readonly KnowledgeSourceId[];
  readonly deletedVectorCount: number;
  readonly deletedExtractedTextCount: number;
  readonly occurredAt: number;
}

export interface RetrievalPerformedEvent {
  readonly kind: "retrieval-performed";
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceIds: readonly KnowledgeSourceId[];
  readonly chunkIds: readonly string[];
  readonly referenceCount: number;
  readonly noEvidence: boolean;
  readonly occurredAt: number;
}

export interface AnswerContextAssembledEvent {
  readonly kind: "answer-context-assembled";
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceIds: readonly KnowledgeSourceId[];
  readonly chunkIds: readonly string[];
  readonly referenceCount: number;
  readonly citationCount: number;
  readonly occurredAt: number;
}

export interface ModelContextSentEvent {
  readonly kind: "model-context-sent";
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceIds: readonly KnowledgeSourceId[];
  readonly chunkIds: readonly string[];
  readonly referenceCount: number;
  readonly citationCount: number;
  readonly modelId: string;
  readonly occurredAt: number;
}

// AuditEventSink — injectable port. The default node-sqlite sink in `./audit-emitter.ts`
// persists every metadata-only event to `capsule_audit_events` and mirrors
// source-added/source-removed events into `capsule_membership_changes`. Callers that want
// to forward events to an external evidence ledger compose their own sink.

export interface AuditEventSink {
  readonly emit: (event: CapsuleAuditEvent) => void;
}
