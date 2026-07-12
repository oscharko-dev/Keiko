import {
  FEEDBACK_PUBLICATION_PREPARATION_COLUMNS,
  targetFromPreparation,
  verifyStoredProjection,
  type FeedbackPublicationPreparationRow,
  type FeedbackPublicationReviewRow,
} from "./feedback-publication-records.js";
import {
  FeedbackPublicationError,
  type ApprovedFeedbackIssueProjection,
  type FeedbackPublicationClaim,
} from "./feedback-publication-types.js";
import { acquirePostgresClient, isRetryablePostgresError } from "./postgres-client.js";
import type { PgClientLike, PgPoolLike } from "./postgres-types.js";

export interface FeedbackPublicationDispatchRow extends FeedbackPublicationPreparationRow {
  readonly outbox_id: string;
  readonly outbox_status: string;
  readonly outbox_expires_at: Date;
  readonly lease_owner: string | null;
  readonly lease_expires_at: Date | null;
  readonly review_state: string;
  readonly review_version: number;
  readonly review_payload_digest: string;
  readonly approval_payload_digest: string | null;
  readonly approval_marker: string | null;
  readonly approval_projection_digest: string | null;
  readonly approval_target_key: string | null;
  readonly approval_label_policy_version: string | null;
  readonly approval_record_version: number | null;
  readonly approval_preparation_id: string | null;
  readonly approval_target_policy_digest: string | null;
  readonly canonical_bytes: Uint8Array;
  readonly payload_exact_digest: string;
  readonly payload_expires_at: Date;
  readonly private_group_id: string | null;
}

const DECODER = new TextDecoder("utf-8", { fatal: true });

interface ClaimDependencies {
  readonly pool: PgPoolLike;
  readonly deadlineMs: number;
  readonly maxRetries: number;
  readonly claim: FeedbackPublicationClaim;
  readonly assertCurrentTarget: (row: FeedbackPublicationPreparationRow) => void;
}

interface DatabaseClockRow {
  readonly database_now: Date;
}

export async function lockDispatchCandidate(
  client: PgClientLike,
  outboxId: string,
): Promise<FeedbackPublicationDispatchRow | undefined> {
  const result = await client.query<FeedbackPublicationDispatchRow>(
    `SELECT ${FEEDBACK_PUBLICATION_PREPARATION_COLUMNS},outbox.id AS outbox_id,outbox.status AS outbox_status,outbox.expires_at AS outbox_expires_at,outbox.lease_owner,outbox.lease_expires_at,i.state AS review_state,i.version AS review_version,i.payload_digest AS review_payload_digest,i.approval_payload_digest,i.approval_marker,i.approval_projection_digest,i.approval_target_key,i.approval_label_policy_version,i.approval_record_version,i.approval_preparation_id,i.approval_target_policy_digest,p.canonical_bytes,p.exact_body_sha256 AS payload_exact_digest,p.expires_at AS payload_expires_at,private.semantic_group_id AS private_group_id FROM feedback_publication_outbox outbox JOIN feedback_publication_preparations prep ON prep.id=outbox.preparation_id JOIN feedback_review_items i ON i.id=prep.item_id JOIN feedback_payloads p ON p.id=i.payload_id LEFT JOIN feedback_private_semantic_groups private ON private.semantic_group_id=i.semantic_group_id WHERE outbox.id=$1 FOR UPDATE OF outbox,prep,i,p`,
    [outboxId],
  );
  return result.rows[0];
}

function assertDispatchSnapshot(row: FeedbackPublicationDispatchRow, at: Date): void {
  if ([row.private_group_id !== null, row.review_state === "private-security"].some(Boolean)) {
    throw new FeedbackPublicationError("payload-private");
  }
  if ([row.payload_expires_at, row.expires_at, row.outbox_expires_at].some((date) => date <= at)) {
    throw new FeedbackPublicationError("payload-expired");
  }
  const bindingMatches = [
    row.review_state === "approved",
    row.review_version === row.source_record_version + 1,
    row.review_payload_digest === row.payload_digest,
    row.approval_payload_digest === row.payload_digest,
    row.approval_marker === row.reconciliation_marker,
    row.approval_projection_digest === row.projection_digest,
    row.approval_target_key === row.target_key,
    row.approval_label_policy_version === row.label_policy_version,
    row.approval_record_version === row.review_version,
    row.approval_preparation_id === row.id,
    row.approval_target_policy_digest === row.target_policy_digest,
    row.status === "approved",
  ].every(Boolean);
  if (!bindingMatches) throw new FeedbackPublicationError("projection-drift");
}

export function assertUnclaimedDispatchCandidate(
  row: FeedbackPublicationDispatchRow,
  at: Date,
): void {
  assertDispatchSnapshot(row, at);
  if (row.outbox_status !== "unclaimed") {
    throw new FeedbackPublicationError("claim-unavailable");
  }
}

function dispatchReview(row: FeedbackPublicationDispatchRow): FeedbackPublicationReviewRow {
  return {
    semantic_group_id: "",
    review_group_id: "",
    payload_digest: row.review_payload_digest,
    state: row.review_state,
    version: row.review_version,
    canonical_bytes: row.canonical_bytes,
    payload_exact_digest: row.payload_exact_digest,
    payload_expires_at: row.payload_expires_at,
    private_group_id: row.private_group_id,
  };
}

