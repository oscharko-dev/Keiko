import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceInstance } from "@oscharko-dev/keiko-contracts";
import { ApiError } from "@/lib/api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";

import {
  activeExecutionLocation,
  useWorkbenchExecutionLocation,
} from "./useWorkbenchExecutionLocation";

const mocks = vi.hoisted(() => ({
  fetchGitStatus: vi.fn(),
  fetchProjects: vi.fn(),
  selectLocalCheckout: vi.fn(),
  selectFolderWorkspace: vi.fn(),
  bindVerifiedTaskWorkspace: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchGitStatus: mocks.fetchGitStatus,
  fetchProjects: mocks.fetchProjects,
}));
vi.mock("@/lib/task-workspace-api", () => ({
  selectLocalCheckout: mocks.selectLocalCheckout,
  selectFolderWorkspace: mocks.selectFolderWorkspace,
}));
vi.mock("@/lib/verified-task-workspace-binding", () => ({
  bindVerifiedTaskWorkspace: mocks.bindVerifiedTaskWorkspace,
}));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));

const refresh = vi.fn(() => Promise.resolve(true));
const managed = {
  repositoryRoot: "/repo",
  baseBranch: "main",
  executionLocation: "worktree",
} as WorkspaceInstance;

beforeEach(() => {
  mocks.fetchProjects.mockResolvedValue({ projects: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

// #4068: behind the Windows broker the runtime confines only a Keiko-managed worktree, so neither a
// saved Local choice nor the Local default may bind a checkout the server would refuse.
describe("the location a runtime can confine", () => {
  const local = { ...managed, executionLocation: "local" } as WorkspaceInstance;

  it("keeps every preference when the runtime names no locations", () => {
    expect(activeExecutionLocation(null, "/repo", undefined)).toBe("local");
    expect(activeExecutionLocation(null, "/repo", "worktree")).toBe("worktree");
    expect(activeExecutionLocation(local, "/repo", undefined)).toBe("local");
    expect(activeExecutionLocation(null, "/repo", undefined, ["local", "worktree"])).toBe("local");
  });

  it("turns a saved or default Local into a worktree where only a worktree is confined", () => {
    expect(activeExecutionLocation(null, "/repo", undefined, ["worktree"])).toBe("worktree");
    expect(activeExecutionLocation(null, "/repo", "local", ["worktree"])).toBe("worktree");
    expect(activeExecutionLocation(local, "/repo", undefined, ["worktree"])).toBe("worktree");
    expect(activeExecutionLocation(managed, "/repo", undefined, ["worktree"])).toBe("worktree");
  });
});

describe("workbench execution location restoration", () => {
  it("does not revert an external branch change on active-workspace refresh", async () => {
    const initial = {
      root: "/repo",
      branch: "main",
      location: "local" as const,
      activeInstance: {
        ...managed,
        executionLocation: "local",
        taskBranch: "main",
      } as WorkspaceInstance | null,
      workspaceLoading: false,
      workspaceError: false,
      branchLoading: false,
      branchError: false,
      branchDenied: false,
      runIsActive: false,
      folderMode: false,
      refresh,
    };
    const { rerender, result } = renderHook(useWorkbenchExecutionLocation, {
      initialProps: initial,
    });
    expect(result.current.ready).toBe(true);
    await act(async () => {
      rerender({ ...initial, activeInstance: null });
    });
    expect(mocks.selectLocalCheckout).not.toHaveBeenCalled();
    expect(result.current.ready).toBe(false);
    expect(result.current.error).toBe(true);
    mocks.selectLocalCheckout.mockResolvedValue({});
    await act(async () => {
      result.current.retry();
    });
    await waitFor(() => expect(mocks.selectLocalCheckout).toHaveBeenCalledOnce());
  });

  it.each(["loading", "failed"])("waits when the branch inventory is %s", async (status) => {
    const initial = {
      root: "/repo",
      branch: "main",
      location: "local" as const,
      activeInstance: null,
      workspaceLoading: false,
      workspaceError: false,
      branchLoading: status === "loading",
      branchError: status === "failed",
      branchDenied: false,
      runIsActive: false,
      folderMode: false,
      refresh,
    };
    const { rerender } = renderHook(useWorkbenchExecutionLocation, { initialProps: initial });
    await act(async () => {});
    expect(mocks.selectLocalCheckout).not.toHaveBeenCalled();
    mocks.selectLocalCheckout.mockResolvedValue({});
    rerender({ ...initial, branchLoading: false, branchError: false });
    await waitFor(() => expect(mocks.selectLocalCheckout).toHaveBeenCalledOnce());
  });

  // #4404: a Windows checkout failed with "choose a branch in Git" while Git itself could not run.
  // A closed server code with one plain cause reaches the notice; any other failure does not.
  it.each([
    [new ApiError("REPOSITORY_UNREACHABLE", "unreachable", 503), "git-unreadable"],
    [new ApiError("MISSING_REPOSITORY", "missing", 404), "unregistered"],
    [new ApiError("UNSAFE_PATH", "unsafe", 400), undefined],
    [new Error("WORKSPACE_REFRESH_UNAVAILABLE"), undefined],
  ])("names the server's cause of a failed checkout (%s)", async (failure, reason) => {
    mocks.selectLocalCheckout.mockRejectedValue(failure);
    const { result } = renderHook(useWorkbenchExecutionLocation, {
      initialProps: {
        root: "/repo",
        branch: "main",
        location: "local" as const,
        activeInstance: null,
        workspaceLoading: false,
        workspaceError: false,
        branchLoading: false,
        branchError: false,
        branchDenied: false,
        runIsActive: false,
        folderMode: false,
        refresh,
      },
    });
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.reason).toBe(reason);
  });

  // #4068: before readiness answers, the runtime's confinable locations are unknown, so the default
  // Local must not be bound against the operator's own checkout.
  describe("while the runtime has not named its locations", () => {
    const settled = {
      root: "/repo",
      branch: "main",
      activeInstance: null,
      workspaceLoading: false,
      workspaceError: false,
      branchLoading: false,
      branchError: false,
      branchDenied: false,
      runIsActive: false,
      folderMode: false,
      refresh,
    };

    it("binds only the worktree once readiness offers nothing else", async () => {
      mocks.bindVerifiedTaskWorkspace.mockResolvedValue({ ok: true });
      const { rerender, result } = renderHook(useWorkbenchExecutionLocation, {
        initialProps: {
          ...settled,
          location: "local" as "local" | "worktree",
          locationsPending: true,
        },
      });
      await act(async () => {});
      expect(result.current.pending).toBe(true);
      expect(result.current.ready).toBe(false);
      expect(mocks.selectLocalCheckout).not.toHaveBeenCalled();
      expect(mocks.bindVerifiedTaskWorkspace).not.toHaveBeenCalled();
      rerender({ ...settled, location: "worktree", locationsPending: false });
      await waitFor(() => expect(mocks.bindVerifiedTaskWorkspace).toHaveBeenCalledOnce());
      expect(mocks.selectLocalCheckout).not.toHaveBeenCalled();
    });

    it("binds the local checkout as before once readiness offers both locations", async () => {
      mocks.selectLocalCheckout.mockResolvedValue({});
      const { rerender } = renderHook(useWorkbenchExecutionLocation, {
        initialProps: { ...settled, location: "local" as const, locationsPending: true },
      });
      await act(async () => {});
      expect(mocks.selectLocalCheckout).not.toHaveBeenCalled();
      rerender({ ...settled, location: "local", locationsPending: false });
      await waitFor(() => expect(mocks.selectLocalCheckout).toHaveBeenCalledOnce());
    });
  });

  it("refreshes a failed branch inventory when the user retries", async () => {
    const { result } = renderHook(useWorkbenchExecutionLocation, {
      initialProps: {
        root: "/repo",
        branch: "main",
        location: "local",
        activeInstance: null,
        branchLoading: false,
        branchError: true,
        branchDenied: false,
        workspaceLoading: false,
        workspaceError: false,
        runIsActive: false,
        folderMode: false,
        refresh,
      },
    });
    expect(result.current.error).toBe(true);
    await act(async () => result.current.retry());
    expect(refresh).toHaveBeenCalledOnce();
    expect(mocks.selectLocalCheckout).not.toHaveBeenCalled();
  });

  it("does not repeat a completed activation when refresh cannot restore its binding", async () => {
    mocks.selectLocalCheckout.mockResolvedValue({});
    const initial = {
      root: "/repo",
      branch: "main",
      location: "local" as const,
      activeInstance: null,
      workspaceLoading: false,
      workspaceError: false,
      branchLoading: false,
      branchError: false,
      branchDenied: false,
      runIsActive: false,
      folderMode: false,
      refresh,
    };
    const { rerender, result } = renderHook(useWorkbenchExecutionLocation, {
      initialProps: initial,
    });
    await waitFor(() => expect(result.current.pending).toBe(false));
    rerender({ ...initial });
    expect(mocks.selectLocalCheckout).toHaveBeenCalledOnce();
    expect(result.current.error).toBe(true);
  });

  it("joins branch discovery and local activation under one correlation ID", async () => {
    mocks.fetchGitStatus.mockResolvedValue({ available: true, branch: "main", detached: false });
    mocks.selectLocalCheckout.mockResolvedValue({});
    renderHook(useWorkbenchExecutionLocation, {
      initialProps: {
        root: "/repo",
        branch: undefined,
        location: "local" as const,
        activeInstance: null,
        branchLoading: false,
        branchError: false,
        branchDenied: false,
        workspaceLoading: false,
        workspaceError: false,
        runIsActive: false,
        folderMode: false,
        refresh,
      },
    });

    await waitFor(() => expect(mocks.selectLocalCheckout).toHaveBeenCalledOnce());
    const correlationId = mocks.fetchGitStatus.mock.calls[0]?.[1]?.correlationId as string;
    expect(mocks.selectLocalCheckout).toHaveBeenCalledWith({
      root: "/repo",
      branch: "main",
      requestedBy: "studio-operator",
      correlationId,
    });
  });

  it("reports a failed branch discovery under its original attempt correlation", async () => {
    mocks.fetchGitStatus.mockResolvedValue({ available: false });
    renderHook(useWorkbenchExecutionLocation, {
      initialProps: {
        root: "/repo",
        branch: undefined,
        location: "local" as const,
        activeInstance: null,
        branchLoading: false,
        branchError: false,
        branchDenied: false,
        workspaceLoading: false,
        workspaceError: false,
        runIsActive: false,
        folderMode: false,
        refresh,
      },
    });

    await waitFor(() => expect(reportClientDiagnostic).toHaveBeenCalled());
    expect(reportClientDiagnostic).toHaveBeenCalledWith(
      "[keiko] coding workbench checkout selection failed",
      expect.objectContaining({
        correlationId: mocks.fetchGitStatus.mock.calls[0]?.[1]?.correlationId,
      }),
    );
    expect(mocks.selectLocalCheckout).not.toHaveBeenCalled();
  });

  it("waits for the authoritative workspace before selecting a checkout", () => {
    const initial = {
      root: "/repo",
      branch: undefined,
      location: "worktree" as const,
      activeInstance: null as WorkspaceInstance | null,
      branchLoading: false,
      branchError: false,
      branchDenied: false,
      workspaceLoading: true,
      workspaceError: false,
      runIsActive: false,
      folderMode: false,
      refresh,
    };
    const { rerender, result } = renderHook(useWorkbenchExecutionLocation, {
      initialProps: initial,
    });
    expect(result.current.pending).toBe(true);
    expect(mocks.fetchGitStatus).not.toHaveBeenCalled();
    rerender({
      ...initial,
      activeInstance: managed,
      branchLoading: false,
      branchError: false,
      branchDenied: false,
      workspaceLoading: false,
    });
    expect(result.current.ready).toBe(true);
    expect(mocks.selectLocalCheckout).not.toHaveBeenCalled();
    expect(mocks.bindVerifiedTaskWorkspace).not.toHaveBeenCalled();
  });

  it("discards a stale branch read when the selected workspace changes", async () => {
    let finishRead: ((value: unknown) => void) | undefined;
    mocks.fetchGitStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        finishRead = resolve;
      }),
    );
    const initial = {
      root: "/old",
      branch: undefined,
      location: "local" as "local" | "worktree",
      activeInstance: null as WorkspaceInstance | null,
      branchLoading: false,
      branchError: false,
      branchDenied: false,
      workspaceLoading: false,
      workspaceError: false,
      runIsActive: false,
      folderMode: false,
      refresh,
    };
    const { rerender } = renderHook(useWorkbenchExecutionLocation, { initialProps: initial });
    await waitFor(() =>
      expect(mocks.fetchGitStatus).toHaveBeenCalledWith(
        "/old",
        expect.objectContaining({ correlationId: expect.any(String) }),
      ),
    );
    rerender({ ...initial, root: "/repo", location: "worktree", activeInstance: managed });
    await act(async () => {
      finishRead?.({ available: true, branch: "main", detached: false });
    });
    expect(mocks.selectLocalCheckout).not.toHaveBeenCalled();
    expect(mocks.bindVerifiedTaskWorkspace).not.toHaveBeenCalled();
    expect(reportClientDiagnostic).toHaveBeenCalledWith(
      "[keiko] coding workbench checkout selection superseded",
      expect.objectContaining({
        correlationId: mocks.fetchGitStatus.mock.calls[0]?.[1]?.correlationId,
        gitClientOperation: { operation: "checkout-selection", outcome: "discarded-succeeded" },
      }),
    );
  });
});

