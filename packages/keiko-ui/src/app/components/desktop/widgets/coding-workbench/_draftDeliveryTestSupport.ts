import type {
  CodingWorkbenchRuntimePendingApprovalReview,
  CodingWorkbenchRuntimeSnapshot,
} from "@oscharko-dev/keiko-contracts";
import type { DraftDeliveryRecord } from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";

const digest = "a".repeat(64);
const DELIVERY: DraftDeliveryRecord = {
  schemaVersion: "1",
  revision: 5,
  phase: "draft-created",
  reason: "completed",
  proposalId: "draft-1",
  proposalDigest: digest,
  recordedAt: "2026-09-05T00:00:00.000Z",
  binding: {
    runId: "run-1",
    workspaceDigest: digest,
    runtimeAuthorityDigest: digest,
    envelopeDigest: digest,
    remoteDigest: digest,
    issueBindingDigest: digest,
    issueIdDigest: digest,
    issueNumber: 42,
    repository: "owner/repository",
    remoteAlias: "origin",
    baseRef: "main",
    baseSha: "1".repeat(40),
    headRef: "feature/issue-42",
    headSha: "3".repeat(40),
    verifiedCommitProposalId: "commit-1",
    recoveryId: "delivery-1",
  },
  pullRequest: {
    number: 7,
    externalId: "PR_fixture7",
    url: "https://github.com/owner/repository/pull/7",
    repository: "owner/repository",
    headRepository: "owner/repository",
    headRef: "feature/issue-42",
    headSha: "3".repeat(40),
    baseRef: "main",
    baseSha: "1".repeat(40),
    state: "open",
    isDraft: true,
  },
};

export function draftDeliverySnapshot(
  overrides: Partial<DraftDeliveryRecord> = {},
): CodingWorkbenchRuntimeSnapshot {
  return structuredClone({
    schemaVersion: "1",
    state: "succeeded",
    revision: 1,
    updatedAt: "2026-09-05T00:00:00.000Z",
    runId: "run-1",
    issueBinding: {
      schemaVersion: "1",
      repositoryId: "repository-1",
      remoteDigest: digest,
      issueIdDigest: digest,
      contentRevisionDigest: digest,
      bindingDigest: digest,
      issueNumber: 42,
      defaultBaseRef: "main",
    },
    draftDelivery: { ...DELIVERY, ...overrides },
  });
}

export function draftDeliveryReview(
  action: "push" | "pull-request",
): CodingWorkbenchRuntimePendingApprovalReview {
  const record = draftDeliverySnapshot({
    phase: action === "push" ? "push-proposed" : "pr-proposed",
    reason: "approval-required",
    proposalId: "delivery-1",
  }).draftDelivery;
  if (record === undefined) throw new Error("Delivery fixture requires a record");
  return {
    requestId: record.proposalId,
    paths: [],
    pathsTruncated: false,
    fileCount: 0,
    addedLines: 0,
    deletedLines: 0,
    draftDelivery:
      action === "push"
        ? { record }
        : {
            record,
            title: "fix: exact reviewed delivery <script>",
            body: "Original template <img src=x>\n\nCloses #42\n\nTrusted region",
          },
  };
}
