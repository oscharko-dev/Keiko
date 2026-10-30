import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceInstance } from "@oscharko-dev/keiko-contracts";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";

import { useWorkbenchExecutionLocation } from "./useWorkbenchExecutionLocation";

const mocks = vi.hoisted(() => ({
  fetchGitStatus: vi.fn(),
  selectLocalCheckout: vi.fn(),
  selectFolderWorkspace: vi.fn(),
  bindVerifiedTaskWorkspace: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchGitStatus: mocks.fetchGitStatus,
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

afterEach(() => {
  vi.clearAllMocks();
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

  it("refreshes a failed branch inventory when the user retries", async () => {
    const { result } = renderHook(useWorkbenchExecutionLocation, {
      initialProps: {
        root: "/repo",
        branch: "main",
        location: "local",
        activeInstance: null,
        branchLoading: false,
        branchError: true,
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
