import type {
  FeedbackPublicationFailureCodeV1,
  FeedbackPublicationPreviewV1,
  FeedbackPublicationStatusV1,
} from "@oscharko-dev/keiko-contracts/feedback-publication";
import { isFeedbackPublicationTargetPolicySnapshotV1 } from "@oscharko-dev/keiko-contracts/feedback-publication";
import type { FeedbackReviewActorV1 } from "@oscharko-dev/keiko-contracts/feedback-review";
import { isCanonicalFeedbackReviewId } from "./feedback-review-identifier.js";
import { digestFeedbackTargetPolicyV1 } from "./feedback-publication-projection.js";
import type { FeedbackPublicationTargetPolicyResolver } from "./feedback-publication-store.js";
import { FeedbackPublicationError } from "./feedback-publication-types.js";
import { acquirePostgresClient } from "./postgres-client.js";
import type { PgPoolLike } from "./postgres-types.js";

export interface FeedbackPublicationCommandContext {
  readonly version: number;
  readonly payloadDigest: string;
  readonly sourceVersion?: number | undefined;
  readonly projectionDigest?: string | undefined;
  readonly targetPolicyDigest?: string | undefined;
}

interface ContextRow {
  readonly command_version: number;
  readonly payload_digest: string;
  readonly source_record_version: number | null;
  readonly projection_digest: string | null;
  readonly target_policy_digest: string | null;
}

interface PreviewRow {
  readonly item_id: string;
  readonly id: string;
  readonly status: "prepared" | "approved";
  readonly projection_digest: string;
  readonly target_policy_digest: string;
  readonly title_bytes: Uint8Array;
  readonly body_bytes: Uint8Array;
  readonly target_owner: string;
  readonly target_repository: string;
  readonly target_labels: readonly string[];
  readonly label_policy_version: string;
  readonly target_policy_version: string;
  readonly target_key: string;
  readonly target_api_origin: "https://api.github.com";
  readonly target_repository_id: string;
  readonly target_installation_id: string;
  readonly expires_at: Date;
}

interface StatusRow {
  readonly item_id: string;
  readonly preparation_id: string | null;
  readonly preparation_status: "prepared" | "approved" | "cancelled-private" | null;
  readonly projection_digest: string | null;
  readonly target_policy_digest: string | null;
  readonly target_owner: string | null;
  readonly target_repository: string | null;
  readonly outbox_status: string | null;
  readonly failure_code: FeedbackPublicationFailureCodeV1 | null;
  readonly next_attempt_at: Date | null;
  readonly issue_number: number | null;
}

const DECODER = new TextDecoder("utf-8", { fatal: true });

export class PostgresFeedbackPublicationQuery {
  constructor(
    private readonly pool: PgPoolLike,
    private readonly resolveTargetPolicy: FeedbackPublicationTargetPolicyResolver,
    private readonly deadlineMs = 5_000,
  ) {}

  async commandContext(
    itemId: string,
    preparationId: string | undefined,
    includePrivate: boolean,
    action?: "approve-publication" | "cancel-publication-route-private" | undefined,
    idempotencyKey?: string | undefined,
    replayActor?: FeedbackReviewActorV1 | undefined,
  ): Promise<FeedbackPublicationCommandContext | undefined> {
    assertIds(itemId, preparationId);
    const row = await this.one<ContextRow>(CONTEXT_SQL, [
      itemId,
      preparationId ?? null,
      includePrivate,
      action ?? null,
      idempotencyKey ?? null,
      replayActor?.issuer ?? null,
      replayActor?.subject ?? null,
      replayActor?.permissionPolicyVersion ?? null,
    ]);
    if (row === undefined) return undefined;
    return {
      version: row.command_version,
      payloadDigest: row.payload_digest,
      ...(row.source_record_version === null ? {} : { sourceVersion: row.source_record_version }),
      ...(row.projection_digest === null ? {} : { projectionDigest: row.projection_digest }),
      ...(row.target_policy_digest === null
        ? {}
        : { targetPolicyDigest: row.target_policy_digest }),
    };
  }

  async preview(
    itemId: string,
    preparationId: string,
    includePrivate: boolean,
  ): Promise<FeedbackPublicationPreviewV1 | undefined> {
    assertIds(itemId, preparationId);
    const row = await this.one<PreviewRow>(PREVIEW_SQL, [itemId, preparationId, includePrivate]);
    if (row === undefined) return undefined;
    this.assertCurrentTarget(row);
    return previewResponse(row);
  }

  async status(
    itemId: string,
    preparationId: string | undefined,
    includePrivate: boolean,
  ): Promise<FeedbackPublicationStatusV1 | undefined> {
    assertIds(itemId, preparationId);
    const row = await this.one<StatusRow>(STATUS_SQL, [
      itemId,
      preparationId ?? null,
      includePrivate,
    ]);
    if (row === undefined || (preparationId !== undefined && row.preparation_id === null))
      return undefined;
    return statusResponse(row);
  }

