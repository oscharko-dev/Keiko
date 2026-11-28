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
import type { WorkspaceBinding } from "@oscharko-dev/keiko-contracts";
import type { WindowCfgRecord, WindowRenderContext } from "../../windows/WindowsRegistry";
import {
  ActiveWorkspaceProvider,
  type ActiveWorkspaceApi,
} from "../../context/ActiveWorkspaceContext";
import { CodingWorkbenchWindowHost } from "./CodingWorkbenchWindowHost";
import type { CodingWorkbenchGitTarget } from "./CodingWorkbenchWindow";

interface WindowProps {
  readonly selectedRoot?: string | undefined;
  readonly selectedBranch?: string | undefined;
  readonly selectedLocation?: "local" | "worktree" | undefined;
  readonly historySelection?: string | undefined;
  readonly onHistorySelectionHandled?: () => void;
  readonly onOpenHistory?: () => void;
  readonly onOpenGit?: (target: CodingWorkbenchGitTarget) => void;
  readonly onSelectRepository?: (root: string) => void;
  readonly onSelectBranch?: (branch: string, repositoryRoot: string | null) => void;
  readonly onPinRepository?: (root: string) => void;
  readonly activationTrigger?: string | undefined;
  readonly leftRun?: string | undefined;
  readonly onLeftRun?: (runId: string | undefined) => void;
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

// The routine mount report (#4068) is observed on its own; the #A pins below keep proving that a
// repository or branch pick reports nothing.
const repositoryResolved = vi.hoisted(() => vi.fn<(source: string) => void>());
vi.mock("@/lib/coding-workbench-interaction", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-workbench-interaction")>()),
  reportCodingWorkbenchRepositoryResolved: repositoryResolved,
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

const BOUND: WorkspaceBinding = {
  schemaVersion: "1",
  workspaceId: "ws-bound",
  taskId: "task-bound",
  activeRoot: "/repos/bound",
  boundSurfaces: [],
  gitDeliveryRoot: "/repos/bound",
  editorProjectRoot: "/repos/bound",
};

function workspaceState(
  state: Partial<Pick<ActiveWorkspaceApi, "loading" | "error" | "activeBinding">>,
): ActiveWorkspaceApi {
  const activeBinding = state.activeBinding ?? null;
  return {
    instances: [],
    activeBinding,
    activeInstance: null,
    activeRoot: activeBinding?.activeRoot ?? null,
    loading: state.loading ?? false,
    switching: false,
    error: state.error ?? null,
    inventoryUnavailable: false,
  } as unknown as ActiveWorkspaceApi;
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

  // A restored layout mounts the Workbench on first paint, before the shell's project has loaded.
  // The window must seed from that project once it arrives instead of keeping no repository and
  // showing the "Code setup" fallback for a project the shell already selected.
  it("seeds once from a shared selection that arrives after the window mounted", () => {
    windowRendered.mockClear();
    const context = contextFixture({ selectedRoot: null });
    const view = render(<CodingWorkbenchWindowHost cfg={{}} context={context} />);
    expect(windowRendered.mock.calls.at(-1)?.[0]?.selectedRoot).toBeUndefined();

    view.rerender(
      <CodingWorkbenchWindowHost
        cfg={{}}
        context={{ ...context, selectedRoot: "/repos/shared" }}
      />,
    );
    expect(windowRendered.mock.calls.at(-1)?.[0]?.selectedRoot).toBe("/repos/shared");

    view.rerender(
      <CodingWorkbenchWindowHost cfg={{}} context={{ ...context, selectedRoot: "/repos/other" }} />,
    );
    expect(windowRendered.mock.calls.at(-1)?.[0]?.selectedRoot).toBe("/repos/shared");
    expect(context.updateCfg).not.toHaveBeenCalled();
  });

  it("never seeds from the shell once an active task-workspace binding decided the window", () => {
    windowRendered.mockClear();
    const binding: WorkspaceBinding = {
      schemaVersion: "1",
      workspaceId: "ws-bound",
      taskId: "task-bound",
      activeRoot: "/repos/bound",
      boundSurfaces: [],
      gitDeliveryRoot: "/repos/bound",
      editorProjectRoot: "/repos/bound",
    };
    const context = contextFixture({ selectedRoot: null, activeBinding: binding });
    const view = render(<CodingWorkbenchWindowHost cfg={{}} context={context} />);

    view.rerender(
      <CodingWorkbenchWindowHost
        cfg={{}}
        context={{ ...context, activeBinding: null, selectedRoot: "/repos/shared" }}
      />,
    );

    expect(windowRendered.mock.calls.at(-1)?.[0]?.selectedRoot).toBeUndefined();
  });

  // #4271: before the task-workspace state has answered, a null binding means "not read yet", not
  // "unbound". Seeding from the shell's project then bound that folder in place of the active task
  // workspace whenever the project loaded first.
  it("waits for the task-workspace read before deciding between the shell and a binding", () => {
    windowRendered.mockClear();
    diagnostics.writes = [];
    const context = contextFixture({ selectedRoot: "/repos/shell", activeBinding: null });
    const view = render(
      <ActiveWorkspaceProvider value={workspaceState({ loading: true })}>
        <CodingWorkbenchWindowHost cfg={{}} context={context} />
      </ActiveWorkspaceProvider>,
    );
    expect(windowRendered.mock.calls.at(-1)?.[0]?.selectedRoot).toBeUndefined();

    view.rerender(
      <ActiveWorkspaceProvider value={workspaceState({ activeBinding: BOUND })}>
        <CodingWorkbenchWindowHost cfg={{}} context={{ ...context, activeBinding: BOUND }} />
      </ActiveWorkspaceProvider>,
    );
    view.rerender(
      <ActiveWorkspaceProvider value={workspaceState({})}>
        <CodingWorkbenchWindowHost cfg={{}} context={context} />
      </ActiveWorkspaceProvider>,
    );

    expect(windowRendered.mock.calls.at(-1)?.[0]?.selectedRoot).toBeUndefined();
    expect(diagnostics.writes).toEqual([
      "[keiko] coding workbench interaction: repository-seed-skipped",
    ]);
  });

  it("seeds from the shell once the task-workspace read answered without a binding", () => {
    windowRendered.mockClear();
    diagnostics.writes = [];
    const context = contextFixture({ selectedRoot: "/repos/shell", activeBinding: null });
    const view = render(
      <ActiveWorkspaceProvider value={workspaceState({ loading: true })}>
        <CodingWorkbenchWindowHost cfg={{}} context={context} />
      </ActiveWorkspaceProvider>,
    );
    view.rerender(
      <ActiveWorkspaceProvider value={workspaceState({ error: "unavailable" })}>
        <CodingWorkbenchWindowHost cfg={{}} context={context} />
      </ActiveWorkspaceProvider>,
    );
    expect(windowRendered.mock.calls.at(-1)?.[0]?.selectedRoot).toBeUndefined();

    view.rerender(
      <ActiveWorkspaceProvider value={workspaceState({})}>
        <CodingWorkbenchWindowHost cfg={{}} context={context} />
      </ActiveWorkspaceProvider>,
    );
    view.rerender(
      <ActiveWorkspaceProvider value={workspaceState({})}>
        <CodingWorkbenchWindowHost cfg={{}} context={{ ...context, selectedRoot: "/repos/x" }} />
      </ActiveWorkspaceProvider>,
    );

    expect(windowRendered.mock.calls.at(-1)?.[0]?.selectedRoot).toBe("/repos/shell");
    expect(diagnostics.writes).toEqual(["[keiko] coding workbench interaction: repository-seeded"]);
  });

  it("follows a binding that is present even while a later read is pending or failed", () => {
    for (const state of [{ loading: true }, { error: "unavailable" }]) {
      windowRendered.mockClear();
      diagnostics.writes = [];
      const context = contextFixture({ selectedRoot: "/repos/shell", activeBinding: BOUND });
      const view = render(
        <ActiveWorkspaceProvider value={workspaceState({ ...state, activeBinding: BOUND })}>
          <CodingWorkbenchWindowHost cfg={{}} context={context} />
        </ActiveWorkspaceProvider>,
      );
      expect(windowRendered.mock.calls.at(-1)?.[0]?.selectedRoot).toBeUndefined();
      expect(diagnostics.writes).toEqual([
        "[keiko] coding workbench interaction: repository-seed-skipped",
      ]);
      view.unmount();
    }
  });

  // The qualification's shape: a restored window with its own repository never waits for, seeds
  // from, or reports a shell seed, whatever the task-workspace state does.
  it("keeps a stored repository without a seed decision", () => {
    windowRendered.mockClear();
    diagnostics.writes = [];
    const context = contextFixture({ selectedRoot: "/repos/shell", activeBinding: null });
    const view = render(
      <ActiveWorkspaceProvider value={workspaceState({ loading: true })}>
        <CodingWorkbenchWindowHost cfg={{ repositoryPath: "/repos/cfg" }} context={context} />
      </ActiveWorkspaceProvider>,
    );
    expect(windowRendered.mock.calls.at(-1)?.[0]?.selectedRoot).toBe("/repos/cfg");
    view.rerender(
      <ActiveWorkspaceProvider value={workspaceState({})}>
        <CodingWorkbenchWindowHost cfg={{ repositoryPath: "/repos/cfg" }} context={context} />
      </ActiveWorkspaceProvider>,
    );
    expect(windowRendered.mock.calls.at(-1)?.[0]?.selectedRoot).toBe("/repos/cfg");
    expect(diagnostics.writes).toEqual([]);
  });

  // U-3: a window that follows the active workspace ran in repository A while another window (Git)
  // had B selected; the shell's project followed B. Remounting the window after the run (the
  // workspace read can be unreadable then) re-seeded B and the Workbench activated it unasked. The
  // repository a run works in is pinned into the window's own configuration, so no re-seed happens.
  it("keeps the repository a run worked in when the window mounts again against another shell project", () => {
    windowRendered.mockClear();
    const context = contextFixture({ selectedRoot: "/repos/git-window", activeBinding: BOUND });
    let cfg: WindowCfgRecord = {};
    vi.mocked(context.updateCfg).mockImplementation((patch) => {
      cfg = { ...cfg, ...patch };
    });
    const first = render(<CodingWorkbenchWindowHost cfg={cfg} context={context} />);
    expect(windowRendered.mock.calls.at(-1)?.[0]?.selectedRoot).toBeUndefined();

    windowRendered.mock.calls.at(-1)?.[0]?.onPinRepository?.("/repos/bound");
    expect(context.updateCfg).toHaveBeenCalledExactlyOnceWith({
      repositoryPath: "/repos/bound",
      repositoryPinned: true,
    });
    first.unmount();

    // The remount finds no readable binding and the shell on the Git window's repository.
    render(
      <ActiveWorkspaceProvider value={workspaceState({})}>
        <CodingWorkbenchWindowHost cfg={cfg} context={{ ...context, activeBinding: null }} />
      </ActiveWorkspaceProvider>,
    );

    expect(windowRendered.mock.calls.at(-1)?.[0]?.selectedRoot).toBe("/repos/bound");
  });

  // U-3: the shell's seed only ever binds a folder when nothing is active; once a workspace is
  // active the window follows it, so the seed can never trigger an activation of another repository.
  it("follows an active workspace instead of a seed the shell decided earlier", () => {
    windowRendered.mockClear();
    const context = contextFixture({ selectedRoot: "/repos/git-window", activeBinding: null });
    const active = { ...workspaceState({}), activeInstance: { repositoryRoot: "/repos/bound" } };
    const view = render(
      <ActiveWorkspaceProvider value={workspaceState({})}>
        <CodingWorkbenchWindowHost cfg={{}} context={context} />
      </ActiveWorkspaceProvider>,
    );
    expect(windowRendered.mock.calls.at(-1)?.[0]).toMatchObject({
      selectedRoot: "/repos/git-window",
      activationTrigger: "shell-seed",
    });

    view.rerender(
      <ActiveWorkspaceProvider value={active as unknown as ActiveWorkspaceApi}>
        <CodingWorkbenchWindowHost cfg={{}} context={context} />
      </ActiveWorkspaceProvider>,
    );

    expect(windowRendered.mock.calls.at(-1)?.[0]?.selectedRoot).toBeUndefined();
  });

  // Two windows pinned to different repositories would bind their own pin back every time the
  // other one moved the active workspace. A pin is not a selection: it holds only while it is the
  // active repository or none is active.
  it("follows the active workspace instead of binding a pin back after another window moved it", () => {
    windowRendered.mockClear();
    const context = contextFixture();
    const cfg = { repositoryPath: "/repos/a", repositoryPinned: true };
    const withActive = (root: string | null): ActiveWorkspaceApi =>
      ({
        ...workspaceState({}),
        activeInstance: root === null ? null : { repositoryRoot: root },
      }) as unknown as ActiveWorkspaceApi;
    const view = render(
      <ActiveWorkspaceProvider value={withActive("/repos/a")}>
        <CodingWorkbenchWindowHost cfg={cfg} context={context} />
      </ActiveWorkspaceProvider>,
    );
    expect(windowRendered.mock.calls.at(-1)?.[0]?.selectedRoot).toBe("/repos/a");

    view.rerender(
      <ActiveWorkspaceProvider value={withActive("/repos/b")}>
        <CodingWorkbenchWindowHost cfg={cfg} context={context} />
      </ActiveWorkspaceProvider>,
    );
    expect(windowRendered.mock.calls.at(-1)?.[0]?.selectedRoot).toBeUndefined();

    view.rerender(
      <ActiveWorkspaceProvider value={withActive(null)}>
        <CodingWorkbenchWindowHost cfg={cfg} context={context} />
      </ActiveWorkspaceProvider>,
    );
    expect(windowRendered.mock.calls.at(-1)?.[0]?.selectedRoot).toBe("/repos/a");

    // The person's own pick is never overridden by another window's active workspace.
    view.rerender(
      <ActiveWorkspaceProvider value={withActive("/repos/b")}>
        <CodingWorkbenchWindowHost cfg={{ repositoryPath: "/repos/a" }} context={context} />
      </ActiveWorkspaceProvider>,
    );
    expect(windowRendered.mock.calls.at(-1)?.[0]?.selectedRoot).toBe("/repos/a");
  });

  it("names a pinned repository apart from the person's own pick", () => {
    windowRendered.mockClear();
    const context = contextFixture();
    const view = render(
      <CodingWorkbenchWindowHost cfg={{ repositoryPath: "/repos/a" }} context={context} />,
    );
    expect(windowRendered.mock.calls.at(-1)?.[0]?.activationTrigger).toBe("window-selection");

    view.rerender(
      <CodingWorkbenchWindowHost
        cfg={{ repositoryPath: "/repos/a", repositoryPinned: true }}
        context={context}
      />,
    );
    expect(windowRendered.mock.calls.at(-1)?.[0]?.activationTrigger).toBe("window-pinned");

    windowRendered.mock.calls.at(-1)?.[0]?.onSelectRepository?.("/repos/b");
    expect(context.updateCfg).toHaveBeenLastCalledWith(
      expect.objectContaining({ repositoryPath: "/repos/b", repositoryPinned: undefined }),
    );
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

    props?.onSelectBranch?.("feature/x", "/repos/cfg");

    expect(diagnostics.writes).toEqual([]);
  });

  it("stores a selected branch together with the repository it was chosen for (#E)", () => {
    const context = renderHost({ repositoryPath: "/repos/a" });
    const props = windowRendered.mock.calls.at(-1)?.[0];

    props?.onSelectBranch?.("release", "/repos/a");

    expect(context.updateCfg).toHaveBeenCalledExactlyOnceWith({
      targetBranch: "release",
      targetBranchRoot: "/repos/a",
    });
  });

  // #4491: a window that shows the active binding's repository has no root of its own. The pick
  // pins that repository; stored for no repository, `resolvedTargetBranch` dropped it.
  it("pins the shown repository when a window without its own repository chooses a branch", () => {
    windowRendered.mockClear();
    const context = contextFixture({ activeBinding: BOUND });
    const view = render(<CodingWorkbenchWindowHost cfg={{}} context={context} />);
    const props = windowRendered.mock.calls.at(-1)?.[0];

    props?.onSelectBranch?.("fix/elsewhere", "/repos/bound");

    const patch = {
      repositoryPath: "/repos/bound",
      targetBranch: "fix/elsewhere",
      targetBranchRoot: "/repos/bound",
    };
    expect(context.updateCfg).toHaveBeenCalledExactlyOnceWith(patch);
    view.rerender(<CodingWorkbenchWindowHost cfg={patch} context={context} />);
    expect(windowRendered.mock.calls.at(-1)?.[0]?.selectedBranch).toBe("fix/elsewhere");
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

  it("keeps the run the window left with New task in its own configuration (#4491)", () => {
    windowRendered.mockClear();
    const context = renderHost({ repositoryPath: "/repos/a", leftRunId: "run-7" });
    const props = windowRendered.mock.calls.at(-1)?.[0];
    expect(props?.leftRun).toBe("run-7");
    props?.onLeftRun?.("run-8");
    expect(context.updateCfg).toHaveBeenCalledWith({ leftRunId: "run-8" });
  });

  it("clears saved location and branch when consuming a history selection", () => {
    windowRendered.mockClear();
    const context = renderHost({
      repositoryPath: "/repos/a",
      targetBranch: "main",
      targetBranchRoot: "/repos/a",
      executionLocation: "local",
      historySelection: "managed-task",
    });
    const props = windowRendered.mock.calls.at(-1)?.[0];
    expect(props?.selectedLocation).toBeUndefined();
    expect(props?.selectedBranch).toBeUndefined();
    props?.onHistorySelectionHandled?.();
    expect(context.updateCfg).toHaveBeenCalledWith({
      historySelection: undefined,
      executionLocation: undefined,
      targetBranch: undefined,
      targetBranchRoot: undefined,
    });
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

  describe("repository source report (#4068)", () => {
    const binding: WorkspaceBinding = {
      schemaVersion: "1",
      workspaceId: "ws-bound",
      taskId: "task-bound",
      activeRoot: "/repos/bound",
      boundSurfaces: [],
      gitDeliveryRoot: "/repos/bound",
      editorProjectRoot: "/repos/bound",
    };

    it.each([
      ["window", { repositoryPath: "/repos/cfg" }, { selectedRoot: "/repos/shared" }],
      ["shell", {}, { selectedRoot: "/repos/shared" }],
      ["none", {}, { selectedRoot: "/repos/shared", activeBinding: binding }],
    ] as const)("reports %s once when the window mounts", (source, cfg, overrides) => {
      repositoryResolved.mockClear();
      renderHost(cfg, overrides);
      expect(repositoryResolved.mock.calls).toEqual([[source]]);
    });

    it("waits for the shell's folder and then reports once, not for later changes", () => {
      repositoryResolved.mockClear();
      const context = contextFixture({ selectedRoot: null });
      const view = render(<CodingWorkbenchWindowHost cfg={{}} context={context} />);
      expect(repositoryResolved).not.toHaveBeenCalled();

      view.rerender(
        <CodingWorkbenchWindowHost cfg={{}} context={{ ...context, selectedRoot: "/repos/a" }} />,
      );
      view.rerender(
        <CodingWorkbenchWindowHost
          cfg={{ repositoryPath: "/repos/picked" }}
          context={{ ...context, selectedRoot: "/repos/b" }}
        />,
      );

      expect(repositoryResolved.mock.calls).toEqual([["shell"]]);
    });

    it("reports nothing for a repository the person picks", () => {
      repositoryResolved.mockClear();
      renderHost({ repositoryPath: "/repos/cfg" });
      windowRendered.mock.calls.at(-1)?.[0]?.onSelectRepository?.("/repos/newly-bound");
      expect(repositoryResolved.mock.calls).toEqual([["window"]]);
    });
  });
});
