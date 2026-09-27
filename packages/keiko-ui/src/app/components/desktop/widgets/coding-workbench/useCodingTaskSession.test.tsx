import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingHistoryDetail } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts";
import { useCodingTaskSession } from "./useCodingTaskSession";
import type { ActiveWorkspaceApi } from "../../context/ActiveWorkspaceContext";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";

const scopeEffects = vi.hoisted(() => ({ deferred: false }));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useEffect: (effect: React.EffectCallback, deps?: React.DependencyList): void => {
      const delayed = scopeEffects.deferred && deps?.length === 4 && typeof deps[0] === "string";
      react.useEffect(delayed ? (): undefined => undefined : effect, deps);
    },
  };
});

const read = vi.hoisted(() => vi.fn());
const update = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-history-api", () => ({
  CODING_HISTORY_CHANGED: "keiko:coding-history-changed",
  fetchCodingTask: read,
  updateCodingTask: update,
}));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => undefined;
  let rejectFn: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

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
  it("distinguishes a returned task from another repository", async () => {
    read.mockResolvedValue({ ...detail, task: { ...detail.task, projectPath: "/other" } });
    const { result } = renderHook(() =>
      useCodingTaskSession({
        snapshot: snapshot("chat-one"),
        active: false,
        root: "/repo",
        workspace: activeWorkspace(),
        selection: undefined,
      }),
    );
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.detail).toBeNull();
    expect(reportClientDiagnostic).toHaveBeenCalledWith(
      "[keiko] coding task history scope outcome",
      expect.objectContaining({
        correlationId: read.mock.calls[0]?.[1],
        codingHistoryScope: expect.objectContaining({
          reason: "repository-mismatch",
          taskId: "chat-one",
        }),
      }),
    );
    expect(JSON.stringify(vi.mocked(reportClientDiagnostic).mock.calls)).not.toContain("/other");
  });

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
    expect(reportClientDiagnostic).toHaveBeenCalledWith(
      "[keiko] coding task history scope outcome",
      expect.objectContaining({
        correlationId: expect.any(String),
        codingHistoryScope: expect.objectContaining({
          reason: "detail-cleared",
          taskId: "chat-one",
          requestedScopeId: expect.any(String),
          currentScopeId: expect.any(String),
        }),
      }),
    );
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.detail).toBeNull();
    expect(reportClientDiagnostic).toHaveBeenCalledWith(
      "[keiko] coding task history scope outcome",
      expect.objectContaining({
        correlationId: expect.any(String),
        codingHistoryScope: expect.objectContaining({
          reason: "workspace-mismatch",
          targetWorkspaceId: "ws-one",
          currentWorkspaceId: "ws-two",
        }),
      }),
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
    expect(read).toHaveBeenCalledWith("chat-one", expect.any(String));
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

  // #3631: the host clears a consumed selection; selecting the same task again retries it.
  it("retries a failed activation when the same task is selected again", async () => {
    const { result, rerender } = renderHook(
      ({ selection }: { readonly selection: string | undefined }) =>
        useCodingTaskSession({
          snapshot: null,
          active: false,
          root: "/repo",
          workspace: null,
          selection,
        }),
      { initialProps: { selection: "chat-one" as string | undefined } },
    );
    await waitFor(() => expect(result.current.error).toBe(true));
    const reads = read.mock.calls.length;
    rerender({ selection: undefined });
    rerender({ selection: "chat-one" });
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(reads));
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

describe("pending history activation scope", () => {
  it("rejects a stale selection before passive scope effects run", async () => {
    const workspace = activeWorkspace();
    if (workspace.activeInstance === null) throw new Error("Missing fixture");
    const pending = deferred<CodingHistoryDetail>();
    read.mockReturnValue(pending.promise);
    const { result, rerender } = renderHook(
      ({ current }) =>
        useCodingTaskSession({
          snapshot: null,
          active: false,
          root: "/repo",
          workspace: current,
          selection: "chat-one",
        }),
      { initialProps: { current: workspace } },
    );
    scopeEffects.deferred = true;
    try {
      rerender({
        current: {
          ...workspace,
          activeInstance: { ...workspace.activeInstance, workspaceId: "ws-external" },
        },
      });
      await act(async () => pending.resolve(detail));
      expect(workspace.switchTo).not.toHaveBeenCalled();
      expect(result.current.detail).toBeNull();
    } finally {
      scopeEffects.deferred = false;
    }
  });

  it.each([false, true])(
    "does not override an external workspace switch (return=%s)",
    async (returnToSource) => {
      const workspace = activeWorkspace();
      if (workspace.activeInstance === null) throw new Error("Missing workspace fixture");
      const pending = deferred<CodingHistoryDetail>();
      read.mockReturnValue(pending.promise);
      const { result, rerender } = renderHook(
        ({ current }) =>
          useCodingTaskSession({
            snapshot: null,
            active: false,
            root: "/repo",
            workspace: current,
            selection: "chat-one",
          }),
        { initialProps: { current: workspace } },
      );
      expect(result.current.pending).toBe(true);
      rerender({
        current: {
          ...workspace,
          activeInstance: {
            ...workspace.activeInstance,
            workspaceId: "ws-external",
          },
        },
      });
      if (returnToSource) rerender({ current: workspace });
      await act(async () => pending.resolve(detail));
      expect(workspace.switchTo).not.toHaveBeenCalled();
      expect(result.current.detail).toBeNull();
      expect(result.current.pending).toBe(false);
      expect(result.current.error).toBe(false);
    },
  );

  it("does not reactivate a task after changing the unbound project root", async () => {
    const workspace = { ...activeWorkspace(), activeInstance: null };
    const pending = deferred<CodingHistoryDetail>();
    read.mockReturnValue(pending.promise);
    const { result, rerender } = renderHook(
      ({ root }) =>
        useCodingTaskSession({
          snapshot: null,
          active: false,
          root,
          workspace,
          selection: "chat-one",
        }),
      { initialProps: { root: "/repo" } },
    );
    rerender({ root: "/other" });
    await act(async () => pending.resolve(detail));
    expect(workspace.switchTo).not.toHaveBeenCalled();
    expect(result.current.detail).toBeNull();
    expect(result.current.pending).toBe(false);
  });

  it("does not switch the global workspace after the workbench unmounts", async () => {
    const workspace = activeWorkspace();
    const pending = deferred<CodingHistoryDetail>();
    read.mockReturnValue(pending.promise);
    const { unmount } = renderHook(() =>
      useCodingTaskSession({
        snapshot: null,
        active: false,
        root: "/repo",
        workspace,
        selection: "chat-one",
      }),
    );
    unmount();
    await act(async () => pending.resolve(detail));
    expect(workspace.switchTo).not.toHaveBeenCalled();
  });
});

describe("history activation settlement", () => {
  it.each(["ws-one", "ws-external"])(
    "handles the switch acknowledgement in %s",
    async (workspaceId) => {
      const switching = deferred<boolean>();
      const workspace = { ...activeWorkspace(), switchTo: vi.fn(() => switching.promise) };
      if (workspace.activeInstance === null) throw new Error("Missing workspace fixture");
      const { result, rerender } = renderHook(
        ({ current }) =>
          useCodingTaskSession({
            snapshot: null,
            active: false,
            root: "/repo",
            workspace: current,
            selection: "chat-one",
          }),
        {
          initialProps: {
            current: {
              ...workspace,
              activeInstance: {
                ...workspace.activeInstance,
                workspaceId: "ws-source",
              },
            },
          },
        },
      );
      await waitFor(() => expect(workspace.switchTo).toHaveBeenCalledWith("ws-one"));
      rerender({
        current: { ...workspace, activeInstance: { ...workspace.activeInstance, workspaceId } },
      });
      await act(async () => switching.resolve(true));
      expect(result.current.pending).toBe(false);
      expect(result.current.error).toBe(false);
      if (workspaceId === "ws-one") expect(result.current.detail).toEqual(detail);
      else {
        expect(result.current.detail).toBeNull();
        expect(reportClientDiagnostic).toHaveBeenCalledWith(
          "[keiko] coding task history scope outcome",
          expect.objectContaining({
            correlationId: expect.any(String),
            codingHistoryScope: expect.objectContaining({
              reason: "activation-superseded",
              taskId: "chat-one",
              requestedScopeId: expect.any(String),
              currentScopeId: expect.any(String),
            }),
          }),
        );
      }
    },
  );

  it("records clearing a completed historical task without a live snapshot", async () => {
    const workspace = activeWorkspace();
    if (workspace.activeInstance === null) throw new Error("Missing workspace fixture");
    const { result, rerender } = renderHook(
      ({ current }) =>
        useCodingTaskSession({
          snapshot: null,
          active: false,
          root: "/repo",
          workspace: current,
          selection: "chat-one",
        }),
      { initialProps: { current: workspace } },
    );
    await waitFor(() => expect(result.current.detail).toEqual(detail));
    vi.mocked(reportClientDiagnostic).mockClear();
    rerender({
      current: {
        ...workspace,
        activeInstance: { ...workspace.activeInstance, workspaceId: "ws-two" },
      },
    });
    expect(result.current.detail).toBeNull();
    expect(reportClientDiagnostic).toHaveBeenCalledExactlyOnceWith(
      "[keiko] coding task history scope outcome",
      expect.objectContaining({
        correlationId: expect.any(String),
        codingHistoryScope: expect.objectContaining({
          reason: "detail-cleared",
          taskId: "chat-one",
          requestedScopeId: expect.any(String),
          currentScopeId: expect.any(String),
        }),
      }),
    );
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("does not restore history after the active workspace is cleared during its switch", async () => {
    const switching = deferred<boolean>();
    const workspace = { ...activeWorkspace(), switchTo: vi.fn(() => switching.promise) };
    const { result, rerender } = renderHook(
      ({ current }: { current: ActiveWorkspaceApi }) =>
        useCodingTaskSession({
          snapshot: null,
          active: false,
          root: "/repo",
          workspace: current,
          selection: "chat-one",
        }),
      { initialProps: { current: workspace } },
    );
    await waitFor(() => expect(workspace.switchTo).toHaveBeenCalledWith("ws-one"));
    rerender({ current: { ...workspace, activeInstance: null } });
    await act(async () => switching.resolve(true));
    expect(result.current.detail).toBeNull();
    expect(result.current.pending).toBe(false);
    expect(reportClientDiagnostic).toHaveBeenCalledWith(
      "[keiko] coding task history scope outcome",
      expect.objectContaining({
        correlationId: expect.any(String),
        codingHistoryScope: expect.objectContaining({
          reason: "activation-superseded",
          taskId: "chat-one",
          requestedScopeId: expect.any(String),
          currentScopeId: expect.any(String),
        }),
      }),
    );
  });

  it("discards a late fetch failure after the operator changed projects", async () => {
    const pending = deferred<CodingHistoryDetail>();
    read.mockReturnValue(pending.promise);
    const { result, rerender } = renderHook(
      ({ root }) =>
        useCodingTaskSession({
          snapshot: null,
          active: false,
          root,
          workspace: null,
          selection: "chat-one",
        }),
      { initialProps: { root: "/repo" } },
    );
    rerender({ root: "/other" });
    await act(async () => pending.reject(new Error("private server response")));
    expect(result.current.error).toBe(false);
    expect(result.current.pending).toBe(false);
    expect(reportClientDiagnostic).toHaveBeenCalledWith(
      "[keiko] coding task history scope outcome",
      expect.objectContaining({
        correlationId: expect.any(String),
        codingHistoryScope: expect.objectContaining({
          reason: "activation-cancelled",
          taskId: "chat-one",
          requestedScopeId: expect.any(String),
          currentScopeId: expect.any(String),
        }),
      }),
    );
    expect(vi.mocked(reportClientDiagnostic).mock.calls.at(-1)?.[1]?.correlationId).toBe(
      read.mock.calls[0]?.[1],
    );
    const scope = vi.mocked(reportClientDiagnostic).mock.calls.at(-1)?.[1]?.codingHistoryScope;
    expect(scope?.requestedScopeId).not.toBe(scope?.currentScopeId);

    expect(JSON.stringify(vi.mocked(reportClientDiagnostic).mock.calls)).not.toContain(
      "private server response",
    );
  });
});
