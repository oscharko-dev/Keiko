export const FEEDBACK_REVIEW_STATES_V1 = [
  "pending",
  "approved",
  "duplicate",
  "rejected",
  "archived",
  "private-security",
  "expired",
] as const;

export type FeedbackReviewStateV1 = (typeof FEEDBACK_REVIEW_STATES_V1)[number];

export const FEEDBACK_REVIEW_ACTIONS_V1 = [
  "mark-duplicate",
  "reject",
  "archive",
  "route-private-security",
  "expire",
  "place-legal-hold",
  "release-legal-hold",
  "expire-legal-hold",
] as const;

export type FeedbackReviewActionV1 = (typeof FEEDBACK_REVIEW_ACTIONS_V1)[number];

export const FEEDBACK_REJECTION_REASONS_V1 = [
  "insufficient-information",
  "not-actionable",
  "out-of-scope",
  "policy-violation",
] as const;
export type FeedbackRejectionReasonV1 = (typeof FEEDBACK_REJECTION_REASONS_V1)[number];

export const FEEDBACK_LEGAL_HOLD_POLICY_KEY_MAX_LENGTH_V1 = 64;
export const FEEDBACK_LEGAL_HOLD_POLICY_KEY_MAX_COUNT_V1 = 32;
const LEGAL_HOLD_POLICY_KEY = /^[a-z][a-z0-9-]{0,63}$/u;
export type FeedbackLegalHoldPolicyKeyV1 = string;

export function isFeedbackLegalHoldPolicyKeyV1(
  value: unknown,
): value is FeedbackLegalHoldPolicyKeyV1 {
  return typeof value === "string" && LEGAL_HOLD_POLICY_KEY.test(value);
}

export function isFeedbackLegalHoldPolicyAllowlistV1(
  value: readonly string[],
): value is readonly FeedbackLegalHoldPolicyKeyV1[] {
  return (
    value.length <= FEEDBACK_LEGAL_HOLD_POLICY_KEY_MAX_COUNT_V1 &&
    value.every(isFeedbackLegalHoldPolicyKeyV1) &&
    new Set(value).size === value.length
  );
}

export interface FeedbackReviewActorV1 {
  readonly issuer: string;
  readonly subject: string;
  readonly permissionPolicyVersion: string;
}

export const FEEDBACK_REVIEW_ACTOR_ISSUER_MAX_LENGTH_V1 = 2_048;
export const FEEDBACK_REVIEW_ACTOR_SUBJECT_MAX_LENGTH_V1 = 255;
export const FEEDBACK_REVIEW_PERMISSION_POLICY_MAX_LENGTH_V1 = 64;

function hasForbiddenActorControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159))) {
      return true;
    }
  }
  return false;
}

function isBoundedActorValue(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !hasForbiddenActorControl(value)
  );
}

export function isFeedbackReviewActorV1(value: unknown): value is FeedbackReviewActorV1 {
  if (typeof value !== "object" || value === null) return false;
  const actor = value as Partial<FeedbackReviewActorV1>;
  return (
    isBoundedActorValue(actor.issuer, FEEDBACK_REVIEW_ACTOR_ISSUER_MAX_LENGTH_V1) &&
    isBoundedActorValue(actor.subject, FEEDBACK_REVIEW_ACTOR_SUBJECT_MAX_LENGTH_V1) &&
    isBoundedActorValue(
      actor.permissionPolicyVersion,
      FEEDBACK_REVIEW_PERMISSION_POLICY_MAX_LENGTH_V1,
    )
  );
}

export interface FeedbackApprovalBindingV1 {
  readonly payloadDigest: string;
  readonly reconciliationMarker: string;
  readonly issueProjectionDigest: string;
  readonly targetKey: string;
  readonly labelPolicyVersion: string;
  readonly actor: FeedbackReviewActorV1;
  readonly recordVersion: number;
}

export type FeedbackReviewTransitionDecisionV1 =
  { readonly allowed: true; readonly state: FeedbackReviewStateV1 } | { readonly allowed: false };

const PENDING_TARGETS: Readonly<Partial<Record<FeedbackReviewActionV1, FeedbackReviewStateV1>>> = {
  "mark-duplicate": "duplicate",
  reject: "rejected",
  archive: "archived",
  "route-private-security": "private-security",
  expire: "expired",
};

export function feedbackReviewTransitionV1(
  state: FeedbackReviewStateV1,
  action: FeedbackReviewActionV1,
  hasActiveLegalHold: boolean,
): FeedbackReviewTransitionDecisionV1 {
  if (action === "place-legal-hold") {
    return hasActiveLegalHold ? { allowed: false } : { allowed: true, state };
  }
  if (action === "release-legal-hold" || action === "expire-legal-hold") {
    return hasActiveLegalHold ? { allowed: true, state } : { allowed: false };
  }
  const target = state === "pending" ? PENDING_TARGETS[action] : undefined;
  return target === undefined ? { allowed: false } : { allowed: true, state: target };
}

export function isFeedbackReviewActionV1(value: unknown): value is FeedbackReviewActionV1 {
  return (
    typeof value === "string" && (FEEDBACK_REVIEW_ACTIONS_V1 as readonly string[]).includes(value)
  );
}
