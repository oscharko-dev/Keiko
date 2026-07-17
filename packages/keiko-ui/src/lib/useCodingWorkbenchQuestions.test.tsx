import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "./api";
import {
  answerCodingWorkbenchRuntimeQuestion,
  listCodingWorkbenchRuntimeQuestions,
  rejectCodingWorkbenchRuntimeQuestion,
} from "./coding-workbench-runtime-api";
import { useCodingWorkbenchQuestions } from "./useCodingWorkbenchQuestions";

vi.mock("./coding-workbench-runtime-api", () => ({
  answerCodingWorkbenchRuntimeQuestion: vi.fn(),
  listCodingWorkbenchRuntimeQuestions: vi.fn(),
  rejectCodingWorkbenchRuntimeQuestion: vi.fn(),
  newCodingWorkbenchRuntimeRequestId: (): string => "ui-req",
}));

const pending = {
  questions: [
    {
      id: "que_1",
      questions: [
        {
          header: "Decision",
          question: "Continue?",
          options: [{ label: "Continue", description: "Proceed once" }],
        },
      ],
    },
  ],
} as const;

const snapshot = { schemaVersion: "1", state: "paused", revision: 3, updatedAt: "x" } as const;

async function flush(): Promise<void> {
  await act(async () => Promise.resolve());
}

// A stable identity: the input is re-created every render, but refreshSnapshot is an effect
// dependency, so it must not change between renders or the listing effect would loop forever.
const stableRefresh = vi.fn(() => Promise.resolve());

function activeInput(
  refreshSnapshot: () => Promise<void> = stableRefresh,
): Parameters<typeof useCodingWorkbenchQuestions>[0] {
  return { runId: "run-1", revision: 3, runState: "paused", runtimeEventCount: 0, refreshSnapshot };
}

