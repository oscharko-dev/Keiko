// #3563 review: `CodingWorkbenchWindowHost.tsx` (the thin adapter between the windows registry and
// `CodingWorkbenchWindow`) forwards a successful bind to `context.updateCfg({ repositoryPath })`
// so the next time this window opens it seeds from the bound repository. This test pins that
// without loading the full runtime (the window itself is fully mocked here).
//
// #A review: a repository/branch pick is local window state until Start, not a failure, so the
// routine `reportClientDiagnostic` calls this host used to make on every selection were removed —
// they surfaced server-side as warn-level client failures for an ordinary pick.

import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import type { WindowCfgRecord, WindowRenderContext } from "../../windows/WindowsRegistry";
import { CodingWorkbenchWindowHost } from "./CodingWorkbenchWindowHost";
import type { CodingWorkbenchGitTarget } from "./CodingWorkbenchWindow";

interface WindowProps {
  readonly selectedRoot?: string | undefined;
  readonly selectedBranch?: string | undefined;
  readonly historySelection?: string | undefined;
  readonly onHistorySelectionHandled?: () => void;
  readonly onOpenHistory?: () => void;
  readonly onOpenGit?: (target: CodingWorkbenchGitTarget) => void;
  readonly onSelectRepository?: (root: string) => void;
  readonly onSelectBranch?: (branch: string) => void;
}

const windowRendered = vi.hoisted(() => vi.fn<(props: WindowProps) => void>());
const diagnostics = vi.hoisted(() => ({ writes: [] as string[] }));

vi.mock("./CodingWorkbenchWindow", () => ({
  CodingWorkbenchWindow: (props: WindowProps): null => {
    windowRendered(props);
    return null;
  },
}));

vi.mock("@/lib/client-diagnostics", () => ({
  reportClientDiagnostic: (note: string): void => {
    diagnostics.writes.push(note);
  },
}));

function contextFixture(overrides: Partial<WindowRenderContext> = {}): WindowRenderContext {
  return {
    windowId: "window-1",
    linkedRoot: null,
    linkedFilePath: undefined,
    linkedRoots: [],
    linkedCapsuleIds: [],
    linkedCapsuleSetIds: [],
    linkedFigmaSnapshotRunIds: [],
    selectedRoot: null,
    activeRoot: null,
    activeBinding: null,
    updateCfg: vi.fn(),
    openWindow: vi.fn(() => "opened-window-id"),
    focusWindow: vi.fn(),
    updateWindow: vi.fn(),
    openEditorFile: vi.fn(() => ({ kind: "opened", windowId: "editor-1" })),
    ...overrides,
  } as WindowRenderContext;
}

function renderHost(
  cfg: WindowCfgRecord,
  overrides: Partial<WindowRenderContext> = {},
): WindowRenderContext {
  const context = contextFixture(overrides);
  render(<CodingWorkbenchWindowHost cfg={cfg} context={context} />);
  return context;
}

