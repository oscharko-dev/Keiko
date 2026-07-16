// Coverage for the managed-task-workspace authorization boundary's leaf-id derivation (Epic #443).
// resolveManagedTaskWorkspaceRoot re-derives a WorkspaceInstance's identity from a candidate root
// before trusting it; these tests exercise that derivation directly against a stubbed provisioning
// port, without needing a live managed worktree on disk.

import { describe, expect, it, vi } from "vitest";
import { resolveManagedTaskWorkspaceRoot } from "./authorization.js";
import type { WorkspaceProvisioningService } from "./types.js";

function provisioningStub(
  getInstance: WorkspaceProvisioningService["getInstance"],
): WorkspaceProvisioningService {
  return {
    provision: (): never => {
      throw new Error("not used in this test");
    },
    activate: (): never => {
      throw new Error("not used in this test");
    },
    getInstance,
  };
}

describe("resolveManagedTaskWorkspaceRoot", () => {
  it("derives the workspace leaf id after trimming trailing path separators", () => {
    const getInstance = vi.fn<WorkspaceProvisioningService["getInstance"]>();
    const result = resolveManagedTaskWorkspaceRoot(
      {
        managedTaskWorkspaceRoot: "/managed",
        workspaceProvisioning: provisioningStub(getInstance),
      },
      "/managed/repo_a/ws_b///",
    );

    expect(result).toBeUndefined();
    expect(getInstance).toHaveBeenCalledWith("ws_b");
  });

  it("returns undefined when the managed root or provisioning port is missing", () => {
    expect(
      resolveManagedTaskWorkspaceRoot(
        { managedTaskWorkspaceRoot: undefined, workspaceProvisioning: undefined },
        "/managed/repo_a/ws_b",
      ),
    ).toBeUndefined();
  });

  // Regression for S8786: the leaf-id parser used to trim trailing separators with `/[/\\]+$/`,
  // a shape SonarCloud flags on sight even though this bounded class has no ambiguity of its own
  // (authorization.ts's trimTrailingSeparators is now regex-free). This asserts a root with a huge
  // run of trailing separators still resolves quickly instead of relying on regex backtracking.
  it("derives the leaf id from a root with a huge run of trailing separators in bounded time", () => {
    const getInstance = vi.fn<WorkspaceProvisioningService["getInstance"]>();
    const root = `/managed/repo_a/ws_b${"/".repeat(20_000)}`;

    const start = Date.now();
    const result = resolveManagedTaskWorkspaceRoot(
      {
        managedTaskWorkspaceRoot: "/managed",
        workspaceProvisioning: provisioningStub(getInstance),
      },
      root,
    );
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(200);
    expect(result).toBeUndefined();
    expect(getInstance).toHaveBeenCalledWith("ws_b");
  });
});
