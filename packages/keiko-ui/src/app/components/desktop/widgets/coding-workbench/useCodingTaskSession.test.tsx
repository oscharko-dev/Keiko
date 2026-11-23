import { StrictMode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingHistoryDetail } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts";
import { useCodingTaskSession } from "./useCodingTaskSession";
import type { ActiveWorkspaceApi } from "../../context/ActiveWorkspaceContext";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { notifyCodingAppSessionChanged } from "@/lib/coding-app-session-client";

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

describe("restoring the run's task after a server restart (#4068 W9)", () => {
  it("reads the task again when the browser is paired after the first read failed", async () => {
    // The restarted server answers an unpaired caller exactly like an unknown task.
    read.mockRejectedValueOnce(new Error("Coding task not found."));
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
    expect(read).toHaveBeenCalledTimes(1);

    act(() => {
      notifyCodingAppSessionChanged();
    });

    await waitFor(() => expect(result.current.detail?.task.id).toBe("chat-one"));
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[1]?.[0]).toBe("chat-one");
  });

  it("does not read again without a pairing", async () => {
    read.mockRejectedValueOnce(new Error("Coding task not found."));
    const { result, rerender } = renderHook(() =>
      useCodingTaskSession({
        snapshot: snapshot("chat-one"),
        active: false,
        root: "/repo",
        workspace: activeWorkspace(),
        selection: undefined,
      }),
    );
    await waitFor(() => expect(result.current.pending).toBe(false));
    rerender();
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(read).toHaveBeenCalledTimes(1);
  });
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
    // The operator switched repository and the scope did not change meanwhile: an ordinary
    // transition on the routine info line, under the history read's own correlation, and no
    // warn/unknown diagnostic (Keiko 1.3.1 stress test, F3).
    expect(reportClientDiagnostic).toHaveBeenCalledExactlyOnceWith(
      "[keiko] coding workbench interaction: history-repository-switched",
      {
        correlationId: read.mock.calls[0]?.[1],
        codingWorkbenchInteraction: { interaction: "history-repository-switched" },
      },
    );
    expect(vi.mocked(reportClientDiagnostic).mock.calls[0]?.[1]).not.toHaveProperty(
      "codingHistoryScope",
    );
    expect(JSON.stringify(vi.mocked(reportClientDiagnostic).mock.calls)).not.toContain("/other");
  });

  it("records a returned task of another workspace as a routine switch (#4118)", async () => {
    read.mockResolvedValue({ ...detail, task: { ...detail.task, workspaceId: "ws-other" } });
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
    expect(reportClientDiagnostic).toHaveBeenCalledExactlyOnceWith(
      "[keiko] coding workbench interaction: history-workspace-switched",
      {
        correlationId: read.mock.calls[0]?.[1],
        codingWorkbenchInteraction: { interaction: "history-workspace-switched" },
      },
    );
    expect(JSON.stringify(vi.mocked(reportClientDiagnostic).mock.calls)).not.toContain("ws-other");
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
    // The read for the new workspace returned the old workspace's task while the scope held still:
    // the operator switched workspaces, routine evidence and no warn/unknown diagnostic (#4118).
    expect(reportClientDiagnostic).toHaveBeenCalledWith(
      "[keiko] coding workbench interaction: history-workspace-switched",
      {
        correlationId: expect.any(String),
        codingWorkbenchInteraction: { interaction: "history-workspace-switched" },
      },
    );
    expect(reportClientDiagnostic).not.toHaveBeenCalledWith(
      "[keiko] coding task history scope outcome",
      expect.objectContaining({
        codingHistoryScope: expect.objectContaining({ reason: "workspace-mismatch" }),
      }),
    );
  });

  it("hides a task from the previous repository after the desktop selection changes", async () => {
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
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.conversationId).toBeUndefined();
    expect(result.current.visibleRun).toBe(false);
    expect(workspace.provision).not.toHaveBeenCalled();
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

  // F30: an outcome-unknown run ends in "Recovery required". Its panel is forced visible so the
  // person reads it, but New task must always be a way out: the run stays recoverable from
  // Coding History, and it never locks the window onto itself.
  describe("leaving a recovery-required run", () => {
    const recovery = (): CodingWorkbenchRuntimeSnapshot => ({
      ...snapshot("chat-one"),
      state: "recovery-required",
    });
    const render = (
      selection?: string,
    ): ReturnType<
      typeof renderHook<
        ReturnType<typeof useCodingTaskSession>,
        { readonly run: CodingWorkbenchRuntimeSnapshot | null }
      >
    > =>
      renderHook(
        ({ run }: { readonly run: CodingWorkbenchRuntimeSnapshot | null }) =>
          useCodingTaskSession({
            snapshot: run,
            active: run?.state === "running",
            root: "/repo",
            workspace: null,
            selection,
          }),
        { initialProps: { run: recovery() as CodingWorkbenchRuntimeSnapshot | null } },
      );

    it("lets New task detach the window from an acknowledged recovery run", async () => {
      const { result } = render();
      expect(result.current.visibleRun).toBe(true);
      await act(async () => {
        await result.current.newTask();
      });
      expect(result.current.visibleRun).toBe(false);
      expect(result.current.conversationId).toBeUndefined();
      const left = vi
        .mocked(reportClientDiagnostic)
        .mock.calls.filter(([message]) => message.endsWith("recovery-left"));
      expect(left).toEqual([
        [
          "[keiko] coding workbench interaction: recovery-left",
          {
            correlationId: expect.any(String),
            codingWorkbenchInteraction: { interaction: "recovery-left" },
          },
        ],
      ]);
    });

    it("lets a New task pick from Coding History detach the window from the recovery run", async () => {
      const { result } = render("new:1");
      await waitFor(() => expect(result.current.pending).toBe(false));
      expect(result.current.visibleRun).toBe(false);
    });

    it("follows the next run the window starts after leaving the recovery run", async () => {
      const { result, rerender } = render();
      await act(async () => {
        await result.current.newTask();
      });
      rerender({ run: { ...snapshot("chat-next"), state: "running", runId: "run-next" } });
      expect(result.current.visibleRun).toBe(true);
    });
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

  // #4271: the runtime status is the process's latest run, whatever task the window shows. A new
  // window opened from Coding History reads it only after the pick, and that settled run of
  // another task replaced the opened one ("opening loads the wrong session").
  it("keeps a task opened from Coding History when a settled run of another task arrives", async () => {
    const two = { ...detail, task: { ...detail.task, id: "chat-two", latestRunId: "run-two" } };
    read.mockImplementation((id: string) =>
      Promise.resolve(id === "chat-two" ? two : { ...detail, task: { ...detail.task, id } }),
    );
    const workspace = activeWorkspace();
    const { result, rerender } = renderHook(
      ({ run }: { readonly run: CodingWorkbenchRuntimeSnapshot | null }) =>
        useCodingTaskSession({
          snapshot: run,
          active: run?.state === "running",
          root: "/repo",
          workspace,
          selection: "chat-two",
        }),
      { initialProps: { run: null as CodingWorkbenchRuntimeSnapshot | null } },
    );
    await waitFor(() => expect(result.current.conversationId).toBe("chat-two"));
    rerender({ run: { ...snapshot("chat-latest"), runId: "run-latest" } });
    await act(async () => Promise.resolve());
    expect(read).not.toHaveBeenCalledWith("chat-latest", expect.any(String));
    expect(result.current.conversationId).toBe("chat-two");
    // The hold is recorded once per pick, body-free.
    expect(reportClientDiagnostic).toHaveBeenCalledExactlyOnceWith(
      "[keiko] coding workbench interaction: history-run-held",
      {
        correlationId: expect.any(String),
        codingWorkbenchInteraction: { interaction: "history-run-held" },
      },
    );
    expect(JSON.stringify(vi.mocked(reportClientDiagnostic).mock.calls)).not.toContain("chat-");
    // A run that becomes active afterwards owns the window again.
    rerender({ run: { ...snapshot("chat-next"), runId: "run-next", state: "running" } });
    await waitFor(() => expect(read).toHaveBeenCalledWith("chat-next", expect.any(String)));
  });

  // Review (#4271): the first status read can report the picked task's own settled run; that run
  // is the task's, so the window keeps it visible instead of holding it as another task's.
  it("keeps the picked task's own settled run visible when the first status read reports it", async () => {
    const two = { ...detail, task: { ...detail.task, id: "chat-two", latestRunId: "run-two" } };
    read.mockImplementation((id: string) =>
      Promise.resolve(id === "chat-two" ? two : { ...detail, task: { ...detail.task, id } }),
    );
    const { result, rerender } = renderHook(
      ({ run }: { readonly run: CodingWorkbenchRuntimeSnapshot | null }) =>
        useCodingTaskSession({
          snapshot: run,
          active: run?.state === "running",
          root: "/repo",
          workspace: activeWorkspace(),
          selection: "chat-two",
        }),
      { initialProps: { run: null as CodingWorkbenchRuntimeSnapshot | null } },
    );
    await waitFor(() => expect(result.current.conversationId).toBe("chat-two"));
    rerender({ run: { ...snapshot("chat-two"), runId: "run-two" } });
    await act(async () => Promise.resolve());
    expect(result.current.conversationId).toBe("chat-two");
    expect(result.current.visibleRun).toBe(true);
    expect(reportClientDiagnostic).not.toHaveBeenCalledWith(
      "[keiko] coding workbench interaction: history-run-held",
      expect.anything(),
    );
  });

  // Audit (#4271): the window's own run can settle before a status read ever sees it active; it
  // is a run after the pick, so the window follows it like any other.
  it("follows a run started after the pick even when it is first seen settled", async () => {
    const two = { ...detail, task: { ...detail.task, id: "chat-two", latestRunId: "run-two" } };
    read.mockImplementation((id: string) =>
      Promise.resolve(id === "chat-two" ? two : { ...detail, task: { ...detail.task, id } }),
    );
    const { result, rerender } = renderHook(
      ({ run }: { readonly run: CodingWorkbenchRuntimeSnapshot | null }) =>
        useCodingTaskSession({
          snapshot: run,
          active: run?.state === "running",
          root: "/repo",
          workspace: activeWorkspace(),
          selection: "chat-two",
        }),
      { initialProps: { run: null as CodingWorkbenchRuntimeSnapshot | null } },
    );
    await waitFor(() => expect(result.current.conversationId).toBe("chat-two"));
    rerender({ run: { ...snapshot("chat-latest"), runId: "run-latest" } });
    await act(async () => Promise.resolve());
    expect(result.current.conversationId).toBe("chat-two");
    rerender({ run: { ...snapshot("chat-own"), runId: "run-own" } });
    await waitFor(() => expect(read).toHaveBeenCalledWith("chat-own", expect.any(String)));
  });

  // Audit (#4271): a status read without any run already told the window there is no other run,
  // so its own first run is followed even when the next read sees it settled.
  it("follows the window's first run after a status read without any run", async () => {
    read.mockImplementation((id: string) =>
      Promise.resolve({ ...detail, task: { ...detail.task, id } }),
    );
    const { runId: _none, ...idle } = { ...snapshot(), state: "idle" as const };
    const { result, rerender } = renderHook(
      ({ run }: { readonly run: CodingWorkbenchRuntimeSnapshot | null }) =>
        useCodingTaskSession({
          snapshot: run,
          active: run?.state === "running",
          root: "/repo",
          workspace: activeWorkspace(),
          selection: "chat-two",
        }),
      { initialProps: { run: null as CodingWorkbenchRuntimeSnapshot | null } },
    );
    await waitFor(() => expect(result.current.conversationId).toBe("chat-two"));
    rerender({ run: idle });
    rerender({ run: { ...snapshot("chat-own"), runId: "run-own" } });
    await waitFor(() => expect(read).toHaveBeenCalledWith("chat-own", expect.any(String)));
    expect(reportClientDiagnostic).not.toHaveBeenCalledWith(
      "[keiko] coding workbench interaction: history-run-held",
      expect.anything(),
    );
  });

  it("keeps New task empty when a settled run of another task arrives afterwards", async () => {
    const { result, rerender } = renderHook(
      ({ run }: { readonly run: CodingWorkbenchRuntimeSnapshot | null }) =>
        useCodingTaskSession({
          snapshot: run,
          active: false,
          root: "/repo",
          workspace: null,
          selection: "new:1",
        }),
      { initialProps: { run: null as CodingWorkbenchRuntimeSnapshot | null } },
    );
    await waitFor(() => expect(result.current.pending).toBe(false));
    rerender({ run: { ...snapshot("chat-latest"), runId: "run-latest" } });
    await act(async () => Promise.resolve());
    expect(read).not.toHaveBeenCalledWith("chat-latest", expect.any(String));
    expect(result.current.conversationId).toBeUndefined();
    const held = vi
      .mocked(reportClientDiagnostic)
      .mock.calls.filter(([message]) => message.endsWith("history-run-held"));
    expect(held).toEqual([
      [
        "[keiko] coding workbench interaction: history-run-held",
        {
          correlationId: expect.any(String),
          codingWorkbenchInteraction: { interaction: "history-run-held" },
        },
      ],
    ]);
  });

  it("drops the previous conversation when reading another selected task fails", async () => {
    const workspace = activeWorkspace();
    read.mockImplementation((id: string) =>
      id === "chat-one" ? Promise.resolve(detail) : Promise.reject(new Error("Read failed")),
    );
    const { result, rerender } = renderHook(
      ({ selection }: { readonly selection: string | undefined }) =>
        useCodingTaskSession({
          snapshot: snapshot("chat-one"),
          active: false,
          root: "/repo",
          workspace,
          selection,
        }),
      { initialProps: { selection: undefined as string | undefined } },
    );
    await waitFor(() => expect(result.current.conversationId).toBe("chat-one"));
    rerender({ selection: "chat-two" });
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.pending).toBe(false);
    expect(result.current.conversationId).toBeUndefined();
    expect(result.current.detail).toBeNull();
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

  it("resets the draft synchronously before awaiting new workspace creation (#3877)", async () => {
    const pending = deferred<boolean>();
    const workspace = activeWorkspace();
    vi.mocked(workspace.provision).mockReturnValue(pending.promise);
    const onDraftReset = vi.fn();
    const { result } = renderHook(() =>
      useCodingTaskSession({
        snapshot: null,
        active: false,
        root: "/repo",
        workspace,
        selection: undefined,
        onDraftReset,
      }),
    );
    let settled = false;
    let creation: Promise<void> | undefined;
    act(() => {
      creation = result.current.newTask().then((): void => {
        settled = true;
      });
    });
    expect(onDraftReset).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    expect(reportClientDiagnostic).toHaveBeenCalledWith("[keiko] coding task draft reset", {
      correlationId: expect.any(String),
      composerActivity: "coding-task-reset",
    });
    await act(async () => {
      pending.resolve(true);
      await creation;
    });
  });

  it("resets the draft through New task history selection and refuses resets during an active run (#3877)", async () => {
    const onDraftReset = vi.fn();
    const { result, rerender } = renderHook(
      ({ active, selection }) =>
        useCodingTaskSession({
          snapshot: null,
          active,
          root: "/repo",
          workspace: null,
          location: "local",
          selection,
          onDraftReset,
        }),
      { initialProps: { active: false, selection: "new:task-one" } },
    );
    await waitFor(() => expect(onDraftReset).toHaveBeenCalledOnce());
    rerender({ active: true, selection: "new:task-two" });
    await act(async () => {
      await result.current.newTask();
    });
    expect(onDraftReset).toHaveBeenCalledOnce();
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

  // #4271: React mounts a new window twice in development (StrictMode); the remount discarded the
  // pick's read as stale and never read it again, so the window stayed on "Loading task…".
  it("opens a task picked from Coding History when the window mounts twice", async () => {
    const workspace = activeWorkspace();
    const handled = vi.fn();
    const { result } = renderHook(
      () =>
        useCodingTaskSession({
          snapshot: null,
          active: false,
          root: "/repo",
          workspace,
          selection: "chat-one",
          onSelectionHandled: handled,
        }),
      { wrapper: StrictMode },
    );
    await waitFor(() => expect(result.current.conversationId).toBe("chat-one"));
    expect(result.current.pending).toBe(false);
    expect(workspace.switchTo).toHaveBeenCalledWith("ws-one");
  });

  it("requests one new workspace for New task when the window mounts twice", async () => {
    const workspace = activeWorkspace();
    const { result } = renderHook(
      () =>
        useCodingTaskSession({
          snapshot: null,
          active: false,
          root: "/repo",
          workspace,
          selection: "new:1",
        }),
      { wrapper: StrictMode },
    );
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(workspace.provision).toHaveBeenCalledOnce();
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

describe("a followed run's revision bumps refresh the task in the background", () => {
  function running(revision: number): CodingWorkbenchRuntimeSnapshot {
    return { ...snapshot("chat-one"), state: "running", revision };
  }

  function renderRevisions(): {
    readonly result: { readonly current: ReturnType<typeof useCodingTaskSession> };
    readonly rerender: (props: { revision: number }) => void;
  } {
    return renderHook(
      ({ revision }: { revision: number }) =>
        useCodingTaskSession({
          snapshot: running(revision),
          active: true,
          root: "/repo",
          workspace: activeWorkspace(),
          selection: undefined,
        }),
      { initialProps: { revision: 1 } },
    );
  }

  it("never shows the loading state again and reads a bounded number of times", async () => {
    const { result, rerender } = renderRevisions();
    await waitFor(() => expect(result.current.detail?.task.id).toBe("chat-one"));
    const pendingStates: boolean[] = [];
    const history = vi.fn();
    window.addEventListener("keiko:coding-history-changed", history);
    for (let revision = 2; revision <= 21; revision += 1) {
      rerender({ revision });
      pendingStates.push(result.current.pending);
    }
    await waitFor(() => expect(result.current.pending).toBe(false));
    window.removeEventListener("keiko:coding-history-changed", history);
    expect(pendingStates).not.toContain(true);
    expect(read.mock.calls.length).toBeLessThanOrEqual(4);
    expect(history.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("drops a queued refresh once a task is picked from Coding History", async () => {
    const { result, rerender } = renderHook(
      ({ revision, selection }: { revision: number; selection: string | undefined }) =>
        useCodingTaskSession({
          snapshot: running(revision),
          active: false,
          root: "/repo",
          workspace: activeWorkspace(),
          selection,
        }),
      { initialProps: { revision: 1, selection: undefined as string | undefined } },
    );
    await waitFor(() => expect(result.current.detail?.task.id).toBe("chat-one"));
    const inflight = deferred<CodingHistoryDetail>();
    read.mockReturnValueOnce(inflight.promise);
    rerender({ revision: 2, selection: undefined });
    rerender({ revision: 3, selection: undefined });
    const picked: CodingHistoryDetail = {
      ...detail,
      task: { ...detail.task, id: "chat-two", latestRunId: "run-two" },
    };
    read.mockResolvedValueOnce(picked);
    rerender({ revision: 3, selection: "chat-two" });
    await waitFor(() => expect(result.current.detail?.task.id).toBe("chat-two"));
    await act(async () => {
      inflight.resolve(detail);
      await inflight.promise;
    });
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(read.mock.calls.map(([id]: unknown[]) => id)).toEqual([
      "chat-one",
      "chat-one",
      "chat-two",
    ]);
    expect(result.current.detail?.task.id).toBe("chat-two");
  });

  it("raises no error when a background read fails", async () => {
    const { result, rerender } = renderRevisions();
    await waitFor(() => expect(result.current.detail?.task.id).toBe("chat-one"));
    read.mockRejectedValue(new Error("temporarily unavailable"));
    const history = vi.fn();
    window.addEventListener("keiko:coding-history-changed", history);
    rerender({ revision: 2 });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(reportClientDiagnostic).toHaveBeenCalled());
    window.removeEventListener("keiko:coding-history-changed", history);
    expect(result.current.error).toBe(false);
    expect(result.current.detail?.task.id).toBe("chat-one");
    expect(history).not.toHaveBeenCalled();
  });
});

describe("a task the person left stays left after a reload (#4491)", () => {
  function render(input: {
    leftRun?: string;
    onLeftRun?: (runId: string | undefined) => void;
  }): ReturnType<typeof renderHook<ReturnType<typeof useCodingTaskSession>, unknown>> {
    return renderHook(() =>
      useCodingTaskSession({
        snapshot: snapshot("chat-one"),
        active: false,
        root: "/repo",
        workspace: activeWorkspace(),
        selection: undefined,
        location: "local",
        ...input,
      }),
    );
  }

  it("does not follow a run back into its completed task", async () => {
    read.mockResolvedValue({ ...detail, task: { ...detail.task, status: "completed" } });
    const { result } = render({});
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.detail).toBeNull();
    expect(result.current.conversationId).toBeUndefined();
  });

  it("remembers the run the person left with New task and does not follow it on the next mount", async () => {
    const onLeftRun = vi.fn();
    const first = render({ onLeftRun });
    await waitFor(() => expect(first.result.current.detail?.task.id).toBe("chat-one"));
    await act(async () => {
      await first.result.current.newTask();
    });
    expect(onLeftRun).toHaveBeenCalledWith("run-one");
    first.unmount();
    read.mockClear();
    const second = render({ leftRun: "run-one" });
    await waitFor(() => expect(second.result.current.pending).toBe(false));
    expect(read).not.toHaveBeenCalled();
    expect(second.result.current.detail).toBeNull();
    expect(second.result.current.conversationId).toBeUndefined();
  });
});

describe("switching back to a repository shows its open task (#4491)", () => {
  function workspaceOf(workspaceId: string, root: string): ActiveWorkspaceApi {
    const base = activeWorkspace();
    if (base.activeInstance === null) throw new Error("fixture has an active instance");
    return {
      ...base,
      activeInstance: { ...base.activeInstance, workspaceId, repositoryRoot: root },
    };
  }
  const other: CodingHistoryDetail = {
    ...detail,
    task: {
      ...detail.task,
      id: "chat-two",
      projectPath: "/repo-b",
      workspaceId: "ws-two",
      latestRunId: "run-two",
    },
  };

  it("restores the first repository's task after a run in the second one", async () => {
    read.mockImplementation((id: string) => Promise.resolve(id === "chat-two" ? other : detail));
    const first = { snapshot: snapshot("chat-one"), root: "/repo", workspace: activeWorkspace() };
    const second = {
      snapshot: { ...snapshot("chat-two"), runId: "run-two" },
      root: "/repo-b",
      workspace: workspaceOf("ws-two", "/repo-b"),
    };
    const { result, rerender } = renderHook(
      (props: typeof first) =>
        useCodingTaskSession({ ...props, active: false, selection: undefined }),
      { initialProps: first },
    );
    await waitFor(() => expect(result.current.detail?.task.id).toBe("chat-one"));
    rerender(second);
    await waitFor(() => expect(result.current.detail?.task.id).toBe("chat-two"));
    rerender({ ...first, snapshot: second.snapshot });
    await waitFor(() => expect(result.current.detail?.task.id).toBe("chat-one"));
    expect(result.current.conversationId).toBe("chat-one");
  });

  it("does not restore a task the person left with New task", async () => {
    read.mockImplementation((id: string) => Promise.resolve(id === "chat-two" ? other : detail));
    const first = { snapshot: snapshot("chat-one"), root: "/repo", workspace: activeWorkspace() };
    const second = {
      snapshot: { ...snapshot("chat-two"), runId: "run-two" },
      root: "/repo-b",
      workspace: workspaceOf("ws-two", "/repo-b"),
    };
    const { result, rerender } = renderHook(
      (props: typeof first) =>
        useCodingTaskSession({
          ...props,
          active: false,
          selection: undefined,
          location: "local",
        }),
      { initialProps: first },
    );
    await waitFor(() => expect(result.current.detail?.task.id).toBe("chat-one"));
    await act(async () => {
      await result.current.newTask();
    });
    rerender(second);
    await waitFor(() => expect(result.current.detail?.task.id).toBe("chat-two"));
    rerender({ ...first, snapshot: second.snapshot });
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.detail).toBeNull();
  });
});

describe("an update of the displayed task (#4491)", () => {
  it("shows a rename made in Coding History without reading the task again", async () => {
    const { result } = renderHook(() =>
      useCodingTaskSession({
        snapshot: snapshot("chat-one"),
        active: false,
        root: "/repo",
        workspace: activeWorkspace(),
        selection: undefined,
      }),
    );
    await waitFor(() => expect(result.current.detail?.task.title).toBe("Inspect"));
    read.mockClear();
    act(() => {
      window.dispatchEvent(
        new CustomEvent("keiko:coding-history-changed", {
          detail: { ...detail.task, title: "Renamed" },
        }),
      );
    });
    expect(result.current.detail?.task.title).toBe("Renamed");
    act(() => {
      window.dispatchEvent(
        new CustomEvent("keiko:coding-history-changed", {
          detail: { ...detail.task, id: "chat-other", title: "Other" },
        }),
      );
    });
    expect(result.current.detail?.task.title).toBe("Renamed");
    expect(read).not.toHaveBeenCalled();
  });
});

describe("a Coding History pick while a run is active (#4491)", () => {
  it("keeps the running task on display and opens the pick once the run has ended", async () => {
    const picked: CodingHistoryDetail = {
      ...detail,
      task: { ...detail.task, id: "chat-two", projectPath: "/repo-b", latestRunId: "run-two" },
    };
    read.mockImplementation((id: string) => Promise.resolve(id === "chat-two" ? picked : detail));
    const running = { ...snapshot("chat-one"), state: "running" as const };
    const { result, rerender } = renderHook(
      (props: { root: string; selection: string | undefined; active: boolean }) =>
        useCodingTaskSession({
          ...props,
          snapshot: props.active ? running : snapshot("chat-one"),
          workspace: activeWorkspace(),
        }),
      { initialProps: { root: "/repo", selection: undefined, active: true } },
    );
    await waitFor(() => expect(result.current.detail?.task.id).toBe("chat-one"));
    rerender({ root: "/repo-b", selection: "chat-two", active: true });
    expect(result.current.detail?.task.id).toBe("chat-one");
    rerender({ root: "/repo-b", selection: "chat-two", active: false });
    await waitFor(() => expect(result.current.detail?.task.id).toBe("chat-two"));
  });
});

describe("completed tasks and the current task (#4491 audit)", () => {
  const completed: CodingHistoryDetail = {
    ...detail,
    task: { ...detail.task, status: "completed" },
  };
  const other: CodingHistoryDetail = {
    ...detail,
    task: {
      ...detail.task,
      id: "chat-two",
      projectPath: "/repo-b",
      workspaceId: "ws-two",
      latestRunId: "run-two",
    },
  };
  function workspaceOf(workspaceId: string, root: string): ActiveWorkspaceApi {
    const base = activeWorkspace();
    if (base.activeInstance === null) throw new Error("fixture has an active instance");
    return {
      ...base,
      activeInstance: { ...base.activeInstance, workspaceId, repositoryRoot: root },
    };
  }
  function readsOf(id: string): number {
    return read.mock.calls.filter((call: unknown[]) => call[0] === id).length;
  }
  function switching(): {
    readonly first: {
      snapshot: CodingWorkbenchRuntimeSnapshot;
      root: string;
      workspace: ActiveWorkspaceApi;
    };
    readonly second: {
      snapshot: CodingWorkbenchRuntimeSnapshot;
      root: string;
      workspace: ActiveWorkspaceApi;
    };
  } {
    return {
      first: { snapshot: snapshot("chat-one"), root: "/repo", workspace: activeWorkspace() },
      second: {
        snapshot: { ...snapshot("chat-two"), runId: "run-two" },
        root: "/repo-b",
        workspace: workspaceOf("ws-two", "/repo-b"),
      },
    };
  }

  it("keeps a completed task picked from Coding History once its run is followed", async () => {
    read.mockResolvedValue(completed);
    const { result, rerender } = renderHook(
      ({ run }: { readonly run: CodingWorkbenchRuntimeSnapshot | null }) =>
        useCodingTaskSession({
          snapshot: run,
          active: false,
          root: "/repo",
          workspace: activeWorkspace(),
          selection: "chat-one",
        }),
      { initialProps: { run: null as CodingWorkbenchRuntimeSnapshot | null } },
    );
    await waitFor(() => expect(result.current.detail?.task.id).toBe("chat-one"));
    rerender({ run: snapshot("chat-one") });
    await waitFor(() => expect(readsOf("chat-one")).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.detail?.task.id).toBe("chat-one");
  });

  it("does not restore a repository's task that was completed meanwhile", async () => {
    let done = false;
    read.mockImplementation((id: string) =>
      Promise.resolve(id === "chat-two" ? other : done ? completed : detail),
    );
    const { first, second } = switching();
    const { result, rerender } = renderHook(
      (props: typeof first) =>
        useCodingTaskSession({ ...props, active: false, selection: undefined }),
      { initialProps: first },
    );
    await waitFor(() => expect(result.current.detail?.task.id).toBe("chat-one"));
    rerender(second);
    await waitFor(() => expect(result.current.detail?.task.id).toBe("chat-two"));
    done = true;
    rerender({ ...first, snapshot: second.snapshot });
    await waitFor(() => expect(readsOf("chat-one")).toBe(2));
    await act(async () => Promise.resolve());
    expect(result.current.detail).toBeNull();
    expect(result.current.conversationId).toBeUndefined();
  });

  it("raises no error for a remembered task that is gone and forgets it", async () => {
    let gone = false;
    read.mockImplementation((id: string) =>
      id === "chat-two"
        ? Promise.resolve(other)
        : gone
          ? Promise.reject(new Error("CODING_TASK_NOT_FOUND"))
          : Promise.resolve(detail),
    );
    const { first, second } = switching();
    const { result, rerender } = renderHook(
      (props: typeof first) =>
        useCodingTaskSession({ ...props, active: false, selection: undefined }),
      { initialProps: first },
    );
    await waitFor(() => expect(result.current.detail?.task.id).toBe("chat-one"));
    rerender(second);
    await waitFor(() => expect(result.current.detail?.task.id).toBe("chat-two"));
    gone = true;
    rerender({ ...first, snapshot: second.snapshot });
    await waitFor(() => expect(readsOf("chat-one")).toBe(2));
    await act(async () => Promise.resolve());
    expect(result.current.error).toBe(false);
    rerender(second);
    await waitFor(() => expect(result.current.detail?.task.id).toBe("chat-two"));
    rerender({ ...first, snapshot: second.snapshot });
    await act(async () => Promise.resolve());
    expect(readsOf("chat-one")).toBe(2);
    expect(result.current.error).toBe(false);
  });

  it("leaves the displayed task once it is completed in Coding History", async () => {
    const { result } = renderHook(() =>
      useCodingTaskSession({
        snapshot: snapshot("chat-one"),
        active: false,
        root: "/repo",
        workspace: activeWorkspace(),
        selection: undefined,
      }),
    );
    await waitFor(() => expect(result.current.detail?.task.id).toBe("chat-one"));
    act(() => {
      window.dispatchEvent(
        new CustomEvent("keiko:coding-history-changed", { detail: completed.task }),
      );
    });
    expect(result.current.detail).toBeNull();
    expect(result.current.conversationId).toBeUndefined();
  });

  it("shows a rename of a completed task opened from Coding History", async () => {
    read.mockResolvedValue(completed);
    const { result } = renderHook(() =>
      useCodingTaskSession({
        snapshot: null,
        active: false,
        root: "/repo",
        workspace: activeWorkspace(),
        selection: "chat-one",
      }),
    );
    await waitFor(() => expect(result.current.detail?.task.id).toBe("chat-one"));
    act(() => {
      window.dispatchEvent(
        new CustomEvent("keiko:coding-history-changed", {
          detail: { ...completed.task, title: "Renamed" },
        }),
      );
    });
    expect(result.current.detail?.task.title).toBe("Renamed");
  });
});
