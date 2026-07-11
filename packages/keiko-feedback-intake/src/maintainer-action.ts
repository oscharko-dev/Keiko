import type { FeedbackMaintainerPermissionV1 } from "@oscharko-dev/keiko-contracts/feedback-maintainer";
import {
  FEEDBACK_REJECTION_REASONS_V1,
  type FeedbackReviewActorV1,
} from "@oscharko-dev/keiko-contracts/feedback-review";
import { isCanonicalFeedbackReviewId } from "./feedback-review-identifier.js";
import type { FeedbackReviewCommand } from "./feedback-review-types.js";

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function common(
  value: Record<string, unknown>,
  itemId: string,
  actor: FeedbackReviewActorV1,
): Omit<FeedbackReviewCommand, "action"> | undefined {
  if (
    !isCanonicalFeedbackReviewId(itemId) ||
    !Number.isSafeInteger(value.expectedVersion) ||
    typeof value.expectedPayloadDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.expectedPayloadDigest) ||
    typeof value.idempotencyKey !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/u.test(value.idempotencyKey)
  )
    return undefined;
  return {
    itemId,
    expectedVersion: value.expectedVersion as number,
    expectedPayloadDigest: value.expectedPayloadDigest,
    idempotencyKey: value.idempotencyKey,
    actor,
  };
}

export function parseMaintainerAction(
  input: unknown,
  itemId: string,
  actor: FeedbackReviewActorV1,
): FeedbackReviewCommand | undefined {
  const value = object(input);
  if (value === undefined || typeof value.action !== "string") return undefined;
  const shared = common(value, itemId, actor);
  if (shared === undefined) return undefined;
  const base = ["action", "expectedVersion", "expectedPayloadDigest", "idempotencyKey"];
  if (SIMPLE_ACTIONS.has(value.action) && exactKeys(value, base)) {
    return { ...shared, action: value.action as SimpleAction };
  }
  switch (value.action) {
    case "mark-duplicate":
      return duplicate(value, shared, base);
    case "reject":
      return reject(value, shared, base);
    case "place-legal-hold":
      return hold(value, shared, base);
    default:
      return undefined;
  }
}

type Shared = Omit<FeedbackReviewCommand, "action">;
type SimpleAction =
  "archive" | "route-private-security" | "release-legal-hold" | "expire-legal-hold";
const SIMPLE_ACTIONS = new Set<string>([
  "archive",
  "route-private-security",
  "release-legal-hold",
  "expire-legal-hold",
]);

function duplicate(
  value: Record<string, unknown>,
  shared: Shared,
  base: readonly string[],
): FeedbackReviewCommand | undefined {
  return exactKeys(value, [...base, "targetItemId"]) &&
    isCanonicalFeedbackReviewId(value.targetItemId)
    ? { ...shared, action: "mark-duplicate" as const, targetItemId: value.targetItemId }
    : undefined;
}

function reject(
  value: Record<string, unknown>,
  shared: Shared,
  base: readonly string[],
): FeedbackReviewCommand | undefined {
  return exactKeys(value, [...base, "reason"]) &&
    FEEDBACK_REJECTION_REASONS_V1.includes(value.reason as never)
    ? {
        ...shared,
        action: "reject" as const,
        reason: value.reason as (typeof FEEDBACK_REJECTION_REASONS_V1)[number],
      }
    : undefined;
}

function hold(
  value: Record<string, unknown>,
  shared: Shared,
  base: readonly string[],
): FeedbackReviewCommand | undefined {
  return exactKeys(value, [...base, "policyKey", "reviewAt", "expiresAt"]) &&
    typeof value.policyKey === "string" &&
    typeof value.reviewAt === "string" &&
    typeof value.expiresAt === "string"
    ? {
        ...shared,
        action: "place-legal-hold" as const,
        policyKey: value.policyKey,
        reviewAt: new Date(value.reviewAt),
        expiresAt: new Date(value.expiresAt),
      }
    : undefined;
}

export function permissionForAction(
  command: FeedbackReviewCommand,
): FeedbackMaintainerPermissionV1 {
  if (command.action === "route-private-security") return "feedback.security";
  if (command.action.includes("legal-hold")) return "feedback.legal-hold";
  return "feedback.review";
}
