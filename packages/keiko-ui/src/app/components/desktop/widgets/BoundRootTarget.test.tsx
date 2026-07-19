import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceManifest } from "@oscharko-dev/keiko-contracts";
import { BoundRootTarget, resolveExplicitWindowRoot } from "./BoundRootTarget";
import { useWorkspaceManifest } from "../hooks/useWorkspaceManifest";

vi.mock("../hooks/useWorkspaceManifest", () => ({ useWorkspaceManifest: vi.fn() }));

const useWorkspaceManifestMock = vi.mocked(useWorkspaceManifest);

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
        displayName: "Root A",
        identityDigest: "b".repeat(64) as WorkspaceManifest["roots"][number]["identityDigest"],
        sourceDigest: { outcome: "absent" },
      },
      {
        rootRef: "root-b" as WorkspaceManifest["roots"][number]["rootRef"],
        canonicalRoot: "/repo/b",
        displayName: "Root B",
        identityDigest: "c".repeat(64) as WorkspaceManifest["roots"][number]["identityDigest"],
        sourceDigest: { outcome: "absent" },
      },
    ],
    focusedRootRef: "root-b" as WorkspaceManifest["focusedRootRef"],
  };
}

beforeEach(() => {
  useWorkspaceManifestMock.mockReturnValue({ manifest: manifest() } as ReturnType<
    typeof useWorkspaceManifest
  >);
});

describe("BoundRootTarget", () => {
  it("defaults an unconfigured read surface to the focused manifest root", () => {
    expect(resolveExplicitWindowRoot(manifest(), undefined, "/repo/a", false)).toBe("/repo/b");
  });

  it("keeps the task-workspace root locked even when cfg names a sibling root", () => {
    expect(resolveExplicitWindowRoot(manifest(), "/repo/b", "/task/root", true)).toBe("/task/root");
  });

  it("persists an explicit member selection and retargets its child", () => {
    const onSelect = vi.fn();
    render(
      <BoundRootTarget
        fallbackRoot="/repo/a"
        configuredRoot="/repo/a"
        lockedToActiveRoot={false}
        label="Terminal"
        onSelect={onSelect}
      >
        {(root) => <div>{root}</div>}
      </BoundRootTarget>,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Terminal root" }), {
      target: { value: "/repo/b" },
    });
    expect(onSelect).toHaveBeenCalledWith("/repo/b");
    expect(screen.getByText("/repo/a")).toBeInTheDocument();
  });
});
