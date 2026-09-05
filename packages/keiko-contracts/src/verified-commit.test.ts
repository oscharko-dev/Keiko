import { validateCodingWorkbenchRuntimeApprovalReviewChannelPayload } from "./coding-workbench-runtime-approval-review.js";
import { describe, expect, it } from "vitest";
import { isVerifiedCommitResult, type VerifiedCommitResult } from "./verified-commit.js";

const receipt: VerifiedCommitResult = {
  schemaVersion: "1",
  proposalId: "commit-1",
  runId: "run-1",
  envelopeDigest: "a".repeat(64),
  runtimeAuthorityDigest: "b".repeat(64),
  workspaceDigest: "c".repeat(64),
  repositoryDigest: "d".repeat(64),
  baseSha: "1".repeat(40),
  parentSha: "2".repeat(40),
  stagedTreeDigest: "e".repeat(64),
  verificationEvidenceId: "verification-1",
  messageDigest: "f".repeat(64),
  status: "approval-required",
  reason: "approval-required",
  recordedAt: "2026-09-04T10:00:00.000Z",
};

describe("closed verified commit receipt", () => {
  it("accepts exact body-free receipts and binds successful results to the approved tree", () => {
    expect(isVerifiedCommitResult(receipt)).toBe(true);
    const success = {
      ...receipt,
      status: "succeeded",
      reason: "completed",
      headSha: "3".repeat(40),
      committedTreeDigest: receipt.stagedTreeDigest,
    };
    expect(isVerifiedCommitResult(success)).toBe(true);
    expect(isVerifiedCommitResult({ ...success, committedTreeDigest: "0".repeat(64) })).toBe(false);
  });
  it.each([
    "approvalToken",
    "approval",
    "command",
    "args",
    "env",
    "path",
    "message",
    "output",
    "diff",
    "secret",
  ])("rejects the hostile %s field even when nested", (field) => {
    expect(isVerifiedCommitResult({ ...receipt, [field]: { body: "private fixture" } })).toBe(
      false,
    );
    expect(
      isVerifiedCommitResult({ ...receipt, messageDigest: { [field]: "private fixture" } }),
    ).toBe(false);
  });
  it.each([
    { status: "failed", reason: "approval-required" },
    { status: "blocked", reason: "completed" },
    { status: "drift", reason: "execution-uncertain" },
    { status: "recovery-required", reason: "message-policy" },
    { status: "verification-failed", reason: "candidate-drift" },
    { recordedAt: "2026-02-30T10:00:00.000Z" },
    { headSha: "3".repeat(40) },
    { issueBindingDigest: "https://private.invalid" },
    { parentSha: "HEAD" },
  ])("rejects a contradictory or malformed receipt %j", (change) => {
    expect(isVerifiedCommitResult({ ...receipt, ...change })).toBe(false);
  });
});

describe("message-policy violation codes on a blocked receipt (#3390)", () => {
  const blocked = {
    ...receipt,
    status: "blocked",
    reason: "message-policy",
    violations: ["missing-conventional-prefix", "subject-too-long"],
  };
  it("accepts a closed, non-empty violation-code list", () => {
    expect(isVerifiedCommitResult(blocked)).toBe(true);
    expect(
      isVerifiedCommitResult({
        ...receipt,
        status: "blocked",
        reason: "message-policy",
        violations: ["empty-subject"],
      }),
    ).toBe(true);
  });
  it.each([
    { violations: [] }, // never zero: even "empty-subject" alone short-circuits to one code
    { violations: Array.from({ length: 7 }, () => "missing-conventional-prefix") }, // exceeds the closed vocabulary size (6)
    { violations: ["not-a-real-code"] },
    { violations: ["empty-subject", "not-a-real-code"] },
  ])("rejects a malformed violation list $violations", ({ violations }) => {
    expect(isVerifiedCommitResult({ ...blocked, violations })).toBe(false);
  });
  it("rejects violations on any reason other than message-policy", () => {
    expect(isVerifiedCommitResult({ ...receipt, violations: ["empty-subject"] })).toBe(false);
    expect(
      isVerifiedCommitResult({
        ...receipt,
        status: "blocked",
        reason: "issue-directive",
        violations: ["empty-subject"],
      }),
    ).toBe(false);
  });
  it("still accepts a message-policy block without violations (boolean-only messageAllowed)", () => {
    expect(
      isVerifiedCommitResult({ ...receipt, status: "blocked", reason: "message-policy" }),
    ).toBe(true);
  });
});

describe("transient verified commit review", () => {
  const review = {
    session: "active",
    pending: {
      requestId: receipt.proposalId,
      paths: ["code.ts"],
      pathsTruncated: false,
      fileCount: 1,
      addedLines: 1,
      deletedLines: 1,
      verifiedCommit: { result: receipt, message: "feat: reviewed candidate" },
    },
  };
  it("accepts the exact pending review and rejects a mismatched proposal", () => {
    expect(validateCodingWorkbenchRuntimeApprovalReviewChannelPayload(review).ok).toBe(true);
    expect(
      validateCodingWorkbenchRuntimeApprovalReviewChannelPayload({
        ...review,
        pending: { ...review.pending, requestId: "other-proposal" },
      }).ok,
    ).toBe(false);
  });
  it.each(["", " ", "x".repeat(8193), "feat: bad\0message", "feat: bad\u202Emessage"])(
    "rejects unsafe or incomplete reviewed message %j",
    (message) => {
      expect(
        validateCodingWorkbenchRuntimeApprovalReviewChannelPayload({
          ...review,
          pending: {
            ...review.pending,
            verifiedCommit: { ...review.pending.verifiedCommit, message },
          },
        }).ok,
      ).toBe(false);
    },
  );
  it("keeps approval tokens out of both nested receipts and the transient review", () => {
    for (const verifiedCommit of [
      { ...review.pending.verifiedCommit, approvalToken: "private fixture" },
      {
        ...review.pending.verifiedCommit,
        result: { ...receipt, output: { secret: "private fixture" } },
      },
    ]) {
      expect(
        validateCodingWorkbenchRuntimeApprovalReviewChannelPayload({
          ...review,
          pending: { ...review.pending, verifiedCommit },
        }).ok,
      ).toBe(false);
    }
  });
});
