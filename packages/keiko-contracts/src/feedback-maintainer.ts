import type { FeedbackReviewStateV1 } from "./feedback-review.js";

export const FEEDBACK_MAINTAINER_PERMISSIONS_V1 = [
  "feedback.review",
  "feedback.security",
  "feedback.legal-hold",
  "feedback.publish",
  "feedback.audit",
] as const;
export type FeedbackMaintainerPermissionV1 = (typeof FEEDBACK_MAINTAINER_PERMISSIONS_V1)[number];

export const FEEDBACK_MAINTAINER_PATH_PREFIX_V1 = "/v1/maintainer";
export const FEEDBACK_MAINTAINER_SESSION_COOKIE_V1 = "__Host-keiko-feedback-session";
export const FEEDBACK_MAINTAINER_OIDC_COOKIE_V1 = "__Host-keiko-feedback-oidc";
export const FEEDBACK_MAINTAINER_CSRF_HEADER_V1 = "keiko-feedback-csrf";

export interface FeedbackMaintainerSessionV1 {
  readonly permissions: readonly FeedbackMaintainerPermissionV1[];
  readonly csrfToken: string;
  readonly absoluteExpiresAt: string;
  readonly legalHoldPolicyKeys?: readonly string[] | undefined;
  readonly publicationTargets?: readonly FeedbackPublicationTargetCatalogItemV1[] | undefined;
}

export interface FeedbackPublicationTargetCatalogItemV1 {
  readonly targetKey: string;
  readonly owner: string;
  readonly repository: string;
  readonly labels: readonly string[];
  readonly targetPolicyVersion: string;
  readonly projectionPolicyVersion: "github-issue-v1";
}

export interface FeedbackReviewListItemV1 {
  readonly itemId: string;
  readonly reviewGroupId: string;
  readonly groupCount: number;
  readonly payloadDigest: string;
  readonly state: FeedbackReviewStateV1;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly category: string;
  readonly featureArea: string;
  readonly impact: string;
  readonly severityCounts?:
    { readonly errors: number; readonly warnings: number; readonly infos: number } | undefined;
}

export interface FeedbackReviewListPageV1 {
  readonly items: readonly FeedbackReviewListItemV1[];
  readonly nextCursor?: string | undefined;
}

export interface FeedbackReviewDetailV1 extends FeedbackReviewListItemV1 {
  readonly canonicalPayload: string;
  readonly legalHold:
    | { readonly status: "none" }
    | {
        readonly status: "active" | "expired";
        readonly policyKey: string;
        readonly reviewAt: string;
        readonly expiresAt: string;
      };
}

export interface FeedbackReviewHoldGovernanceV1 {
  readonly itemId: string;
  readonly payloadDigest: string;
  readonly version: number;
  readonly legalHold:
    | { readonly status: "none" }
    | {
        readonly status: "active" | "expired";
        readonly policyKey: string;
        readonly reviewAt: string;
        readonly expiresAt: string;
      };
}

export interface FeedbackReviewAuditV1 {
  readonly eventId: string;
  readonly itemId: string;
  readonly payloadDigest: string;
  readonly priorVersion: number;
  readonly resultVersion: number;
  readonly action: string;
  readonly priorState: FeedbackReviewStateV1;
  readonly resultState: FeedbackReviewStateV1;
  readonly result: "applied";
  readonly eventAt: string;
  readonly issuer: string;
  readonly subject: string;
  readonly permissionPolicyVersion: string;
  readonly policyKey?: string | undefined;
}

export function isFeedbackMaintainerPermissionV1(
  value: unknown,
): value is FeedbackMaintainerPermissionV1 {
  return (
    typeof value === "string" &&
    (FEEDBACK_MAINTAINER_PERMISSIONS_V1 as readonly string[]).includes(value)
  );
}
