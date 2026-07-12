import { createHash } from "node:crypto";
import { type FeedbackPublicationCommandV1 } from "@oscharko-dev/keiko-contracts/feedback-publication";
import { isFeedbackReviewActorV1 } from "@oscharko-dev/keiko-contracts/feedback-review";
import { isCanonicalFeedbackReviewId } from "./feedback-review-identifier.js";
import {
  FeedbackPublicationError,
  type FeedbackPublicationClaim,
} from "./feedback-publication-types.js";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const TARGET_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;
const WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const PREPARE_KEYS = new Set([
  "action",
  "itemId",
  "expectedVersion",
  "expectedPayloadDigest",
  "idempotencyKey",
  "actor",
  "targetKey",
]);

export function assertFeedbackPublicationCommand(command: FeedbackPublicationCommandV1): void {
  if (!isFeedbackReviewActorV1(command.actor)) throw new FeedbackPublicationError("invalid-actor");
  assertCommonCommand(command);
  assertActionCommand(command);
}

export function assertFeedbackPublicationClaim(claim: FeedbackPublicationClaim): void {
  const valid = [
    isCanonicalFeedbackReviewId(claim.outboxId),
    WORKER_ID.test(claim.workerId),
    Number.isSafeInteger(claim.leaseDurationMs),
    claim.leaseDurationMs >= 1_000,
    claim.leaseDurationMs <= 300_000,
  ].every(Boolean);
  if (!valid) invalidRequest();
}

function assertCommonCommand(command: FeedbackPublicationCommandV1): void {
  const valid = [
    isCanonicalFeedbackReviewId(command.itemId),
    Number.isSafeInteger(command.expectedVersion),
    command.expectedVersion >= 1,
    SHA256.test(command.expectedPayloadDigest),
    IDEMPOTENCY_KEY.test(command.idempotencyKey),
  ].every(Boolean);
  if (!valid) throw new FeedbackPublicationError("invalid-request");
}

function assertActionCommand(command: FeedbackPublicationCommandV1): void {
  if (command.action === "prepare-publication") {
    if (!TARGET_KEY.test(command.targetKey) || !hasOnlyKeys(command, PREPARE_KEYS))
      invalidRequest();
    return;
  }
  if (!isCanonicalFeedbackReviewId(command.preparationId)) invalidRequest();
  if (command.action !== "approve-publication") return;
  if (!SHA256.test(command.expectedProjectionDigest)) invalidRequest();
  if (!SHA256.test(command.expectedTargetPolicyDigest)) invalidRequest();
}

function invalidRequest(): never {
  throw new FeedbackPublicationError("invalid-request");
}

function commandProjection(command: FeedbackPublicationCommandV1): readonly unknown[] {
  const common = [
    command.action,
    command.itemId,
    command.expectedVersion,
    command.expectedPayloadDigest,
    command.actor.issuer,
    command.actor.subject,
    command.actor.permissionPolicyVersion,
  ];
  if (command.action === "prepare-publication") return [...common, command.targetKey];
  if (command.action === "approve-publication") {
    return [
      ...common,
      command.preparationId,
      command.expectedProjectionDigest,
      command.expectedTargetPolicyDigest,
    ];
  }
  return [...common, command.preparationId];
}

function hasOnlyKeys(value: object, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

export function feedbackPublicationCommandDigest(command: FeedbackPublicationCommandV1): string {
  return createHash("sha256")
    .update("keiko-feedback-publication-command-v1")
    .update("\0")
    .update(JSON.stringify(commandProjection(command)))
    .digest("hex");
}
