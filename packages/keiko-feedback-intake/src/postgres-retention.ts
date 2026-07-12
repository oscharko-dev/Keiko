import type { PgClientLike } from "./postgres-types.js";

export interface PurgeClass {
  readonly classCode:
    | "receipt"
    | "payload"
    | "dedupe"
    | "abuse"
    | "group"
    | "review-audit"
    | "review-idempotency"
    | "private-review-group"
    | "oidc-transaction"
    | "maintainer-session"
    | "key-destruction-evidence"
    | "publication-preparation"
    | "publication-outbox"
    | "publication-audit"
    | "publication-delivery-audit"
    | "publication-idempotency"
    | "publication-installation-circuit"
    | "github-issue-linkage";
  readonly count: number;
  readonly complete: boolean;
}

export const PUBLICATION_RETENTION_BATCH_SIZE = 100;

interface PurgeQuery {
  readonly classCode: PurgeClass["classCode"];
  readonly query: string;
  readonly batched?: boolean;
  readonly remainingQuery?: string;
}

function boundedDelete(table: string, key: string, predicate = "expires_at <= $1"): string {
  return `WITH candidates AS (SELECT ${key} FROM ${table} WHERE ${predicate} ORDER BY expires_at,${key} FOR UPDATE SKIP LOCKED LIMIT $2),deleted AS (DELETE FROM ${table} target USING candidates WHERE target.${key}=candidates.${key} RETURNING 1) SELECT count(*)::text AS deleted FROM deleted`;
}

function purgeQuery(
  classCode: PurgeClass["classCode"],
  query: string,
  batched = false,
  remainingQuery?: string,
): PurgeQuery {
  return {
    classCode,
    query,
    batched,
    ...(remainingQuery === undefined ? {} : { remainingQuery }),
  };
}

function batchedPurgeQuery(
  classCode: PurgeClass["classCode"],
  table: string,
  key: string,
  predicate = "expires_at <= $1",
): PurgeQuery {
  return purgeQuery(
    classCode,
    boundedDelete(table, key, predicate),
    true,
    `SELECT NOT EXISTS (SELECT 1 FROM ${table} WHERE ${predicate}) AS complete`,
  );
}

const PURGE_QUERIES: readonly PurgeQuery[] = [
  batchedPurgeQuery("publication-outbox", "feedback_publication_outbox", "id"),
  batchedPurgeQuery(
    "publication-preparation",
    "feedback_publication_preparations",
    "id",
    "expires_at <= $1 AND NOT EXISTS (SELECT 1 FROM feedback_review_items item WHERE item.approval_preparation_id=feedback_publication_preparations.id AND item.state='approved')",
  ),
  batchedPurgeQuery("publication-audit", "feedback_publication_audit", "event_id"),
  batchedPurgeQuery(
    "publication-delivery-audit",
    "feedback_publication_delivery_audit",
    "event_id",
  ),
  batchedPurgeQuery(
    "publication-idempotency",
    "feedback_publication_idempotency",
    "idempotency_key",
  ),
  batchedPurgeQuery("github-issue-linkage", "feedback_github_issue_linkage", "item_id"),
  purgeQuery("receipt", "DELETE FROM feedback_receipts WHERE expires_at <= $1"),
  purgeQuery(
    "payload",
    "DELETE FROM feedback_payloads p WHERE p.expires_at <= $1 AND NOT EXISTS (SELECT 1 FROM feedback_receipts r WHERE r.payload_id = p.id) AND NOT EXISTS (SELECT 1 FROM feedback_review_items i JOIN feedback_legal_holds h ON h.item_id = i.id WHERE i.payload_id = p.id AND h.expires_at > $1)",
  ),
  purgeQuery("dedupe", "DELETE FROM feedback_dedupe_entries WHERE expires_at <= $1"),
  purgeQuery(
    "abuse",
    "WITH i AS (DELETE FROM feedback_abuse_buckets WHERE expires_at <= $1 RETURNING 1), g AS (DELETE FROM feedback_global_buckets WHERE expires_at <= $1 RETURNING 1) SELECT (SELECT count(*) FROM i) + (SELECT count(*) FROM g) AS deleted",
  ),
  purgeQuery(
    "group",
    "DELETE FROM feedback_semantic_groups g WHERE NOT EXISTS (SELECT 1 FROM feedback_payloads p WHERE p.semantic_group_id = g.id) AND NOT EXISTS (SELECT 1 FROM feedback_dedupe_entries d WHERE d.semantic_group_id = g.id)",
  ),
  purgeQuery("review-audit", "DELETE FROM feedback_review_audit WHERE expires_at <= $1"),
  purgeQuery(
    "review-idempotency",
    "DELETE FROM feedback_review_idempotency WHERE expires_at <= $1",
  ),
  purgeQuery(
    "private-review-group",
    "DELETE FROM feedback_private_review_group_tombstones WHERE expires_at <= $1",
  ),
  purgeQuery("oidc-transaction", "DELETE FROM feedback_oidc_transactions WHERE expires_at <= $1"),
  purgeQuery(
    "maintainer-session",
    "DELETE FROM feedback_maintainer_sessions WHERE revoked_at IS NOT NULL OR idle_expires_at <= $1 OR absolute_expires_at <= $1",
  ),
  batchedPurgeQuery(
    "publication-installation-circuit",
    "feedback_publication_installation_circuits",
    "installation_id",
  ),
  purgeQuery(
    "key-destruction-evidence",
    "DELETE FROM feedback_key_deletion_evidence WHERE result = 'destroyed' AND event_at <= $1::timestamptz - interval '365 days'",
  ),
];

function purgeValues(item: PurgeQuery, now: Date): readonly unknown[] {
  if (item.batched === true) return [now, PUBLICATION_RETENTION_BATCH_SIZE];
  return item.query.includes("$1") ? [now] : [];
}

async function purgeComplete(client: PgClientLike, item: PurgeQuery, now: Date): Promise<boolean> {
  if (item.batched !== true || item.remainingQuery === undefined) return true;
  const result = await client.query<{ readonly complete: boolean }>(item.remainingQuery, [now]);
  return result.rows[0]?.complete === true;
}

export async function purgeExpiredClasses(
  client: PgClientLike,
  now: Date,
): Promise<readonly PurgeClass[]> {
  const results: PurgeClass[] = [];
  for (const item of PURGE_QUERIES) {
    const result = await client.query<{
      readonly deleted?: string;
    }>(item.query, purgeValues(item, now));
    const count =
      result.rows[0]?.deleted === undefined
        ? (result.rowCount ?? 0)
        : Number(result.rows[0].deleted);
    results.push({
      classCode: item.classCode,
      count,
      complete: await purgeComplete(client, item, now),
    });
  }
  return results;
}

export async function writeDeletionWatermark(
  client: PgClientLike,
  item: PurgeClass,
  cutoff: Date,
): Promise<void> {
  if (!item.complete) return;
  await client.query(
    "INSERT INTO feedback_deletion_ledger (class_code, cutoff, deleted_count, completed_at) VALUES ($1,$2,$3,$2) ON CONFLICT (class_code) DO UPDATE SET cutoff = EXCLUDED.cutoff, deleted_count = EXCLUDED.deleted_count, completed_at = EXCLUDED.completed_at",
    [item.classCode, cutoff, item.count],
  );
}
