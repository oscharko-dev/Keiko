import type { FeedbackReviewActorV1 } from "@oscharko-dev/keiko-contracts/feedback-review";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const TARGET_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;

interface PrepareRequest {
  readonly action: "prepare-publication";
  readonly expectedVersion: number;
  readonly targetKey: string;
  readonly idempotencyKey: string;
}

interface BoundRequest {
  readonly action: "approve-publication" | "cancel-publication-route-private";
  readonly preparationId: string;
  readonly expectedProjectionDigest: string;
  readonly expectedTargetPolicyDigest: string;
  readonly idempotencyKey: string;
}

export type MaintainerPublicationRequest = PrepareRequest | BoundRequest;

function record(input: unknown): Record<string, unknown> | undefined {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  );
}

export function parseMaintainerPublicationRequest(
  input: unknown,
): MaintainerPublicationRequest | undefined {
  const value = record(input);
  if (value === undefined || typeof value.action !== "string") return undefined;
  if (value.action === "prepare-publication") return parsePrepare(value);
  if (
    value.action === "approve-publication" ||
    value.action === "cancel-publication-route-private"
  ) {
    return parseBound(value, value.action);
  }
  return undefined;
}

function parsePrepare(value: Record<string, unknown>): PrepareRequest | undefined {
  const keys = ["action", "expectedVersion", "targetKey", "idempotencyKey"];
  if (!exact(value, keys) || !Number.isSafeInteger(value.expectedVersion)) return undefined;
  if ((value.expectedVersion as number) < 1) return undefined;
  if (typeof value.targetKey !== "string" || !TARGET_KEY.test(value.targetKey)) return undefined;
  if (typeof value.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(value.idempotencyKey))
    return undefined;
  return {
    action: "prepare-publication",
    expectedVersion: value.expectedVersion as number,
    targetKey: value.targetKey,
    idempotencyKey: value.idempotencyKey,
  };
}

function parseBound(
  value: Record<string, unknown>,
  action: BoundRequest["action"],
): BoundRequest | undefined {
  const keys = [
    "action",
    "preparationId",
    "expectedProjectionDigest",
    "expectedTargetPolicyDigest",
    "idempotencyKey",
  ];
  if (!exact(value, keys) || !validId(value.preparationId)) return undefined;
  if (
    typeof value.expectedProjectionDigest !== "string" ||
    !SHA256.test(value.expectedProjectionDigest)
  )
    return undefined;
  if (
    typeof value.expectedTargetPolicyDigest !== "string" ||
    !SHA256.test(value.expectedTargetPolicyDigest)
  )
    return undefined;
  if (typeof value.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(value.idempotencyKey))
    return undefined;
  return {
    action,
    preparationId: value.preparationId,
    expectedProjectionDigest: value.expectedProjectionDigest,
    expectedTargetPolicyDigest: value.expectedTargetPolicyDigest,
    idempotencyKey: value.idempotencyKey,
  };
}

export function maintainerPublicationActor(identity: {
  readonly issuer: string;
  readonly subject: string;
  readonly permissionPolicyVersion: string;
}): FeedbackReviewActorV1 {
  return {
    issuer: identity.issuer,
    subject: identity.subject,
    permissionPolicyVersion: identity.permissionPolicyVersion,
  };
}
