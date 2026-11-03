import { describe, expect, it } from "vitest";
import {
  CODING_RUNTIME_DELIVERY_UNAVAILABLE_REASONS,
  isCodingRuntimeDeliveryResult,
  isCodingRuntimeDeliveryReview,
} from "./coding-runtime-delivery.js";
import { validateCodingWorkbenchRuntimeApprovalReviewChannelPayload } from "./coding-workbench-runtime-approval-review.js";
import {
  isDraftDeliveryBinding,
  isDraftDeliveryBranchBinding,
  isDraftDeliveryIssueBinding,
  isDraftDeliveryPullRequestBinding,
  isDraftDeliveryRecord,
  isDraftDeliveryRepositoryBinding,
  isIssueBoundDraftDeliveryRecord,
  isPullRequestDraftDeliveryRecord,
  type DraftDeliveryRecord,
  type DraftDeliveryRepositoryBinding,
} from "./draft-delivery.js";

// ADR-0086 D13 (owner decision, 2026-10-30): a run on a verified github.com origin opens a draft pull
// request without an accepted issue. Its binding is the branch-push binding plus the repository, and
// it admits every phase and a pull request identity exactly as an issue-bound record does.
const binding: DraftDeliveryRepositoryBinding = {
  kind: "github-repository",
  runId: "run-1",
  workspaceDigest: "a".repeat(64),
  runtimeAuthorityDigest: "b".repeat(64),
  envelopeDigest: "c".repeat(64),
  remoteDigest: "d".repeat(64),
  repository: "owner/repository",
  remoteAlias: "origin",
  baseRef: "main",
  baseSha: "1".repeat(40),
  headRef: "claude/task-branch",
  headSha: "2".repeat(40),
  verifiedCommitProposalId: "commit-1",
  recoveryId: "delivery-1",
};
const record: DraftDeliveryRecord = {
  schemaVersion: "1",
  binding,
  revision: 0,
  phase: "push-proposed",
  reason: "approval-required",
  proposalId: "push-1",
  proposalDigest: "9".repeat(64),
  recordedAt: "2026-09-05T00:00:00.000Z",
};
const pullRequest = {
  number: 7,
  externalId: "PR_fixture7",
  url: "https://github.com/owner/repository/pull/7",
  repository: binding.repository,
  headRepository: binding.repository,
  headRef: binding.headRef,
  headSha: binding.headSha,
  baseRef: binding.baseRef,
  baseSha: binding.baseSha,
  state: "open",
  isDraft: true,
} as const;

describe("issue-free github-repository delivery binding", () => {
  it("accepts the binding and narrows it by kind", () => {
    expect(isDraftDeliveryBinding(binding)).toBe(true);
    expect(isDraftDeliveryRepositoryBinding(binding)).toBe(true);
    expect(isDraftDeliveryPullRequestBinding(binding)).toBe(true);
    expect(isDraftDeliveryBranchBinding(binding)).toBe(false);
    expect(isDraftDeliveryIssueBinding(binding)).toBe(false);
    expect(isDraftDeliveryRecord(JSON.parse(JSON.stringify(record)) as unknown)).toBe(true);
  });

  it("lets only an issue-bound or repository binding stand for a pull request", () => {
    const { repository: _repository, kind: _kind, ...rest } = binding;
    expect(isDraftDeliveryPullRequestBinding({ ...rest, kind: "branch-push" })).toBe(false);
    expect(isPullRequestDraftDeliveryRecord(record)).toBe(true);
    expect(isIssueBoundDraftDeliveryRecord(record)).toBe(false);
  });

  it.each([
    ["push-proposed", "approval-required"],
    ["pushing", "in-flight"],
    ["pushed", "completed"],
    ["pr-proposed", "approval-required"],
    ["creating-pr", "in-flight"],
    ["recovery-required", "remote-drift"],
  ] as const)("accepts a record in the %s phase", (phase, reason) => {
    expect(isDraftDeliveryRecord({ ...record, phase, reason })).toBe(true);
  });

  it("accepts a delivered draft pull request that matches the binding and refuses one that does not", () => {
    const created = {
      ...record,
      phase: "draft-created",
      reason: "completed",
      pullRequest,
    } as const;
    expect(isDraftDeliveryRecord(created)).toBe(true);
    expect(isDraftDeliveryRecord({ ...created, pullRequest: undefined })).toBe(false);
    expect(
      isDraftDeliveryRecord({ ...created, pullRequest: { ...pullRequest, isDraft: false } }),
    ).toBe(false);
    expect(
      isDraftDeliveryRecord({
        ...created,
        pullRequest: { ...pullRequest, headSha: "3".repeat(40) },
      }),
    ).toBe(false);
    expect(
      isDraftDeliveryRecord({
        ...created,
        pullRequest: { ...pullRequest, repository: "other/repository" },
      }),
    ).toBe(false);
    expect(
      isDraftDeliveryRecord({
        ...created,
        pullRequest: { ...pullRequest, baseRef: "release/1" },
      }),
    ).toBe(false);
  });

  it.each([
    ["an issue number", { issueNumber: 42 }],
    ["an issue digest", { issueBindingDigest: "e".repeat(64) }],
    ["an unknown field", { extra: "x" }],
    ["no repository", { repository: undefined }],
    ["a malformed repository", { repository: "not a repository" }],
    ["a different kind", { kind: "other" }],
    ["a remote alias other than origin", { remoteAlias: "upstream" }],
    ["a malformed head sha", { headSha: "zz" }],
    ["a full ref spelling", { headRef: "refs/heads/main" }],
    ["a malformed digest", { remoteDigest: "short" }],
  ])("refuses a binding with %s", (_label, override) => {
    expect(isDraftDeliveryBinding({ ...binding, ...override })).toBe(false);
  });

  it("refuses a binding missing a required field", () => {
    const { recoveryId: _omitted, ...rest } = binding;
    expect(isDraftDeliveryBinding(rest)).toBe(false);
  });
});

describe("delivery vocabulary for a pull request without an issue", () => {
  it("names github-origin-required as a closed unavailable reason", () => {
    expect(CODING_RUNTIME_DELIVERY_UNAVAILABLE_REASONS).toContain("github-origin-required");
    expect(
      isCodingRuntimeDeliveryResult({ status: "unavailable", reason: "github-origin-required" }),
    ).toBe(true);
  });

  it("carries a repository record as an approvable pull request proposal", () => {
    const proposal: DraftDeliveryRecord = {
      ...record,
      phase: "pr-proposed",
      reason: "approval-required",
    };
    const review = { record: proposal, title: "feat: change", body: "Body without a closing line" };
    expect(isCodingRuntimeDeliveryResult({ status: "recorded", record: proposal })).toBe(true);
    expect(isCodingRuntimeDeliveryReview(review)).toBe(true);
    expect(
      validateCodingWorkbenchRuntimeApprovalReviewChannelPayload({
        session: "active",
        pending: {
          requestId: proposal.proposalId,
          paths: [],
          pathsTruncated: false,
          fileCount: 0,
          addedLines: 0,
          deletedLines: 0,
          draftDelivery: review,
        },
      }).ok,
    ).toBe(true);
  });
});
