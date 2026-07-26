import { readFileSync } from "node:fs";
import { join } from "node:path";
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

const rootGroupCss = readFileSync(
  join(import.meta.dirname, "MultiRootFilesWidget.module.css"),
  "utf8",
).replace(/\s+/g, " ");

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
      {root === "/repo-a" ? null : (
        <button
          type="button"
          role="treeitem"
          aria-selected="false"
          onClick={() => onOpenFile(root, "src/app.ts")}
        >
          Open {root}
        </button>
      )}
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

function manifest(
  roots: readonly WorkspaceRootDescriptor[] = [
    root("root-a", "/repo-a", "Repo A"),
    root("root-b", "/repo-b", "Repo B"),
  ],
): WorkspaceManifest {
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

  it("uses roving tabindex with ArrowUp, ArrowDown, Home, and End across root groups", async (): Promise<void> => {
    const current = manifest();
    render(
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
    const rootA = screen.getByRole("treeitem", { name: "Repo A" });
    const rootB = screen.getByRole("treeitem", { name: "Repo B" });

    expect(rootA).toHaveAttribute("tabindex", "0");
    expect(rootB).toHaveAttribute("tabindex", "-1");
    rootA.focus();
    fireEvent.keyDown(rootA, { key: "ArrowUp" });
    expect(rootA).toHaveFocus();
    fireEvent.keyDown(rootA, { key: "ArrowDown" });
    expect(rootB).toHaveFocus();
    expect(rootA).toHaveAttribute("tabindex", "-1");
    expect(rootB).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(rootB, { key: "ArrowUp" });
    expect(rootA).toHaveFocus();
    fireEvent.keyDown(rootA, { key: "End" });
    expect(rootB).toHaveFocus();
    fireEvent.keyDown(rootB, { key: "ArrowDown" });
    expect(rootB).toHaveFocus();
    fireEvent.keyDown(rootB, { key: "Home" });
    expect(rootA).toHaveFocus();
    fireEvent.keyDown(rootA, { key: "ArrowLeft" });
    expect(rootA).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(rootA, { key: "ArrowRight" });
    expect(rootA).toHaveAttribute("aria-expanded", "true");
  });

  it("supports tree keys from the expanded-state control", async (): Promise<void> => {
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
    const rootA = screen.getByRole("treeitem", { name: "Repo A" });
    const rootB = screen.getByRole("treeitem", { name: "Repo B" });
    const rootBHeader = headers[1]!;

    rootBHeader.focus();
    fireEvent.keyDown(rootBHeader, { key: "ArrowLeft" });
    expect(rootBHeader).toHaveAttribute("aria-expanded", "false");
    expect(rootB).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(rootBHeader, { key: "ArrowRight" });
    expect(rootBHeader).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(rootBHeader, { key: "ArrowUp" });
    expect(rootA).toHaveFocus();
  });

  it("leaves nested file-tree key events with the nested tree", async (): Promise<void> => {
    const current = manifest();
    render(
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
    const nestedFile = screen.getByRole("treeitem", { name: "Open /repo-b" });

    nestedFile.focus();
    fireEvent.keyDown(nestedFile, { key: "ArrowUp" });

    expect(nestedFile).toHaveFocus();
  });

  it("synchronizes the roving tab stop when the focused root changes", async (): Promise<void> => {
    const current = manifest();
    const { rerender } = render(
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
    const rootA = screen.getByRole("treeitem", { name: "Repo A" });
    const rootB = screen.getByRole("treeitem", { name: "Repo B" });
    const next = {
      ...current,
      revision: current.revision + 1,
      focusedRootRef: current.roots[1]!.rootRef,
    };

    rerender(
      <I18nProvider>
        <MultiRootFilesWidget
          manifest={next}
          workspace={workspace(next)}
          onActiveFileChange={vi.fn()}
          onOpenFile={vi.fn()}
          onOpenGitDelivery={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(rootA).toHaveAttribute("tabindex", "-1");
    expect(rootB).toHaveAttribute("tabindex", "0");
  });

  it("exposes expanded state on the focusable root control", async (): Promise<void> => {
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
    const rootB = headers[1]!;

    expect(rootB).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(rootB);
    expect(rootB).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps root-group focus visible in keyboard and pointer modalities", (): void => {
    expect(rootGroupCss).toContain(
      ".cmpRootGroup:focus-visible { outline: var(--focus-width, 2px) solid var(--focus-ring);",
    );
    expect(rootGroupCss).toContain(
      ':global(:root[data-input-modality="pointer"]) .cmpRootGroup:focus { outline: var(--focus-width, 2px) solid var(--focus-ring) !important;',
    );
  });

  it.each([
    {
      state: "empty",
      roots: [root("root-a", "/repo-a", "Repo A")],
    },
    {
      state: "populated",
      roots: [root("root-b", "/repo-b", "Repo B")],
    },
  ])("has no axe violations for a $state root", async ({ roots }): Promise<void> => {
    const current = manifest(roots);
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

    expect(await axe(container)).toHaveNoViolations();
  });
});
