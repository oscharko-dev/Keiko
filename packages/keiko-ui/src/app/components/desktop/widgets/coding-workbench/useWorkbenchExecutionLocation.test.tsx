import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceInstance } from "@oscharko-dev/keiko-contracts";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";

import { useWorkbenchExecutionLocation } from "./useWorkbenchExecutionLocation";

const mocks = vi.hoisted(() => ({
  fetchGitStatus: vi.fn(),
  selectLocalCheckout: vi.fn(),
  bindVerifiedTaskWorkspace: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchGitStatus: mocks.fetchGitStatus,
}));
vi.mock("@/lib/task-workspace-api", () => ({ selectLocalCheckout: mocks.selectLocalCheckout }));
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
  it("joins branch discovery and local activation under one correlation ID", async () => {
    mocks.fetchGitStatus.mockResolvedValue({ available: true, branch: "main", detached: false });
    mocks.selectLocalCheckout.mockResolvedValue({});
    renderHook(useWorkbenchExecutionLocation, {
      initialProps: {
        root: "/repo",
        branch: undefined,
        location: "local" as const,
        activeInstance: null,
        workspaceLoading: false,
        workspaceError: false,
        runIsActive: false,
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
        workspaceLoading: false,
        workspaceError: false,
        runIsActive: false,
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
      workspaceLoading: true,
      workspaceError: false,
      runIsActive: false,
      refresh,
    };
    const { rerender, result } = renderHook(useWorkbenchExecutionLocation, {
      initialProps: initial,
    });
    expect(result.current.pending).toBe(true);
    expect(mocks.fetchGitStatus).not.toHaveBeenCalled();
    rerender({ ...initial, activeInstance: managed, workspaceLoading: false });
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
      workspaceLoading: false,
      workspaceError: false,
      runIsActive: false,
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
