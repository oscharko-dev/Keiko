import { describe, expect, it, vi } from "vitest";

import { createGovernedTaskBranches } from "./governedTaskBranches.js";
import { createProductionTaskBranchPort } from "./productionTaskBranchPort.js";

// #3907: the workspace side of a governed task branch. Three server-owned records move together
// and the one step that can refuse comes first, so a refusal or a later fault leaves nothing moved.

const adoption = {
  runId: "run-branch",
  workspaceDigest: "a".repeat(64),
  branch: "feature/x",
  baseBranch: "main",
  headSha: "1".repeat(40),
};

function fixture(
  options: {
    readonly rebind?: "refuse" | "ok";
    readonly adopt?: "ok" | "throw";
  } = {},
): {
  readonly port: ReturnType<typeof createProductionTaskBranchPort>;
  readonly calls: string[];
  readonly branches: ReturnType<typeof createGovernedTaskBranches>;
  readonly undo: ReturnType<typeof vi.fn>;
} {
  const calls: string[] = [];
  const branches = createGovernedTaskBranches();
  const undo = vi.fn(() => {
    calls.push("undo");
  });
  const port = createProductionTaskBranchPort({
    workspaceId: "local:one",
    lifecycle: {
      admitTaskBranch: (workspaceId) => {
        calls.push(`admit:${workspaceId}`);
        return "admitted";
      },
      adoptTaskBranch: (request) => {
        calls.push(`adopt:${request.workspaceId}:${request.branch}:${request.baseBranch}`);
        // The record must already be in place when the instance moves, or the run would lose its
        // workspace between the two.
        expect(branches.latest("run-branch")?.taskBranch).toBe("feature/x");
        if (options.adopt === "throw") throw new TypeError("instance refused");
        return {} as never;
      },
    },
    branches,
    authority: {
      rebindGitDeliveryBranch: (runId, rebound) => {
        calls.push(`rebind:${runId}:${rebound.headRef}:${rebound.baseRef}`);
        return options.rebind === "refuse" ? undefined : undo;
      },
    },
  });
  return { port, calls, branches, undo };
}

describe("the workspace side of a governed task branch (#3907)", () => {
  it("asks the lifecycle about this run's own workspace", () => {
    const { port, calls } = fixture();
    expect(port?.admit()).toBe("admitted");
    expect(calls).toEqual(["admit:local:one"]);
  });

  it("moves the authority, records the branch and adopts it in the workspace, in that order", () => {
    const { port, calls, branches, undo } = fixture();
    expect(port?.adopt(adoption)).toBe(true);
    expect(calls).toEqual(["rebind:run-branch:feature/x:main", "adopt:local:one:feature/x:main"]);
    expect(branches.latest("run-branch")).toEqual({
      runId: "run-branch",
      taskBranch: "feature/x",
      baseBranch: "main",
      headSha: adoption.headSha,
      workspaceDigest: adoption.workspaceDigest,
    });
    expect(undo).not.toHaveBeenCalled();
  });

  it("changes nothing when the authority refuses the move", () => {
    const { port, calls, branches } = fixture({ rebind: "refuse" });
    expect(port?.adopt(adoption)).toBe(false);
    expect(calls).toEqual(["rebind:run-branch:feature/x:main"]);
    expect(branches.latest("run-branch")).toBeUndefined();
  });

  it("undoes the authority move and forgets the record when the workspace cannot adopt", () => {
    const { port, calls, branches, undo } = fixture({ adopt: "throw" });
    expect(() => port?.adopt(adoption)).toThrow("instance refused");
    expect(calls).toEqual([
      "rebind:run-branch:feature/x:main",
      "adopt:local:one:feature/x:main",
      "undo",
    ]);
    expect(undo).toHaveBeenCalledOnce();
    expect(branches.latest("run-branch")).toBeUndefined();
  });

  it("offers no port when the lifecycle cannot admit or adopt a task branch", () => {
    const branches = createGovernedTaskBranches();
    const authority = { rebindGitDeliveryBranch: (): undefined => undefined };
    expect(
      createProductionTaskBranchPort({
        workspaceId: "local:one",
        lifecycle: {},
        branches,
        authority,
      }),
    ).toBeUndefined();
    expect(
      createProductionTaskBranchPort({
        workspaceId: "local:one",
        lifecycle: { admitTaskBranch: () => "admitted" },
        branches,
        authority,
      }),
    ).toBeUndefined();
  });
});
