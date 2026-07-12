import { randomBytes, randomUUID } from "node:crypto";
import type {
  FeedbackPublicationApproveCommandV1,
  FeedbackPublicationApprovalResponseV1,
  FeedbackPublicationCancelCommandV1,
  FeedbackPublicationCancelResponseV1,
  FeedbackPublicationPrepareCommandV1,
  FeedbackPublicationPreparedResponseV1,
  FeedbackPublicationTargetPolicySnapshotV1,
} from "@oscharko-dev/keiko-contracts/feedback-publication";
import { isFeedbackPublicationTargetPolicySnapshotV1 } from "@oscharko-dev/keiko-contracts/feedback-publication";
import {
  assertFeedbackPublicationClaim,
  assertFeedbackPublicationCommand,
  feedbackPublicationCommandDigest,
} from "./feedback-publication-command.js";
import {
  persistApproval,
  persistPreparation,
  persistPrivateCancellation,
  type FeedbackPublicationCancelResultStatus,
} from "./feedback-publication-persistence.js";
import {
  createFeedbackIssueProjectionV1,
  digestFeedbackTargetPolicyV1,
} from "./feedback-publication-projection.js";
import { claimFeedbackPublication } from "./feedback-publication-dispatch.js";
import {
  assertApprovalPreparation,
  assertCancellationPreparation,
  assertPrepareReplay,
  assertPublicationReplay,
  findPublicationReplay,
  lockPublicationPreparation,
  lockPublicationReview,
  preparedPublicationResponse,
  readGithubIssueLinkage,
  reportFromReview,
  verifyPublicationReview,
  verifyStoredProjection,
  type FeedbackPublicationPreparationRow,
  type FeedbackPublicationReplayRow,
} from "./feedback-publication-records.js";
import {
  FeedbackPublicationError,
  type ApprovedFeedbackIssueProjection,
  type FeedbackPublicationClaim,
  type FeedbackGithubIssueLinkage,
} from "./feedback-publication-types.js";
import { acquirePostgresClient, isRetryablePostgresError } from "./postgres-client.js";
import type { PgClientLike, PgPoolLike } from "./postgres-types.js";

export type FeedbackPublicationTargetPolicyResolver = (
  targetKey: string,
) => FeedbackPublicationTargetPolicySnapshotV1 | undefined;

type PublicationCommand =
  | FeedbackPublicationPrepareCommandV1
  | FeedbackPublicationApproveCommandV1
  | FeedbackPublicationCancelCommandV1;

function replayCancellation(
  row: FeedbackPublicationReplayRow,
): FeedbackPublicationCancelResponseV1 {
  const common = {
    itemId: row.item_id,
    preparationId: row.preparation_id,
    recordVersion: row.result_version,
    replayed: true,
  };
  if (row.result_status === "manual-reconciliation") {
    return {
      ...common,
      status: "manual-reconciliation",
      failure: "manual-reconciliation-required",
    };
  }
  if (row.result_status === "manual-remediation") {
    return { ...common, status: "manual-remediation", failure: "manual-remediation-required" };
  }
  return { ...common, status: "cancelled-private" };
}

function cancellationResponse(
  command: FeedbackPublicationCancelCommandV1,
  status: FeedbackPublicationCancelResultStatus,
  version: number,
): FeedbackPublicationCancelResponseV1 {
  const common = {
    itemId: command.itemId,
    preparationId: command.preparationId,
    recordVersion: version,
    replayed: false,
  };
  if (status === "manual-reconciliation") {
    return {
      ...common,
      status: "manual-reconciliation",
      failure: "manual-reconciliation-required",
    };
  }
  if (status === "manual-remediation") {
    return { ...common, status: "manual-remediation", failure: "manual-remediation-required" };
  }
  return { ...common, status: "cancelled-private" };
}

async function lockedOutboxStatus(
  client: PgClientLike,
  preparationId: string,
): Promise<string | undefined> {
  const result = await client.query<{ readonly status: string }>(
    "SELECT status FROM feedback_publication_outbox WHERE preparation_id=$1 FOR UPDATE",
    [preparationId],
  );
  return result.rows[0]?.status;
}

function cancellationStatus(status: string | undefined): FeedbackPublicationCancelResultStatus {
  if (status === "succeeded") return "manual-remediation";
  if (status === undefined || status === "unclaimed") return "cancelled-private";
  return "manual-reconciliation";
}

