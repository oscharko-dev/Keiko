import { createHash, randomUUID } from "node:crypto";
import type {
  FeedbackPublicationApproveCommandV1,
  FeedbackPublicationCancelCommandV1,
  FeedbackPublicationPrepareCommandV1,
} from "@oscharko-dev/keiko-contracts/feedback-publication";
import type { FeedbackIssueProjectionV1 } from "./feedback-publication-projection.js";
import type { PgClientLike } from "./postgres-types.js";

const ENCODER = new TextEncoder();

export type FeedbackPublicationCancelResultStatus =
  "cancelled-private" | "manual-reconciliation" | "manual-remediation";

export async function persistPreparation(
  client: PgClientLike,
  command: FeedbackPublicationPrepareCommandV1,
  projection: FeedbackIssueProjectionV1,
  target: import("@oscharko-dev/keiko-contracts/feedback-publication").FeedbackPublicationTargetPolicySnapshotV1,
  digest: string,
  preparationId: string,
  at: Date,
  expiresAt: Date,
): Promise<void> {
  await client.query(
    "INSERT INTO feedback_publication_preparations (id,item_id,payload_digest,source_record_version,projection_version,title_bytes,body_bytes,projection_digest,reconciliation_marker,target_api_origin,target_repository_id,target_owner,target_repository,target_installation_id,target_labels,target_key,label_policy_version,target_policy_version,target_policy_digest,status,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::bigint,$12,$13,$14::bigint,$15,$16,$17,$18,$19,'prepared',$20,$21)",
    [
      preparationId,
      command.itemId,
      command.expectedPayloadDigest,
      command.expectedVersion,
      projection.version,
      ENCODER.encode(projection.title),
      ENCODER.encode(projection.body),
      projection.projectionDigest,
      projection.reconciliationMarker,
      target.apiOrigin,
      target.repositoryId,
      target.owner,
      target.repository,
      target.installationId,
      target.labels,
      target.targetKey,
      target.labelPolicyVersion,
      target.targetPolicyVersion,
      projection.targetPolicyDigest,
      at,
      expiresAt,
    ],
  );
  await persistAudit(client, command, preparationId, projection, command.expectedVersion, at);
  await client.query(
    "INSERT INTO feedback_publication_idempotency (idempotency_key,request_digest,action,item_id,preparation_id,result_status,result_version,result_at,expires_at) VALUES ($1,$2,$3,$4,$5,'prepared',$6,$7,$7::timestamptz + interval '365 days')",
    [
      command.idempotencyKey,
      digest,
      command.action,
      command.itemId,
      preparationId,
      command.expectedVersion,
      at,
    ],
  );
}

async function persistAudit(
  client: PgClientLike,
  command:
    | FeedbackPublicationPrepareCommandV1
    | FeedbackPublicationApproveCommandV1
    | FeedbackPublicationCancelCommandV1,
  preparationId: string,
  projection: Pick<FeedbackIssueProjectionV1, "projectionDigest" | "targetPolicyDigest">,
  resultVersion: number,
  at: Date,
  resultStatus?: FeedbackPublicationCancelResultStatus,
): Promise<void> {
  const status =
    command.action === "prepare-publication"
      ? "prepared"
      : command.action === "approve-publication"
        ? "approved"
        : (resultStatus ?? "cancelled-private");
  await client.query(
    "INSERT INTO feedback_publication_audit (item_id,preparation_id,payload_digest,projection_digest,target_policy_digest,prior_version,result_version,action,result_status,event_at,actor_issuer,actor_sub,permission_policy_version,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$10::timestamptz + interval '365 days')",
    [
      command.itemId,
      preparationId,
      command.expectedPayloadDigest,
      projection.projectionDigest,
      projection.targetPolicyDigest,
      command.expectedVersion,
      resultVersion,
      command.action,
      status,
      at,
      command.actor.issuer,
      command.actor.subject,
      command.actor.permissionPolicyVersion,
    ],
  );
}

