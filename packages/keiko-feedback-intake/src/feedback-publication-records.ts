import { createHash } from "node:crypto";
import type {
  FeedbackPublicationApproveCommandV1,
  FeedbackPublicationCancelCommandV1,
  FeedbackPublicationPreparedResponseV1,
  FeedbackPublicationTargetPolicySnapshotV1,
} from "@oscharko-dev/keiko-contracts/feedback-publication";
import type { FeedbackReportV1 } from "@oscharko-dev/keiko-contracts/feedback-report";
import { verifyCanonicalFeedbackReportBodyV1 } from "@oscharko-dev/keiko-security/feedback-report";
import {
  recomputeFeedbackIssueProjectionV1,
  type FeedbackIssueProjectionV1,
} from "./feedback-publication-projection.js";
import {
  FeedbackPublicationError,
  type FeedbackGithubIssueLinkage,
} from "./feedback-publication-types.js";
import type { PgClientLike } from "./postgres-types.js";

export interface FeedbackPublicationReviewRow {
  readonly semantic_group_id: string;
  readonly review_group_id: string;
  readonly payload_digest: string;
  readonly state: string;
  readonly version: number;
  readonly canonical_bytes: Uint8Array;
  readonly payload_exact_digest: string;
  readonly payload_expires_at: Date;
  readonly private_group_id: string | null;
}

export interface FeedbackPublicationPreparationRow {
  readonly id: string;
  readonly item_id: string;
  readonly payload_digest: string;
  readonly source_record_version: number;
  readonly title_bytes: Uint8Array;
  readonly body_bytes: Uint8Array;
  readonly projection_digest: string;
  readonly reconciliation_marker: string;
  readonly target_api_origin: "https://api.github.com";
  readonly target_repository_id: string;
  readonly target_owner: string;
  readonly target_repository: string;
  readonly target_installation_id: string;
  readonly target_labels: readonly string[];
  readonly target_key: string;
  readonly label_policy_version: string;
  readonly target_policy_version: string;
  readonly target_policy_digest: string;
  readonly status: "prepared" | "approved" | "cancelled-private";
  readonly expires_at: Date;
}

export interface FeedbackPublicationReplayRow {
  readonly request_digest: string;
  readonly item_id: string;
  readonly preparation_id: string;
  readonly outbox_id: string | null;
  readonly result_status:
    "prepared" | "approved" | "cancelled-private" | "manual-reconciliation" | "manual-remediation";
  readonly result_version: number;
}

export const FEEDBACK_PUBLICATION_PREPARATION_COLUMNS =
  "prep.id,prep.item_id,prep.payload_digest,prep.source_record_version,prep.title_bytes,prep.body_bytes,prep.projection_digest,prep.reconciliation_marker,prep.target_api_origin,prep.target_repository_id::text,prep.target_owner,prep.target_repository,prep.target_installation_id::text,prep.target_labels,prep.target_key,prep.label_policy_version,prep.target_policy_version,prep.target_policy_digest,prep.status,prep.expires_at";
const DECODER = new TextDecoder("utf-8", { fatal: true });

export function targetFromPreparation(
  row: FeedbackPublicationPreparationRow,
): FeedbackPublicationTargetPolicySnapshotV1 {
  return {
    apiOrigin: row.target_api_origin,
    repositoryId: row.target_repository_id,
    owner: row.target_owner,
    repository: row.target_repository,
    installationId: row.target_installation_id,
    labels: row.target_labels,
    targetKey: row.target_key,
    labelPolicyVersion: row.label_policy_version,
    targetPolicyVersion: row.target_policy_version,
  };
}

export function verifyPublicationReview(
  row: FeedbackPublicationReviewRow,
  expectedVersion: number,
  expectedDigest: string,
  at: Date,
): void {
  if (row.private_group_id !== null || row.state === "private-security") {
    throw new FeedbackPublicationError("payload-private");
  }
  if (row.payload_expires_at <= at) throw new FeedbackPublicationError("payload-expired");
  if (row.version !== expectedVersion || row.payload_digest !== expectedDigest) {
    throw new FeedbackPublicationError("cas-mismatch");
  }
  const actual = createHash("sha256").update(row.canonical_bytes).digest("hex");
  if (actual !== row.payload_digest || row.payload_exact_digest !== row.payload_digest) {
    throw new FeedbackPublicationError("projection-drift");
  }
}

export function reportFromReview(row: FeedbackPublicationReviewRow): FeedbackReportV1 {
  const verified = verifyCanonicalFeedbackReportBodyV1({
    bytes: row.canonical_bytes,
    claimedDigest: row.payload_digest,
  });
  if (!verified.ok) throw new FeedbackPublicationError("projection-drift");
  return verified.value.report;
}

