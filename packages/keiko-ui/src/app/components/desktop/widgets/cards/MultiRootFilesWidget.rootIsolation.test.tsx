import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_TRUST_SCHEMA_VERSION,
  type WorkspaceManifest,
  type WorkspaceRootDescriptor,
  type WorkspaceRootRef,
} from "@oscharko-dev/keiko-contracts";
import { I18nProvider } from "@/lib/i18n";
import { fetchFilesTree, fetchGitStatus, fetchProjects } from "../../../../../lib/api";
import type { WorkspaceManifestView } from "../../hooks/useWorkspaceManifest";
import { MultiRootFilesWidget } from "./MultiRootFilesWidget";

// Like the a11y sibling, this file deliberately does NOT mock ./FilesWidget. The defect under test
// is that FilesWidget reports an active-file change on unattended lifecycle events — a mount, a
// refresh, a top-level directory load — and not only on user selection. A mock would have to
// re-implement exactly that behaviour to expose it, and a mock that re-implements the production
// behaviour it guards is the fixture that can no longer fail when production moves.
vi.mock("../../../../../lib/api", async () => {
  const actual =
    await vi.importActual<typeof import("../../../../../lib/api")>("../../../../../lib/api");
  return {
    ...actual,
    fetchProjects: vi.fn(),
    fetchFilesTree: vi.fn(),
    fetchGitStatus: vi.fn(),
  };
});

vi.mock("../../workspace-trust/useWorkspaceTrust", () => ({
  useWorkspaceTrust: (projectId: string) => ({
    status: {
      kind: "workspace-trust-status",
      schemaVersion: WORKSPACE_TRUST_SCHEMA_VERSION,
      projectId,
      trust: projectId === "/repo-populated" ? "trusted" : "restricted",
      decidedBy: "server",
      reason: projectId === "/repo-populated" ? "human-grant" : "human-revocation",
      revision: 1,
    },
  }),
}));

const EMPTY_ROOT = "/repo-empty";
const POPULATED_ROOT = "/repo-populated";

const entryBase = {
  sizeBytes: 1,
  modifiedAt: 1,
  extension: null,
  symlink: false,
  readable: true,
} as const;

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

function manifest(roots: readonly WorkspaceRootDescriptor[]): WorkspaceManifest {
  const first = roots[0];
  if (first === undefined) throw new Error("A workspace manifest needs at least one root.");
  return {
    kind: "workspace-manifest",
    schemaVersion: 1,
    manifestRef: "manifest-a" as WorkspaceManifest["manifestRef"],
    manifestDigest: "b".repeat(64) as WorkspaceManifest["manifestDigest"],
    workspaceId: "workspace-a",
    revision: 1,
    roots,
    focusedRootRef: first.rootRef,
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

function renderExplorer(
  roots: readonly WorkspaceRootDescriptor[],
  onActiveFileChange: (
    path: string | null,
    root: string | null,
    activeDirectoryPath?: string | null,
  ) => void = vi.fn(),
): HTMLElement {
  const current = manifest(roots);
  const { container } = render(
    <I18nProvider>
      <MultiRootFilesWidget
        manifest={current}
        workspace={workspace(current)}
        onActiveFileChange={onActiveFileChange}
        onOpenFile={vi.fn()}
        onOpenGitDelivery={vi.fn()}
      />
    </I18nProvider>,
  );
  return container;
}

async function settledTrees(expected: number): Promise<void> {
  await waitFor(() => {
    expect(document.querySelectorAll(".files-tree")).toHaveLength(expected);
  });
}

beforeEach(() => {
  vi.mocked(fetchProjects).mockResolvedValue({
    projects: [
      {
        name: "Repo C",
        path: "/repo-c",
        available: true,
        favorite: false,
        createdAt: 1,
        lastOpenedAt: 1,
      },
    ],
  });
  vi.mocked(fetchGitStatus).mockRejectedValue(new Error("no git repository"));
  vi.mocked(fetchFilesTree).mockImplementation(async (treeRoot: string, path = "") => ({
    root: treeRoot,
    path,
    truncated: false,
    entries:
      treeRoot === POPULATED_ROOT && path === ""
        ? [
            { ...entryBase, name: "src", path: "src", kind: "directory", sizeBytes: 0 },
            { ...entryBase, name: "app.ts", path: "app.ts", kind: "file", extension: "ts" },
          ]
        : [],
  }));
});

afterEach(() => vi.clearAllMocks());

describe("MultiRootFilesWidget root isolation over the real file tree", () => {
  it("lets only the focused root write the shared active-file binding", async () => {
    // One Files window owns ONE cfg, and onActiveFileChange is its writer. Every root group used to
    // receive that writer unchanged, so a non-focused group's mount and directory load re-pointed
    // `resolvedRoot` for every connected window with no user action naming it.
    const onActiveFileChange = vi.fn();
    renderExplorer(
      [
        root("root-populated", POPULATED_ROOT, "Populated"),
        root("root-empty", EMPTY_ROOT, "Empty"),
      ],
      onActiveFileChange,
    );

    await settledTrees(2);
    await waitFor(() => {
      expect(vi.mocked(fetchFilesTree).mock.calls.some(([r]) => r === EMPTY_ROOT)).toBe(true);
    });

    // The focused root is the first one, so nothing reported may name the other.
    const reportedRoots = onActiveFileChange.mock.calls.map(([, reportedRoot]) => reportedRoot);
    expect(reportedRoots).not.toContain(EMPTY_ROOT);
  });

  it("keeps the binding untouched when a non-focused group is collapsed and re-expanded", async () => {
    const onActiveFileChange = vi.fn();
    renderExplorer(
      [
        root("root-populated", POPULATED_ROOT, "Populated"),
        root("root-empty", EMPTY_ROOT, "Empty"),
      ],
      onActiveFileChange,
    );
    await settledTrees(2);
    onActiveFileChange.mockClear();

    // Collapsing and re-expanding remounts that group's FilesWidget, which re-fires its lifecycle
    // reports. None of them belong to the focused root, so none may reach the shared writer.
    const group = screen.getByRole("treeitem", { name: "Empty" });
    const toggle = group.querySelector("button");
    if (toggle === null) throw new Error("root group toggle missing");
    await userEvent.click(toggle);
    await userEvent.click(toggle);
    await settledTrees(2);

    expect(onActiveFileChange).not.toHaveBeenCalled();
  });
});
