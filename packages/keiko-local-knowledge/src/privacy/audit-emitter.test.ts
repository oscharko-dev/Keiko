// Tests for emitCapsuleAuditEvent + createSqliteAuditSink. The sqlite sink persists every
// metadata-only event into capsule_audit_events and mirrors source membership changes into
// capsule_membership_changes for the narrower composition history view.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { KnowledgeCapsuleId, KnowledgeSourceId } from "@oscharko-dev/keiko-contracts";

import { createCapsule } from "../capsule-lifecycle.js";
import { addSourceToCapsule } from "../source-lifecycle.js";
import { freshStore, sampleCapsuleInput, sampleSourceInput } from "../_support.js";
import type { KnowledgeStore } from "../store.js";

import { createSqliteAuditSink, emitCapsuleAuditEvent } from "./audit-emitter.js";
import type {
  AuditEventSink,
  CapsuleAuditEvent,
  CapsuleSourceAddedEvent,
  CapsuleSourceRemovedEvent,
} from "./types.js";

interface MembershipRow {
  readonly id: string;
  readonly capsule_id: string;
  readonly change_kind: string;
  readonly source_id: string | null;
  readonly occurred_at: number;
}

interface AuditRow {
  readonly kind: string;
  readonly source_id: string | null;
  readonly job_id: string | null;
  readonly error_code: string | null;
  readonly processed_documents: number | null;
  readonly failed_documents: number | null;
  readonly deleted_vector_count: number | null;
  readonly deleted_extracted_text_count: number | null;
  readonly details_json: string | null;
  readonly occurred_at: number;
}

function listMembershipChanges(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
): readonly MembershipRow[] {
  return store._internal.db
    .prepare(
      "SELECT id, capsule_id, change_kind, source_id, occurred_at FROM capsule_membership_changes WHERE capsule_id = :c ORDER BY occurred_at ASC, id ASC",
    )
    .all({ c: capsuleId }) as unknown as readonly MembershipRow[];
}

function listAuditEvents(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
): readonly AuditRow[] {
  return store._internal.db
    .prepare(
      "SELECT kind, source_id, job_id, error_code, processed_documents, failed_documents, deleted_vector_count, deleted_extracted_text_count, details_json, occurred_at FROM capsule_audit_events WHERE capsule_id = :c ORDER BY occurred_at ASC, kind ASC",
    )
    .all({ c: capsuleId }) as unknown as readonly AuditRow[];
}

