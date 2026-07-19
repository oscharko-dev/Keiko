import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_TRUST_SCHEMA_VERSION,
  type WorkspaceManifest,
  type WorkspaceRootDescriptor,
  type WorkspaceRootRef,
} from "@oscharko-dev/keiko-contracts";
import { I18nProvider } from "@/lib/i18n";
import type { WorkspaceManifestView } from "../../hooks/useWorkspaceManifest";
import { MultiRootFilesWidget } from "./MultiRootFilesWidget";

vi.mock("../../../../../lib/api", () => ({
  fetchProjects: vi.fn().mockResolvedValue({
    projects: [{ id: "p3", name: "Repo C", path: "/repo-c", available: true }],
  }),
}));

vi.mock("../../workspace-trust/useWorkspaceTrust", () => ({
  useWorkspaceTrust: (projectId: string) => ({
    status: {
      kind: "workspace-trust-status",
      schemaVersion: WORKSPACE_TRUST_SCHEMA_VERSION,
      projectId,
      trust: projectId === "/repo-a" ? "trusted" : "restricted",
      decidedBy: "server",
      reason: projectId === "/repo-a" ? "human-grant" : "human-revocation",
      revision: 1,
    },
  }),
}));

vi.mock("./FilesWidget", () => ({
  FilesWidget: ({
    root,
    onOpenFile,
  }: {
    readonly root: string;
    readonly onOpenFile: (root: string, path: string) => void;
  }) => (
    <div role="tree" aria-label={`Files ${root}`}>
      <button
        type="button"
        role="treeitem"
        aria-selected="false"
        onClick={() => onOpenFile(root, "src/app.ts")}
      >
        Open {root}
      </button>
    </div>
  ),
}));

function root(
  rootRef: string,
  canonicalRoot: string,
  displayName: string,
): WorkspaceRootDescriptor {
  return {
    rootRef: rootRef as WorkspaceRootRef,
    canonicalRoot,
    displayName,
    identityDigest: "a".repeat(64) as WorkspaceRootDescriptor["identityDigest"],
    sourceDigest: { outcome: "absent" },
  };
}

function manifest(): WorkspaceManifest {
  const roots = [root("root-a", "/repo-a", "Repo A"), root("root-b", "/repo-b", "Repo B")];
  return {
    kind: "workspace-manifest",
    schemaVersion: 1,
    manifestRef: "manifest-a" as WorkspaceManifest["manifestRef"],
    manifestDigest: "b".repeat(64) as WorkspaceManifest["manifestDigest"],
    workspaceId: "workspace-a",
    revision: 1,
    roots,
    focusedRootRef: roots[0]!.rootRef,
  };
}

function workspace(current: WorkspaceManifest): WorkspaceManifestView {
  return {
    manifest: current,
    loading: false,
    mutating: false,
    issue: null,
    refresh: vi.fn(async () => undefined),
    addRoot: vi.fn(async () => true),
    removeRoot: vi.fn(async () => true),
    reorderRoots: vi.fn(async () => true),
    focusRoot: vi.fn(async () => true),
  };
}

afterEach(() => vi.clearAllMocks());

describe("MultiRootFilesWidget", () => {
  it("renders every root, trust state, and root-management action", async () => {
    const current = manifest();
    const view = workspace(current);
    const onOpenFile = vi.fn();
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <MultiRootFilesWidget
          manifest={current}
          workspace={view}
          onActiveFileChange={vi.fn()}
          onOpenFile={onOpenFile}
          onOpenGitDelivery={vi.fn()}
        />
      </I18nProvider>,
    );
    await screen.findByRole("option", { name: "Repo C" });

    expect(screen.getByRole("treeitem", { name: "Repo A" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByLabelText("Trusted workspace")).toBeVisible();
    expect(screen.getByLabelText("Restricted Mode")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Focus root: Repo B" }));
    expect(view.focusRoot).toHaveBeenCalledWith("root-b");
    await user.click(screen.getByRole("button", { name: "Move root up: Repo B" }));
    expect(view.reorderRoots).toHaveBeenCalledWith("root-b", ["root-b", "root-a"]);
    await user.click(screen.getByRole("button", { name: "Remove root: Repo B" }));
    expect(view.removeRoot).toHaveBeenCalledWith("root-b", "root-b");
    await user.click(screen.getByRole("treeitem", { name: "Open /repo-b" }));
    expect(onOpenFile).toHaveBeenCalledWith("/repo-b", "src/app.ts");
  });

  it("supports arrow navigation across root groups, collapse, axe, and 320px width", async () => {
    const current = manifest();
    const { container } = render(
      <I18nProvider>
        <MultiRootFilesWidget
          manifest={current}
          workspace={workspace(current)}
          onActiveFileChange={vi.fn()}
          onOpenFile={vi.fn()}
          onOpenGitDelivery={vi.fn()}
        />
      </I18nProvider>,
    );
    await screen.findByRole("option", { name: "Repo C" });
    const headers = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button[data-root-group-header]"),
    );
    headers[0]?.focus();
    fireEvent.keyDown(headers[0]!, { key: "ArrowDown" });
    expect(headers[1]).toHaveFocus();
    await userEvent.click(headers[1]!);
    expect(screen.getByRole("treeitem", { name: "Repo B" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    container.style.width = "320px";
    expect(await axe(container)).toHaveNoViolations();
  });
});
