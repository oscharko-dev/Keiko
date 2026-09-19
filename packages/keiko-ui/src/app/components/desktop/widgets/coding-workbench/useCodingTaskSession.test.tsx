import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingHistoryDetail } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts";
import { useCodingTaskSession } from "./useCodingTaskSession";

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
beforeEach(() => {
  vi.clearAllMocks();
  read.mockResolvedValue(detail);
});

describe("coding task selection", () => {
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
