import { describe, expect, it } from "vitest";
import type { WorkspaceManifest } from "@oscharko-dev/keiko-contracts";
import { requestWorkspaceRoots, workspaceRootTargets } from "./workspaceRootTargets";

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
});
