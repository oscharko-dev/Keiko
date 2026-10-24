import { act, renderHook, waitFor, type RenderHookResult } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, CodingHistoryDetail } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts";
import { useCodingTaskSession, type CodingTaskSession } from "./useCodingTaskSession";
import type { ActiveWorkspaceApi } from "../../context/ActiveWorkspaceContext";

const read = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-history-api", () => ({
  CODING_HISTORY_CHANGED: "keiko:coding-history-changed",
  fetchCodingTask: read,
  updateCodingTask: vi.fn(),
}));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));

// S03 (#3904): the fork is the person's standing request, made against the task and the run on
// display. It ends with the request it belongs to; nothing else starts or keeps it.
function message(id: string, role: "user" | "assistant"): ChatMessage {
  return {
    id,
    chatId: "chat-one",
    role,
    content: `${role} ${id}`,
    timestamp: 1,
    runId: "run-one",
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  };
}

const detail: CodingHistoryDetail = {
  task: {
    id: "chat-one",
    title: "Inspect the parser",
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
  messages: [message("m-1", "user"), message("m-2", "assistant"), message("m-3", "user")],
  truncated: false,
};

function snapshot(runId = "run-one"): CodingWorkbenchRuntimeSnapshot {
  return {
    schemaVersion: "1",
    state: "succeeded",
    revision: 1,
    updatedAt: "2026-09-19T10:00:00.000Z",
    runId,
    conversationId: "chat-one",
  };
}

function workspace(): ActiveWorkspaceApi {
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

interface Props {
  readonly runId: string;
  readonly active: boolean;
}

async function loaded(
  initial: Props = { runId: "run-one", active: false },
): Promise<RenderHookResult<CodingTaskSession, Props>> {
  const rendered = renderHook(
    (props: Props) =>
      useCodingTaskSession({
        snapshot: snapshot(props.runId),
        active: props.active,
        root: "/repo",
        workspace: workspace(),
        selection: undefined,
      }),
    { initialProps: initial },
  );
  await waitFor(() => expect(rendered.result.current.detail).not.toBeNull());
  return rendered;
}

beforeEach(() => {
  vi.clearAllMocks();
  read.mockResolvedValue(detail);
});

describe("forking the loaded coding task", () => {
  it("starts with no fork", async () => {
    const { result } = await loaded();

    expect(result.current.fork).toBeNull();
  });

  it("forks the task as it ended, naming the task by its title and no message", async () => {
    const { result } = await loaded();

    act(() => {
      result.current.beginFork();
    });

    expect(result.current.fork).toEqual({ taskId: "chat-one", title: "Inspect the parser" });
  });

  it("forks just before one of the task's user messages", async () => {
    const { result } = await loaded();

    act(() => {
      result.current.beginFork("m-3");
    });

    expect(result.current.fork).toEqual({
      taskId: "chat-one",
      title: "Inspect the parser",
      beforeMessageId: "m-3",
    });
  });

  it.each([
    ["an assistant message", "m-2"],
    ["a message the task does not have", "m-9"],
  ])("does not fork before %s", async (_name, messageId) => {
    const { result } = await loaded();

    act(() => {
      result.current.beginFork(messageId);
    });

    expect(result.current.fork).toBeNull();
  });

  it("ends when the person cancels it", async () => {
    const { result } = await loaded();
    act(() => {
      result.current.beginFork();
    });

    act(() => {
      result.current.cancelFork();
    });

    expect(result.current.fork).toBeNull();
  });

  it("ends when another run is on display, because the request was made against the earlier one", async () => {
    const { result, rerender } = await loaded();
    act(() => {
      result.current.beginFork();
    });
    expect(result.current.fork).not.toBeNull();

    rerender({ runId: "run-two", active: false });

    await waitFor(() => expect(result.current.fork).toBeNull());
  });

  it("ends when a run becomes active", async () => {
    const { result, rerender } = await loaded();
    act(() => {
      result.current.beginFork();
    });

    rerender({ runId: "run-one", active: true });

    await waitFor(() => expect(result.current.fork).toBeNull());
  });

  it("is not offered while a run is active", async () => {
    const { result } = await loaded({ runId: "run-one", active: true });

    act(() => {
      result.current.beginFork();
    });

    expect(result.current.fork).toBeNull();
  });

  it("ends when the person starts a new task instead", async () => {
    const { result } = await loaded();
    act(() => {
      result.current.beginFork("m-1");
    });

    await act(async () => {
      await result.current.newTask();
    });

    await waitFor(() => expect(result.current.fork).toBeNull());
  });
});
