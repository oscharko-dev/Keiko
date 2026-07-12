import type {
  FeedbackPublicationApprovalResponseV1,
  FeedbackPublicationCancelResponseV1,
  FeedbackPublicationFailureCodeV1,
  FeedbackPublicationPreparedResponseV1,
  FeedbackPublicationTargetPolicySnapshotV1,
} from "@oscharko-dev/keiko-contracts/feedback-publication";

export type FeedbackPublicationErrorCode =
  | FeedbackPublicationFailureCodeV1
  | "not-found"
  | "invalid-request"
  | "invalid-actor"
  | "invalid-transition"
  | "claim-unavailable";

export class FeedbackPublicationError extends Error {
  constructor(readonly code: FeedbackPublicationErrorCode) {
    super(`Feedback publication mutation failed: ${code}`);
    this.name = "FeedbackPublicationError";
  }
}

export interface ApprovedFeedbackIssueProjection {
  readonly outboxId: string;
  readonly preparationId: string;
  readonly itemId: string;
  readonly title: string;
  readonly body: string;
  readonly projectionDigest: string;
  readonly reconciliationMarker: string;
  readonly target: FeedbackPublicationTargetPolicySnapshotV1;
  readonly targetPolicyDigest: string;
  readonly leaseOwner: string;
  readonly leaseExpiresAt: Date;
}

export interface FeedbackPublicationClaim {
  readonly outboxId: string;
  readonly workerId: string;
  readonly leaseDurationMs: number;
}

export interface FeedbackGithubIssueLinkage {
  readonly itemId: string;
  readonly preparationId: string;
  readonly targetPolicyDigest: string;
  readonly repositoryId: string;
  readonly issueNodeId: string;
  readonly issueNumber: number;
  readonly linkedAt: Date;
}

export type FeedbackPublicationMutationResponse =
  | FeedbackPublicationPreparedResponseV1
  | FeedbackPublicationApprovalResponseV1
  | FeedbackPublicationCancelResponseV1;
