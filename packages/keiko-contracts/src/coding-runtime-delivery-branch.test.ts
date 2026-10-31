import { describe, expect, it } from "vitest";
import {
  CODING_RUNTIME_DELIVERY_UNAVAILABLE_REASONS,
  isCodingRuntimeDeliveryResult,
  isCodingRuntimeDeliveryReview,
} from "./coding-runtime-delivery.js";
import { validateCodingWorkbenchRuntimeApprovalReviewChannelPayload } from "./coding-workbench-runtime-approval-review.js";
import type { DraftDeliveryRecord } from "./draft-delivery.js";

const digest = "a".repeat(64);
function branchPush(phase: "push-proposed" | "pr-proposed" = "push-proposed"): DraftDeliveryRecord {
  return {
    schemaVersion: "1",
    revision: 0,
    phase,
    reason: "approval-required",
    proposalId: "delivery-1",
    proposalDigest: digest,
    recordedAt: "2026-09-05T00:00:00.000Z",
    binding: {
      kind: "branch-push",
      runId: "run-1",
      workspaceDigest: digest,
      runtimeAuthorityDigest: digest,
      envelopeDigest: digest,
      remoteDigest: digest,
      remoteAlias: "origin",
      baseRef: "master",
      baseSha: "1".repeat(40),
      headRef: "claude/task",
      headSha: "2".repeat(40),
      verifiedCommitProposalId: "commit-1",
      recoveryId: "recovery-1",
    },
  };
}

describe("issue-free delivery reasons and review", () => {
  it.each(["repository-required", "remote-required", "issue-binding-required"])(
    "names %s as a closed unavailable reason",
    (reason) => {
      expect(CODING_RUNTIME_DELIVERY_UNAVAILABLE_REASONS).toContain(reason);
      expect(isCodingRuntimeDeliveryResult({ status: "unavailable", reason })).toBe(true);
    },
  );

  it("carries a branch-push record as a recorded result and an approvable push review", () => {
    expect(isCodingRuntimeDeliveryResult({ status: "recorded", record: branchPush() })).toBe(true);
    expect(isCodingRuntimeDeliveryReview({ record: branchPush() })).toBe(true);
    expect(
      validateCodingWorkbenchRuntimeApprovalReviewChannelPayload({
        session: "active",
        pending: {
          requestId: "delivery-1",
          paths: [],
          pathsTruncated: false,
          fileCount: 0,
          addedLines: 0,
          deletedLines: 0,
          draftDelivery: { record: branchPush() },
        },
      }).ok,
    ).toBe(true);
  });

  it("never lets a branch-push record stand for a pull request proposal", () => {
    const review = { record: branchPush("pr-proposed"), title: "feat: change", body: "Body" };
    expect(isCodingRuntimeDeliveryReview(review)).toBe(false);
    expect(isCodingRuntimeDeliveryResult({ status: "recorded", record: review.record })).toBe(
      false,
    );
  });
});