describe("emitCapsuleAuditEvent + sqlite sink", () => {
  let env: { readonly store: KnowledgeStore; readonly cleanup: () => void };
  let capsuleId: KnowledgeCapsuleId;
  let sourceId: KnowledgeSourceId;

  beforeEach(() => {
    env = freshStore();
    capsuleId = "cap-audit" as KnowledgeCapsuleId;
    createCapsule(env.store, sampleCapsuleInput({ id: capsuleId }));
    const src = sampleSourceInput("src-audit");
    addSourceToCapsule(env.store, capsuleId, src);
    sourceId = src.id;
  });

  afterEach(() => {
    env.cleanup();
  });

  it("writes an add-source row for a source-added event", () => {
    const sink = createSqliteAuditSink(env.store);
    const event: CapsuleSourceAddedEvent = {
      kind: "source-added",
      capsuleId,
      sourceId,
      occurredAt: 1_700_000_000,
    };

    emitCapsuleAuditEvent(event, sink);

    const rows = listMembershipChanges(env.store, capsuleId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.change_kind).toBe("add-source");
    expect(rows[0]?.source_id).toBe(sourceId);
    expect(rows[0]?.occurred_at).toBe(1_700_000_000);
    expect(listAuditEvents(env.store, capsuleId)[0]).toMatchObject({
      kind: "source-added",
      source_id: sourceId,
      occurred_at: 1_700_000_000,
    });
  });

  it("writes a remove-source row for a source-removed event", () => {
    const sink = createSqliteAuditSink(env.store);
    const event: CapsuleSourceRemovedEvent = {
      kind: "source-removed",
      capsuleId,
      sourceId,
      occurredAt: 1_700_000_001,
    };

    emitCapsuleAuditEvent(event, sink);

    const rows = listMembershipChanges(env.store, capsuleId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.change_kind).toBe("remove-source");
    expect(rows[0]?.source_id).toBe(sourceId);
    expect(listAuditEvents(env.store, capsuleId)[0]).toMatchObject({
      kind: "source-removed",
      source_id: sourceId,
    });
  });

  it("persists every non-membership event to the audit table without creating membership rows", () => {
    const sink = createSqliteAuditSink(env.store);
    const events: readonly CapsuleAuditEvent[] = [
      { kind: "capsule-created", capsuleId, occurredAt: 1 },
      { kind: "capsule-deleted", capsuleId, occurredAt: 2 },
      { kind: "indexing-job-started", capsuleId, jobId: "job-1", occurredAt: 3 },
      {
        kind: "indexing-job-completed",
        capsuleId,
        jobId: "job-1",
        processedDocuments: 5,
        failedDocuments: 0,
        occurredAt: 4,
      },
      {
        kind: "indexing-job-failed",
        capsuleId,
        jobId: "job-1",
        errorCode: "embedding-failed",
        occurredAt: 5,
      },
      {
        kind: "retention-applied",
        capsuleId,
        deletedVectorCount: 1,
        deletedExtractedTextCount: 0,
        occurredAt: 6,
      },
    ];

    for (const event of events) emitCapsuleAuditEvent(event, sink);

    expect(listMembershipChanges(env.store, capsuleId)).toHaveLength(0);
    expect(listAuditEvents(env.store, capsuleId)).toHaveLength(events.length);
    expect(listAuditEvents(env.store, capsuleId)).toEqual([
      {
        kind: "capsule-created",
        source_id: null,
        job_id: null,
        error_code: null,
        processed_documents: null,
        failed_documents: null,
        deleted_vector_count: null,
        deleted_extracted_text_count: null,
        details_json: null,
        occurred_at: 1,
      },
      {
        kind: "capsule-deleted",
        source_id: null,
        job_id: null,
        error_code: null,
        processed_documents: null,
        failed_documents: null,
        deleted_vector_count: null,
        deleted_extracted_text_count: null,
        details_json: null,
        occurred_at: 2,
      },
      {
        kind: "indexing-job-started",
        source_id: null,
        job_id: "job-1",
        error_code: null,
        processed_documents: null,
        failed_documents: null,
        deleted_vector_count: null,
        deleted_extracted_text_count: null,
        details_json: null,
        occurred_at: 3,
      },
      {
        kind: "indexing-job-completed",
        source_id: null,
        job_id: "job-1",
        error_code: null,
        processed_documents: 5,
        failed_documents: 0,
        deleted_vector_count: null,
        deleted_extracted_text_count: null,
        details_json: null,
        occurred_at: 4,
      },
      {
        kind: "indexing-job-failed",
        source_id: null,
        job_id: "job-1",
        error_code: "embedding-failed",
        processed_documents: null,
        failed_documents: null,
        deleted_vector_count: null,
        deleted_extracted_text_count: null,
        details_json: null,
        occurred_at: 5,
      },
      {
        kind: "retention-applied",
        source_id: null,
        job_id: null,
        error_code: null,
        processed_documents: null,
        failed_documents: null,
        deleted_vector_count: 1,
        deleted_extracted_text_count: 0,
        details_json: null,
        occurred_at: 6,
      },
    ]);
  });

  it("persists metadata-only details for retrieval and model-context audit events", () => {
    const sink = createSqliteAuditSink(env.store);
    emitCapsuleAuditEvent(
      {
        kind: "retrieval-performed",
        capsuleId,
        sourceIds: [sourceId],
        chunkIds: ["chunk-1"],
        referenceCount: 1,
        noEvidence: false,
        occurredAt: 7,
      },
      sink,
    );
    emitCapsuleAuditEvent(
      {
        kind: "model-context-sent",
        capsuleId,
        sourceIds: [sourceId],
        chunkIds: ["chunk-1"],
        referenceCount: 1,
        citationCount: 1,
        modelId: "gpt-5.4",
        occurredAt: 8,
      },
      sink,
    );

    expect(listMembershipChanges(env.store, capsuleId)).toHaveLength(0);
    expect(listAuditEvents(env.store, capsuleId)).toEqual([
      {
        kind: "retrieval-performed",
        source_id: null,
        job_id: null,
        error_code: null,
        processed_documents: null,
        failed_documents: null,
        deleted_vector_count: null,
        deleted_extracted_text_count: null,
        details_json:
          '{"sourceIds":["src-audit"],"chunkIds":["chunk-1"],"referenceCount":1,"noEvidence":false}',
        occurred_at: 7,
      },
      {
        kind: "model-context-sent",
        source_id: null,
        job_id: null,
        error_code: null,
        processed_documents: null,
        failed_documents: null,
        deleted_vector_count: null,
        deleted_extracted_text_count: null,
        details_json:
          '{"sourceIds":["src-audit"],"chunkIds":["chunk-1"],"referenceCount":1,"citationCount":1,"modelId":"gpt-5.4"}',
        occurred_at: 8,
      },
    ]);
  });

  it("forwards every event to a caller-supplied sink unchanged", () => {
    // Sibling-sink contract: emitCapsuleAuditEvent calls sink.emit once per event, with
    // the same object reference the caller passed in. This is what lets a future audit
    // table or external ledger be wired in without changing the emitter.
    const received: CapsuleAuditEvent[] = [];
    const captureSink: AuditEventSink = { emit: (event) => received.push(event) };
    const event: CapsuleSourceAddedEvent = {
      kind: "source-added",
      capsuleId,
      sourceId,
      occurredAt: 42,
    };

    emitCapsuleAuditEvent(event, captureSink);

    expect(received).toEqual([event]);
  });
});
