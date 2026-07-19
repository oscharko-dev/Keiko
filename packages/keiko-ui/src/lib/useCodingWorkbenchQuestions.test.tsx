import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "./api";
import {
  answerCodingWorkbenchRuntimeQuestion,
  listCodingWorkbenchRuntimeQuestions,
  newCodingWorkbenchRuntimeRequestId,
  rejectCodingWorkbenchRuntimeQuestion,
} from "./coding-workbench-runtime-api";
import { useCodingWorkbenchQuestions } from "./useCodingWorkbenchQuestions";

vi.mock("./coding-workbench-runtime-api", () => ({
  answerCodingWorkbenchRuntimeQuestion: vi.fn(),
  listCodingWorkbenchRuntimeQuestions: vi.fn(),
  rejectCodingWorkbenchRuntimeQuestion: vi.fn(),
  newCodingWorkbenchRuntimeRequestId: vi.fn((): string => "ui-req"),
}));

// #2478: the list route serves the channel-carried payload with the session facet of the caller's
// own cookie; the question shapes and bounds inside are unchanged.
const pending = {
  session: "active",
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

const emptyActive = { session: "active", questions: [] } as const;

const snapshot = { schemaVersion: "1", state: "paused", revision: 3, updatedAt: "x" } as const;

async function flush(): Promise<void> {
  await act(async () => Promise.resolve());
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve = (_value: T): void => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

// A stable identity keeps mutation refresh assertions independent from incidental rerenders.
const stableRefresh = vi.fn(() => Promise.resolve());

function activeInput(
  refreshSnapshot: () => Promise<void> = stableRefresh,
): Parameters<typeof useCodingWorkbenchQuestions>[0] {
  return { runId: "run-1", revision: 3, runState: "paused", runtimeEventCount: 0, refreshSnapshot };
}

describe("useCodingWorkbenchQuestions", () => {
  afterEach(() => vi.clearAllMocks());

  it("lists the run's questions without refreshing the revision-stable read", async () => {
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
    expect(refreshSnapshot).not.toHaveBeenCalled();
    view.unmount();
  });

  // #2386 regression: a required question is raised only AFTER the initial listing (the runtime
  // publishes a content-free observation event when it registers). Without the event-driven
  // resync the section stays on "no pending questions" forever and the run hangs on the question.
  it("re-lists when a runtime event signals question activity", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(listCodingWorkbenchRuntimeQuestions)
        .mockResolvedValueOnce(emptyActive)
        .mockResolvedValueOnce(emptyActive)
        .mockResolvedValueOnce(emptyActive)
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
      expect(view.result.current).toMatchObject({ status: "empty", questions: [] });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      await flush();
      expect(view.result.current).toMatchObject({ status: "empty", questions: [] });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_500);
      });
      await flush();
      expect(view.result.current).toMatchObject({ status: "ready", questions: pending.questions });
      expect(listCodingWorkbenchRuntimeQuestions).toHaveBeenCalledTimes(4);
      expect(newCodingWorkbenchRuntimeRequestId).toHaveBeenCalledTimes(4);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(listCodingWorkbenchRuntimeQuestions).toHaveBeenCalledTimes(4);
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces same-run signals without aborting an in-flight list", async () => {
    vi.useFakeTimers();
    try {
      const inFlight = deferred<Awaited<ReturnType<typeof listCodingWorkbenchRuntimeQuestions>>>();
      vi.mocked(listCodingWorkbenchRuntimeQuestions)
        .mockResolvedValueOnce(emptyActive)
        .mockReturnValueOnce(inFlight.promise)
        .mockResolvedValueOnce(pending);
      const view = renderHook((input) => useCodingWorkbenchQuestions(input), {
        initialProps: activeInput(),
      });
      await flush();
      view.rerender({ ...activeInput(), runtimeEventCount: 1 });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      const inFlightSignal = vi.mocked(listCodingWorkbenchRuntimeQuestions).mock.calls[1]?.[2];

      view.rerender({ ...activeInput(), runtimeEventCount: 2 });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(listCodingWorkbenchRuntimeQuestions).toHaveBeenCalledTimes(2);
      expect(inFlightSignal?.aborted).toBe(false);

      await act(async () => {
        inFlight.resolve(emptyActive);
        await Promise.resolve();
      });
      await flush();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      await flush();

      expect(view.result.current).toMatchObject({ status: "ready", questions: pending.questions });
      expect(listCodingWorkbenchRuntimeQuestions).toHaveBeenCalledTimes(3);
      expect(inFlightSignal?.aborted).toBe(false);
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an initially empty run one-shot without polling", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(listCodingWorkbenchRuntimeQuestions).mockResolvedValue(emptyActive);
      const view = renderHook(() => useCodingWorkbenchQuestions(activeInput()));
      await flush();
      expect(listCodingWorkbenchRuntimeQuestions).toHaveBeenCalledTimes(1);

      for (const delay of [400, 500, 1_500, 3_000]) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(delay);
        });
        await flush();
      }
      expect(view.result.current).toMatchObject({ status: "empty", questions: [] });
      expect(listCodingWorkbenchRuntimeQuestions).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(listCodingWorkbenchRuntimeQuestions).toHaveBeenCalledTimes(1);
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resyncs when an active run first projects with runtime activity", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(listCodingWorkbenchRuntimeQuestions)
        .mockResolvedValueOnce(emptyActive)
        .mockResolvedValueOnce(pending);
      const view = renderHook(() =>
        useCodingWorkbenchQuestions({ ...activeInput(), runtimeEventCount: 1 }),
      );
      await flush();
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

  it("resyncs when an inactive workbench activates without a retained runtime event", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(listCodingWorkbenchRuntimeQuestions)
        .mockResolvedValueOnce(emptyActive)
        .mockResolvedValueOnce(pending);
      const inactive: Parameters<typeof useCodingWorkbenchQuestions>[0] = {
        ...activeInput(),
        runId: undefined,
        revision: undefined,
        runState: undefined,
      };
      const view = renderHook((input) => useCodingWorkbenchQuestions(input), {
        initialProps: inactive,
      });
      await flush();
      expect(listCodingWorkbenchRuntimeQuestions).not.toHaveBeenCalled();

      view.rerender(activeInput());
      await flush();
      expect(view.result.current).toMatchObject({ status: "empty", questions: [] });
      expect(listCodingWorkbenchRuntimeQuestions).toHaveBeenCalledTimes(1);

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

  it("caps an empty resync at three visibility retries", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(listCodingWorkbenchRuntimeQuestions).mockResolvedValue(emptyActive);
      const view = renderHook((input) => useCodingWorkbenchQuestions(input), {
        initialProps: activeInput(),
      });
      await flush();
      view.rerender({ ...activeInput(), runtimeEventCount: 1 });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      await flush();
      for (const delay of [500, 1_500, 3_000]) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(delay);
        });
        await flush();
      }

      expect(view.result.current).toMatchObject({ status: "empty", questions: [] });
      expect(listCodingWorkbenchRuntimeQuestions).toHaveBeenCalledTimes(5);
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels bounded retries when the run changes", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(listCodingWorkbenchRuntimeQuestions)
        .mockResolvedValueOnce(emptyActive)
        .mockResolvedValueOnce(emptyActive)
        .mockResolvedValueOnce(pending);
      const view = renderHook((input) => useCodingWorkbenchQuestions(input), {
        initialProps: activeInput(),
      });
      await flush();
      view.rerender({ ...activeInput(), runtimeEventCount: 1 });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      await flush();

      view.rerender({ ...activeInput(), runId: "run-2", runtimeEventCount: 0 });
      await flush();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(listCodingWorkbenchRuntimeQuestions).toHaveBeenCalledTimes(3);
      expect(listCodingWorkbenchRuntimeQuestions).toHaveBeenLastCalledWith(
        "run-2",
        expect.any(Object),
        expect.any(AbortSignal),
      );
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels bounded retries on unmount", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(listCodingWorkbenchRuntimeQuestions).mockResolvedValue(emptyActive);
      const view = renderHook((input) => useCodingWorkbenchQuestions(input), {
        initialProps: activeInput(),
      });
      await flush();
      view.rerender({ ...activeInput(), runtimeEventCount: 1 });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      await flush();
      view.unmount();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(listCodingWorkbenchRuntimeQuestions).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops bounded retries when the app session is unpaired", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(listCodingWorkbenchRuntimeQuestions)
        .mockResolvedValueOnce(emptyActive)
        .mockResolvedValueOnce({ session: "unpaired", questions: [] });
      const view = renderHook((input) => useCodingWorkbenchQuestions(input), {
        initialProps: activeInput(),
      });
      await flush();
      view.rerender({ ...activeInput(), runtimeEventCount: 1 });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      await flush();

      expect(view.result.current.status).toBe("unpaired");
      expect(listCodingWorkbenchRuntimeQuestions).toHaveBeenCalledTimes(2);
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops bounded retries when a resync request fails", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(listCodingWorkbenchRuntimeQuestions)
        .mockResolvedValueOnce(emptyActive)
        .mockRejectedValueOnce(new TypeError("offline"));
      const view = renderHook((input) => useCodingWorkbenchQuestions(input), {
        initialProps: activeInput(),
      });
      await flush();
      view.rerender({ ...activeInput(), runtimeEventCount: 1 });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      await flush();

      expect(view.result.current.status).toBe("offline");
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
        .mockResolvedValueOnce(emptyActive)
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
    vi.mocked(listCodingWorkbenchRuntimeQuestions).mockResolvedValue(emptyActive);
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
    vi.mocked(listCodingWorkbenchRuntimeQuestions).mockResolvedValue(emptyActive);
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

  // #2478: revocation/expiry surfaces as the honest re-pair state — never a silent empty list —
  // and the unpaired projection skips the snapshot re-anchor (the server never touched the run).
  it("surfaces an unpaired session distinctly from an empty question list", async () => {
    const refreshSnapshot = vi.fn(() => Promise.resolve());
    vi.mocked(listCodingWorkbenchRuntimeQuestions).mockResolvedValue({
      session: "unpaired",
      questions: [],
    });
    const view = renderHook(() => useCodingWorkbenchQuestions(activeInput(refreshSnapshot)));
    await flush();

    expect(view.result.current).toMatchObject({
      status: "unpaired",
      questions: [],
      errorCode: null,
    });
    expect(refreshSnapshot).not.toHaveBeenCalled();
    view.unmount();
  });
});
