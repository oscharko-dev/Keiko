import { describe, expect, it } from "vitest";

import {
  configuredReviewRunBudget,
  KEIKO_REVIEW_RUN_MAX_DURATION_MINUTES_ENV,
} from "./production.js";
import { createReviewWorkspaceLifecycle, reviewWorkspaceId } from "./reviewWorkspace.js";

const BINDING = {
  reviewRunId: "review-run-1",
  worktreeRoot: "/state/review-worktrees/wt-1",
  repositoryRoot: "/repos/keiko",
  headSha: "c".repeat(40),
};

describe("createReviewWorkspaceLifecycle", () => {
  it("names exactly one review worktree while bound and nothing otherwise", () => {
    const workspace = createReviewWorkspaceLifecycle(() => new Date("2026-10-30T09:00:00.000Z"));
    expect(workspace.getActive()).toBeUndefined();
    expect(workspace.listAll()).toEqual([]);

    expect(workspace.bind(BINDING)).toBe(true);
    const active = workspace.getActive();
    expect(active?.binding).toMatchObject({
      workspaceId: reviewWorkspaceId("review-run-1"),
      activeRoot: BINDING.worktreeRoot,
      boundSurfaces: ["review"],
    });
    expect(active?.instance).toMatchObject({
      managedWorktreePath: BINDING.worktreeRoot,
      lastVerifiedHead: BINDING.headSha,
      lifecycleState: "active",
      health: "healthy",
      executionLocation: "worktree",
    });
    expect(workspace.list(BINDING.repositoryRoot)).toHaveLength(1);
    expect(workspace.list("/repos/other")).toEqual([]);

    workspace.clear();
    expect(workspace.getActive()).toBeUndefined();
    expect(workspace.bound()).toBeUndefined();
  });

  it("refuses a second binding and every mutation of the user's workspace lifecycle", async () => {
    const workspace = createReviewWorkspaceLifecycle();
    workspace.bind(BINDING);
    expect(workspace.bind({ ...BINDING, reviewRunId: "review-run-2" })).toBe(false);
    expect(() => {
      workspace.clearActive();
    }).toThrow();
    const request = { workspaceId: "w", requestedBy: "u" };
    await expect(workspace.setActive({ ...request, acquireLock: false })).rejects.toThrow();
    await expect(workspace.pause(request)).rejects.toThrow();
    await expect(workspace.resume(request)).rejects.toThrow();
    await expect(workspace.prepareHandoff(request)).rejects.toThrow();
  });
});

// Keiko does not limit tokens (#4346): the Reviewer session's time limit is the only setting.
describe("configuredReviewRunBudget", () => {
  const envelope = { maxDurationMinutes: 120 };

  it("defaults to 20 minutes and carries no token allowance", () => {
    expect(configuredReviewRunBudget({}, envelope)).toEqual({ maxDurationMinutes: 20 });
  });

  it("never exceeds the coding envelope, even by default", () => {
    expect(configuredReviewRunBudget({}, { maxDurationMinutes: 5 })).toEqual({
      maxDurationMinutes: 5,
    });
  });

  it("admits an operator setting within the envelope and fails closed above it", () => {
    expect(
      configuredReviewRunBudget({ [KEIKO_REVIEW_RUN_MAX_DURATION_MINUTES_ENV]: "30" }, envelope),
    ).toEqual({ maxDurationMinutes: 30 });
    for (const value of ["121", "0", "-1", "1e6", "abc"]) {
      expect(() =>
        configuredReviewRunBudget({ [KEIKO_REVIEW_RUN_MAX_DURATION_MINUTES_ENV]: value }, envelope),
      ).toThrow(RangeError);
    }
  });

  it("ignores the retired prompt-token setting", () => {
    expect(
      configuredReviewRunBudget({ KEIKO_REVIEW_RUN_MAX_PROMPT_TOKENS: "1" }, envelope),
    ).toEqual({ maxDurationMinutes: 20 });
  });
});