export async function lockPublicationReview(
  client: PgClientLike,
  itemId: string,
): Promise<FeedbackPublicationReviewRow> {
  const result = await client.query<FeedbackPublicationReviewRow>(
    "SELECT i.semantic_group_id,groups.opaque_id AS review_group_id,i.payload_digest,i.state,i.version,p.canonical_bytes,p.exact_body_sha256 AS payload_exact_digest,p.expires_at AS payload_expires_at,private.semantic_group_id AS private_group_id FROM feedback_payloads p JOIN feedback_review_items i ON i.payload_id=p.id JOIN feedback_review_groups groups ON groups.semantic_group_id=i.semantic_group_id LEFT JOIN feedback_private_semantic_groups private ON private.semantic_group_id=i.semantic_group_id WHERE i.id=$1 FOR UPDATE OF p,i",
    [itemId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new FeedbackPublicationError("not-found");
  return row;
}

export async function lockPublicationPreparation(
  client: PgClientLike,
  id: string,
): Promise<FeedbackPublicationPreparationRow> {
  const result = await client.query<FeedbackPublicationPreparationRow>(
    `SELECT ${FEEDBACK_PUBLICATION_PREPARATION_COLUMNS} FROM feedback_publication_preparations prep WHERE prep.id=$1 FOR UPDATE OF prep`,
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) throw new FeedbackPublicationError("not-found");
  return row;
}

export async function findPublicationReplay(
  client: PgClientLike,
  key: string,
): Promise<FeedbackPublicationReplayRow | undefined> {
  return (
    await client.query<FeedbackPublicationReplayRow>(
      "SELECT request_digest,item_id,preparation_id,outbox_id,result_status,result_version FROM feedback_publication_idempotency WHERE idempotency_key=$1 FOR UPDATE",
      [key],
    )
  ).rows[0];
}

export function assertPublicationReplay(row: FeedbackPublicationReplayRow, digest: string): void {
  if (row.request_digest !== digest) throw new FeedbackPublicationError("idempotency-mismatch");
}

export function preparedPublicationResponse(
  row: FeedbackPublicationPreparationRow,
  version: number,
  replayed: boolean,
): FeedbackPublicationPreparedResponseV1 {
  return {
    status: "prepared",
    itemId: row.item_id,
    preparationId: row.id,
    recordVersion: version,
    projectionDigest: row.projection_digest,
    targetPolicyDigest: row.target_policy_digest,
    reconciliationMarker: row.reconciliation_marker,
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
    replayed,
  };
}

export function assertPrepareReplay(
  row: FeedbackPublicationPreparationRow,
  itemId: string,
  payloadDigest: string,
  sourceVersion: number,
  at: Date,
): void {
  if (
    row.item_id !== itemId ||
    row.payload_digest !== payloadDigest ||
    row.source_record_version !== sourceVersion ||
    row.status !== "prepared"
  ) {
    throw new FeedbackPublicationError("cas-mismatch");
  }
  if (row.expires_at <= at) throw new FeedbackPublicationError("payload-expired");
}

export function assertApprovalPreparation(
  row: FeedbackPublicationPreparationRow,
  command: FeedbackPublicationApproveCommandV1,
  at: Date,
): void {
  const identityMatches =
    row.item_id === command.itemId && row.payload_digest === command.expectedPayloadDigest;
  const stateMatches =
    row.source_record_version === command.expectedVersion && row.status === "prepared";
  const digestsMatch =
    row.projection_digest === command.expectedProjectionDigest &&
    row.target_policy_digest === command.expectedTargetPolicyDigest;
  if (!identityMatches || !stateMatches || !digestsMatch) {
    throw new FeedbackPublicationError("cas-mismatch");
  }
  if (row.expires_at <= at) throw new FeedbackPublicationError("payload-expired");
}

export function assertCancellationPreparation(
  row: FeedbackPublicationPreparationRow,
  review: FeedbackPublicationReviewRow,
  command: FeedbackPublicationCancelCommandV1,
  at: Date,
): void {
  const expectedSource =
    review.state === "approved" ? command.expectedVersion - 1 : command.expectedVersion;
  const validStatus = row.status === "prepared" || row.status === "approved";
  if (
    row.item_id !== command.itemId ||
    row.payload_digest !== command.expectedPayloadDigest ||
    row.source_record_version !== expectedSource ||
    row.projection_digest !== command.expectedProjectionDigest ||
    row.target_policy_digest !== command.expectedTargetPolicyDigest ||
    !validStatus
  ) {
    throw new FeedbackPublicationError("cas-mismatch");
  }
  if (row.expires_at <= at) throw new FeedbackPublicationError("payload-expired");
}

export function verifyStoredProjection(
  row: FeedbackPublicationReviewRow,
  prep: FeedbackPublicationPreparationRow,
): FeedbackIssueProjectionV1 {
  const projection = recomputeFeedbackIssueProjectionV1(
    reportFromReview(row),
    targetFromPreparation(prep),
    prep.reconciliation_marker,
  );
  const bytesMatch =
    projection.title === DECODER.decode(prep.title_bytes) &&
    projection.body === DECODER.decode(prep.body_bytes);
  if (
    projection.projectionDigest !== prep.projection_digest ||
    projection.targetPolicyDigest !== prep.target_policy_digest ||
    !bytesMatch
  ) {
    throw new FeedbackPublicationError("projection-drift");
  }
  return projection;
}

interface LinkageRow {
  readonly item_id: string;
  readonly preparation_id: string;
  readonly target_policy_digest: string;
  readonly github_repository_id: string;
  readonly github_issue_node_id: string;
  readonly github_issue_number: number;
  readonly linked_at: Date;
}

export async function readGithubIssueLinkage(
  client: PgClientLike,
  itemId: string,
): Promise<FeedbackGithubIssueLinkage | undefined> {
  const row = (
    await client.query<LinkageRow>(
      "SELECT item_id,preparation_id,target_policy_digest,github_repository_id::text,github_issue_node_id,github_issue_number,linked_at FROM feedback_github_issue_linkage WHERE item_id=$1 AND expires_at>transaction_timestamp()",
      [itemId],
    )
  ).rows[0];
  return row === undefined
    ? undefined
    : {
        itemId: row.item_id,
        preparationId: row.preparation_id,
        targetPolicyDigest: row.target_policy_digest,
        repositoryId: row.github_repository_id,
        issueNodeId: row.github_issue_node_id,
        issueNumber: row.github_issue_number,
        linkedAt: row.linked_at,
      };
}
