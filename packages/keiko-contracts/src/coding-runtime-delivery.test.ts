import { describe, expect, it } from "vitest";
import {
  isCodingRuntimeDeliveryResult,
  isCodingRuntimeDeliveryReview,
  CODING_RUNTIME_DELIVERY_UNAVAILABLE_REASONS,
} from "./coding-runtime-delivery.js";
import { validateCodingWorkbenchRuntimeApprovalReviewChannelPayload } from "./coding-workbench-runtime-approval-review.js";
import type { DraftDeliveryRecord } from "./draft-delivery.js";
const digest = "a".repeat(64);
function proposed(phase: "push-proposed" | "pr-proposed" = "push-proposed"): DraftDeliveryRecord {
  return {
    schemaVersion: "1",
    revision: 0,
    phase,
    reason: "approval-required",
    proposalId: "delivery-1",
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
      issueNumber: 1,
      repository: "owner/repository",
      remoteAlias: "origin",
      baseRef: "master",
      baseSha: "1".repeat(40),
      headRef: "feature/issue-1",
      headSha: "2".repeat(40),
      verifiedCommitProposalId: "commit-1",
      recoveryId: "recovery-1",
    },
  };
}
function pending(draftDelivery: unknown): Record<string, unknown> {
  return {
    requestId: "delivery-1",
    paths: [],
    pathsTruncated: false,
    fileCount: 0,
    addedLines: 0,
    deletedLines: 0,
    draftDelivery,
  };
}
function validPending(value: unknown): boolean {
  return validateCodingWorkbenchRuntimeApprovalReviewChannelPayload({
    session: "active",
    pending: value,
  }).ok;
}
describe("closed runtime delivery result", () => {
  it.each(CODING_RUNTIME_DELIVERY_UNAVAILABLE_REASONS)(
    "accepts bounded unavailable reason %s",
    (reason) => {
      expect(isCodingRuntimeDeliveryResult({ status: "unavailable", reason })).toBe(true);
    },
  );
  it("carries only a closed body-free durable record", () => {
    expect(isCodingRuntimeDeliveryResult({ status: "recorded", record: proposed() })).toBe(true);
  });
  it.each([
    null,
    [],
    {},
    { status: "unavailable", reason: "unknown" },
    { status: "unavailable", reason: "authority-denied", approvalToken: "private" },
    { status: "recorded", record: { ...proposed(), body: "private" } },
    { status: "recorded", record: { ...proposed(), reason: "completed" } },
    { status: "recorded", record: proposed(), title: "private" },
  ])("rejects malformed or text-bearing result %j", (value) => {
    expect(isCodingRuntimeDeliveryResult(value)).toBe(false);
  });
});
describe("authenticated transient draft delivery approval", () => {
  it.each(["push-proposed", "pr-proposed"] as const)(
    "accepts complete %s review only on its matching channel",
    (phase) => {
      const review = {
        record: proposed(phase),
        ...(phase === "pr-proposed" ? { title: "feat: change", body: "Closes #1" } : {}),
      };
      expect(isCodingRuntimeDeliveryReview(review)).toBe(true);
      expect(validPending(pending(review))).toBe(true);
      expect(validPending({ ...pending(review), requestId: "delivery-2" })).toBe(false);
      expect(
        validateCodingWorkbenchRuntimeApprovalReviewChannelPayload({
          session: "unpaired",
          pending: pending(review),
        }).ok,
      ).toBe(false);
    },
  );
  it.each([
    { record: proposed(), body: "private" },
    { record: proposed("pr-proposed") },
    { record: proposed("pr-proposed"), title: "feat: change" },
    { record: { ...proposed(), phase: "pushing", reason: "in-flight" } },
    { record: { ...proposed(), phase: "recovery-required", reason: "remote-drift" } },
    { record: proposed("pr-proposed"), title: "x", body: "x", approvalToken: "private" },
  ])("refuses incomplete or non-approvable review %j", (value) => {
    expect(isCodingRuntimeDeliveryReview(value)).toBe(false);
    expect(validPending(pending(value))).toBe(false);
  });
  it.each(["", " ", "x\0y", "x\ny", "x\ry", "é".repeat(129)])(
    "rejects invalid title %j",
    (title) => {
      expect(
        isCodingRuntimeDeliveryReview({
          record: proposed("pr-proposed"),
          title,
          body: "Closes #1",
        }),
      ).toBe(false);
    },
  );
  it.each(["", " ", "x\0y", "é".repeat(32769)])("rejects invalid body %j", (body) => {
    expect(
      isCodingRuntimeDeliveryReview({
        record: proposed("pr-proposed"),
        title: "feat: change",
        body,
      }),
    ).toBe(false);
  });
  it.each([
    { fileCount: 1 },
    { paths: ["code.ts"], fileCount: 1 },
    { pathsTruncated: true },
    { addedLines: 1 },
    { deletedLines: 1 },
    { verifiedCommit: {} },
    { approvalToken: "private" },
  ])("forbids workspace edit claims and mixed authority %j", (extra) => {
    expect(validPending({ ...pending({ record: proposed() }), ...extra })).toBe(false);
  });
  it("retains the nonempty-path requirement for ordinary edits", () => {
    const emptyEdit = pending({ record: proposed() });
    delete emptyEdit.draftDelivery;
    expect(validPending(emptyEdit)).toBe(false);
  });
});
