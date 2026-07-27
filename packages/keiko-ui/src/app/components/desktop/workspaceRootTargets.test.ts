import { describe, expect, it } from "vitest";
import type { WorkspaceManifest } from "@oscharko-dev/keiko-contracts";
import {
  requestWorkspaceRoots,
  WORKSPACE_ROOT_REQUEST_CONCURRENCY,
  workspaceRootTargets,
  type WorkspaceRootTarget,
} from "./workspaceRootTargets";

function manifest(): WorkspaceManifest {
  return {
    kind: "workspace-manifest",
    schemaVersion: 1,
    workspaceId: "workspace-1" as WorkspaceManifest["workspaceId"],
    manifestRef: "manifest-1" as WorkspaceManifest["manifestRef"],
    revision: 1,
    manifestDigest: "a".repeat(64) as WorkspaceManifest["manifestDigest"],
    roots: [
      {
        rootRef: "root-a" as WorkspaceManifest["roots"][number]["rootRef"],
        canonicalRoot: "/repo/a",
        displayName: "Shared",
        identityDigest: "b".repeat(64) as WorkspaceManifest["roots"][number]["identityDigest"],
        sourceDigest: { outcome: "absent" },
      },
      {
        rootRef: "root-b" as WorkspaceManifest["roots"][number]["rootRef"],
        canonicalRoot: "/repo/b",
        displayName: "Shared",
        identityDigest: "c".repeat(64) as WorkspaceManifest["roots"][number]["identityDigest"],
        sourceDigest: { outcome: "absent" },
      },
    ],
    focusedRootRef: "root-a" as WorkspaceManifest["focusedRootRef"],
  };
}

describe("workspaceRootTargets", () => {
  it("preserves manifest order and disambiguates duplicate display names without exposing paths", () => {
    expect(workspaceRootTargets("/ignored", manifest())).toEqual([
      { id: "root-a", root: "/repo/a", label: "Shared (1)" },
      { id: "root-b", root: "/repo/b", label: "Shared (2)" },
    ]);
  });

  it("keeps root request outcomes ordered and isolates failures", async () => {
    const targets = workspaceRootTargets(undefined, manifest());
    const outcomes = await requestWorkspaceRoots(targets, (target) =>
      target.id === "root-a" ? Promise.resolve(target.root) : Promise.reject(new Error("denied")),
    );

    expect(outcomes).toEqual([
      { status: "success", target: targets[0], value: "/repo/a" },
      { status: "error", target: targets[1], message: "denied" },
    ]);
  });

  it("bounds a 32-root fan-out at the explicit concurrency ceiling", async () => {
    const targets: readonly WorkspaceRootTarget[] = Array.from({ length: 32 }, (_, index) => ({
      id: `root-${String(index)}`,
      root: `/repo/${String(index)}`,
      label: `Root ${String(index + 1)}`,
    }));
    let activeRequests = 0;
    let maximumActiveRequests = 0;

    const outcomes = await requestWorkspaceRoots(targets, async (target) => {
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      await Promise.resolve();
      activeRequests -= 1;
      return target.id;
    });

    expect(maximumActiveRequests).toBe(WORKSPACE_ROOT_REQUEST_CONCURRENCY);
    expect(outcomes).toHaveLength(32);
    expect(outcomes.map((outcome) => outcome.target.id)).toEqual(
      targets.map((target) => target.id),
    );
  });
});
