import { render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
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

// This file deliberately does NOT mock ./FilesWidget. MultiRootFilesWidget.test.tsx does, and that
// is correct for its behavioural assertions — but a hand-written mock of the file tree is a copy of
// the production markup, and a copy cannot detect the production markup drifting away from it. The
// #2605 defect lived in exactly that blind spot: the real tree rendered an accessibility-visible
// caret button as an owned child of role="tree", the mock rendered a bare treeitem, and the mocked
// axe scan passed over a defect the real browser reported as critical. Accessibility structure is
// only meaningfully asserted against the component that actually renders it.
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
    pathReadAuthority: "available",
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

function renderExplorer(roots: readonly WorkspaceRootDescriptor[]): HTMLElement {
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
            {
              ...entryBase,
              name: "src",
              path: "src",
              kind: "directory",
              sizeBytes: undefined,
              modifiedAt: undefined,
            },
            { ...entryBase, name: "app.ts", path: "app.ts", kind: "file", extension: "ts" },
          ]
        : [],
  }));
});

afterEach(() => vi.clearAllMocks());

describe("MultiRootFilesWidget accessibility over the real file tree (#2605)", () => {
  it("has no violations when a root's tree carries folders and files", async () => {
    const container = renderExplorer([
      root("root-populated", POPULATED_ROOT, "Populated"),
      root("root-empty", EMPTY_ROOT, "Empty"),
    ]);

    // A directory row is what renders the caret button beside its treeitem, so waiting for one is
    // what makes this scan cover the structure #2605 was about rather than an unpopulated tree.
    await screen.findByRole("treeitem", { name: /^src$/u });
    await screen.findByRole("treeitem", { name: /app\.ts/u });
    await settledTrees(2);

    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no violations when a root's tree is empty", async () => {
    const container = renderExplorer([root("root-empty", EMPTY_ROOT, "Empty")]);

    await settledTrees(1);

    expect(await axe(container)).toHaveNoViolations();
  });

  it("keeps the caret out of the accessibility tree while the row still announces expansion", async () => {
    renderExplorer([root("root-populated", POPULATED_ROOT, "Populated")]);

    const directoryRow = await screen.findByRole("treeitem", { name: /^src$/u });
    expect(directoryRow).toHaveAttribute("aria-expanded", "false");

    // The caret stays operable for pointer users; it is simply not owned by the tree. role="tree"
    // may own only treeitem and group, so an exposed caret is the exact defect #2605 filed —
    // asserting both halves stops a later change from restoring it by dropping aria-hidden.
    const caret = document.querySelector<HTMLButtonElement>("button.tr-caret-btn");
    expect(caret).not.toBeNull();
    expect(caret).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("button", { name: /expand folder/iu })).toBeNull();
  });
});
