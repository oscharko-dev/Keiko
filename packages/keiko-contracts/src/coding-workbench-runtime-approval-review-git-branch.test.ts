import { describe, expect, it } from "vitest";

import { validateCodingWorkbenchRuntimeApprovalReviewChannelPayload } from "./coding-workbench-runtime-approval-review.js";

function branchReview(overrides: Record<string, unknown> = {}): unknown {
  return {
    session: "active",
    pending: {
      requestId: "permission-branch-1",
      gitBranch: { branchName: "refactor/retry-limit" },
      paths: [],
      pathsTruncated: false,
      fileCount: 0,
      addedLines: 0,
      deletedLines: 0,
      ...overrides,
    },
  };
}

describe("approval review channel: governed task branch (U-27)", () => {
  it("admits the branch a pending task-branch approval would create", () => {
    expect(validateCodingWorkbenchRuntimeApprovalReviewChannelPayload(branchReview()).ok).toBe(
      true,
    );
  });

  it.each([
    ["an empty name", { gitBranch: { branchName: "" } }],
    ["an over-long name", { gitBranch: { branchName: "b".repeat(256) } }],
    ["a control-character name", { gitBranch: { branchName: "a‮b" } }],
    ["an extra key", { gitBranch: { branchName: "a", remote: "origin" } }],
    ["a non-object", { gitBranch: "feature/x" }],
    ["a path list beside the branch", { paths: ["a.ts"], fileCount: 1 }],
  ])("refuses %s", (_label, overrides) => {
    expect(
      validateCodingWorkbenchRuntimeApprovalReviewChannelPayload(branchReview(overrides)).ok,
    ).toBe(false);
  });
});