describe("useCodingWorkbenchQuestions", () => {
  afterEach(() => vi.clearAllMocks());

  it("lists the run's questions and re-anchors the snapshot afterwards", async () => {
    const refreshSnapshot = vi.fn(() => Promise.resolve());
    vi.mocked(listCodingWorkbenchRuntimeQuestions).mockResolvedValue(pending);
    const view = renderHook(() => useCodingWorkbenchQuestions(activeInput(refreshSnapshot)));
    await flush();

    expect(view.result.current).toMatchObject({ status: "ready", questions: pending.questions });
    expect(listCodingWorkbenchRuntimeQuestions).toHaveBeenCalledWith(
      "run-1",
      { requestId: "ui-req", expectedRevision: 3 },
      expect.any(AbortSignal),
    );
    expect(refreshSnapshot).toHaveBeenCalled();
    view.unmount();
  });

  // #2386 regression: a required question is raised only AFTER the initial listing (the runtime
  // publishes a content-free observation event when it registers). Without the event-driven
  // resync the section stays on "no pending questions" forever and the run hangs on the question.
  it("re-lists when a runtime event signals question activity", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(listCodingWorkbenchRuntimeQuestions)
        .mockResolvedValueOnce({ questions: [] })
        .mockResolvedValueOnce(pending);
      const view = renderHook((input) => useCodingWorkbenchQuestions(input), {
        initialProps: activeInput(),
      });
      await flush();
      expect(view.result.current).toMatchObject({ status: "empty", questions: [] });

      view.rerender({ ...activeInput(), runtimeEventCount: 1 });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      await flush();
      expect(view.result.current).toMatchObject({ status: "ready", questions: pending.questions });
      expect(listCodingWorkbenchRuntimeQuestions).toHaveBeenCalledTimes(2);
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  // A question can also be raised while the run is paused (the in-flight turn keeps running); the
  // sticky-paused orchestrator suppresses adapter events, so the resume transition must re-list.
  it("re-lists when the run state transitions while active", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(listCodingWorkbenchRuntimeQuestions)
        .mockResolvedValueOnce({ questions: [] })
        .mockResolvedValueOnce(pending);
      const view = renderHook((input) => useCodingWorkbenchQuestions(input), {
        initialProps: activeInput(),
      });
      await flush();
      expect(view.result.current).toMatchObject({ status: "empty", questions: [] });

      view.rerender({ ...activeInput(), runState: "running" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      await flush();
      expect(view.result.current).toMatchObject({ status: "ready", questions: pending.questions });
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never lists an inactive run and reports a terminal run distinctly", async () => {
    vi.mocked(listCodingWorkbenchRuntimeQuestions).mockResolvedValue(pending);
    const idle = renderHook(() =>
      useCodingWorkbenchQuestions({
        runId: "run-1",
        revision: 3,
        runState: "idle",
        runtimeEventCount: 0,
        refreshSnapshot: stableRefresh,
      }),
    );
    await flush();
    expect(idle.result.current).toMatchObject({ status: "empty", questions: [] });
    expect(listCodingWorkbenchRuntimeQuestions).not.toHaveBeenCalled();
    idle.unmount();

    const done = renderHook(() =>
      useCodingWorkbenchQuestions({
        runId: "run-1",
        revision: 3,
        runState: "succeeded",
        runtimeEventCount: 0,
        refreshSnapshot: stableRefresh,
      }),
    );
    await flush();
    expect(done.result.current.status).toBe("terminal");
    expect(listCodingWorkbenchRuntimeQuestions).not.toHaveBeenCalled();
    done.unmount();
  });

  it("answers once, drops the accepted question, and re-anchors", async () => {
    vi.mocked(listCodingWorkbenchRuntimeQuestions).mockResolvedValue({ questions: [] });
    vi.mocked(answerCodingWorkbenchRuntimeQuestion).mockResolvedValue(snapshot);
    const refreshSnapshot = vi.fn(() => Promise.resolve());
    const view = renderHook(() => useCodingWorkbenchQuestions(activeInput(refreshSnapshot)));
    await flush();

    await act(async () => {
      await view.result.current.answer("que_1", [["Continue"]]);
    });
    expect(answerCodingWorkbenchRuntimeQuestion).toHaveBeenCalledWith(
      "run-1",
      { requestId: "ui-req", expectedRevision: 3, questionId: "que_1", answers: [["Continue"]] },
      expect.any(AbortSignal),
    );
    expect(refreshSnapshot).toHaveBeenCalled();
    view.unmount();
  });

  it("rejects a question through the reject route", async () => {
    vi.mocked(listCodingWorkbenchRuntimeQuestions).mockResolvedValue({ questions: [] });
    vi.mocked(rejectCodingWorkbenchRuntimeQuestion).mockResolvedValue(snapshot);
    const view = renderHook(() => useCodingWorkbenchQuestions(activeInput()));
    await flush();

    await act(async () => {
      await view.result.current.reject("que_1");
    });
    expect(rejectCodingWorkbenchRuntimeQuestion).toHaveBeenCalledWith(
      "run-1",
      { requestId: "ui-req", expectedRevision: 3, questionId: "que_1" },
      expect.any(AbortSignal),
    );
    view.unmount();
  });

  it("fails closed offline on a list error and surfaces stale on a 409 answer", async () => {
    vi.mocked(listCodingWorkbenchRuntimeQuestions).mockRejectedValueOnce(new TypeError("offline"));
    const offline = renderHook(() => useCodingWorkbenchQuestions(activeInput()));
    await flush();
    expect(offline.result.current).toMatchObject({ status: "offline", questions: [] });
    offline.unmount();

    vi.mocked(listCodingWorkbenchRuntimeQuestions).mockResolvedValue(pending);
    vi.mocked(answerCodingWorkbenchRuntimeQuestion).mockRejectedValue(
      new ApiError("CODING_RUNTIME_QUESTION_REVISION", "Stale.", 409),
    );
    const stale = renderHook(() => useCodingWorkbenchQuestions(activeInput()));
    await flush();
    await act(async () => {
      await stale.result.current.answer("que_1", [["Continue"]]);
    });
    expect(stale.result.current).toMatchObject({
      status: "stale",
      errorCode: "CODING_RUNTIME_QUESTION_STALE",
    });
    stale.unmount();
  });
});
