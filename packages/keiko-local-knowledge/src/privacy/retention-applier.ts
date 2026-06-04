// applyRetentionToCapsule — bounded DELETE that prunes a capsule's vectors / extracted
// text rows older than the policy window. Pure SQL — no side effects beyond the two
// statements. The two `WHERE capsule_id = :capsule_id` clauses are load-bearing: the
// cascade isolation test in `./retention-applier.test.ts` removes the function's ability
// to delete cross-capsule rows by relying on those clauses to scope each statement.
//
// Schema notes (cf. packages/keiko-contracts/src/local-knowledge-schema.ts):
//   * `vectors.created_at` is the embedding-write timestamp — the right column for the
//     "vector retention" window.
//   * `parsed_units` has no time column of its own; the "extracted text retention" window
//     is keyed off `documents.last_extracted_at` via a subquery. The chunks/vectors that
//     hang off the deleted parsed_units cascade via composite FK (chunks → parsed_units,
//     vectors → chunks).
//   * Both statements are issued inside a single BEGIN/COMMIT so a crash mid-retention
//     cannot leave half the policy applied (matches the source/composition lifecycles).
//   * A missing field on the policy SKIPS the corresponding statement — `undefined` means
//     "retain indefinitely", per the types.ts contract.

import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";

import type { KnowledgeStore } from "../store.js";

import type { AuditEventSink, CapsuleRetentionPolicy, RetentionApplyResult } from "./types.js";

const DAY_MS = 86_400_000;

const DELETE_OLD_VECTORS_SQL =
  "DELETE FROM vectors WHERE capsule_id = :capsule_id AND created_at < :cutoff";

const DELETE_OLD_PARSED_UNITS_SQL =
  "DELETE FROM parsed_units WHERE capsule_id = :capsule_id AND document_id IN " +
  "(SELECT id FROM documents WHERE capsule_id = :capsule_id AND last_extracted_at < :cutoff)";

interface ChangesRow {
  readonly changes: number;
}

function cutoffFor(now: number, days: number | undefined): number {
  // Caller guards on `hasXyzPolicy` (a `policy.field !== undefined` check) before calling
  // this, so `days === undefined` indicates a programmer error rather than a runtime
  // condition. The `?? 0` fallback is defense-in-depth — it returns `now` (zero cutoff,
  // matches everything) without crashing the transaction.
  if (days === undefined) {
    return now;
  }
  return now - days * DAY_MS;
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

export function applyRetentionToCapsule(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  policy: CapsuleRetentionPolicy,
  now: number,
  auditSink?: AuditEventSink,
): RetentionApplyResult {
  const hasVectorPolicy = typeof policy.retainVectorsDays === "number";
  const hasTextPolicy = typeof policy.retainExtractedTextDays === "number";
  if (!hasVectorPolicy && !hasTextPolicy) {
    return {
      capsuleId,
      deletedVectorCount: 0,
      deletedExtractedTextCount: 0,
      appliedAt: now,
    };
  }

  const db = store._internal.db;
  let deletedVectorCount = 0;
  let deletedExtractedTextCount = 0;
  db.exec("BEGIN");
  try {
    if (hasVectorPolicy) {
      const vectorCutoff = cutoffFor(now, policy.retainVectorsDays);
      deletedVectorCount = runDelete(store, DELETE_OLD_VECTORS_SQL, capsuleId, vectorCutoff);
    }
    if (hasTextPolicy) {
      const textCutoff = cutoffFor(now, policy.retainExtractedTextDays);
      deletedExtractedTextCount = runDelete(
        store,
        DELETE_OLD_PARSED_UNITS_SQL,
        capsuleId,
        textCutoff,
      );
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
    deletedVectorCount,
    deletedExtractedTextCount,
    occurredAt: now,
  });
  return result;
}
