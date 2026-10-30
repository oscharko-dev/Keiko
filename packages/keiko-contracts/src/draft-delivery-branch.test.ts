import { describe, expect, it } from "vitest";
import {
  isDraftDeliveryBinding,
  isDraftDeliveryBranchBinding,
  isDraftDeliveryIssueBinding,
  isDraftDeliveryRecord,
  isIssueBoundDraftDeliveryRecord,
  type DraftDeliveryBranchBinding,
  type DraftDeliveryIssueBinding,
  type DraftDeliveryRecord,
} from "./draft-delivery.js";

// ADR-0085 D1b: an issue-free run pushes its verified commit to its own task branch on `origin`.
// The legacy issue-bound binding is persisted without a `kind` and must stay valid byte for byte.
const issueBinding: DraftDeliveryIssueBinding = {
  runId: "run-1",
  workspaceDigest: "a".repeat(64),
  runtimeAuthorityDigest: "b".repeat(64),
  envelopeDigest: "c".repeat(64),
  remoteDigest: "d".repeat(64),
  issueBindingDigest: "e".repeat(64),
  issueIdDigest: "f".repeat(64),
  issueNumber: 42,
  repository: "owner/repository",
  remoteAlias: "origin",
  baseRef: "main",
  baseSha: "1".repeat(40),
  headRef: "feature/issue-42",
  headSha: "2".repeat(40),
  verifiedCommitProposalId: "commit-1",
  recoveryId: "delivery-1",
};
const branchBinding: DraftDeliveryBranchBinding = {
  kind: "branch-push",
  runId: "run-1",
  workspaceDigest: "a".repeat(64),
  runtimeAuthorityDigest: "b".repeat(64),
  envelopeDigest: "c".repeat(64),
  remoteDigest: "d".repeat(64),
  remoteAlias: "origin",
  baseRef: "main",
  baseSha: "1".repeat(40),
  headRef: "claude/task-branch",
  headSha: "2".repeat(40),
  verifiedCommitProposalId: "commit-1",
  recoveryId: "delivery-1",
};
const issueRecord: DraftDeliveryRecord = {
  schemaVersion: "1",
  binding: issueBinding,
  revision: 0,
  phase: "push-proposed",
  reason: "approval-required",
  proposalId: "push-1",
  proposalDigest: "9".repeat(64),
  recordedAt: "2026-09-05T00:00:00.000Z",
};
const branchRecord: DraftDeliveryRecord = { ...issueRecord, binding: branchBinding };
const pullRequest = {
  number: 7,
  externalId: "PR_fixture7",
  url: "https://github.com/owner/repository/pull/7",
  repository: issueBinding.repository,
  headRepository: issueBinding.repository,
  headRef: issueBinding.headRef,
  headSha: issueBinding.headSha,
  baseRef: issueBinding.baseRef,
  baseSha: issueBinding.baseSha,
  state: "open",
  isDraft: true,
} as const;

describe("issue-free branch-push delivery binding", () => {
  it("keeps a persisted issue-bound record valid byte for byte, with no kind key", () => {
    expect(Object.hasOwn(issueBinding, "kind")).toBe(false);
    expect(isDraftDeliveryBinding(issueBinding)).toBe(true);
    expect(isDraftDeliveryRecord(JSON.parse(JSON.stringify(issueRecord)) as unknown)).toBe(true);
    expect(
      isDraftDeliveryRecord({
        ...issueRecord,
        phase: "draft-created",
        reason: "completed",
        pullRequest,
      }),
    ).toBe(true);
    expect(isDraftDeliveryIssueBinding(issueBinding)).toBe(true);
    expect(isDraftDeliveryBranchBinding(issueBinding)).toBe(false);
  });

  it("accepts a branch binding, including one that is its own base", () => {
    expect(isDraftDeliveryBinding(branchBinding)).toBe(true);
    expect(isDraftDeliveryBranchBinding(branchBinding)).toBe(true);
    expect(isDraftDeliveryIssueBinding(branchBinding)).toBe(false);
    expect(isDraftDeliveryBinding({ ...branchBinding, baseRef: branchBinding.headRef })).toBe(true);
  });

  it.each([
    ["push-proposed", "approval-required"],
    ["pushing", "in-flight"],
    ["pushed", "completed"],
    ["recovery-required", "provider-failed"],
  ] as const)("accepts a branch record in the %s phase", (phase, reason) => {
    expect(isDraftDeliveryRecord({ ...branchRecord, phase, reason })).toBe(true);
  });

  it.each([
    ["pr-proposed", "approval-required"],
    ["creating-pr", "in-flight"],
    ["draft-created", "completed"],
  ] as const)("refuses a branch record in the pull-request phase %s", (phase, reason) => {
    expect(isDraftDeliveryRecord({ ...branchRecord, phase, reason })).toBe(false);
  });

  it("refuses a branch record that carries a pull request identity", () => {
    expect(
      isDraftDeliveryRecord({ ...branchRecord, phase: "pushed", reason: "completed", pullRequest }),
    ).toBe(false);
  });

  it.each([
    ["an issue number", { issueNumber: 42 }],
    ["a repository", { repository: "owner/repository" }],
    ["an issue digest", { issueBindingDigest: "e".repeat(64) }],
    ["an unknown field", { extra: "x" }],
    ["a different kind", { kind: "other" }],
    ["a remote alias other than origin", { remoteAlias: "upstream" }],
    ["a malformed head sha", { headSha: "zz" }],
    ["a full ref spelling", { headRef: "refs/heads/main" }],
    ["an unsafe ref", { headRef: "bad..ref" }],
    ["a malformed digest", { remoteDigest: "short" }],
  ])("refuses a branch binding with %s", (_label, override) => {
    expect(isDraftDeliveryBinding({ ...branchBinding, ...override })).toBe(false);
  });

  it("refuses a branch binding missing a required field", () => {
    const { recoveryId: _omitted, ...rest } = branchBinding;
    expect(isDraftDeliveryBinding(rest)).toBe(false);
  });

  it("refuses an issue-shaped binding that merely adds the branch kind", () => {
    expect(isDraftDeliveryBinding({ ...issueBinding, kind: "branch-push" })).toBe(false);
  });

  it("narrows a record by its binding kind", () => {
    expect(isIssueBoundDraftDeliveryRecord(issueRecord)).toBe(true);
    expect(isIssueBoundDraftDeliveryRecord(branchRecord)).toBe(false);
  });
});
