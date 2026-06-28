import { describe, expect, it } from "vitest";
import type { GitRepositorySummary } from "@/lib/types";
import { deriveSyncView } from "./SyncControl";

function summary(overrides: Partial<GitRepositorySummary> = {}): GitRepositorySummary {
  return {
    schemaVersion: "1",
    root: "/repo",
    state: "available",
    available: true,
    branch: "main",
    detached: false,
    upstream: { ref: "origin/main", remote: "origin", branch: "main" },
    ahead: 0,
    behind: 0,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    conflictedCount: 0,
    clean: true,
    remotes: [{ name: "origin" }],
    truncated: false,
    ...overrides,
  };
}

describe("deriveSyncView (Issue #1576)", () => {
  it("resolves no-upstream branches with remotes to publish-upstream", () => {
    const view = deriveSyncView(summary({ upstream: undefined }), false);
    expect(view.action).toBe("publish-upstream");
    expect(view.remoteAlias).toBe("origin");
    expect(view.setUpstreamTracking).toBe(true);
  });

  it("resolves ahead-only branches to push", () => {
    expect(deriveSyncView(summary({ ahead: 2 }), false).action).toBe("push");
  });

  it("resolves behind-only branches to pull", () => {
    expect(deriveSyncView(summary({ behind: 3 }), false).action).toBe("pull");
  });

  it("resolves up-to-date branches to fetch", () => {
    expect(deriveSyncView(summary(), false).action).toBe("fetch");
  });

  it("keeps diverged branches safe by fetching and pointing at merge reconciliation", () => {
    const view = deriveSyncView(summary({ ahead: 1, behind: 1 }), false);
    expect(view.action).toBe("fetch");
    expect(view.description).toContain("Diverged");
    expect(view.description).toContain("Merge");
  });

  it("blocks detached, conflicted, and no-remote states", () => {
    expect(deriveSyncView(summary({ detached: true }), false).disabled).toBe(true);
    expect(deriveSyncView(summary({ conflictedCount: 1 }), false).disabled).toBe(true);
    expect(deriveSyncView(summary({ remotes: [] }), false).disabled).toBe(true);
  });
});
