// emitCapsuleAuditEvent — pure forwarder onto an `AuditEventSink`. The shape lets a caller
// compose the default node-sqlite sink (writes the schema-compatible event kinds to
// `capsule_membership_changes`) with any number of additional sinks (external evidence
// ledger, in-memory test capture, future sibling-table writer) by constructing their own
// `AuditEventSink` and chaining the calls.
//
// The default sink ONLY writes for the two event kinds that the v2 schema models in
// `capsule_membership_changes`: `source-added` → `add-source`, `source-removed` →
// `remove-source`. The `compose-set` change_kind is intentionally NOT exposed here — the
// composition lifecycle in composition.ts writes that row itself atomically with the
// CapsuleSet creation, and we must not duplicate. Other event kinds (capsule-created,
// capsule-deleted, indexing-job-*, retention-applied) are accepted by the sink but
// silently ignored because the schema has no column to record them today. When a sibling
// audit table is added in a future migration, this sink learns to write to it without any
// caller-side change.

import { randomUUID } from "node:crypto";

import type { KnowledgeStore } from "../store.js";

import type {
  AuditEventSink,
  CapsuleAuditEvent,
  CapsuleSourceAddedEvent,
  CapsuleSourceRemovedEvent,
} from "./types.js";

const INSERT_MEMBERSHIP_SQL =
  "INSERT INTO capsule_membership_changes (id, capsule_id, change_kind, source_id, details_json, occurred_at) VALUES (:id, :capsule_id, :change_kind, :source_id, :details_json, :occurred_at)";

export function emitCapsuleAuditEvent(event: CapsuleAuditEvent, sink: AuditEventSink): void {
  sink.emit(event);
}

export function createSqliteAuditSink(store: KnowledgeStore): AuditEventSink {
  return {
    emit: (event: CapsuleAuditEvent): void => {
      // Only the two source-* variants map to a `capsule_membership_changes` row in the
      // v2 schema. Every other variant is intentionally a no-op until a sibling audit
      // table lands in a future migration.
      if (event.kind === "source-added") {
        insertMembershipRow(store, event, "add-source");
        return;
      }
      if (event.kind === "source-removed") {
        insertMembershipRow(store, event, "remove-source");
        return;
      }
    },
  };
}

function insertMembershipRow(
  store: KnowledgeStore,
  event: CapsuleSourceAddedEvent | CapsuleSourceRemovedEvent,
  changeKind: "add-source" | "remove-source",
): void {
  store._internal.db.prepare(INSERT_MEMBERSHIP_SQL).run({
    id: randomUUID(),
    capsule_id: event.capsuleId,
    change_kind: changeKind,
    source_id: event.sourceId,
    details_json: null,
    occurred_at: event.occurredAt,
  });
}
