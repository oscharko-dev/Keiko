import type { PgClientLike } from "./postgres-types.js";

export interface PurgeClass {
  readonly classCode:
    "receipt" | "payload" | "dedupe" | "abuse" | "group" | "key-destruction-evidence";
  readonly count: number;
}

export async function purgeExpiredClasses(
  client: PgClientLike,
  now: Date,
): Promise<readonly PurgeClass[]> {
  const queries: readonly [PurgeClass["classCode"], string][] = [
    ["receipt", "DELETE FROM feedback_receipts WHERE expires_at <= $1"],
    [
      "payload",
      "DELETE FROM feedback_payloads p WHERE p.expires_at <= $1 AND NOT EXISTS (SELECT 1 FROM feedback_receipts r WHERE r.payload_id = p.id)",
    ],
    ["dedupe", "DELETE FROM feedback_dedupe_entries WHERE expires_at <= $1"],
    [
      "abuse",
      "WITH i AS (DELETE FROM feedback_abuse_buckets WHERE expires_at <= $1 RETURNING 1), g AS (DELETE FROM feedback_global_buckets WHERE expires_at <= $1 RETURNING 1) SELECT (SELECT count(*) FROM i) + (SELECT count(*) FROM g) AS deleted",
    ],
    [
      "group",
      "DELETE FROM feedback_semantic_groups g WHERE NOT EXISTS (SELECT 1 FROM feedback_payloads p WHERE p.semantic_group_id = g.id) AND NOT EXISTS (SELECT 1 FROM feedback_dedupe_entries d WHERE d.semantic_group_id = g.id)",
    ],
    [
      "key-destruction-evidence",
      "DELETE FROM feedback_key_deletion_evidence WHERE result = 'destroyed' AND event_at <= $1 - interval '365 days'",
    ],
  ];
  const results: PurgeClass[] = [];
  for (const [classCode, query] of queries) {
    const result = await client.query<{ readonly deleted?: string }>(query, [now]);
    const count =
      result.rows[0]?.deleted === undefined
        ? (result.rowCount ?? 0)
        : Number(result.rows[0].deleted);
    results.push({ classCode, count });
  }
  return results;
}

export async function writeDeletionWatermark(
  client: PgClientLike,
  item: PurgeClass,
  cutoff: Date,
): Promise<void> {
  await client.query(
    "INSERT INTO feedback_deletion_ledger (class_code, cutoff, deleted_count, completed_at) VALUES ($1,$2,$3,$2) ON CONFLICT (class_code) DO UPDATE SET cutoff = EXCLUDED.cutoff, deleted_count = EXCLUDED.deleted_count, completed_at = EXCLUDED.completed_at",
    [item.classCode, cutoff, item.count],
  );
}
