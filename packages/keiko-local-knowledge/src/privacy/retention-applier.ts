// applyRetentionToCapsule — bounded DELETE that prunes a capsule's vectors / extracted
// text rows older than the policy window. Pure SQL — no side effects beyond these scoped
// statements. The `WHERE capsule_id = :capsule_id` clauses are load-bearing: the cascade
// isolation test in `./retention-applier.test.ts` removes the function's ability to delete
// cross-capsule rows by relying on those clauses to scope each statement.
//
// Schema notes (cf. packages/keiko-contracts/src/local-knowledge-schema.ts):
//   * `vectors.created_at` is the embedding-write timestamp — the right column for the
//     "vector retention" window.
//   * `document_texts` contains raw normalized text and is the row count reported as
//     deletedExtractedTextCount. `parsed_units` has no time column of its own; its cleanup
//     is keyed off `documents.last_extracted_at` via the same subquery. The chunks/vectors
//     that hang off the deleted parsed_units cascade via composite FK (chunks →
//     parsed_units, vectors → chunks).
//   * Both statements are issued inside a single BEGIN/COMMIT so a crash mid-retention
//     cannot leave half the policy applied (matches the source/composition lifecycles).
//   * A missing field on the policy SKIPS the corresponding statement — `undefined` means
//     "retain indefinitely", per the types.ts contract.

import type { KnowledgeCapsuleId, KnowledgeSourceId } from "@oscharko-dev/keiko-contracts";

import { KnowledgeStoreError } from "../errors.js";
import type { KnowledgeStore } from "../store.js";

import type { AuditEventSink, CapsuleRetentionPolicy, RetentionApplyResult } from "./types.js";

const DAY_MS = 86_400_000;

const DELETE_OLD_VECTORS_SQL =
  "DELETE FROM vectors WHERE capsule_id = :capsule_id AND created_at < :cutoff";

const DELETE_OLD_PARSED_UNITS_SQL =
  "DELETE FROM parsed_units WHERE capsule_id = :capsule_id AND document_id IN " +
  "(SELECT id FROM documents WHERE capsule_id = :capsule_id AND last_extracted_at < :cutoff)";

const DELETE_OLD_DOCUMENT_TEXTS_SQL =
  "DELETE FROM document_texts WHERE capsule_id = :capsule_id AND document_id IN " +
  "(SELECT id FROM documents WHERE capsule_id = :capsule_id AND last_extracted_at < :cutoff)";

interface ChangesRow {
  readonly changes: number;
}

interface SourceIdRow {
  readonly id: string;
}

function cutoffFor(now: number, days: number): number {
  return now - days * DAY_MS;
}

function parseRetentionDays(field: keyof CapsuleRetentionPolicy, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new KnowledgeStoreError(`${field} must be a finite non-negative number when set`);
  }
  return value;
}

function runDelete(
  store: KnowledgeStore,
  sql: string,
  capsuleId: KnowledgeCapsuleId,
  cutoff: number,
): number {
  const stmt = store._internal.db.prepare(sql);
  stmt.run({ capsule_id: capsuleId, cutoff });
  // Read the change count via `SELECT changes()` so the helper is independent of the
  // node:sqlite result-shape; the function is connection-scoped and returns the row
  // count touched by the most recent INSERT/UPDATE/DELETE on that connection.
  const row = store._internal.db.prepare("SELECT changes() AS changes").get() as
    | ChangesRow
    | undefined;
  return row?.changes ?? 0;
}

function sourceIdsForCapsule(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
): readonly KnowledgeSourceId[] {
  const rows = store._internal.db
    .prepare("SELECT id FROM capsule_sources WHERE capsule_id = :capsule_id ORDER BY id ASC")
    .all({ capsule_id: capsuleId }) as unknown as readonly SourceIdRow[];
  return rows.map((row) => row.id as KnowledgeSourceId);
}

export function applyRetentionToCapsule(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  policy: CapsuleRetentionPolicy,
  now: number,
  auditSink?: AuditEventSink,
): RetentionApplyResult {
  const retainVectorsDays = parseRetentionDays("retainVectorsDays", policy.retainVectorsDays);
  const retainExtractedTextDays = parseRetentionDays(
    "retainExtractedTextDays",
    policy.retainExtractedTextDays,
  );
  if (retainVectorsDays === undefined && retainExtractedTextDays === undefined) {
    return { capsuleId, deletedVectorCount: 0, deletedExtractedTextCount: 0, appliedAt: now };
  }

  const db = store._internal.db;
  let deletedVectorCount = 0;
  let deletedExtractedTextCount = 0;
  db.exec("BEGIN");
  try {
    if (retainVectorsDays !== undefined) {
      const vectorCutoff = cutoffFor(now, retainVectorsDays);
      deletedVectorCount = runDelete(store, DELETE_OLD_VECTORS_SQL, capsuleId, vectorCutoff);
    }
    if (retainExtractedTextDays !== undefined) {
      const textCutoff = cutoffFor(now, retainExtractedTextDays);
      deletedExtractedTextCount = runDelete(
        store,
        DELETE_OLD_DOCUMENT_TEXTS_SQL,
        capsuleId,
        textCutoff,
      );
      runDelete(store, DELETE_OLD_PARSED_UNITS_SQL, capsuleId, textCutoff);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const result = { capsuleId, deletedVectorCount, deletedExtractedTextCount, appliedAt: now };
  auditSink?.emit({
    kind: "retention-applied",
    capsuleId,
    sourceIds: sourceIdsForCapsule(store, capsuleId),
    deletedVectorCount,
    deletedExtractedTextCount,
    occurredAt: now,
  });
  return result;
}
