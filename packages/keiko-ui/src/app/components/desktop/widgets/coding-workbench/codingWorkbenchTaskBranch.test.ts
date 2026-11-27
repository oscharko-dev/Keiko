import { describe, expect, it } from "vitest";
import type {
  CodingHistoryDetail,
  CodingHistoryTask,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { LOCAL_CHECKOUT_WORKSPACE_ID_PREFIX } from "@oscharko-dev/keiko-contracts/runtime/task-workspace";
import { movedTaskBranch } from "./codingWorkbenchTaskBranch";

const ROOT = "/repos/keiko";

function detail(overrides: Partial<CodingHistoryTask> = {}): CodingHistoryDetail {
  return {
    task: {
      id: "task-1",
      title: "Fix the sum",
      projectPath: ROOT,
      modelId: "model-a",
      branch: "fix/sum",
      workspaceId: `${LOCAL_CHECKOUT_WORKSPACE_ID_PREFIX}${ROOT}`,
      taskId: "task-1",
      status: "active",
      createdAt: 1,
      updatedAt: 2,
      ...overrides,
    },
    messages: [],
    truncated: false,
  };
}

const moved = {
  repositoryRoot: ROOT,
  checkoutBranch: "main",
  selectedBranch: undefined,
  runIsActive: false,
} as const;

describe("movedTaskBranch", () => {
  it("names both branches when the checkout of an open local task moved to another branch", () => {
    expect(movedTaskBranch(detail(), moved)).toEqual({ taskBranch: "fix/sum", nextBranch: "main" });
  });

  it("prefers the chosen branch over the checkout's branch", () => {
    expect(movedTaskBranch(detail(), { ...moved, selectedBranch: "release" })).toEqual({
      taskBranch: "fix/sum",
      nextBranch: "release",
    });
  });

  it("clears once the task's own branch is chosen again", () => {
    expect(movedTaskBranch(detail(), { ...moved, selectedBranch: "fix/sum" })).toBeNull();
  });

  it("stays clear while the checkout is on the task's branch", () => {
    expect(movedTaskBranch(detail(), { ...moved, checkoutBranch: "fix/sum" })).toBeNull();
  });

  it("stays clear while the checkout's branch is unknown and none is chosen", () => {
    expect(movedTaskBranch(detail(), { ...moved, checkoutBranch: null })).toBeNull();
  });

  it("stays clear without a task, during a run, and for another repository", () => {
    expect(movedTaskBranch(null, moved)).toBeNull();
    expect(movedTaskBranch(detail(), { ...moved, runIsActive: true })).toBeNull();
    expect(movedTaskBranch(detail(), { ...moved, repositoryRoot: "/repos/other" })).toBeNull();
    expect(movedTaskBranch(detail(), { ...moved, repositoryRoot: null })).toBeNull();
  });

  it("stays clear for closed, imported and non-local tasks", () => {
    expect(movedTaskBranch(detail({ status: "completed" }), moved)).toBeNull();
    expect(movedTaskBranch(detail({ origin: "imported" }), moved)).toBeNull();
    expect(movedTaskBranch(detail({ workspaceId: "ws-isolated-1" }), moved)).toBeNull();
  });
});