export class PostgresFeedbackPublicationRepository {
  constructor(
    private readonly pool: PgPoolLike,
    private readonly permissionPolicyVersion: string,
    private readonly resolveTargetPolicy: FeedbackPublicationTargetPolicyResolver,
    private readonly deadlineMs = 5_000,
    private readonly now: () => Date = () => new Date(),
    private readonly entropy: () => Uint8Array = () => randomBytes(32),
    private readonly id: () => string = () => randomUUID(),
    private readonly maxRetries = 3,
  ) {
    if (permissionPolicyVersion.length === 0) {
      throw new FeedbackPublicationError("invalid-request");
    }
  }

  async prepare(
    command: FeedbackPublicationPrepareCommandV1,
  ): Promise<FeedbackPublicationPreparedResponseV1> {
    return this.transaction(command, (client, digest, at) =>
      this.prepareTx(client, command, digest, at),
    );
  }

  async approve(
    command: FeedbackPublicationApproveCommandV1,
  ): Promise<FeedbackPublicationApprovalResponseV1> {
    return this.transaction(command, (client, digest, at) =>
      this.approveTx(client, command, digest, at),
    );
  }

  async cancelAndRoutePrivate(
    command: FeedbackPublicationCancelCommandV1,
  ): Promise<FeedbackPublicationCancelResponseV1> {
    return this.transaction(command, (client, digest, at) =>
      this.cancelTx(client, command, digest, at),
    );
  }

  private currentTarget(targetKey: string): FeedbackPublicationTargetPolicySnapshotV1 {
    const target = this.resolveTargetPolicy(targetKey);
    if (target?.targetKey !== targetKey || !isFeedbackPublicationTargetPolicySnapshotV1(target)) {
      throw new FeedbackPublicationError("target-policy-drift");
    }
    return target;
  }

  private assertCurrentTarget(row: FeedbackPublicationPreparationRow): void {
    const current = this.currentTarget(row.target_key);
    if (digestFeedbackTargetPolicyV1(current) !== row.target_policy_digest) {
      throw new FeedbackPublicationError("target-policy-drift");
    }
  }

  private async transaction<T>(
    command: PublicationCommand,
    operation: (client: PgClientLike, digest: string, at: Date) => Promise<T>,
  ): Promise<T> {
    assertFeedbackPublicationCommand(command);
    if (command.actor.permissionPolicyVersion !== this.permissionPolicyVersion) {
      throw new FeedbackPublicationError("permission-denied");
    }
    const at = new Date(this.now().getTime());
    const digest = feedbackPublicationCommandDigest(command);
    return this.retryTransaction((client) => operation(client, digest, at));
  }

