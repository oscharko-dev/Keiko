import type { PgClientLike, PgPoolLike } from "./postgres-types.js";
import { acquirePostgresClient, isRetryablePostgresError } from "./postgres-client.js";
import { readLiveKeyIdsSnapshot, type PgLiveKeyIdsSnapshot } from "./postgres-live-key-snapshot.js";
import { purgeExpiredClasses, writeDeletionWatermark } from "./postgres-retention.js";
import type {
  DestroyedKeyDeletionEvidence,
  KeyDeletionEvidence,
  KeyDeletionLedger,
  PendingKeyDeletionEvidence,
} from "./file-secret-provider.js";
export type { PgClientLike, PgPoolLike, PgQueryResult } from "./postgres-types.js";

export interface PgAttemptReservation {
  readonly abuseKeyId: string;
  readonly abuseHmac: Uint8Array;
  readonly abuseCandidates: readonly { readonly keyId: string; readonly hmac: Uint8Array }[];
  readonly at: Date;
  readonly bucketStart: Date;
  readonly expiresAt: Date;
  readonly perIdentityLimit: number;
  readonly globalLimit: number;
  readonly storageDeadlineMs: number;
}

export interface PgAdmission {
  readonly groupId: string;
  readonly payloadId: string;
  readonly receiptId: string;
  readonly dedupeKeyId: string;
  readonly dedupeHmac: Uint8Array;
  readonly dedupeCandidates: readonly { readonly keyId: string; readonly hmac: Uint8Array }[];
  readonly canonicalBytes: Uint8Array;
  readonly exactBodySha256: string;
  readonly receiptSecretHash: Uint8Array;
  readonly createdAt: Date;
  readonly payloadExpiresAt: Date;
  readonly receiptExpiresAt: Date;
  readonly dedupeExpiresAt: Date;
  readonly openPayloadCount: number;
  readonly openPayloadBytes: number;
  readonly storageDeadlineMs: number;
}

export type PgAdmissionResult =
  | { readonly accepted: true; readonly payloadId: string }
  | { readonly accepted: false; readonly reason: "capacity" };

export type PgAttemptResult = { readonly reserved: true } | { readonly reserved: false };

export class PostgresIntakeRepository implements KeyDeletionLedger {
  constructor(
    private readonly pool: PgPoolLike,
    private readonly maxSerializableRetries = 3,
    private readonly defaultDeadlineMs = 5_000,
  ) {}

  async reserveAttempt(input: PgAttemptReservation): Promise<PgAttemptResult> {
    return this.retry(() => this.reserveAttemptTransaction(input));
  }

  async admit(input: PgAdmission): Promise<PgAdmissionResult> {
    return this.retry(() => this.admissionTransaction(input));
  }

