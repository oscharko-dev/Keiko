import { FeedbackPublicationError } from "./feedback-publication-types.js";
import { appendDeliveryAudit } from "./feedback-publication-worker-sql.js";
import type {
  FeedbackPublicationLeaseIdentity,
  FeedbackPublicationSuccess,
} from "./feedback-publication-worker-types.js";
import type { PgClientLike } from "./postgres-types.js";

interface LinkageRow {
  readonly preparation_id: string;
  readonly target_policy_digest: string;
  readonly github_repository_id: string;
  readonly github_issue_node_id: string;
  readonly github_issue_number: number;
}

async function assertExactLinkage(
  client: PgClientLike,
  lease: FeedbackPublicationLeaseIdentity,
  issue: FeedbackPublicationSuccess,
): Promise<void> {
  const result = await client.query<LinkageRow>(
    "SELECT preparation_id,target_policy_digest,github_repository_id::text,github_issue_node_id,github_issue_number FROM feedback_github_issue_linkage WHERE item_id=$1 FOR UPDATE",
    [lease.itemId],
  );
  const row = result.rows[0];
  if (
    row?.preparation_id !== lease.preparationId ||
    row.target_policy_digest !== lease.targetPolicyDigest ||
    row.github_repository_id !== issue.repositoryId ||
    row.github_issue_node_id !== issue.issueNodeId ||
    row.github_issue_number !== issue.issueNumber
  ) {
    throw new FeedbackPublicationError("idempotency-mismatch");
  }
}

export async function persistWorkerSuccess(
  client: PgClientLike,
  lease: FeedbackPublicationLeaseIdentity,
  issue: FeedbackPublicationSuccess,
  afterLinkageInsert: (() => Promise<void>) | undefined,
  source: "created" | "reconciled" = "created",
): Promise<void> {
  await client.query(
    `INSERT INTO feedback_github_issue_linkage
      (item_id,preparation_id,target_policy_digest,github_repository_id,
       github_issue_node_id,github_issue_number,linked_at,expires_at)
     VALUES ($1,$2,$3,$4::bigint,$5,$6,statement_timestamp(),
       statement_timestamp()+interval '365 days') ON CONFLICT DO NOTHING`,
    [
      lease.itemId,
      lease.preparationId,
      lease.targetPolicyDigest,
      issue.repositoryId,
      issue.issueNodeId,
      issue.issueNumber,
    ],
  );
  await afterLinkageInsert?.();
  await assertExactLinkage(client, lease, issue);
  const updated = await client.query(
    `UPDATE feedback_publication_outbox SET status='succeeded',create_eligible=false,
     reconciled_exact=$2,
     lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=NULL,failure_code=NULL,
     updated_at=clock_timestamp() WHERE id=$1`,
    [lease.outboxId, source === "reconciled"],
  );
  if (updated.rowCount !== 1) throw new FeedbackPublicationError("claim-unavailable");
  await appendDeliveryAudit(client, lease.outboxId, "succeeded", "linked");
}
