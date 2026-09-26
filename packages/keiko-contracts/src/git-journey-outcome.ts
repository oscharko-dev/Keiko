import type { GitDeliveryObservationFailure } from "./git-delivery-observation.js";
import type { GitPullRequestIdentity } from "./git-pull-request-identity.js";
import type { ReadinessSnapshot } from "./git-ci-readiness.js";
import type { PrDescriptionApplicationStatus } from "./pr-description-application.js";

export const GIT_JOURNEY_REASON_STATES = Object.freeze({
  "ready-approval-required": "awaiting-ready-approval",
  "technical-ready": "keiko-technical-ready",
  "human-review-ready": "ready-for-human-review",
  "required-reviews-missing": "awaiting-human-requirements",
  "changes-requested": "awaiting-human-requirements",
  "unresolved-conversations": "awaiting-human-requirements",
  "review-visibility-unknown": "awaiting-human-requirements",
  "issue-closure-pending": "merged-awaiting-issue-closure",
  "merge-and-closure-observed": "completed",
  "closed-unmerged": "blocked",
  "issue-closed-without-merge": "blocked",
  retargeted: "blocked",
  "head-changed": "blocked",
  "readiness-unavailable": "blocked",
  "readiness-stale": "blocked",
  "checks-not-ready": "blocked",
  "description-unavailable": "blocked",
  "description-stale": "blocked",
  "description-not-applied": "blocked",
  "provider-unavailable": "blocked",
  "authority-denied": "blocked",
  "observation-superseded": "blocked",
  cancelled: "cancelled",
  "ready-effect-uncertain": "recovery-required",
} as const);
export type GitJourneyReason = keyof typeof GIT_JOURNEY_REASON_STATES;
export type GitJourneyState = (typeof GIT_JOURNEY_REASON_STATES)[GitJourneyReason];

/** Accepted task identity. No grant, approval token or mutation authority can be reconstructed from it. */
export interface GitJourneyBinding {
  readonly runId: string;
  readonly remoteDigest: string;
  readonly issueBindingDigest: string;
  readonly issueIdDigest: string;
  readonly issueNumber: number;
  readonly repository: string;
  readonly prNumber: number;
  readonly prExternalId: string;
  readonly baseRef: string;
  readonly headRef: string;
  readonly headSha: string;
}
/** Exact canonical provider facts; no comments, review bodies, actors or per-thread identities. */
export interface GitJourneyRemoteFacts {
  readonly status: "observed";
  readonly identity: GitPullRequestIdentity;
  readonly repositoryId: number;
  readonly defaultBranchRef: string;
  readonly mergedAt: string | null;
  readonly mergeCommitSha: string | null;
  readonly reviewDecision: "approved" | "changes-requested" | "review-required" | "unknown";
  readonly issue: {
    readonly number: number;
    readonly state: "open" | "closed";
    readonly closedAt: string | null;
  };
  readonly reviewConversations: {
    readonly total: number;
    readonly unresolved: number;
    readonly resolved: number;
  };
  readonly factsDigest: string;
}
/** Observed completion and Keiko description completeness remain independently visible facts. */
export interface JourneyOutcome {
  readonly schemaVersion: "1";
  readonly binding: GitJourneyBinding;
  readonly state: GitJourneyState;
  readonly reason: GitJourneyReason;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly evidenceRef: string;
  readonly remote: GitJourneyRemoteFacts | null;
  readonly observationFailure: GitDeliveryObservationFailure | null;
  readonly readiness: ReadinessSnapshot | null;
  readonly description: PrDescriptionApplicationStatus | null;
  readonly keikoDescriptionApplied: boolean;
}
