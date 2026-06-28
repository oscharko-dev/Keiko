import { describe, expect, it } from "vitest";
import {
  GIT_REPOSITORY_SCHEMA_VERSION,
  validateGitRepositoryDiffResponse,
  validateGitRepositoryStatusResponse,
} from "./git-repository.js";

describe("git repository wire validators", () => {
  it("accepts a bounded status response with staged, unstaged, and untracked changes", () => {
    expect(
      validateGitRepositoryStatusResponse({
        schemaVersion: GIT_REPOSITORY_SCHEMA_VERSION,
        root: "/repo",
        repositoryRoot: "/repo",
        state: "available",
        available: true,
        branch: "main",
        detached: false,
        clean: false,
        stagedCount: 1,
        unstagedCount: 1,
        untrackedCount: 1,
        conflictedCount: 0,
        changes: [
          {
            path: "src/app.ts",
            indexStatus: "M",
            worktreeStatus: " ",
            staged: true,
            unstaged: false,
            untracked: false,
            conflicted: false,
          },
          {
            path: "src/new.ts",
            indexStatus: "?",
            worktreeStatus: "?",
            staged: false,
            unstaged: false,
            untracked: true,
            conflicted: false,
          },
        ],
        truncated: false,
        maxChanges: 500,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects malformed status responses", () => {
    const result = validateGitRepositoryStatusResponse({
      schemaVersion: "wrong",
      root: "/repo",
      state: "available",
      available: true,
      detached: false,
      clean: true,
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      conflictedCount: 0,
      changes: "nope",
      truncated: false,
      maxChanges: 500,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContain("schemaVersion invalid");
      expect(result.reasons).toContain("changes must be an array");
    }
  });

  it("accepts bounded diff responses", () => {
    expect(
      validateGitRepositoryDiffResponse({
        schemaVersion: GIT_REPOSITORY_SCHEMA_VERSION,
        root: "/repo",
        repositoryRoot: "/repo",
        state: "available",
        available: true,
        path: "src/app.ts",
        scope: "all",
        diff: "diff --git a/src/app.ts b/src/app.ts\n",
        truncated: true,
        maxBytes: 128,
      }),
    ).toEqual({ ok: true });
  });
});
