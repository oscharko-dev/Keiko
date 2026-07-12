import type { ApprovedFeedbackIssueProjection } from "./feedback-publication-types.js";

export const FEEDBACK_PUBLICATION_MAX_CREATE_ATTEMPTS = 3;
export const FEEDBACK_PUBLICATION_MIN_RETRY_MS = 1_000;
export const FEEDBACK_PUBLICATION_MAX_RETRY_MS = 3_600_000;

export type FeedbackPublicationWorkerMode = "create-eligible" | "reconcile-only";

export interface FeedbackPublicationWorkerOptions {
  readonly workerId: string;
  readonly leaseDurationMs: number;
  readonly candidateLimit?: number | undefined;
}

export interface FeedbackPublicationWorkerLease extends ApprovedFeedbackIssueProjection {
  readonly mode: FeedbackPublicationWorkerMode;
  readonly createAttemptCount: number;
}

export interface FeedbackPublicationLeaseIdentity {
  readonly outboxId: string;
  readonly preparationId: string;
  readonly itemId: string;
  readonly targetPolicyDigest: string;
  readonly leaseOwner: string;
  readonly leaseExpiresAt: Date;
}

export interface FeedbackPublicationSuccess {
  readonly repositoryId: string;
  readonly issueNodeId: string;
  readonly issueNumber: number;
}

export type FeedbackPublicationCircuitGate =
  | { readonly allowed: true; readonly probe: boolean }
  | { readonly allowed: false; readonly delayMs: number };

export type FeedbackPublicationRetryCode = "rate-limited" | "provider-unavailable";

export type FeedbackPublicationManualCode =
  | "permission-denied"
  | "validation-error"
  | "repository-unavailable"
  | "duplicate-candidate"
  | "target-policy-drift"
  | "projection-drift"
  | "payload-private"
  | "payload-expired"
  | "retry-exhausted"
  | "lease-expired"
  | "ambiguous-reconciliation";

export function leaseIdentity(
  lease: FeedbackPublicationWorkerLease,
): FeedbackPublicationLeaseIdentity {
  return {
    outboxId: lease.outboxId,
    preparationId: lease.preparationId,
    itemId: lease.itemId,
    targetPolicyDigest: lease.targetPolicyDigest,
    leaseOwner: lease.leaseOwner,
    leaseExpiresAt: lease.leaseExpiresAt,
  };
}