  private async one<Row extends object>(
    sql: string,
    values: readonly unknown[],
  ): Promise<Row | undefined> {
    const client = await acquirePostgresClient(this.pool, this.deadlineMs);
    try {
      return (await client.query<Row>(sql, values)).rows[0];
    } finally {
      client.release();
    }
  }

  private assertCurrentTarget(row: PreviewRow): void {
    const target = this.resolveTargetPolicy(row.target_key);
    if (target === undefined || !isFeedbackPublicationTargetPolicySnapshotV1(target)) {
      throw new FeedbackPublicationError("target-policy-drift");
    }
    if (digestFeedbackTargetPolicyV1(target) !== row.target_policy_digest) {
      throw new FeedbackPublicationError("target-policy-drift");
    }
  }
}

function assertIds(itemId: string, preparationId: string | undefined): void {
  if (!isCanonicalFeedbackReviewId(itemId)) throw new FeedbackPublicationError("invalid-request");
  if (preparationId !== undefined && !isCanonicalFeedbackReviewId(preparationId)) {
    throw new FeedbackPublicationError("invalid-request");
  }
}

function previewResponse(row: PreviewRow): FeedbackPublicationPreviewV1 {
  return {
    status: row.status,
    itemId: row.item_id,
    preparationId: row.id,
    projectionDigest: row.projection_digest,
    targetPolicyDigest: row.target_policy_digest,
    title: DECODER.decode(row.title_bytes),
    body: DECODER.decode(row.body_bytes),
    targetDisplay: {
      owner: row.target_owner,
      repository: row.target_repository,
      labels: row.target_labels,
      labelPolicyVersion: row.label_policy_version,
      targetPolicyVersion: row.target_policy_version,
    },
    expiresAt: row.expires_at.toISOString(),
  };
}

function normalizedStatus(row: StatusRow): FeedbackPublicationStatusV1["status"] {
  if (row.preparation_id === null) return "none";
  if (row.preparation_status === "cancelled-private") return cancelledStatus(row.outbox_status);
  if (row.outbox_status === "retryable-failure") return "retryable";
  if (row.outbox_status === "may-have-committed") return "may-have-committed";
  if (row.outbox_status === "manual-reconciliation") return "manual-reconciliation";
  if (row.outbox_status === "succeeded") return "succeeded";
  return row.preparation_status === "approved" ? "approved" : "prepared";
}

function cancelledStatus(outbox: string | null): FeedbackPublicationStatusV1["status"] {
  if (outbox === null || outbox === "cancelled-private") return "cancelled-private";
  if (outbox === "succeeded") return "manual-remediation";
  return "manual-reconciliation";
}

function statusResponse(row: StatusRow): FeedbackPublicationStatusV1 {
  const status = normalizedStatus(row);
  const common = { itemId: row.item_id, status };
  if (row.preparation_id === null) return common;
  return {
    ...common,
    preparationId: row.preparation_id,
    projectionDigest: row.projection_digest ?? undefined,
    targetPolicyDigest: row.target_policy_digest ?? undefined,
    ...statusFailure(row.failure_code, status),
    ...(row.next_attempt_at === null ? {} : { retryAt: row.next_attempt_at.toISOString() }),
    ...linkage(row),
  };
}

function statusFailure(
  failure: FeedbackPublicationFailureCodeV1 | null,
  status: FeedbackPublicationStatusV1["status"],
): Pick<FeedbackPublicationStatusV1, "failureCode"> {
  if (failure !== null) return { failureCode: failure };
  if (status === "manual-remediation") {
    return { failureCode: "manual-remediation-required" };
  }
  if (status === "manual-reconciliation") {
    return { failureCode: "manual-reconciliation-required" };
  }
  return {};
}

function linkage(row: StatusRow): Pick<FeedbackPublicationStatusV1, "linkage"> {
  if (row.issue_number === null || row.target_owner === null || row.target_repository === null)
    return {};
  return {
    linkage: {
      issueNumber: row.issue_number,
      issueUrl: `https://github.com/${row.target_owner}/${row.target_repository}/issues/${String(row.issue_number)}`,
    },
  };
}

