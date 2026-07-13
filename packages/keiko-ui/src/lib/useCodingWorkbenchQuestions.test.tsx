import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "./api";
import {
  answerCodingWorkbenchRuntimeQuestion,
  getCodingWorkbenchRuntimeQuestions,
  rejectCodingWorkbenchRuntimeQuestion,
} from "./coding-workbench-runtime-api";
import {
  CODING_WORKBENCH_QUESTION_POLL_MS,
  useCodingWorkbenchQuestions,
} from "./useCodingWorkbenchQuestions";

vi.mock("./coding-workbench-runtime-api", () => ({
  answerCodingWorkbenchRuntimeQuestion: vi.fn(),
  getCodingWorkbenchRuntimeQuestions: vi.fn(),
  rejectCodingWorkbenchRuntimeQuestion: vi.fn(),
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

async function flush(): Promise<void> {
  await act(async () => Promise.resolve());
}

describe("useCodingWorkbenchQuestions", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("polls one active run at a bounded cadence and cleans up on terminal transition", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    vi.mocked(getCodingWorkbenchRuntimeQuestions).mockImplementation((_runId, signal) => {
      if (signal) signals.push(signal);
      return Promise.resolve(pending);
    });
    const view = renderHook(
      ({ active, terminal }) => useCodingWorkbenchQuestions({ runId: "run-1", active, terminal }),
      { initialProps: { active: true, terminal: false } },
    );

    await flush();
    expect(view.result.current).toMatchObject({ status: "ready", questions: pending.questions });
    expect(getCodingWorkbenchRuntimeQuestions).toHaveBeenCalledOnce();

    await act(async () => vi.advanceTimersByTimeAsync(CODING_WORKBENCH_QUESTION_POLL_MS));
    expect(getCodingWorkbenchRuntimeQuestions).toHaveBeenCalledTimes(2);

    view.rerender({ active: false, terminal: true });
    expect(view.result.current).toMatchObject({ status: "terminal", questions: [] });
    expect(signals.at(-1)?.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(CODING_WORKBENCH_QUESTION_POLL_MS * 2));
    expect(getCodingWorkbenchRuntimeQuestions).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("submits once, removes accepted questions, and rejects duplicate activations", async () => {
    vi.mocked(getCodingWorkbenchRuntimeQuestions).mockResolvedValue(pending);
    vi.mocked(answerCodingWorkbenchRuntimeQuestion).mockResolvedValue({ accepted: true });
    vi.mocked(rejectCodingWorkbenchRuntimeQuestion).mockResolvedValue({ accepted: true });
    const view = renderHook(() =>
      useCodingWorkbenchQuestions({ runId: "run-1", active: true, terminal: false }),
    );
    await flush();

    await act(async () => {
      await Promise.all([
        view.result.current.answer("que_1", [["Continue"]]),
        view.result.current.answer("que_1", [["Continue"]]),
      ]);
    });

    expect(answerCodingWorkbenchRuntimeQuestion).toHaveBeenCalledOnce();
    expect(view.result.current).toMatchObject({ status: "stale", questions: [] });
    view.unmount();
  });

  it("fails closed for offline refreshes and stale one-use mutations", async () => {
    vi.mocked(getCodingWorkbenchRuntimeQuestions).mockRejectedValueOnce(new TypeError("offline"));
    const offlineView = renderHook(() =>
      useCodingWorkbenchQuestions({ runId: "run-1", active: true, terminal: false }),
    );
    await flush();
    expect(offlineView.result.current).toMatchObject({ status: "offline", questions: [] });
    offlineView.unmount();

    vi.mocked(getCodingWorkbenchRuntimeQuestions).mockResolvedValue(pending);
    vi.mocked(answerCodingWorkbenchRuntimeQuestion).mockRejectedValue(
      new ApiError("CODING_RUNTIME_QUESTION_REJECTED", "Rejected.", 409),
    );
    const staleView = renderHook(() =>
      useCodingWorkbenchQuestions({ runId: "run-1", active: true, terminal: false }),
    );
    await flush();
    await act(async () => {
      await staleView.result.current.answer("que_1", [["Continue"]]);
    });

    expect(staleView.result.current).toMatchObject({
      status: "stale",
      questions: [],
      errorCode: "CODING_RUNTIME_QUESTION_STALE",
    });
    staleView.unmount();
  });

  it("aborts an in-flight mutation when the Workbench unmounts", async () => {
    vi.mocked(getCodingWorkbenchRuntimeQuestions).mockResolvedValue(pending);
    let mutationSignal: AbortSignal | undefined;
    vi.mocked(answerCodingWorkbenchRuntimeQuestion).mockImplementation(
      (_runId, _questionId, _input, signal) => {
        mutationSignal = signal;
        return new Promise(() => undefined);
      },
    );
    const view = renderHook(() =>
      useCodingWorkbenchQuestions({ runId: "run-1", active: true, terminal: false }),
    );
    await flush();
    act(() => {
      void view.result.current.answer("que_1", [["Continue"]]);
    });
    expect(mutationSignal?.aborted).toBe(false);

    view.unmount();
    expect(mutationSignal?.aborted).toBe(true);
  });
});
