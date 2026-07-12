import type { FeedbackPublicationTargetPolicySnapshotV1 } from "@oscharko-dev/keiko-contracts/feedback-publication";
import type { Server } from "node:http";

export const NOW = new Date("2026-07-12T21:30:00.000Z");
export const SENSITIVE_CANARY = "feedback-secret.example.test";
export const BENIGN_CANARY = "Bearer";

export const TARGET: FeedbackPublicationTargetPolicySnapshotV1 = {
  apiOrigin: "https://api.github.com",
  repositoryId: "2077",
  owner: "keiko-feedback",
  repository: "public-findings",
  installationId: "2077",
  labels: ["source: feedback"],
  targetKey: "public-findings",
  labelPolicyVersion: "feedback-v1",
  targetPolicyVersion: "feedback-target-v1",
};

export const ACTOR = {
  issuer: "https://maintainer.example.test",
  subject: "feedback-maintainer",
  permissionPolicyVersion: "feedback-review-v1",
} as const;

export interface FeedbackFlowResult {
  readonly createdIssues: number;
  readonly exactBytesPreserved: boolean;
  readonly maintainerBoundaryEnforced: boolean;
  readonly publicIssueNumber: number;
  readonly publicIssueUrl: string;
  readonly receiptContentFree: boolean;
  readonly redactionPreserved: boolean;
}

export interface StartedServer {
  readonly origin: string;
  readonly server: Server;
}

export interface StoredPayload {
  readonly id: string;
  readonly exactBodySha256: string;
  readonly canonicalBytes: Buffer;
}

export interface PreparedFeedback {
  readonly canonicalJson: string;
  readonly exactBodySha256: string;
}

export interface SubmittedFeedback extends PreparedFeedback {
  readonly receipt: {
    readonly receiptId: string;
    readonly receiptSecret: string;
    readonly expiresAt: string;
  };
}

export type NegativeScenario = "unsafe" | "unavailable" | "rate-limited" | "github-permission";

export interface NegativeResult {
  readonly createdIssues: number;
  readonly persistedPayloads: number;
  readonly rejectedAttemptDidNotPersist: boolean;
  readonly safeTerminalState: boolean;
}
