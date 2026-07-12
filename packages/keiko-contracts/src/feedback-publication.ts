import type { FeedbackReviewActorV1 } from "./feedback-review.js";

export const FEEDBACK_PUBLICATION_PROJECTION_VERSION_V1 = "github-issue-v1" as const;
export const FEEDBACK_GITHUB_API_ORIGIN_V1 = "https://api.github.com" as const;

export const FEEDBACK_PUBLICATION_OUTBOX_STATUSES_V1 = [
  "unclaimed",
  "claimed",
  "may-have-committed",
  "retryable-failure",
  "manual-reconciliation",
  "succeeded",
  "cancelled-private",
] as const;
export type FeedbackPublicationOutboxStatusV1 =
  (typeof FEEDBACK_PUBLICATION_OUTBOX_STATUSES_V1)[number];

export const FEEDBACK_PUBLICATION_FAILURE_CODES_V1 = [
  "permission-denied",
  "validation-error",
  "rate-limited",
  "repository-unavailable",
  "provider-unavailable",
  "duplicate-candidate",
  "target-policy-drift",
  "projection-drift",
  "payload-private",
  "payload-expired",
  "cas-mismatch",
  "idempotency-mismatch",
  "retry-exhausted",
  "lease-expired",
  "ambiguous-reconciliation",
  "manual-reconciliation-required",
  "manual-remediation-required",
] as const;
export type FeedbackPublicationFailureCodeV1 =
  (typeof FEEDBACK_PUBLICATION_FAILURE_CODES_V1)[number];

export interface FeedbackPublicationTargetPolicySnapshotV1 {
  readonly apiOrigin: typeof FEEDBACK_GITHUB_API_ORIGIN_V1;
  readonly repositoryId: string;
  readonly owner: string;
  readonly repository: string;
  readonly installationId: string;
  readonly labels: readonly string[];
  readonly targetKey: string;
  readonly labelPolicyVersion: string;
  readonly targetPolicyVersion: string;
}

interface FeedbackPublicationCommandBaseV1 {
  readonly itemId: string;
  readonly expectedVersion: number;
  readonly expectedPayloadDigest: string;
  readonly idempotencyKey: string;
  readonly actor: FeedbackReviewActorV1;
}

export interface FeedbackPublicationPrepareCommandV1 extends FeedbackPublicationCommandBaseV1 {
  readonly action: "prepare-publication";
  readonly targetKey: string;
}

export interface FeedbackPublicationApproveCommandV1 extends FeedbackPublicationCommandBaseV1 {
  readonly action: "approve-publication";
  readonly preparationId: string;
  readonly expectedProjectionDigest: string;
  readonly expectedTargetPolicyDigest: string;
}

export interface FeedbackPublicationCancelCommandV1 extends FeedbackPublicationCommandBaseV1 {
  readonly action: "cancel-publication-route-private";
  readonly preparationId: string;
  readonly expectedProjectionDigest: string;
  readonly expectedTargetPolicyDigest: string;
}

export type FeedbackPublicationCommandV1 =
  | FeedbackPublicationPrepareCommandV1
  | FeedbackPublicationApproveCommandV1
  | FeedbackPublicationCancelCommandV1;

export interface FeedbackPublicationPreparedResponseV1 {
  readonly status: "prepared";
  readonly itemId: string;
  readonly preparationId: string;
  readonly recordVersion: number;
  readonly projectionDigest: string;
  readonly targetPolicyDigest: string;
  readonly reconciliationMarker: string;
  readonly title: string;
  readonly body: string;
  readonly targetDisplay: {
    readonly owner: string;
    readonly repository: string;
    readonly labels: readonly string[];
    readonly labelPolicyVersion: string;
    readonly targetPolicyVersion: string;
  };
  readonly expiresAt: string;
  readonly replayed: boolean;
}

