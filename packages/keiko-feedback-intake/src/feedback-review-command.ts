import { createHash } from "node:crypto";
import { isFeedbackReviewActorV1 } from "@oscharko-dev/keiko-contracts/feedback-review";
import { isCanonicalFeedbackReviewId } from "./feedback-review-identifier.js";
import { FeedbackReviewError, type FeedbackReviewCommand } from "./feedback-review-types.js";
import type { FeedbackReviewMutationResult } from "./feedback-review-types.js";
import type { FeedbackReviewStateV1 } from "@oscharko-dev/keiko-contracts/feedback-review";

export function feedbackReviewReplayResult(row: {
  readonly item_id: string;
  readonly result_state: FeedbackReviewStateV1;
  readonly result_version: number;
  readonly result_at: Date;
}): FeedbackReviewMutationResult {
  return {
    itemId: row.item_id,
    state: row.result_state,
    version: row.result_version,
    at: row.result_at,
    replayed: true,
  };
}

function commandProjection(command: FeedbackReviewCommand): readonly unknown[] {
  const common = [
    command.itemId,
    command.expectedVersion,
    command.expectedPayloadDigest,
    command.action,
    command.actor.issuer,
    command.actor.subject,
    command.actor.permissionPolicyVersion,
  ];
  switch (command.action) {
    case "mark-duplicate":
      return [...common, command.targetItemId];
    case "reject":
      return [...common, command.reason];
    case "place-legal-hold":
      return [
        ...common,
        command.policyKey,
        command.reviewAt.toISOString(),
        command.expiresAt.toISOString(),
      ];
    default:
      return common;
  }
}

export function feedbackReviewCommandDigest(command: FeedbackReviewCommand): string {
  return createHash("sha256")
    .update(JSON.stringify(commandProjection(command)))
    .digest("hex");
}

export function assertFeedbackReviewCommand(command: FeedbackReviewCommand): void {
  if (!isFeedbackReviewActorV1(command.actor)) throw new FeedbackReviewError("invalid-actor");
  if (
    !isCanonicalFeedbackReviewId(command.itemId) ||
    (command.action === "mark-duplicate" && !isCanonicalFeedbackReviewId(command.targetItemId))
  ) {
    throw new FeedbackReviewError("invalid-request");
  }
  if (
    command.action === "place-legal-hold" &&
    (!Number.isFinite(command.reviewAt.getTime()) || !Number.isFinite(command.expiresAt.getTime()))
  ) {
    throw new FeedbackReviewError("invalid-legal-hold");
  }
}