describe("CodingWorkbenchWindowHost", () => {
  it("prefers the per-window cfg repository over the shared context selection", () => {
    windowRendered.mockClear();
    renderHost({ repositoryPath: "/repos/cfg" }, { selectedRoot: "/repos/shared" });
    const props = windowRendered.mock.calls.at(-1)?.[0];
    expect(props?.selectedRoot).toBe("/repos/cfg");
  });

  it("keeps the window repository when another surface selects a different one", () => {
    windowRendered.mockClear();
    diagnostics.writes = [];
    const context = contextFixture({ selectedRoot: "/repos/shared" });
    const view = render(
      <CodingWorkbenchWindowHost cfg={{ repositoryPath: "/repos/cfg" }} context={context} />,
    );
    expect(context.updateCfg).not.toHaveBeenCalled();

    view.rerender(
      <CodingWorkbenchWindowHost
        cfg={{ repositoryPath: "/repos/cfg" }}
        context={{ ...context, selectedRoot: "/repos/other" }}
      />,
    );

    expect(context.updateCfg).not.toHaveBeenCalled();
    expect(windowRendered.mock.calls.at(-1)?.[0]?.selectedRoot).toBe("/repos/cfg");
    expect(diagnostics.writes).toEqual([]);
  });

  it("keeps the per-window repository when the header moves onto that same repository", () => {
    const context = contextFixture({ selectedRoot: "/repos/shared" });
    const view = render(
      <CodingWorkbenchWindowHost cfg={{ repositoryPath: "/repos/cfg" }} context={context} />,
    );

    view.rerender(
      <CodingWorkbenchWindowHost
        cfg={{ repositoryPath: "/repos/cfg" }}
        context={{ ...context, selectedRoot: "/repos/cfg" }}
      />,
    );

    expect(context.updateCfg).not.toHaveBeenCalled();
  });

  it("seeds once from the shared selection when the cfg carries no repositoryPath", () => {
    windowRendered.mockClear();
    const context = contextFixture({ selectedRoot: "/repos/shared" });
    const view = render(<CodingWorkbenchWindowHost cfg={{}} context={context} />);
    view.rerender(
      <CodingWorkbenchWindowHost cfg={{}} context={{ ...context, selectedRoot: "/repos/other" }} />,
    );
    const props = windowRendered.mock.calls.at(-1)?.[0];
    expect(props?.selectedRoot).toBe("/repos/shared");
  });

  it("persists the bound repository through onSelectRepository without a client diagnostic (#A)", () => {
    windowRendered.mockClear();
    diagnostics.writes = [];
    const context = renderHost({});
    const props = windowRendered.mock.calls.at(-1)?.[0];

    props?.onSelectRepository?.("/repos/newly-bound");

    // The one job of the host's callback: write the newly bound root to per-window cfg so a later
    // reopen seeds from it, dropping any branch chosen for the PREVIOUS repository (#E).
    expect(context.updateCfg).toHaveBeenCalledExactlyOnceWith({
      repositoryPath: "/repos/newly-bound",
      targetBranch: undefined,
      targetBranchRoot: undefined,
    });
    // A repository pick is local window state until Start, never a client failure.
    expect(diagnostics.writes).toEqual([]);
  });

  it("selecting a branch emits no client diagnostic either (#A)", () => {
    diagnostics.writes = [];
    renderHost({ repositoryPath: "/repos/cfg" });
    const props = windowRendered.mock.calls.at(-1)?.[0];

    props?.onSelectBranch?.("feature/x");

    expect(diagnostics.writes).toEqual([]);
  });

  it("stores a selected branch together with the repository it was chosen for (#E)", () => {
    const context = renderHost({ repositoryPath: "/repos/a" });
    const props = windowRendered.mock.calls.at(-1)?.[0];

    props?.onSelectBranch?.("release");

    expect(context.updateCfg).toHaveBeenCalledExactlyOnceWith({
      targetBranch: "release",
      targetBranchRoot: "/repos/a",
    });
  });

  it("keeps the target branch selected while its repository stays bound", () => {
    windowRendered.mockClear();
    renderHost({
      repositoryPath: "/repos/a",
      targetBranch: "release",
      targetBranchRoot: "/repos/a",
    });

    expect(windowRendered.mock.calls.at(-1)?.[0]?.selectedBranch).toBe("release");
  });

  // #E: Coding History's `onOpen` (CodingHistoryPanel.tsx) opens this window with a new
  // `repositoryPath` and `historySelection` but no `targetBranch` — the cfg patch merge (owned
  // outside this file) then keeps whatever `targetBranch`/`targetBranchRoot` this window already
  // had. A target branch chosen for repository A must never survive onto repository B.
  it("drops a target branch that belonged to a different repository", () => {
    windowRendered.mockClear();
    const context = contextFixture({});
    const view = render(
      <CodingWorkbenchWindowHost
        cfg={{ repositoryPath: "/repos/a", targetBranch: "release", targetBranchRoot: "/repos/a" }}
        context={context}
      />,
    );
    expect(windowRendered.mock.calls.at(-1)?.[0]?.selectedBranch).toBe("release");

    // Simulates the merged cfg after CodingHistoryPanel's onOpen changes only repositoryPath and
    // historySelection: the stale targetBranch/targetBranchRoot from repo A ride along untouched.
    view.rerender(
      <CodingWorkbenchWindowHost
        cfg={{
          repositoryPath: "/repos/b",
          historySelection: "task-1",
          targetBranch: "release",
          targetBranchRoot: "/repos/a",
        }}
        context={context}
      />,
    );

    const after = windowRendered.mock.calls.at(-1)?.[0];
    expect(after?.selectedRoot).toBe("/repos/b");
    expect(after?.selectedBranch).toBeUndefined();
  });

  it("routes onOpenGit through openWindow with the derived Git target", () => {
    windowRendered.mockClear();
    const context = renderHost({});
    const props = windowRendered.mock.calls.at(-1)?.[0];

    props?.onOpenGit?.({ root: "/repos/x", binding: "repository" });

    expect(context.openWindow).toHaveBeenCalledWith("governedGit", {
      projectPath: "/repos/x",
      rootBinding: "coding-repository",
    });
  });

  it("opens the governed pull request window when a description review is requested", () => {
    windowRendered.mockClear();
    const context = renderHost({});
    const props = windowRendered.mock.calls.at(-1)?.[0];

    props?.onOpenGit?.({
      root: "/repos/y",
      binding: "task-workspace",
      descriptionReview: {
        ownerAndRepo: "owner/repo",
        prNumber: 42,
        proposalId: "proposal-1",
        snapshotDigest: "d".repeat(64),
      },
    });

    expect(context.openWindow).toHaveBeenCalledWith("governedPullRequest", {
      projectPath: "/repos/y",
      descriptionOwnerAndRepo: "owner/repo",
      descriptionPrNumber: 42,
      descriptionProposalId: "proposal-1",
      descriptionSnapshotDigest: "d".repeat(64),
    });
  });
});