function outboxKey(command: FeedbackPublicationApproveCommandV1): string {
  return createHash("sha256")
    .update("keiko-feedback-publication-outbox-v1")
    .update("\0")
    .update(command.itemId)
    .update("\0")
    .update(command.expectedProjectionDigest)
    .update("\0")
    .update(command.expectedTargetPolicyDigest)
    .digest("hex");
}

async function closeTerminalPayload(client: PgClientLike, itemId: string, at: Date): Promise<void> {
  await client.query(
    "UPDATE feedback_payloads SET expires_at=LEAST(expires_at,$2::timestamptz + interval '30 days') WHERE id=(SELECT payload_id FROM feedback_review_items WHERE id=$1)",
    [itemId, at],
  );
  await client.query(
    "UPDATE feedback_receipts SET closed=true,closed_at=COALESCE(closed_at,$2),expires_at=LEAST(expires_at,$2::timestamptz + interval '30 days') WHERE payload_id=(SELECT payload_id FROM feedback_review_items WHERE id=$1)",
    [itemId, at],
  );
}

async function persistApprovalIdempotency(
  client: PgClientLike,
  command: FeedbackPublicationApproveCommandV1,
  digest: string,
  outboxId: string,
  version: number,
  at: Date,
): Promise<void> {
  await client.query(
    "INSERT INTO feedback_publication_idempotency (idempotency_key,request_digest,action,item_id,preparation_id,outbox_id,result_status,result_version,result_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,'approved',$7,$8,$8::timestamptz + interval '365 days')",
    [
      command.idempotencyKey,
      digest,
      command.action,
      command.itemId,
      command.preparationId,
      outboxId,
      version,
      at,
    ],
  );
}

export async function persistApproval(
  client: PgClientLike,
  command: FeedbackPublicationApproveCommandV1,
  projection: Pick<
    FeedbackIssueProjectionV1,
    "projectionDigest" | "targetPolicyDigest" | "reconciliationMarker"
  >,
  digest: string,
  at: Date,
): Promise<{ readonly outboxId: string; readonly version: number }> {
  const version = command.expectedVersion + 1;
  const updated = await client.query(
    "UPDATE feedback_review_items SET state='approved',version=$2,updated_at=$3,approval_payload_digest=$4,approval_marker=$5,approval_projection_digest=$6,approval_target_key=(SELECT target_key FROM feedback_publication_preparations WHERE id=$7),approval_label_policy_version=(SELECT label_policy_version FROM feedback_publication_preparations WHERE id=$7),approval_actor_issuer=$8,approval_actor_sub=$9,approval_permission_policy_version=$10,approval_record_version=$2,approval_preparation_id=$7,approval_target_policy_digest=$11 WHERE id=$1 AND state='pending' AND version=$12 AND payload_digest=$4 RETURNING version",
    [
      command.itemId,
      version,
      at,
      command.expectedPayloadDigest,
      projection.reconciliationMarker,
      projection.projectionDigest,
      command.preparationId,
      command.actor.issuer,
      command.actor.subject,
      command.actor.permissionPolicyVersion,
      projection.targetPolicyDigest,
      command.expectedVersion,
    ],
  );
  if (updated.rowCount !== 1) throw new Error("feedback-publication-cas-mismatch");
  const prepared = await client.query(
    "UPDATE feedback_publication_preparations SET status='approved',approved_at=$2 WHERE id=$1 AND status='prepared' RETURNING id",
    [command.preparationId, at],
  );
  if (prepared.rowCount !== 1) throw new Error("feedback-publication-cas-mismatch");
  const outboxId = randomUUID();
  await client.query(
    "INSERT INTO feedback_publication_outbox (id,preparation_id,idempotency_key,status,created_at,updated_at,expires_at) VALUES ($1,$2,$3,'unclaimed',$4,$4,LEAST($4::timestamptz + interval '7 days',(SELECT expires_at FROM feedback_publication_preparations WHERE id=$2)))",
    [outboxId, command.preparationId, outboxKey(command), at],
  );
  await closeTerminalPayload(client, command.itemId, at);
  await persistAudit(client, command, command.preparationId, projection, version, at);
  await persistApprovalIdempotency(client, command, digest, outboxId, version, at);
  return { outboxId, version };
}