  private async retry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < this.maxSerializableRetries; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!isRetryablePostgresError(error) || attempt + 1 === this.maxSerializableRetries)
          throw error;
      }
    }
    throw new Error("Serializable retry bound exhausted");
  }

  private async client(timeoutMs: number): Promise<PgClientLike> {
    return acquirePostgresClient(this.pool, timeoutMs);
  }

  private async begin(client: PgClientLike, timeoutMs: number): Promise<void> {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SELECT set_config('statement_timeout', $1::text, true)", [
      String(timeoutMs),
    ]);
  }

  private async rollback(client: PgClientLike): Promise<void> {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The checked-out client is always released; the pool discards failed transaction state.
    }
  }

  private async reserveAttemptTransaction(input: PgAttemptReservation): Promise<PgAttemptResult> {
    const client = await this.client(input.storageDeadlineMs);
    try {
      await this.begin(client, input.storageDeadlineMs);
      const reserved = await reserveAttemptRows(client, input);
      if (!reserved) {
        await this.rollback(client);
        return { reserved: false };
      }
      await client.query("COMMIT");
      return { reserved: true };
    } catch (error) {
      await this.rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async admissionTransaction(input: PgAdmission): Promise<PgAdmissionResult> {
    const client = await this.client(input.storageDeadlineMs);
    try {
      await this.begin(client, input.storageDeadlineMs);
      await client.query("SELECT pg_advisory_xact_lock($1)", [2_074]);
      if (!(await hasCapacity(client, input))) {
        await this.rollback(client);
        return { accepted: false, reason: "capacity" };
      }
      const groupId = await resolveSemanticGroup(client, input);
      const reusable = await reusablePayload(client, input, groupId);
      const payloadId = reusable?.id ?? (await insertPayload(client, input, groupId));
      await client.query(
        "INSERT INTO feedback_receipts (id, payload_id, secret_hash, created_at, expires_at) VALUES ($1,$2,$3,$4,$5)",
        [
          input.receiptId,
          payloadId,
          input.receiptSecretHash,
          input.createdAt,
          input.receiptExpiresAt,
        ],
      );
      await client.query("COMMIT");
      return { accepted: true, payloadId };
    } catch (error) {
      await this.rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async findReceipt(
    id: string,
  ): Promise<
    | { readonly secretHash: Uint8Array; readonly expiresAt: Date; readonly closed: boolean }
    | undefined
  > {
    const client = await this.client(this.defaultDeadlineMs);
    try {
      await this.begin(client, this.defaultDeadlineMs);
      const result = await client.query<{
        readonly secret_hash: Uint8Array;
        readonly expires_at: Date;
        readonly closed: boolean;
      }>("SELECT secret_hash, expires_at, closed FROM feedback_receipts WHERE id = $1 LIMIT 1", [
        id,
      ]);
      const row = result.rows[0];
      const receipt =
        row === undefined
          ? undefined
          : { secretHash: row.secret_hash, expiresAt: row.expires_at, closed: row.closed };
      await client.query("COMMIT");
      return receipt;
    } catch (error) {
      await this.rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
  async purge(now: Date): Promise<readonly number[]> {
    const client = await this.client(this.defaultDeadlineMs);
    try {
      await this.begin(client, this.defaultDeadlineMs);
      const classes = await purgeExpiredClasses(client, now);
      for (const item of classes) await writeDeletionWatermark(client, item, now);
      await client.query("COMMIT");
      return classes.map((item) => item.count);
    } catch (error) {
      await this.rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
  async keyInUse(kind: "abuse" | "dedupe", keyId: string, now: Date): Promise<boolean> {
    const client = await this.client(this.defaultDeadlineMs);
    try {
      await this.begin(client, this.defaultDeadlineMs);
      const table = kind === "abuse" ? "feedback_abuse_buckets" : "feedback_dedupe_entries";
      const column = kind === "abuse" ? "key_id" : "dedupe_key_id";
      const result = await client.query(
        `SELECT 1 FROM ${table} WHERE ${column} = $1 AND expires_at > $2 LIMIT 1`,
        [keyId, now],
      );
      await client.query("COMMIT");
      return result.rowCount === 1;
    } catch (error) {
      await this.rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
  async liveKeyIdsSnapshot(now: Date): Promise<PgLiveKeyIdsSnapshot> {
    const client = await this.client(this.defaultDeadlineMs);
    try {
      await this.begin(client, this.defaultDeadlineMs);
      const snapshot = await readLiveKeyIdsSnapshot(client, now);
      await client.query("COMMIT");
      return snapshot;
    } catch (error) {
      await this.rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
  async pendingDeletions(
    keyClass: "abuse" | "dedupe",
  ): Promise<readonly PendingKeyDeletionEvidence[]> {
    const client = await this.client(this.defaultDeadlineMs);
    try {
      await this.begin(client, this.defaultDeadlineMs);
      const result = await client.query<{
        readonly key_class: "abuse" | "dedupe";
        readonly key_id: string;
        readonly event_at: Date;
        readonly result: "pending";
      }>(
        "SELECT key_class, key_id, event_at, result FROM feedback_key_deletion_evidence WHERE key_class = $1 AND result = 'pending' ORDER BY event_at, key_id",
        [keyClass],
      );
      await client.query("COMMIT");
      return result.rows.map((row) => ({
        keyClass: row.key_class,
        keyId: row.key_id,
        timestamp: row.event_at,
        result: row.result,
      }));
    } catch (error) {
      await this.rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async beginDeletion(evidence: PendingKeyDeletionEvidence): Promise<void> {
    await this.writeKeyDeletion(
      "WITH changed AS (INSERT INTO feedback_key_deletion_evidence (key_class, key_id, event_at, result) VALUES ($1,$2,$3,$4) ON CONFLICT (key_class, key_id) DO UPDATE SET event_at = feedback_key_deletion_evidence.event_at WHERE feedback_key_deletion_evidence.result = 'pending' RETURNING result) SELECT result FROM changed",
      evidence,
    );
  }

  async completeDeletion(evidence: DestroyedKeyDeletionEvidence): Promise<void> {
    await this.writeKeyDeletion(
      "WITH changed AS (UPDATE feedback_key_deletion_evidence SET event_at = $3, result = $4 WHERE key_class = $1 AND key_id = $2 AND result = 'pending' RETURNING result) SELECT result FROM changed UNION ALL SELECT result FROM feedback_key_deletion_evidence WHERE key_class = $1 AND key_id = $2 AND result = 'destroyed' LIMIT 1",
      evidence,
    );
  }

  private async writeKeyDeletion(text: string, evidence: KeyDeletionEvidence): Promise<void> {
    const client = await this.client(this.defaultDeadlineMs);
    try {
      await this.begin(client, this.defaultDeadlineMs);
      const result = await client.query<{ readonly result: KeyDeletionEvidence["result"] }>(text, [
        evidence.keyClass,
        evidence.keyId,
        evidence.timestamp,
        evidence.result,
      ]);
      if (result.rows[0]?.result !== evidence.result) {
        throw new Error("Feedback key deletion evidence is unavailable");
      }
      await client.query("COMMIT");
    } catch (error) {
      await this.rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function reserveAttemptRows(
  client: PgClientLike,
  input: PgAttemptReservation,
): Promise<boolean> {
  const matched = await client.query<{
    readonly key_id: string;
    readonly identity_hmac: Uint8Array;
  }>(
    "SELECT key_id, identity_hmac FROM feedback_abuse_buckets WHERE bucket_start = $1 AND (key_id, identity_hmac) IN (SELECT * FROM unnest($2::text[], $3::bytea[])) AND expires_at > $4 ORDER BY key_id LIMIT 1 FOR UPDATE",
    [
      input.bucketStart,
      input.abuseCandidates.map((candidate) => candidate.keyId),
      input.abuseCandidates.map((candidate) => candidate.hmac),
      input.at,
    ],
  );
  const existing = matched.rows[0];
  const identity =
    existing?.key_id === undefined
      ? await client.query(
          "INSERT INTO feedback_abuse_buckets (bucket_start, key_id, identity_hmac, request_count, expires_at) VALUES ($1,$2,$3,1,$4) RETURNING request_count",
          [input.bucketStart, input.abuseKeyId, input.abuseHmac, input.expiresAt],
        )
      : await client.query(
          "UPDATE feedback_abuse_buckets SET request_count = request_count + 1 WHERE bucket_start = $1 AND key_id = $2 AND identity_hmac = $3 AND request_count < $4 RETURNING request_count",
          [input.bucketStart, existing.key_id, existing.identity_hmac, input.perIdentityLimit],
        );
  const global = await client.query(
    "INSERT INTO feedback_global_buckets (bucket_start, request_count, expires_at) VALUES ($1,1,$2) ON CONFLICT (bucket_start) DO UPDATE SET request_count = feedback_global_buckets.request_count + 1 WHERE feedback_global_buckets.request_count < $3 RETURNING request_count",
    [input.bucketStart, input.expiresAt, input.globalLimit],
  );
  return identity.rowCount === 1 && global.rowCount === 1;
}

async function hasCapacity(client: PgClientLike, input: PgAdmission): Promise<boolean> {
  const result = await client.query<{ readonly count: string; readonly bytes: string }>(
    "SELECT count(*)::text AS count, COALESCE(sum(octet_length(canonical_bytes)),0)::text AS bytes FROM feedback_payloads WHERE expires_at > $1",
    [input.createdAt],
  );
  const row = result.rows[0];
  return (
    row !== undefined &&
    Number(row.count) < input.openPayloadCount &&
    Number(row.bytes) + input.canonicalBytes.byteLength <= input.openPayloadBytes
  );
}

async function resolveSemanticGroup(client: PgClientLike, input: PgAdmission): Promise<string> {
  const matched = await client.query<{ readonly semantic_group_id: string }>(
    "SELECT semantic_group_id FROM feedback_dedupe_entries WHERE (dedupe_key_id, dedupe_hmac) IN (SELECT * FROM unnest($1::text[], $2::bytea[])) AND expires_at > $3 ORDER BY created_at LIMIT 1",
    [
      input.dedupeCandidates.map((candidate) => candidate.keyId),
      input.dedupeCandidates.map((candidate) => candidate.hmac),
      input.createdAt,
    ],
  );
  const groupId = matched.rows[0]?.semantic_group_id;
  if (groupId !== undefined) {
    await client.query(
      "UPDATE feedback_dedupe_entries SET bounded_count = LEAST(bounded_count + 1, 9223372036854775807) WHERE semantic_group_id = $1 AND expires_at > $2",
      [groupId, input.createdAt],
    );
    return groupId;
  }
  await client.query("INSERT INTO feedback_semantic_groups (id, created_at) VALUES ($1,$2)", [
    input.groupId,
    input.createdAt,
  ]);
  await client.query(
    "INSERT INTO feedback_dedupe_entries (dedupe_key_id, dedupe_hmac, semantic_group_id, created_at, expires_at) VALUES ($1,$2,$3,$4,$5)",
    [input.dedupeKeyId, input.dedupeHmac, input.groupId, input.createdAt, input.dedupeExpiresAt],
  );
  return input.groupId;
}

async function reusablePayload(
  client: PgClientLike,
  input: PgAdmission,
  groupId: string,
): Promise<{ readonly id: string; readonly expiresAt: Date } | undefined> {
  const reusable = await client.query<{ readonly id: string; readonly expires_at: Date }>(
    "SELECT id, expires_at FROM feedback_payloads WHERE semantic_group_id = $1 AND expires_at >= $2 ORDER BY created_at DESC LIMIT 1",
    [groupId, input.receiptExpiresAt],
  );
  const row = reusable.rows[0];
  return row === undefined ? undefined : { id: row.id, expiresAt: row.expires_at };
}

async function insertPayload(
  client: PgClientLike,
  input: PgAdmission,
  groupId: string,
): Promise<string> {
  await client.query(
    "INSERT INTO feedback_payloads (id, semantic_group_id, exact_body_sha256, canonical_bytes, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6)",
    [
      input.payloadId,
      groupId,
      input.exactBodySha256,
      input.canonicalBytes,
      input.createdAt,
      input.payloadExpiresAt,
    ],
  );
  return input.payloadId;
}
