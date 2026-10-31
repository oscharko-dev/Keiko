import { describe, expect, it } from "vitest";
import { validateCodingWorkbenchRuntimeSnapshot } from "./coding-workbench-runtime-api.js";

// ADR-0085 D1b: the snapshot of an issue-free run may carry a branch-push delivery record, and only
// a run that has no accepted issue may carry one.
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
function delivery(kind: "branch-push" | "issue"): Record<string, unknown> {
  const shared = {
    runId: "run-1",
    workspaceDigest: digest,
    runtimeAuthorityDigest: digest,
    envelopeDigest: digest,
    remoteDigest: digest,
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
    revision: 0,
    phase: "push-proposed",
    reason: "approval-required",
    proposalId: "delivery-1",
    proposalDigest: digest,
    recordedAt: "2026-09-05T00:00:00.000Z",
    binding:
      kind === "branch-push"
        ? { kind, ...shared }
        : {
            ...shared,
            issueBindingDigest: digest,
            issueIdDigest: digest,
            issueNumber: 42,
            repository: "owner/repository",
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

describe("runtime snapshot with a branch-push delivery", () => {
  it("accepts a branch-push record on a run with no accepted issue", () => {
    expect(
      validateCodingWorkbenchRuntimeSnapshot(snapshot({ draftDelivery: delivery("branch-push") }))
        .ok,
    ).toBe(true);
  });

  it("refuses a branch-push record on a run that has an accepted issue", () => {
    expect(
      validateCodingWorkbenchRuntimeSnapshot(
        snapshot({ issueBinding, draftDelivery: delivery("branch-push") }),
      ).ok,
    ).toBe(false);
  });

  it("refuses a branch-push record of another run", () => {
    const other = delivery("branch-push");
    expect(
      validateCodingWorkbenchRuntimeSnapshot(
        snapshot({
          draftDelivery: { ...other, binding: { ...(other.binding as object), runId: "run-2" } },
        }),
      ).ok,
    ).toBe(false);
  });

  it("still requires the frozen issue for an issue-bound record", () => {
    expect(
      validateCodingWorkbenchRuntimeSnapshot(snapshot({ draftDelivery: delivery("issue") })).ok,
    ).toBe(false);
    expect(
      validateCodingWorkbenchRuntimeSnapshot(
        snapshot({ issueBinding, draftDelivery: delivery("issue") }),
      ).ok,
    ).toBe(true);
  });
});