async function persistPrivateRouting(
  client: PgClientLike,
  reviewGroupId: string,
  semanticGroupId: string,
  at: Date,
): Promise<void> {
  await client.query(
    "INSERT INTO feedback_private_semantic_groups (semantic_group_id,restricted_at) VALUES ($1,$2) ON CONFLICT (semantic_group_id) DO NOTHING",
    [semanticGroupId, at],
  );
  await client.query(
    "INSERT INTO feedback_private_review_group_tombstones (review_group_id,restricted_at,expires_at) VALUES ($1,$2,$2::timestamptz + interval '365 days') ON CONFLICT (review_group_id) DO UPDATE SET restricted_at=GREATEST(feedback_private_review_group_tombstones.restricted_at,EXCLUDED.restricted_at),expires_at=GREATEST(feedback_private_review_group_tombstones.expires_at,EXCLUDED.expires_at)",
    [reviewGroupId, at],
  );
}

async function persistCancellationIdempotency(
  client: PgClientLike,
  command: FeedbackPublicationCancelCommandV1,
  digest: string,
  resultStatus: FeedbackPublicationCancelResultStatus,
  version: number,
  at: Date,
): Promise<void> {
  await client.query(
    "INSERT INTO feedback_publication_idempotency (idempotency_key,request_digest,action,item_id,preparation_id,result_status,result_version,result_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8::timestamptz + interval '365 days')",
    [
      command.idempotencyKey,
      digest,
      command.action,
      command.itemId,
      command.preparationId,
      resultStatus,
      version,
      at,
    ],
  );
}

export async function persistPrivateCancellation(
  client: PgClientLike,
  command: FeedbackPublicationCancelCommandV1,
  projection: Pick<FeedbackIssueProjectionV1, "projectionDigest" | "targetPolicyDigest">,
  digest: string,
  reviewGroupId: string,
  semanticGroupId: string,
  at: Date,
  resultStatus: FeedbackPublicationCancelResultStatus,
): Promise<number> {
  const version = command.expectedVersion + 1;
  if (resultStatus === "cancelled-private") {
    await client.query(
      "UPDATE feedback_publication_outbox SET status='cancelled-private',create_eligible=false,failure_code='payload-private',lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=NULL,updated_at=$2 WHERE preparation_id=$1 AND status='unclaimed'",
      [command.preparationId, at],
    );
  } else if (resultStatus === "manual-reconciliation") {
    await client.query(
      "UPDATE feedback_publication_outbox SET status='manual-reconciliation',create_eligible=false,failure_code='manual-reconciliation-required',lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=NULL,updated_at=$2 WHERE preparation_id=$1 AND status<>'succeeded'",
      [command.preparationId, at],
    );
  }
  const preparation = await client.query(
    "UPDATE feedback_publication_preparations SET status='cancelled-private',cancelled_at=$2 WHERE id=$1 AND status IN ('prepared','approved')",
    [command.preparationId, at],
  );
  if (preparation.rowCount !== 1) throw new Error("feedback-publication-cas-mismatch");
  const review = await client.query(
    "UPDATE feedback_review_items SET state='private-security',version=$2,updated_at=$3,approval_payload_digest=NULL,approval_marker=NULL,approval_projection_digest=NULL,approval_target_key=NULL,approval_label_policy_version=NULL,approval_actor_issuer=NULL,approval_actor_sub=NULL,approval_permission_policy_version=NULL,approval_record_version=NULL,approval_preparation_id=NULL,approval_target_policy_digest=NULL WHERE id=$1 AND version=$4 AND state IN ('pending','approved') RETURNING id",
    [command.itemId, version, at, command.expectedVersion],
  );
  if (review.rowCount !== 1) throw new Error("feedback-publication-cas-mismatch");
  await closeTerminalPayload(client, command.itemId, at);
  await persistPrivateRouting(client, reviewGroupId, semanticGroupId, at);
  await persistAudit(client, command, command.preparationId, projection, version, at, resultStatus);
  await persistCancellationIdempotency(client, command, digest, resultStatus, version, at);
  return version;
}
