import type { PgClientLike } from "./postgres-types.js";

export interface PgLiveKeyIdsSnapshot {
  readonly abuse: readonly string[];
  readonly dedupe: readonly string[];
}

async function liveIds(
  client: PgClientLike,
  query: string,
  now: Date,
  limit: number,
): Promise<readonly string[]> {
  const result = await client.query<{ readonly key_id: string }>(query, [now, limit]);
  return result.rows.map((row) => row.key_id);
}

export async function readLiveKeyIdsSnapshot(
  client: PgClientLike,
  now: Date,
): Promise<PgLiveKeyIdsSnapshot> {
  const abuse = await liveIds(
    client,
    "SELECT DISTINCT key_id FROM feedback_abuse_buckets WHERE expires_at > $1 ORDER BY key_id LIMIT $2",
    now,
    3,
  );
  const dedupe = await liveIds(
    client,
    "SELECT DISTINCT dedupe_key_id AS key_id FROM feedback_dedupe_entries WHERE expires_at > $1 ORDER BY dedupe_key_id LIMIT $2",
    now,
    4,
  );
  return { abuse, dedupe };
}