  private async retryTransaction<T>(operation: (client: PgClientLike) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      try {
        return await this.transactionAttempt(operation);
      } catch (error) {
        if (!isRetryablePostgresError(error) || attempt + 1 === this.maxRetries) throw error;
      }
    }
    throw new Error("Feedback publication retry bound exhausted");
  }

  private async transactionAttempt<T>(operation: (client: PgClientLike) => Promise<T>): Promise<T> {
    const client = await acquirePostgresClient(this.pool, this.deadlineMs);
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await client.query("SELECT set_config('statement_timeout',$1::text,true)", [
        String(this.deadlineMs),
      ]);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof Error && error.message === "feedback-publication-cas-mismatch") {
        throw new FeedbackPublicationError("cas-mismatch");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async prepareTx(
    client: PgClientLike,
    command: FeedbackPublicationPrepareCommandV1,
    digest: string,
    at: Date,
  ): Promise<FeedbackPublicationPreparedResponseV1> {
    const replay = await findPublicationReplay(client, command.idempotencyKey);
    if (replay !== undefined) {
      assertPublicationReplay(replay, digest);
      const review = await lockPublicationReview(client, command.itemId);
      verifyPublicationReview(review, command.expectedVersion, command.expectedPayloadDigest, at);
      if (review.state !== "pending") throw new FeedbackPublicationError("invalid-transition");
      const preparation = await lockPublicationPreparation(client, replay.preparation_id);
      assertPrepareReplay(
        preparation,
        command.itemId,
        command.expectedPayloadDigest,
        command.expectedVersion,
        at,
      );
      this.assertCurrentTarget(preparation);
      verifyStoredProjection(review, preparation);
      return preparedPublicationResponse(preparation, replay.result_version, true);
    }
    const review = await lockPublicationReview(client, command.itemId);
    verifyPublicationReview(review, command.expectedVersion, command.expectedPayloadDigest, at);
    if (review.state !== "pending") throw new FeedbackPublicationError("invalid-transition");
    const target = this.currentTarget(command.targetKey);
    const projection = createFeedbackIssueProjectionV1(
      reportFromReview(review),
      target,
      this.entropy,
    );
    const expiresAt = new Date(
      Math.min(review.payload_expires_at.getTime(), at.getTime() + 30 * 86_400_000),
    );
    const preparationId = this.id();
    await persistPreparation(
      client,
      command,
      projection,
      target,
      digest,
      preparationId,
      at,
      expiresAt,
    );
    const preparation = await lockPublicationPreparation(client, preparationId);
    return preparedPublicationResponse(preparation, review.version, false);
  }

  private async approveTx(
    client: PgClientLike,
    command: FeedbackPublicationApproveCommandV1,
    digest: string,
    at: Date,
  ): Promise<FeedbackPublicationApprovalResponseV1> {
    const replay = await findPublicationReplay(client, command.idempotencyKey);
    if (replay !== undefined) {
      assertPublicationReplay(replay, digest);
      if (replay.outbox_id === null) throw new FeedbackPublicationError("invalid-transition");
      return {
        status: "approved",
        itemId: replay.item_id,
        preparationId: replay.preparation_id,
        recordVersion: replay.result_version,
        outboxId: replay.outbox_id,
        replayed: true,
      };
    }
    const review = await lockPublicationReview(client, command.itemId);
    verifyPublicationReview(review, command.expectedVersion, command.expectedPayloadDigest, at);
    if (review.state !== "pending") throw new FeedbackPublicationError("invalid-transition");
    const preparation = await lockPublicationPreparation(client, command.preparationId);
    assertApprovalPreparation(preparation, command, at);
    this.assertCurrentTarget(preparation);
    const projection = verifyStoredProjection(review, preparation);
    const result = await persistApproval(client, command, projection, digest, at);
    return {
      status: "approved",
      itemId: command.itemId,
      preparationId: command.preparationId,
      recordVersion: result.version,
      outboxId: result.outboxId,
      replayed: false,
    };
  }

  private async cancelTx(
    client: PgClientLike,
    command: FeedbackPublicationCancelCommandV1,
    digest: string,
    at: Date,
  ): Promise<FeedbackPublicationCancelResponseV1> {
    const replay = await findPublicationReplay(client, command.idempotencyKey);
    if (replay !== undefined) {
      assertPublicationReplay(replay, digest);
      return replayCancellation(replay);
    }
    const review = await lockPublicationReview(client, command.itemId);
    verifyPublicationReview(review, command.expectedVersion, command.expectedPayloadDigest, at);
    const preparation = await lockPublicationPreparation(client, command.preparationId);
    assertCancellationPreparation(preparation, review, command, at);
    const status = cancellationStatus(await lockedOutboxStatus(client, command.preparationId));
    const projection = verifyStoredProjection(review, preparation);
    const version = await persistPrivateCancellation(
      client,
      command,
      projection,
      digest,
      review.review_group_id,
      review.semantic_group_id,
      at,
      status,
    );
    return cancellationResponse(command, status, version);
  }

  async claimApprovedProjection(
    claim: FeedbackPublicationClaim,
  ): Promise<ApprovedFeedbackIssueProjection | undefined> {
    assertFeedbackPublicationClaim(claim);
    return claimFeedbackPublication({
      pool: this.pool,
      deadlineMs: this.deadlineMs,
      maxRetries: this.maxRetries,
      claim,
      assertCurrentTarget: (row) => {
        this.assertCurrentTarget(row);
      },
    });
  }

  async linkage(itemId: string): Promise<FeedbackGithubIssueLinkage | undefined> {
    const client = await acquirePostgresClient(this.pool, this.deadlineMs);
    try {
      return await readGithubIssueLinkage(client, itemId);
    } finally {
      client.release();
    }
  }
}