const CONTEXT_SQL = `WITH replay_context AS (
  SELECT audit.prior_version AS command_version,audit.payload_digest,
    NULL::integer AS source_record_version,audit.projection_digest,audit.target_policy_digest
  FROM feedback_publication_idempotency replay
  JOIN feedback_publication_audit audit
    ON audit.item_id=replay.item_id AND audit.preparation_id=replay.preparation_id
   AND audit.action=replay.action AND audit.result_status=replay.result_status
   AND audit.result_version=replay.result_version AND audit.event_at=replay.result_at
   AND audit.expires_at=replay.expires_at
  WHERE replay.idempotency_key=$5::text AND replay.action=$4::text
    AND replay.item_id=$1::uuid AND replay.preparation_id=$2::uuid
    AND replay.expires_at>transaction_timestamp()
    AND audit.actor_issuer=$6::text AND audit.actor_sub=$7::text
    AND audit.permission_policy_version=$8::text
), live_context AS (
  SELECT CASE WHEN prep.status='prepared' THEN prep.source_record_version ELSE item.version END
      AS command_version,
    item.payload_digest,prep.source_record_version,prep.projection_digest,
    prep.target_policy_digest
  FROM feedback_review_items item
  JOIN feedback_payloads payload ON payload.id=item.payload_id
  LEFT JOIN feedback_private_semantic_groups private ON private.semantic_group_id=item.semantic_group_id
  LEFT JOIN feedback_legal_holds hold ON hold.item_id=item.id AND hold.expires_at>transaction_timestamp()
  LEFT JOIN feedback_publication_preparations prep ON prep.item_id=item.id AND prep.id=$2::uuid
  WHERE item.id=$1 AND (payload.expires_at>transaction_timestamp() OR hold.item_id IS NOT NULL)
    AND ($3::boolean OR (item.state<>'private-security' AND private.semantic_group_id IS NULL))
    AND ($2::uuid IS NULL OR prep.id IS NOT NULL)
)
SELECT * FROM replay_context
UNION ALL
SELECT * FROM live_context WHERE NOT EXISTS (SELECT 1 FROM replay_context)
LIMIT 1`;

const PREVIEW_SQL = `SELECT prep.item_id,prep.id,prep.status,prep.projection_digest,
  prep.target_policy_digest,prep.title_bytes,prep.body_bytes,prep.target_owner,
  prep.target_repository,prep.target_labels,prep.label_policy_version,
  prep.target_policy_version,prep.target_key,prep.target_api_origin,
  prep.target_repository_id::text,prep.target_installation_id::text,prep.expires_at
 FROM feedback_publication_preparations prep
 JOIN feedback_review_items item ON item.id=prep.item_id
 JOIN feedback_payloads payload ON payload.id=item.payload_id
 LEFT JOIN feedback_private_semantic_groups private ON private.semantic_group_id=item.semantic_group_id
 WHERE prep.item_id=$1 AND prep.id=$2 AND prep.status IN ('prepared','approved')
   AND prep.expires_at>transaction_timestamp() AND payload.expires_at>transaction_timestamp()
   AND ($3::boolean OR (item.state<>'private-security' AND private.semantic_group_id IS NULL))
   AND ((prep.status='prepared' AND item.state='pending' AND item.version=prep.source_record_version)
     OR (prep.status='approved' AND item.state='approved'
       AND item.version=prep.source_record_version+1 AND item.approval_preparation_id=prep.id))`;

const STATUS_SQL = `SELECT item.id AS item_id,prep.id AS preparation_id,
  prep.status AS preparation_status,prep.projection_digest,prep.target_policy_digest,
  prep.target_owner,prep.target_repository,outbox.status AS outbox_status,
  outbox.failure_code,outbox.next_attempt_at,linkage.github_issue_number AS issue_number
 FROM feedback_review_items item
 JOIN feedback_payloads payload ON payload.id=item.payload_id
 LEFT JOIN feedback_private_semantic_groups private ON private.semantic_group_id=item.semantic_group_id
 LEFT JOIN feedback_legal_holds hold ON hold.item_id=item.id AND hold.expires_at>transaction_timestamp()
 LEFT JOIN LATERAL (
   SELECT candidate.id,candidate.status,candidate.projection_digest,
     candidate.target_policy_digest,candidate.target_owner,candidate.target_repository
   FROM feedback_publication_preparations candidate
   WHERE candidate.item_id=item.id AND candidate.expires_at>transaction_timestamp()
     AND ($2::uuid IS NULL OR candidate.id=$2::uuid)
   ORDER BY candidate.created_at DESC,candidate.id DESC LIMIT 1
 ) prep ON true
 LEFT JOIN feedback_publication_outbox outbox ON outbox.preparation_id=prep.id
 LEFT JOIN feedback_github_issue_linkage linkage ON linkage.item_id=item.id
   AND linkage.preparation_id=prep.id AND linkage.expires_at>transaction_timestamp()
 WHERE item.id=$1 AND (payload.expires_at>transaction_timestamp() OR hold.item_id IS NOT NULL)
   AND ($3::boolean OR (item.state<>'private-security' AND private.semantic_group_id IS NULL))`;
