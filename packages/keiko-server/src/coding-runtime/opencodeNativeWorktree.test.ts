import { describe, expect, it, vi } from "vitest";
import { TaskWorkspaceError } from "../task-workspace/errors.js";
import type { ActiveWorkspaceView, WorkspaceProvisionResult } from "../task-workspace/types.js";
import type { WorkspaceInstance } from "@oscharko-dev/keiko-contracts";
import {
  createNativeWorktreeProvisionPort,
  nativeWorktreeAnswer,
  provisioningSource,
  type NativeWorktreeProvisionPortInput,
} from "./opencodeNativeWorktree.js";

const WORKSPACE = "/managed/worktrees/repo/current";
const REQUEST = {
  runId: "run-worktree-1",
  workspaceRoot: WORKSPACE,
  name: "feature-x",
  correlationId: "run-worktree-1",
};

function active(activeRoot = WORKSPACE): ActiveWorkspaceView {
  return {
    instance: { repositoryRoot: "/projects/repo", taskBranch: "keiko/task/current-1234abcd" },
    binding: { activeRoot },
  } as unknown as ActiveWorkspaceView;
}

function provisioned(created: boolean): WorkspaceProvisionResult {
  return {
    instance: { taskId: "feature-x", taskBranch: "keiko/task/feature-x-0a1b2c3d" },
    binding: { activeRoot: "/managed/worktrees/repo/feature-x" },
    created,
  } as unknown as WorkspaceProvisionResult;
}

function port(
  input: Partial<NativeWorktreeProvisionPortInput>,
): ReturnType<typeof createNativeWorktreeProvisionPort> {
  return createNativeWorktreeProvisionPort({
    lifecycle: input.lifecycle,
    provisioning: input.provisioning,
  });
}

// #3903 AC4: an approved Code Mode `worktree_create` becomes a managed task workspace, branched from
// the run's current task branch, through the existing owners.
describe("native worktree provisioning through the managed task-workspace owner", () => {
  it("provisions from the active workspace's repository and task branch", async () => {
    const provision = vi.fn(() => Promise.resolve(provisioned(true)));
    const result = await port({
      lifecycle: { getActive: () => active() },
      provisioning: { provision },
    }).provision(REQUEST);

    expect(provision).toHaveBeenCalledExactlyOnceWith({
      repositoryRequestPath: "/projects/repo",
      taskId: "feature-x",
      baseBranch: "keiko/task/current-1234abcd",
      requestedBy: "coding-runtime-native-worktree",
      correlationId: "run-worktree-1",
    });
    expect(result).toEqual({
      ok: true,
      taskId: "feature-x",
      branch: "keiko/task/feature-x-0a1b2c3d",
      created: true,
    });
    expect(nativeWorktreeAnswer(result)).toMatchObject({ disposition: "provisioned" });
  });

  it("names an existing workspace of that name as found, not created", async () => {
    const result = await port({
      lifecycle: { getActive: () => active() },
      provisioning: { provision: () => Promise.resolve(provisioned(false)) },
    }).provision(REQUEST);
    expect(nativeWorktreeAnswer(result)).toMatchObject({
      disposition: "resumed",
      message: expect.stringContaining('found the managed task workspace "feature-x"') as string,
    });
  });

  it("refuses when the run's workspace is no longer the active one, or none is", async () => {
    const provision = vi.fn(() => Promise.resolve(provisioned(true)));
    for (const getActive of [
      (): ActiveWorkspaceView => active("/elsewhere"),
      (): undefined => undefined,
    ])
      await expect(
        port({ lifecycle: { getActive }, provisioning: { provision } }).provision(REQUEST),
      ).resolves.toEqual({ ok: false, reason: "workspace-changed" });
    expect(provision).not.toHaveBeenCalled();
  });

  it("refuses without the owners, and maps the owner's classified failure", async () => {
    await expect(port({}).provision(REQUEST)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    const failing = port({
      lifecycle: { getActive: () => active() },
      provisioning: {
        provision: () => Promise.reject(new TaskWorkspaceError("BRANCH_CONFLICT", "branch exists")),
      },
    });
    await expect(failing.provision(REQUEST)).resolves.toEqual({
      ok: false,
      reason: "provision-failed",
    });
    expect(nativeWorktreeAnswer({ ok: false, reason: "provision-failed" }).message).toMatch(
      /could not be created/u,
    );
  });

  it("lets an unclassified failure reach the caller", async () => {
    const broken = port({
      lifecycle: { getActive: () => active() },
      provisioning: { provision: () => Promise.reject(new Error("disk")) },
    });
    await expect(broken.provision(REQUEST)).rejects.toThrow("disk");
  });
});

// #3903 AC4, #3902 AC3: the one workspace another was branched from, whose tasks it may fork.
describe("the workspace a managed workspace was provisioned from", () => {
  function instance(
    workspaceId: string,
    fields: Partial<WorkspaceInstance> = {},
  ): WorkspaceInstance {
    return {
      workspaceId,
      repositoryId: "repo-1",
      baseBranch: "main",
      taskBranch: `keiko/task/${workspaceId}`,
      managedWorktreePath: `/managed/worktrees/repo/${workspaceId}`,
      lifecycleState: "active",
      ...fields,
    } as WorkspaceInstance;
  }
  const SOURCE = instance("current");
  const TARGET = instance("feature-x", { baseBranch: "keiko/task/current" });

  it("names the one settled workspace of the repository whose task branch is the base branch", () => {
    expect(provisioningSource([SOURCE, TARGET, instance("other")], "feature-x")).toEqual({
      workspaceId: "current",
      root: "/managed/worktrees/repo/current",
    });
    expect(
      port({
        lifecycle: { getActive: () => undefined, listAll: () => [SOURCE, TARGET] },
        provisioning: undefined,
      }).source?.("feature-x"),
    ).toEqual({ workspaceId: "current", root: "/managed/worktrees/repo/current" });
  });

  it.each([
    ["an unknown workspace", [SOURCE, TARGET], "missing"],
    ["no workspace on its base branch", [instance("feature-x")], "feature-x"],
    [
      "another repository's branch",
      [instance("current", { repositoryId: "repo-2" }), TARGET],
      "feature-x",
    ],
    [
      "two workspaces on that branch",
      [SOURCE, { ...SOURCE, workspaceId: "copy" }, TARGET],
      "feature-x",
    ],
    [
      "a source still provisioning",
      [instance("current", { lifecycleState: "provisioning" }), TARGET],
      "feature-x",
    ],
    [
      "a source being removed",
      [instance("current", { lifecycleState: "cleanup-pending" }), TARGET],
      "feature-x",
    ],
  ] as const)("names none for %s", (_name, instances, workspaceId) => {
    expect(provisioningSource(instances, workspaceId)).toBeUndefined();
  });

  it("offers no source without the lifecycle's inventory", () => {
    expect(port({ lifecycle: { getActive: () => undefined } }).source).toBeUndefined();
  });
});