// Owner decision 2026-10-30: an ordinary folder is bound in place as a folder workspace, with no
// branch to resolve and no worktree.
describe("workbench execution location in an ordinary folder", () => {
  const folderInstance = {
    repositoryRoot: "/folder",
    executionLocation: "local",
    workspaceKind: "folder",
  } as WorkspaceInstance;
  const initial = {
    root: "/folder",
    branch: undefined,
    location: "local" as const,
    folderMode: true,
    activeInstance: null as WorkspaceInstance | null,
    workspaceLoading: false,
    workspaceError: false,
    branchLoading: false,
    branchError: false,
    branchDenied: false,
    runIsActive: false,
    refresh,
  };

  it("binds the folder in place without reading a branch, then is ready", async () => {
    mocks.selectFolderWorkspace.mockResolvedValue({});
    const { rerender, result } = renderHook(useWorkbenchExecutionLocation, {
      initialProps: initial,
    });
    await waitFor(() => expect(mocks.selectFolderWorkspace).toHaveBeenCalledOnce());
    expect(mocks.selectFolderWorkspace).toHaveBeenCalledWith({
      root: "/folder",
      requestedBy: "studio-operator",
      correlationId: expect.any(String),
    });
    expect(mocks.fetchGitStatus).not.toHaveBeenCalled();
    expect(mocks.selectLocalCheckout).not.toHaveBeenCalled();
    expect(mocks.bindVerifiedTaskWorkspace).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalled();
    rerender({ ...initial, activeInstance: folderInstance });
    expect(result.current.ready).toBe(true);
  });

  it("is not ready through a repository binding of the same root, and binds the folder", async () => {
    mocks.selectFolderWorkspace.mockResolvedValue({});
    const repository = {
      repositoryRoot: "/folder",
      executionLocation: "local",
      taskBranch: "main",
    } as WorkspaceInstance;
    const { result } = renderHook(useWorkbenchExecutionLocation, {
      initialProps: { ...initial, activeInstance: repository },
    });
    expect(result.current.ready).toBe(false);
    await waitFor(() => expect(mocks.selectFolderWorkspace).toHaveBeenCalledOnce());
  });

  it("never treats a folder binding as the checkout of a repository root", async () => {
    mocks.selectLocalCheckout.mockResolvedValue({});
    const { result } = renderHook(useWorkbenchExecutionLocation, {
      initialProps: { ...initial, folderMode: false, activeInstance: folderInstance },
    });
    expect(result.current.ready).toBe(false);
    await waitFor(() => expect(mocks.fetchGitStatus).toHaveBeenCalled());
  });

  it("reports a refused folder binding as an error with a retry, never as ready", async () => {
    mocks.selectFolderWorkspace.mockRejectedValue(new Error("refused"));
    const { result } = renderHook(useWorkbenchExecutionLocation, { initialProps: initial });
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.ready).toBe(false);
    mocks.selectFolderWorkspace.mockResolvedValue({});
    await act(async () => {
      result.current.retry();
    });
    await waitFor(() => expect(mocks.selectFolderWorkspace).toHaveBeenCalledTimes(2));
  });
});

