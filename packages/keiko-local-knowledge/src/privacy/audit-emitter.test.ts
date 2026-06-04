// Tests for emitCapsuleAuditEvent + createSqliteAuditSink. The sqlite sink maps the two
// schema-compatible event kinds (source-added, source-removed) to capsule_membership_changes
// rows. Other event kinds are accepted but not persisted by the default sink because the
// v2 schema does not yet have a sibling audit table — those are caller-routable through a
// composed sink.

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
  });

  it("does not write a membership row for events without a schema mapping", () => {
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