export type FeedbackPublicationApprovalResponseV1 =
  | {
      readonly status: "approved";
      readonly itemId: string;
      readonly preparationId: string;
      readonly recordVersion: number;
      readonly outboxId: string;
      readonly replayed: boolean;
    }
  | {
      readonly status: "manual-reconciliation" | "manual-remediation";
      readonly itemId: string;
      readonly preparationId: string;
      readonly recordVersion: number;
      readonly failure: "manual-reconciliation-required" | "manual-remediation-required";
      readonly replayed: boolean;
    };

export type FeedbackPublicationCancelResponseV1 =
  | {
      readonly status: "cancelled-private";
      readonly itemId: string;
      readonly preparationId: string;
      readonly recordVersion: number;
      readonly replayed: boolean;
    }
  | {
      readonly status: "manual-reconciliation" | "manual-remediation";
      readonly itemId: string;
      readonly preparationId: string;
      readonly recordVersion: number;
      readonly failure: "manual-reconciliation-required" | "manual-remediation-required";
      readonly replayed: boolean;
    };

export interface FeedbackPublicationPreviewV1 {
  readonly status: "prepared" | "approved";
  readonly itemId: string;
  readonly preparationId: string;
  readonly projectionDigest: string;
  readonly targetPolicyDigest: string;
  readonly title: string;
  readonly body: string;
  readonly targetDisplay: FeedbackPublicationTargetDisplayV1;
  readonly expiresAt: string;
}

export interface FeedbackPublicationTargetDisplayV1 {
  readonly owner: string;
  readonly repository: string;
  readonly labels: readonly string[];
  readonly labelPolicyVersion: string;
  readonly targetPolicyVersion: string;
}

export type FeedbackPublicationMaintainerStatusV1 =
  | "none"
  | "prepared"
  | "approved"
  | "retryable"
  | "may-have-committed"
  | "manual-reconciliation"
  | "manual-remediation"
  | "succeeded"
  | "cancelled-private";

export interface FeedbackPublicationStatusV1 {
  readonly itemId: string;
  readonly status: FeedbackPublicationMaintainerStatusV1;
  readonly preparationId?: string | undefined;
  readonly projectionDigest?: string | undefined;
  readonly targetPolicyDigest?: string | undefined;
  readonly failureCode?: FeedbackPublicationFailureCodeV1 | undefined;
  readonly retryAt?: string | undefined;
  readonly linkage?: { readonly issueNumber: number; readonly issueUrl: string } | undefined;
}

const DECIMAL_ID = /^[1-9][0-9]{0,19}$/u;
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}$/u;
const TARGET_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;
const LABEL_POLICY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const TARGET_POLICY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function validLabels(labels: unknown): labels is readonly string[] {
  if (!Array.isArray(labels) || labels.length > 20) return false;
  for (const label of labels) {
    if (typeof label !== "string" || label.length === 0) return false;
    if (new TextEncoder().encode(label).length > 50 || hasControlCharacter(label)) return false;
  }
  return new Set(labels).size === labels.length;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)) return true;
  }
  return false;
}

function matches(value: unknown, pattern: RegExp): boolean {
  return typeof value === "string" && pattern.test(value);
}

function validDecimalId(value: unknown): boolean {
  if (typeof value !== "string" || !DECIMAL_ID.test(value)) return false;
  return BigInt(value) <= MAX_POSTGRES_BIGINT;
}

export function isFeedbackPublicationTargetPolicySnapshotV1(
  value: unknown,
): value is FeedbackPublicationTargetPolicySnapshotV1 {
  if (typeof value !== "object" || value === null) return false;
  const target = value as Partial<FeedbackPublicationTargetPolicySnapshotV1>;
  return [
    target.apiOrigin === FEEDBACK_GITHUB_API_ORIGIN_V1,
    validDecimalId(target.repositoryId),
    validDecimalId(target.installationId),
    matches(target.owner, OWNER),
    matches(target.repository, REPOSITORY),
    validLabels(target.labels),
    matches(target.targetKey, TARGET_KEY),
    matches(target.labelPolicyVersion, LABEL_POLICY_VERSION),
    matches(target.targetPolicyVersion, TARGET_POLICY_VERSION),
  ].every(Boolean);
}
