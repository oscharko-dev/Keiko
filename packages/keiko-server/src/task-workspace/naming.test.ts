// Coverage for deterministic task-workspace naming/identity (Issue #445). Proves the idempotency-key
// property (AC3) and that every derived branch name is a safe git ref regardless of task-id content.

import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { isSafeGitRefName } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import {
  deriveManagedWorktreePath,
  deriveRepositoryId,
  deriveTaskBranchName,
  deriveWorkspaceId,
  MANAGED_ROOT_MARKER_FILENAME,
} from "./naming.js";

describe("deriveRepositoryId", () => {
  it("is deterministic and content-free", () => {
    expect(deriveRepositoryId("/a/b")).toBe(deriveRepositoryId("/a/b"));
    expect(deriveRepositoryId("/a/b")).toMatch(/^repo_[0-9a-f]{16}$/u);
    expect(deriveRepositoryId("/a/b")).not.toBe(deriveRepositoryId("/a/c"));
  });
});

describe("deriveWorkspaceId (idempotency key)", () => {
  it("is stable for the same repo+task and distinct otherwise", () => {
    const repo = deriveRepositoryId("/repo");
    const other = deriveRepositoryId("/other");
    expect(deriveWorkspaceId({ repositoryId: repo, taskId: "t1" })).toBe(
      deriveWorkspaceId({ repositoryId: repo, taskId: "t1" }),
    );
    expect(deriveWorkspaceId({ repositoryId: repo, taskId: "t1" })).not.toBe(
      deriveWorkspaceId({ repositoryId: repo, taskId: "t2" }),
    );
    expect(deriveWorkspaceId({ repositoryId: repo, taskId: "t1" })).not.toBe(
      deriveWorkspaceId({ repositoryId: other, taskId: "t1" }),
    );
    expect(deriveWorkspaceId({ repositoryId: repo, taskId: "t1" })).toMatch(/^ws_[0-9a-f]{24}$/u);
  });
});

describe("deriveTaskBranchName", () => {
  const adversarial = [
    "",
    "  ",
    "feature/x",
    "../escape",
    "a b c",
    "héllo-ünïcode",
    "UPPER_Case",
    "-leading-dash",
    "..",
    "a".repeat(200),
    "a/b/c",
    "task@{now}",
    "issue-445",
  ];

  it("is deterministic, prefixed, and always a safe git ref", () => {
    for (const taskId of adversarial) {
      const branch = deriveTaskBranchName({ taskId });
      expect(branch).toBe(deriveTaskBranchName({ taskId }));
      expect(branch.startsWith("keiko/task/")).toBe(true);
      expect(isSafeGitRefName(branch)).toBe(true);
    }
  });

  it("disambiguates two task ids that slugify identically", () => {
    expect(deriveTaskBranchName({ taskId: "Issue 445" })).not.toBe(
      deriveTaskBranchName({ taskId: "issue-445" }),
    );
  });
});

describe("deriveManagedWorktreePath / marker", () => {
  it("joins managedRoot/repositoryId/workspaceId", () => {
    expect(
      deriveManagedWorktreePath({ managedRoot: "/m", repositoryId: "repo_x", workspaceId: "ws_y" }),
    ).toBe(join("/m", "repo_x", "ws_y"));
  });

  it("exposes the ownership marker filename", () => {
    expect(MANAGED_ROOT_MARKER_FILENAME).toBe(".keiko-managed-root");
  });
});
