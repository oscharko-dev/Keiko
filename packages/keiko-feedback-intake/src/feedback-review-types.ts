import type {
  FeedbackLegalHoldPolicyKeyV1,
  FeedbackRejectionReasonV1,
  FeedbackReviewActorV1,
  FeedbackReviewStateV1,
} from "@oscharko-dev/keiko-contracts/feedback-review";

interface ReviewCommandBase {
  readonly itemId: string;
  readonly expectedVersion: number;
  readonly expectedPayloadDigest: string;
  readonly idempotencyKey: string;
  readonly actor: FeedbackReviewActorV1;
}

export type FeedbackReviewCommand =
  | (ReviewCommandBase & { readonly action: "archive" | "route-private-security" | "expire" })
  | (ReviewCommandBase & {
      readonly action: "mark-duplicate";
      readonly targetItemId: string;
    })
  | (ReviewCommandBase & {
      readonly action: "reject";
      readonly reason: FeedbackRejectionReasonV1;
    })
  | (ReviewCommandBase & {
      readonly action: "place-legal-hold";
      readonly policyKey: FeedbackLegalHoldPolicyKeyV1;
      readonly reviewAt: Date;
      readonly expiresAt: Date;
    })
  | (ReviewCommandBase & { readonly action: "release-legal-hold" | "expire-legal-hold" });

export interface FeedbackReviewMutationResult {
  readonly itemId: string;
  readonly state: FeedbackReviewStateV1;
  readonly version: number;
  readonly at: Date;
  readonly replayed: boolean;
}

export interface FeedbackReviewRecord {
  readonly itemId: string;
  readonly payloadId: string;
  readonly payloadDigest: string;
  readonly state: FeedbackReviewStateV1;
  readonly version: number;
  readonly hasActiveLegalHold: boolean;
}

export type FeedbackReviewErrorCode =
  | "not-found"
  | "cas-mismatch"
  | "idempotency-mismatch"
  | "invalid-transition"
  | "invalid-duplicate-target"
  | "invalid-legal-hold"
  | "invalid-actor"
  | "invalid-request"
  | "payload-digest-drift"
  | "payload-expired";

export class FeedbackReviewError extends Error {
  constructor(readonly code: FeedbackReviewErrorCode) {
    super(`Feedback review mutation failed: ${code}`);
    this.name = "FeedbackReviewError";
  }
}
