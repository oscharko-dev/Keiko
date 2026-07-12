import type { PgClientLike } from "./postgres-types.js";
import type {
  FeedbackPublicationLeaseIdentity,
  FeedbackPublicationWorkerMode,
} from "./feedback-publication-worker-types.js";

export interface WorkerCandidateRow {
  readonly id: string;
  readonly status: string;
  readonly target_installation_id: string;
  readonly create_attempt_count: number;
}

export interface WorkerClockRow {
  readonly database_now: Date;
}

export async function databaseNow(client: PgClientLike): Promise<Date> {
  const result = await client.query<WorkerClockRow>("SELECT clock_timestamp() AS database_now");
  const at = result.rows[0]?.database_now;
  if (at === undefined) throw new Error("feedback-publication-database-clock-unavailable");
  return at;
}

export async function selectWorkerCandidate(
  client: PgClientLike,
  excludedInstallationIds: readonly string[],
  stateCandidateLimit: number,
): Promise<WorkerCandidateRow | undefined> {
  const result = await client.query<WorkerCandidateRow>(WORKER_CANDIDATE_SQL, [
    excludedInstallationIds,
    stateCandidateLimit,
  ]);
  return result.rows[0];
}

export const WORKER_CANDIDATE_SQL = `WITH state_candidates AS MATERIALIZED (
       (SELECT outbox.id
        FROM feedback_publication_outbox outbox
        JOIN feedback_publication_preparations prep ON prep.id=outbox.preparation_id
        WHERE outbox.status='unclaimed'
          AND prep.target_installation_id <> ALL($1::bigint[])
        ORDER BY outbox.created_at,outbox.id LIMIT $2)
       UNION ALL
       (SELECT outbox.id
        FROM feedback_publication_outbox outbox
        JOIN feedback_publication_preparations prep ON prep.id=outbox.preparation_id
        WHERE outbox.status='retryable-failure'
          AND outbox.next_attempt_at <= statement_timestamp()
          AND prep.target_installation_id <> ALL($1::bigint[])
        ORDER BY outbox.next_attempt_at,outbox.created_at,outbox.id LIMIT $2)
       UNION ALL
       (SELECT outbox.id
        FROM feedback_publication_outbox outbox
        JOIN feedback_publication_preparations prep ON prep.id=outbox.preparation_id
        WHERE outbox.status='may-have-committed' AND outbox.lease_expires_at IS NULL
          AND (outbox.next_attempt_at IS NULL OR outbox.next_attempt_at <= statement_timestamp())
          AND prep.target_installation_id <> ALL($1::bigint[])
        ORDER BY outbox.next_attempt_at NULLS FIRST,outbox.created_at,outbox.id LIMIT $2)
       UNION ALL
       (SELECT outbox.id
        FROM feedback_publication_outbox outbox
        JOIN feedback_publication_preparations prep ON prep.id=outbox.preparation_id
        WHERE outbox.status='may-have-committed'
          AND outbox.lease_expires_at <= statement_timestamp()
          AND (outbox.next_attempt_at IS NULL OR outbox.next_attempt_at <= statement_timestamp())
          AND prep.target_installation_id <> ALL($1::bigint[])
        ORDER BY outbox.lease_expires_at,outbox.next_attempt_at NULLS FIRST,
          outbox.created_at,outbox.id LIMIT $2)
       UNION ALL
       (SELECT outbox.id
        FROM feedback_publication_outbox outbox
        JOIN feedback_publication_preparations prep ON prep.id=outbox.preparation_id
        WHERE outbox.status='claimed' AND outbox.lease_expires_at <= statement_timestamp()
          AND prep.target_installation_id <> ALL($1::bigint[])
        ORDER BY outbox.lease_expires_at,outbox.created_at,outbox.id LIMIT $2)
     )
     SELECT outbox.id,outbox.status,prep.target_installation_id::text,
       outbox.create_attempt_count
     FROM state_candidates candidate
     JOIN feedback_publication_outbox outbox ON outbox.id=candidate.id
     JOIN feedback_publication_preparations prep ON prep.id=outbox.preparation_id
     WHERE prep.target_installation_id <> ALL($1::bigint[])
       AND (
         outbox.status='unclaimed'
         OR (outbox.status='retryable-failure' AND outbox.next_attempt_at <= statement_timestamp())
         OR (outbox.status='may-have-committed'
           AND (outbox.next_attempt_at IS NULL OR outbox.next_attempt_at <= statement_timestamp())
           AND (outbox.lease_expires_at IS NULL OR outbox.lease_expires_at <= statement_timestamp()))
         OR (outbox.status='claimed' AND outbox.lease_expires_at <= statement_timestamp())
       )
     ORDER BY outbox.created_at,outbox.id
     FOR UPDATE OF outbox SKIP LOCKED LIMIT 1`;

export function candidateMode(row: WorkerCandidateRow): FeedbackPublicationWorkerMode {
  return row.status === "may-have-committed" ? "reconcile-only" : "create-eligible";
}

export async function claimWorkerCandidate(
  client: PgClientLike,
  row: WorkerCandidateRow,
  workerId: string,
  at: Date,
  leaseDurationMs: number,
): Promise<Date | undefined> {
  const mode = candidateMode(row);
  const status = mode === "create-eligible" ? "claimed" : "may-have-committed";
  const result = await client.query<{ readonly lease_expires_at: Date }>(
    `UPDATE feedback_publication_outbox
     SET status=$2,create_eligible=$3,lease_owner=$4,
       lease_expires_at=$5::timestamptz + $6::integer * interval '1 millisecond',
       next_attempt_at=NULL,failure_code=NULL,attempt_count=attempt_count+1,updated_at=$5
     WHERE id=$1 AND expires_at >= $5::timestamptz + $6::integer * interval '1 millisecond'
       AND attempt_count < 10
     RETURNING lease_expires_at`,
    [row.id, status, mode === "create-eligible", workerId, at, leaseDurationMs],
  );
  return result.rows[0]?.lease_expires_at;
}

export function exactLeaseValues(lease: FeedbackPublicationLeaseIdentity): readonly unknown[] {
  return [
    lease.outboxId,
    lease.preparationId,
    lease.itemId,
    lease.targetPolicyDigest,
    lease.leaseOwner,
    lease.leaseExpiresAt,
  ];
}

export const EXACT_LEASE_WHERE = `outbox.id=$1 AND outbox.preparation_id=$2
  AND prep.item_id=$3 AND prep.target_policy_digest=$4
  AND outbox.lease_owner=$5 AND outbox.lease_expires_at=$6
  AND outbox.lease_expires_at > clock_timestamp() AND outbox.expires_at > clock_timestamp()`;

export async function appendDeliveryAudit(
  client: PgClientLike,
  outboxId: string,
  action: string,
  resultCode: string,
): Promise<void> {
  await client.query(
    `INSERT INTO feedback_publication_delivery_audit
      (outbox_id,preparation_id,installation_id,action,result_code,create_attempt_count,event_at,expires_at)
     SELECT outbox.id,prep.id,prep.target_installation_id,$2,$3,outbox.create_attempt_count,
       statement_timestamp(),statement_timestamp() + interval '365 days'
     FROM feedback_publication_outbox outbox
     JOIN feedback_publication_preparations prep ON prep.id=outbox.preparation_id
     WHERE outbox.id=$1`,
    [outboxId, action, resultCode],
  );
}
