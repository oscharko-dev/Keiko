import { describe, expect, it } from "vitest";
import { validateCodingWorkbenchRuntimeSnapshot } from "./coding-workbench-runtime-api.js";

// ADR-0086 D13: the snapshot of an issue-free run on a verified github.com origin may carry a
// repository-bound delivery record, with a delivered draft pull request; only a run that has no
// accepted issue may carry one.
const digest = "a".repeat(64);
const issueBinding = {
  schemaVersion: "1",
  repositoryId: "repository-1",
  remoteDigest: digest,
  issueIdDigest: digest,
  contentRevisionDigest: digest,
  bindingDigest: digest,
  issueNumber: 42,
  defaultBaseRef: "main",
};
const repository = "owner/repository";
function delivery(): Record<string, unknown> {
  const binding = {
    kind: "github-repository",
    runId: "run-1",
    workspaceDigest: digest,
    runtimeAuthorityDigest: digest,
    envelopeDigest: digest,
    remoteDigest: digest,
    repository,
    remoteAlias: "origin",
    baseRef: "main",
    baseSha: "1".repeat(40),
    headRef: "claude/task-1",
    headSha: "3".repeat(40),
    verifiedCommitProposalId: "commit-1",
    recoveryId: "delivery-1",
  };
  return {
    schemaVersion: "1",
    revision: 3,
    phase: "draft-created",
    reason: "completed",
    proposalId: "delivery-1",
    proposalDigest: digest,
    recordedAt: "2026-09-05T00:00:00.000Z",
    binding,
    pullRequest: {
      number: 7,
      externalId: "PR_fixture7",
      url: `https://github.com/${repository}/pull/7`,
      repository,
      headRepository: repository,
      headRef: binding.headRef,
      headSha: binding.headSha,
      baseRef: binding.baseRef,
      baseSha: binding.baseSha,
      state: "open",
      isDraft: true,
    },
  };
}
function snapshot(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: "1",
    state: "running",
    revision: 1,
    updatedAt: "2026-09-05T00:00:00.000Z",
    runId: "run-1",
    ...extra,
  };
}

describe("runtime snapshot with a repository-bound delivery", () => {
  it("accepts a delivered draft pull request on a run with no accepted issue", () => {
    expect(validateCodingWorkbenchRuntimeSnapshot(snapshot({ draftDelivery: delivery() })).ok).toBe(
      true,
    );
  });

  it("refuses a repository-bound record on a run that has an accepted issue", () => {
    expect(
      validateCodingWorkbenchRuntimeSnapshot(snapshot({ issueBinding, draftDelivery: delivery() }))
        .ok,
    ).toBe(false);
  });

  it("refuses a repository-bound record of another run", () => {
    const other = delivery();
    expect(
      validateCodingWorkbenchRuntimeSnapshot(
        snapshot({
          draftDelivery: { ...other, binding: { ...(other.binding as object), runId: "run-2" } },
        }),
      ).ok,
    ).toBe(false);
  });
});
