// Coverage for the managed-task-workspace authorization boundary's leaf-id derivation (Epic #443).
// resolveManagedTaskWorkspaceInstanceFromLookup re-derives a WorkspaceInstance's identity from a
// candidate root before trusting it; these tests exercise that derivation directly against a
// stubbed lookup, without needing a live managed worktree on disk. (#3347 review moved the
// WorkspaceInfo-returning wrappers that used to live here — resolveManagedTaskWorkspaceRoot /
// resolveRegisteredOrManagedWorkspaceRoot — into workspace-root-access.ts, where they compose the
// STRONG proof (ownership, lifecycle, gitdir identity) instead of trusting this lookup alone; see
// workspace-root-access.test.ts for their coverage.)

import { describe, expect, it, vi } from "vitest";
import { resolveManagedTaskWorkspaceInstanceFromLookup } from "./authorization.js";
import type { WorkspaceProvisioningService } from "./types.js";

function lookupStub(getInstance: WorkspaceProvisioningService["getInstance"]): {
  readonly managedRoot: string;
  readonly getInstance: WorkspaceProvisioningService["getInstance"];
} {
  return { managedRoot: "/managed", getInstance };
}

describe("resolveManagedTaskWorkspaceInstanceFromLookup", () => {
  it("derives the workspace leaf id after trimming trailing path separators", () => {
    const getInstance = vi.fn<WorkspaceProvisioningService["getInstance"]>();
    const result = resolveManagedTaskWorkspaceInstanceFromLookup(
      lookupStub(getInstance),
      "/managed/repo_a/ws_b///",
    );

    expect(result).toBeUndefined();
    expect(getInstance).toHaveBeenCalledWith("ws_b");
  });

  it("returns undefined when the managed root is missing", () => {
    expect(
      resolveManagedTaskWorkspaceInstanceFromLookup(
        { managedRoot: undefined, getInstance: vi.fn() },
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
    const result = resolveManagedTaskWorkspaceInstanceFromLookup(lookupStub(getInstance), root);
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(1000);
    expect(result).toBeUndefined();
    expect(getInstance).toHaveBeenCalledWith("ws_b");
  });
});