// #4371: when the server refused the folder (the closed DENIED reason) the checkout says so once.
describe("a checkout failure the server named as a refusal", () => {
  const input = {
    root: "/repo",
    branch: "main",
    location: "worktree" as const,
    folderMode: false,
    activeInstance: null,
    branchLoading: false,
    branchError: true,
    workspaceLoading: false,
    workspaceError: false,
    runIsActive: false,
    refresh,
  };

  it("is denied when the branch read was refused", () => {
    const { result } = renderHook(() =>
      useWorkbenchExecutionLocation({ ...input, branchDenied: true }),
    );
    expect(result.current.error).toBe(true);
    expect(result.current.denied).toBe(true);
  });

  it("is not denied for an ordinary failure", () => {
    const { result } = renderHook(() =>
      useWorkbenchExecutionLocation({ ...input, branchDenied: false }),
    );
    expect(result.current.error).toBe(true);
    expect(result.current.denied).toBe(false);
  });
});

// A folder deleted and re-created under the same path: the server dropped the binding, the held
// instance still names the folder, and the registered project reports no workspace.
describe("a selection whose folder lost its workspace behind a still-held binding", () => {
  const held = { ...managed, executionLocation: "local", taskBranch: "main" } as WorkspaceInstance;
  const input = {
    root: "/repo",
    branch: "main",
    location: "local" as const,
    activeInstance: held as WorkspaceInstance | null,
    workspaceLoading: false,
    workspaceError: false,
    branchLoading: false,
    branchError: false,
    branchDenied: false,
    runIsActive: false,
    folderMode: false,
    refresh,
  };
  const project = (workspaceAvailable: boolean): { projects: unknown[] } => ({
    projects: [{ path: "/repo", available: true, workspaceAvailable, readable: true }],
  });

  it("binds the checkout again by itself and is ready once the folder reports a workspace", async () => {
    mocks.fetchProjects.mockResolvedValueOnce(project(false)).mockResolvedValue(project(true));
    mocks.selectLocalCheckout.mockResolvedValue(undefined);
    const { result } = renderHook(() => useWorkbenchExecutionLocation(input));
    await waitFor(() => {
      expect(mocks.selectLocalCheckout).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });
    expect(result.current.error).toBe(false);
  });

  it("never carries one folder's lost workspace over to the next selected folder", async () => {
    mocks.fetchProjects.mockResolvedValueOnce(project(false));
    mocks.selectLocalCheckout.mockRejectedValue(new Error("refused"));
    const { result, rerender } = renderHook((props) => useWorkbenchExecutionLocation(props), {
      initialProps: input,
    });
    await waitFor(() => {
      expect(result.current.error).toBe(true);
    });
    // The next folder's availability read is still in flight when it is selected.
    mocks.fetchProjects.mockReturnValue(new Promise(() => undefined));
    rerender({ ...input, root: "/other", activeInstance: { ...held, repositoryRoot: "/other" } });
    expect(result.current.ready).toBe(true);
    expect(mocks.selectLocalCheckout).toHaveBeenCalledTimes(1);
  });

  it("lets only the newest availability read answer", async () => {
    let answerOlder: ((value: { projects: unknown[] }) => void) | undefined;
    mocks.fetchProjects
      .mockReturnValueOnce(
        new Promise((resolve) => {
          answerOlder = resolve;
        }),
      )
      .mockResolvedValueOnce(project(true));
    const { result } = renderHook(() => useWorkbenchExecutionLocation(input));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => {
      expect(mocks.fetchProjects).toHaveBeenCalledTimes(2);
    });
    await act(async () => {
      answerOlder?.(project(false));
      await Promise.resolve();
    });
    expect(result.current.ready).toBe(true);
    expect(mocks.selectLocalCheckout).not.toHaveBeenCalled();
  });

  it("names the lost workspace, not a branch, when a bind leaves the folder unbound", async () => {
    // A repository cloned again at the same path: the bind succeeds, the folder stays unconnected.
    mocks.fetchProjects.mockResolvedValue(project(false));
    mocks.selectLocalCheckout.mockResolvedValue(undefined);
    const { result } = renderHook(() => useWorkbenchExecutionLocation(input));
    await waitFor(() => {
      expect(result.current.error).toBe(true);
    });
    expect(result.current.reason).toBe("unbound");
    expect(result.current.ready).toBe(false);
  });

  it("says the folder is unbound until its workspace is back, with or without an error", async () => {
    mocks.fetchProjects.mockResolvedValueOnce(project(false)).mockResolvedValue(project(true));
    mocks.selectLocalCheckout.mockReturnValue(new Promise(() => undefined));
    const { result } = renderHook(() => useWorkbenchExecutionLocation(input));
    await waitFor(() => {
      expect(result.current.unbound).toBe(true);
    });
    expect(result.current.error).toBe(false);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => {
      expect(result.current.unbound).toBe(false);
    });
  });

  it("keeps the server's own named cause over the lost workspace", async () => {
    mocks.fetchProjects.mockResolvedValue(project(false));
    mocks.selectLocalCheckout.mockRejectedValue(
      new ApiError("MISSING_REPOSITORY", "Select a registered repository.", 404),
    );
    const { result } = renderHook(() => useWorkbenchExecutionLocation(input));
    await waitFor(() => {
      expect(result.current.error).toBe(true);
    });
    expect(result.current.reason).toBe("unregistered");
  });

  it("stays not ready with an error when the folder cannot be bound", async () => {
    mocks.fetchProjects.mockResolvedValue(project(false));
    mocks.selectLocalCheckout.mockRejectedValue(new Error("refused"));
    const { result } = renderHook(() => useWorkbenchExecutionLocation(input));
    await waitFor(() => {
      expect(result.current.error).toBe(true);
    });
    expect(result.current.ready).toBe(false);
    expect(mocks.selectLocalCheckout).toHaveBeenCalledTimes(1);
  });
});
