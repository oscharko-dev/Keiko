import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingHistoryDetail } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts";
import { useCodingTaskSession } from "./useCodingTaskSession";
import type { ActiveWorkspaceApi } from "../../context/ActiveWorkspaceContext";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";

const read = vi.hoisted(() => vi.fn());
const update = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-history-api", () => ({
  CODING_HISTORY_CHANGED: "keiko:coding-history-changed",
  fetchCodingTask: read,
  updateCodingTask: update,
}));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));

const detail: CodingHistoryDetail = {
  task: {
    id: "chat-one",
    title: "Inspect",
    projectPath: "/repo",
    modelId: "coding",
    branch: "keiko/task/one",
    workspaceId: "ws-one",
    taskId: "task-one",
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    latestRunId: "run-one",
  },
  messages: [],
  truncated: false,
};
function snapshot(conversationId?: string): CodingWorkbenchRuntimeSnapshot {
  return {
    schemaVersion: "1",
    state: "succeeded",
    revision: 1,
    updatedAt: "2026-09-19T10:00:00.000Z",
    runId: "run-one",
    conversationId,
  };
}

function activeWorkspace(): ActiveWorkspaceApi {
  const action = vi.fn(async () => true);
  return {
    instances: [],
    activeBinding: null,
    activeRoot: "/managed/repo",
    loading: false,
    switching: false,
    error: null,
    inventoryUnavailable: false,
    refresh: action,
    switchTo: action,
    clearActive: action,
    pause: action,
    resume: action,
    prepareHandoff: action,
    repair: action,
    provision: action,
    activeInstance: {
      schemaVersion: "1",
      workspaceId: "ws-one",
      taskId: "task-one",
      repositoryId: "repo-one",
      repositoryRoot: "/repo",
      baseBranch: "master",
      taskBranch: "keiko/task/one",
      managedWorktreePath: "/managed/repo",
      gitdirIdentity: "gitdir-one",
      lifecycleState: "active",
      health: "healthy",
      lock: null,
      createdAt: "2026-09-19T10:00:00.000Z",
      updatedAt: "2026-09-19T10:00:00.000Z",
      driftMarkers: [],
      recoveryHints: [],
      auditCorrelationId: "audit-one",
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  read.mockResolvedValue(detail);
});

describe("coding task selection", () => {
  it.each(["/repo", "/other-repository"])(
    "keeps an explicitly opened task visible after switching from %s",
    async (initialRoot) => {
      const original = activeWorkspace();
      if (original.activeInstance === null) throw new Error("Missing workspace fixture");
      const workspace = {
        ...original,
        activeInstance: { ...original.activeInstance, repositoryRoot: initialRoot },
      };
      const opened = { ...detail, task: { ...detail.task, id: "chat-two", workspaceId: "ws-two" } };
      read.mockResolvedValue(opened);
      const { result, rerender } = renderHook(
        ({ current }) =>
          useCodingTaskSession({
            snapshot: null,
            active: false,
            root: "/repo",
            workspace: current,
            selection: "chat-two",
          }),
        { initialProps: { current: workspace } },
      );
      await waitFor(() => expect(workspace.switchTo).toHaveBeenCalledWith("ws-two"));
      await waitFor(() => expect(result.current.pending).toBe(false));
      if (workspace.activeInstance === null) throw new Error("Missing workspace fixture");
      rerender({
        current: {
          ...workspace,
          activeInstance: {
            ...workspace.activeInstance,
            repositoryRoot: "/repo",
            workspaceId: "ws-two",
          },
        },
      });
      expect(result.current.conversationId).toBe("chat-two");
      expect(result.current.detail).toEqual(opened);
    },
  );

  it("clears the loaded conversation when changing workspaces within the same repository", async () => {
    const workspace = activeWorkspace();
    const { result, rerender } = renderHook(
      ({ current }) =>
        useCodingTaskSession({
          snapshot: snapshot("chat-one"),
          active: false,
          root: "/repo",
          workspace: current,
          selection: undefined,
        }),
      { initialProps: { current: workspace } },
    );
    await waitFor(() => expect(result.current.conversationId).toBe("chat-one"));
    if (workspace.activeInstance === null) throw new Error("Missing workspace fixture");
    rerender({
      current: {
        ...workspace,
        activeInstance: {
          ...workspace.activeInstance,
          repositoryRoot: "/repo",
          workspaceId: "ws-two",
          taskId: "task-two",
        },
      },
    });
    expect(result.current.detail).toBeNull();
    expect(result.current.conversationId).toBeUndefined();
    expect(result.current.visibleRun).toBe(false);
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.detail).toBeNull();
    expect(reportClientDiagnostic).toHaveBeenCalledWith(
      "[keiko] coding task history scope mismatch",
      { correlationId: "run-one" },
    );
  });

  it("keeps a task bound from Code setup visible when the desktop base folder differs", async () => {
    const workspace = activeWorkspace();
    const { result } = renderHook(() =>
      useCodingTaskSession({
        snapshot: snapshot("chat-one"),
        active: false,
        root: "/desktop-base",
        workspace,
        selection: undefined,
      }),
    );
    await waitFor(() => expect(result.current.conversationId).toBe("chat-one"));
    expect(result.current.visibleRun).toBe(true);
    await act(async () => result.current.newTask());
    expect(workspace.provision).toHaveBeenCalledWith({
      root: "/repo",
      baseBranch: "master",
      taskId: expect.stringMatching(/^coding-/u),
    });
  });

  it("keeps recovery controls reachable for a legacy run without a saved conversation", () => {
    const { result } = renderHook(() =>
      useCodingTaskSession({
        snapshot: { ...snapshot(), state: "recovery-required" },
        active: false,
        root: "/repo",
        workspace: null,
        selection: undefined,
      }),
    );
    expect(result.current.visibleRun).toBe(true);
  });

  it("does not reload a previous task after a new workspace is active", async () => {
    read.mockResolvedValue({ ...detail, task: { ...detail.task, workspaceId: "ws-previous" } });
    const { result } = renderHook(() =>
      useCodingTaskSession({
        snapshot: snapshot("chat-one"),
        active: false,
        root: "/repo",
        workspace: activeWorkspace(),
        selection: undefined,
      }),
    );
    await act(async () => Promise.resolve());
    expect(read).toHaveBeenCalledWith("chat-one");
    expect(result.current.detail).toBeNull();
  });

  it("hides an unassociated finished timeline rather than attributing it to the selected repository", () => {
    const { result } = renderHook(() =>
      useCodingTaskSession({
        snapshot: snapshot(),
        active: false,
        root: "/different-repo",
        workspace: null,
        selection: undefined,
      }),
    );
    expect(result.current.visibleRun).toBe(false);
    expect(result.current.conversationId).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it("continues the saved task after completion and hides it on a repository change", async () => {
    const { result, rerender } = renderHook(
      ({ root }) =>
        useCodingTaskSession({
          snapshot: snapshot("chat-one"),
          active: false,
          root,
          workspace: null,
          selection: undefined,
        }),
      { initialProps: { root: "/repo" } },
    );
    await waitFor(() => expect(result.current.conversationId).toBe("chat-one"));
    expect(result.current.visibleRun).toBe(true);
    rerender({ root: "/other" });
    expect(result.current.detail).toBeNull();
    expect(result.current.visibleRun).toBe(false);
  });

  it("rejects reopening a history entry when its managed workspace cannot be activated", async () => {
    const { result } = renderHook(() =>
      useCodingTaskSession({
        snapshot: null,
        active: false,
        root: "/repo",
        workspace: null,
        selection: "chat-one",
      }),
    );
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.conversationId).toBeUndefined();
  });

  it("clears the old conversation for New task and surfaces workspace creation failure", async () => {
    const { result } = renderHook(() =>
      useCodingTaskSession({
        snapshot: snapshot("chat-one"),
        active: false,
        root: "/repo",
        workspace: null,
        selection: undefined,
      }),
    );
    await waitFor(() => expect(result.current.conversationId).toBe("chat-one"));
    await act(async () => {
      await result.current.newTask();
    });
    expect(result.current.conversationId).toBeUndefined();
    expect(result.current.visibleRun).toBe(false);
    expect(result.current.error).toBe(true);
    expect(result.current.pending).toBe(false);
  });
});