export function claimedProjectionFromRow(
  row: FeedbackPublicationDispatchRow,
  at: Date,
  leaseOwner: string,
  leaseExpiresAt: Date,
): ApprovedFeedbackIssueProjection {
  assertDispatchSnapshot(row, at);
  const exactLease = [
    row.outbox_status === "claimed",
    row.lease_owner === leaseOwner,
    row.lease_expires_at?.getTime() === leaseExpiresAt.getTime(),
    leaseExpiresAt > at,
  ].every(Boolean);
  if (!exactLease) throw new FeedbackPublicationError("claim-unavailable");
  const projection = verifyStoredProjection(dispatchReview(row), row);
  return {
    outboxId: row.outbox_id,
    preparationId: row.id,
    itemId: row.item_id,
    title: DECODER.decode(row.title_bytes),
    body: DECODER.decode(row.body_bytes),
    projectionDigest: projection.projectionDigest,
    reconciliationMarker: projection.reconciliationMarker,
    target: targetFromPreparation(row),
    targetPolicyDigest: row.target_policy_digest,
    leaseOwner,
    leaseExpiresAt,
  };
}

async function beginClaim(client: PgClientLike, deadlineMs: number): Promise<void> {
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  await client.query("SELECT set_config('statement_timeout',$1::text,true)", [String(deadlineMs)]);
}

async function claimWithinTransaction(
  client: PgClientLike,
  dependencies: ClaimDependencies,
): Promise<ApprovedFeedbackIssueProjection | undefined> {
  const { claim } = dependencies;
  const row = await lockDispatchCandidate(client, claim.outboxId);
  if (row === undefined) return undefined;
  if (row.outbox_status !== "unclaimed") throw new FeedbackPublicationError("claim-unavailable");
  dependencies.assertCurrentTarget(row);
  const clock = await client.query<DatabaseClockRow>("SELECT clock_timestamp() AS database_now");
  const databaseNow = clock.rows[0]?.database_now;
  if (databaseNow === undefined) throw new FeedbackPublicationError("claim-unavailable");
  assertUnclaimedDispatchCandidate(row, databaseNow);
  const updated = await client.query<{ readonly lease_expires_at: Date }>(
    "UPDATE feedback_publication_outbox SET status='claimed',lease_owner=$2,lease_expires_at=$3::timestamptz + $4::integer * interval '1 millisecond',updated_at=$3 WHERE id=$1 AND status='unclaimed' AND expires_at >= $3::timestamptz + $4::integer * interval '1 millisecond' RETURNING lease_expires_at",
    [claim.outboxId, claim.workerId, databaseNow, claim.leaseDurationMs],
  );
  const leaseExpiresAt = updated.rows[0]?.lease_expires_at;
  if (
    updated.rowCount !== 1 ||
    leaseExpiresAt === undefined ||
    leaseExpiresAt.getTime() - databaseNow.getTime() !== claim.leaseDurationMs
  ) {
    throw new FeedbackPublicationError("claim-unavailable");
  }
  return claimedProjectionFromRow(
    {
      ...row,
      outbox_status: "claimed",
      lease_owner: claim.workerId,
      lease_expires_at: leaseExpiresAt,
    },
    databaseNow,
    claim.workerId,
    leaseExpiresAt,
  );
}

async function releaseExpiredClaim(
  client: PgClientLike,
  claim: FeedbackPublicationClaim,
  leaseExpiresAt: Date,
): Promise<void> {
  await client.query(
    "UPDATE feedback_publication_outbox SET status='unclaimed',lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1 AND status='claimed' AND lease_owner=$2 AND lease_expires_at=$3 AND lease_expires_at <= clock_timestamp()",
    [claim.outboxId, claim.workerId, leaseExpiresAt],
  );
}

async function verifyCommittedLease(
  client: PgClientLike,
  claim: FeedbackPublicationClaim,
  projection: ApprovedFeedbackIssueProjection,
): Promise<void> {
  const result = await client.query<
    DatabaseClockRow & {
      readonly status: string;
      readonly lease_owner: string | null;
      readonly lease_expires_at: Date | null;
    }
  >(
    "SELECT clock_timestamp() AS database_now,status,lease_owner,lease_expires_at FROM feedback_publication_outbox WHERE id=$1",
    [claim.outboxId],
  );
  const row = result.rows[0];
  const live = [
    row?.status === "claimed",
    row?.lease_owner === claim.workerId,
    row?.lease_expires_at?.getTime() === projection.leaseExpiresAt.getTime(),
    row !== undefined && projection.leaseExpiresAt > row.database_now,
  ].every(Boolean);
  if (live) return;
  await releaseExpiredClaim(client, claim, projection.leaseExpiresAt);
  throw new FeedbackPublicationError("claim-unavailable");
}

async function claimAttempt(
  dependencies: ClaimDependencies,
): Promise<ApprovedFeedbackIssueProjection | undefined> {
  const client = await acquirePostgresClient(dependencies.pool, dependencies.deadlineMs);
  let committed = false;
  try {
    await beginClaim(client, dependencies.deadlineMs);
    const projection = await claimWithinTransaction(client, dependencies);
    await client.query("COMMIT");
    committed = true;
    if (projection !== undefined) {
      await verifyCommittedLease(client, dependencies.claim, projection);
    }
    return projection;
  } catch (error) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined);
    if (committed && !(error instanceof FeedbackPublicationError)) {
      throw new FeedbackPublicationError("claim-unavailable");
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function claimFeedbackPublication(
  dependencies: ClaimDependencies,
): Promise<ApprovedFeedbackIssueProjection | undefined> {
  for (let attempt = 0; attempt < dependencies.maxRetries; attempt += 1) {
    try {
      return await claimAttempt(dependencies);
    } catch (error) {
      if (!isRetryablePostgresError(error) || attempt + 1 === dependencies.maxRetries) throw error;
    }
  }
  throw new Error("Feedback publication claim retry bound exhausted");
}
