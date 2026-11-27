import { act, renderHook, waitFor, type RenderHookResult } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingAppSessionChannelSnapshot } from "@oscharko-dev/keiko-contracts";

import {
  encodeCodingAppSessionPairingFragment,
  validateCodingAppSessionChannelSnapshot,
} from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import { ApiError } from "./api";
import { CODING_WORKBENCH_EARLIER_RUN_FEED_LIMIT } from "./useCodingWorkbenchEarlierRunFeeds";
import { correlationIdOf } from "./client-error-summary";
import type { CodingAppSessionStreamInput } from "./coding-app-session-channel-api";
import type { ClientDiagnosticMeta } from "./client-diagnostics";
import {
  redeemCodingAppSessionPairingNavigation,
  type CodingAppSessionPairingSeams,
} from "./coding-app-session-client";
import {
  CODING_SAFE_ACTIVITY_RECONNECT_DELAYS_MS,
  CODING_SAFE_ACTIVITY_RECONNECT_RESET_MS,
  useCodingWorkbenchSafeActivity,
  type UseCodingWorkbenchSafeActivityInput,
} from "./useCodingWorkbenchSafeActivity";

const getSnapshotMock = vi.hoisted(() => vi.fn());
const streamSnapshotsMock = vi.hoisted(() => vi.fn());
const reportDiagnosticSpy = vi.hoisted(() =>
  vi.fn<(message: string, meta?: ClientDiagnosticMeta) => void>(),
);

vi.mock("./client-diagnostics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client-diagnostics")>()),
  reportClientDiagnostic: reportDiagnosticSpy,
}));

vi.mock("./coding-app-session-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./coding-app-session-client")>()),
  codingAppSessionPairingSettled: () => Promise.resolve(true),
}));

vi.mock("./coding-app-session-channel-api", () => ({
  getCodingAppSessionChannelSnapshot: getSnapshotMock,
  streamCodingAppSessionChannelSnapshots: streamSnapshotsMock,
}));

const AT = "2026-07-19T12:00:00.000Z";

// A launcher re-pair that arrives without a page load (F65): a fragment, and a pair endpoint that
// acknowledges it.
const REPAIR_SEAMS: CodingAppSessionPairingSeams = {
  readFragment: (): string =>
    encodeCodingAppSessionPairingFragment({
      requestId: "req_re-pair",
      issuedAtMs: 1,
      claim: "e".repeat(64),
    }),
  stripFragment: (): void => undefined,
  postPairing: (): Promise<unknown> => Promise.resolve({ schemaVersion: "1" }),
};

function snapshot(droppedEventCount = 0, runId = "run-1"): CodingAppSessionChannelSnapshot {
  return {
    schemaVersion: "1",
    content: {
      kind: "safe-activity",
      feed: {
        schemaVersion: "1",
        availability: "available",
        runId,
        updatedAt: AT,
        turns: [],
        truncated: false,
        droppedEventCount,
      },
    },
  };
}

function repliedSnapshot(): CodingAppSessionChannelSnapshot {
  const current = snapshot(3);
  const content = current.content;
  if (
    content?.kind !== "safe-activity" ||
    !("feed" in content) ||
    content.feed.availability !== "available"
  )
    throw new TypeError("Expected available fixture");
  const result: CodingAppSessionChannelSnapshot = {
    ...current,
    content: {
      ...content,
      feed: {
        ...content.feed,
        turns: [
          {
            turnId: "turn-current-reply",
            messages: [
              {
                messageId: "message-current-reply",
                role: "assistant",
                occurredAt: AT,
                segments: [{ kind: "text", text: "Current connection reply.", truncated: false }],
                truncated: false,
              },
            ],
            tools: [],
            truncated: false,
          },
        ],
      },
    },
  };
  expect(validateCodingAppSessionChannelSnapshot(result).ok).toBe(true);
  return result;
}

function unavailableSnapshot(runId = "run-1"): CodingAppSessionChannelSnapshot {
  return {
    schemaVersion: "1",
    content: {
      kind: "safe-activity",
      feed: {
        schemaVersion: "1",
        availability: "unavailable",
        runId,
        updatedAt: AT,
        droppedEventCount: 0,
      },
    },
  };
}

function holdStreamUntilAbort(): void {
  streamSnapshotsMock.mockImplementation(
    ({ signal }: { readonly signal: AbortSignal }): Promise<void> =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  );
}

describe("useCodingWorkbenchSafeActivity", () => {
  beforeEach(() => {
    getSnapshotMock.mockReset();
    streamSnapshotsMock.mockReset();
    reportDiagnosticSpy.mockReset();
    getSnapshotMock.mockResolvedValue(snapshot());
    holdStreamUntilAbort();
  });

  afterEach(() => vi.useRealTimers());

  it("loads the authenticated projection and labels paused content as a confirmed snapshot", async () => {
    const view = renderHook(
      ({ runState }: { readonly runState: "running" | "paused" }) =>
        useCodingWorkbenchSafeActivity({
          runId: "run-1",
          runState,
          runtimeEventSignal: 0,
        }),
      { initialProps: { runState: "running" as "running" | "paused" } },
    );

    await waitFor(() => expect(view.result.current.status).toBe("live"));
    expect(view.result.current.feed?.runId).toBe("run-1");
    view.rerender({ runState: "paused" });
    expect(view.result.current.status).toBe("paused");
  });

  it("reopens the app-session channel after a re-pair without a page load (F65)", async () => {
    const view = renderHook(() =>
      useCodingWorkbenchSafeActivity({
        runId: "run-1",
        runState: "running",
        runtimeEventSignal: 0,
      }),
    );
    await waitFor(() => expect(view.result.current.status).toBe("live"));
    expect(getSnapshotMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await redeemCodingAppSessionPairingNavigation(REPAIR_SEAMS);
    });

    await waitFor(() => expect(streamSnapshotsMock).toHaveBeenCalledTimes(2));
    expect(getSnapshotMock).toHaveBeenCalledTimes(2);
  });

  it("coalesces a burst of stream snapshots into a single re-render with the latest projection", async () => {
    // The pre-existing "wait for droppedEventCount to be 3" test would pass even without any
    // batching, because whichever snapshot arrives last always wins. Pinning batching requires
    // proving that (a) the intermediate droppedEventCount values NEVER surface in state, and
    // (b) the batch collapses to a single React re-render.
    vi.useFakeTimers();
    let publish: ((value: CodingAppSessionChannelSnapshot) => void) | undefined;
    streamSnapshotsMock.mockImplementation(
      ({
        signal,
        onSnapshot,
      }: {
        readonly signal: AbortSignal;
        readonly onSnapshot: typeof publish;
      }): Promise<void> => {
        publish = onSnapshot;
        return new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    );
    let renderCount = 0;
    const view = renderHook(() => {
      renderCount += 1;
      return useCodingWorkbenchSafeActivity({
        runId: "run-1",
        runState: "running",
        runtimeEventSignal: 0,
      });
    });
    // Flush the mount effect's async body (pairingSettled + getSnapshot both resolve on the
    // microtask queue), then let the STREAM_BATCH_MS timer fire so the initial live snapshot
    // lands.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(view.result.current.status).toBe("live");

    const rendersBeforeBurst = renderCount;
    act(() => {
      publish?.(snapshot(1));
      publish?.(snapshot(2));
      publish?.(snapshot(3));
    });
    // Before the STREAM_BATCH_MS window elapses no state update has landed, so the intermediate
    // snapshots must not be observable via the returned hook value.
    expect(view.result.current.feed?.droppedEventCount).toBe(0);

    await act(async () => vi.advanceTimersByTimeAsync(64));
    expect(view.result.current.feed?.droppedEventCount).toBe(3);
    // A batched flush must produce a bounded number of extra renders; a naive
    // "publish each snapshot immediately" implementation would produce 3+.
    expect(renderCount - rendersBeforeBurst).toBeLessThanOrEqual(2);
  });

  it("retains confirmed content but marks it non-live when the fetch stream closes", async () => {
    let closeStream: (() => void) | undefined;
    streamSnapshotsMock.mockImplementation(
      (): Promise<void> =>
        new Promise((resolve) => {
          closeStream = resolve;
        }),
    );
    const view = renderHook(() =>
      useCodingWorkbenchSafeActivity({
        runId: "run-1",
        runState: "running",
        runtimeEventSignal: 0,
      }),
    );
    await waitFor(() => expect(view.result.current.status).toBe("live"));
    await act(async () => closeStream?.());

    await waitFor(() => expect(view.result.current.status).toBe("disconnected"));
    expect(view.result.current.feed?.runId).toBe("run-1");
  });

  it("fails closed when the channel has no matching safe-activity content", async () => {
    getSnapshotMock.mockResolvedValue({ schemaVersion: "1", content: null });
    streamSnapshotsMock.mockResolvedValue(undefined);
    const view = renderHook(() =>
      useCodingWorkbenchSafeActivity({
        runId: "run-1",
        runState: "running",
        runtimeEventSignal: 0,
      }),
    );

    await waitFor(() => expect(view.result.current.status).toBe("unavailable"));
    expect(view.result.current.feed).toBeNull();
  });

  // #3610 (W17): Stop purges the run's projection, and the Workbench then said "Activity not
  // connected" with a Reconnect button that could never bring anything back. A finished run without
  // a projection has ended; there is no held feed to caption as final.
  it("reports a finished run without a projection as ended, not as a lost connection", async () => {
    getSnapshotMock.mockResolvedValue({ schemaVersion: "1", content: null });
    streamSnapshotsMock.mockResolvedValue(undefined);
    const view = renderHook(() =>
      useCodingWorkbenchSafeActivity({
        runId: "run-1",
        runState: "cancelled",
        runtimeEventSignal: 0,
      }),
    );

    await waitFor(() => expect(view.result.current.status).toBe("ended"));
    expect(view.result.current.feed).toBeNull();
  });

  it("turns a purged projection into ended once the stopping run settles", async () => {
    getSnapshotMock.mockResolvedValue({ schemaVersion: "1", content: null });
    streamSnapshotsMock.mockResolvedValue(undefined);
    const view = renderHook(
      ({ runState }: { readonly runState: "stopping" | "cancelled" }) =>
        useCodingWorkbenchSafeActivity({ runId: "run-1", runState, runtimeEventSignal: 0 }),
      { initialProps: { runState: "stopping" as "stopping" | "cancelled" } },
    );
    await waitFor(() => expect(view.result.current.status).toBe("unavailable"));

    view.rerender({ runState: "cancelled" });

    expect(view.result.current.status).toBe("ended");
    expect(view.result.current.feed).toBeNull();
  });

  it.each(["succeeded", "failed", "cancelled", "taken-over"] as const)(
    "reads a %s run once without opening an unnecessary live stream",
    async (runState) => {
      streamSnapshotsMock.mockRejectedValue(new Error("live channel restarted"));
      const view = renderHook(() =>
        useCodingWorkbenchSafeActivity({
          runId: "run-1",
          runState,
          runtimeEventSignal: 0,
        }),
      );
      await waitFor(() => expect(view.result.current.status).toBe("ended"));
      expect(getSnapshotMock).toHaveBeenCalledOnce();
      expect(streamSnapshotsMock).not.toHaveBeenCalled();
      expect(view.result.current.feed?.runId).toBe("run-1");
      expect(view.result.current.errorCode).toBeNull();
    },
  );

  it("preserves a failed final snapshot read instead of claiming a confirmed transcript", async () => {
    getSnapshotMock.mockRejectedValue(new Error("snapshot unavailable"));
    const view = renderHook(() =>
      useCodingWorkbenchSafeActivity({
        runId: "run-1",
        runState: "succeeded",
        runtimeEventSignal: 0,
      }),
    );
    await waitFor(() => expect(view.result.current.status).toBe("error"));
    expect(view.result.current.feed).toBeNull();
    expect(streamSnapshotsMock).not.toHaveBeenCalled();
  });

  it("still streams the final updates when the run finishes during the initial snapshot read", async () => {
    let resolveSnapshot: ((value: CodingAppSessionChannelSnapshot) => void) | undefined;
    getSnapshotMock.mockImplementation(
      () =>
        new Promise<CodingAppSessionChannelSnapshot>((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    const view = renderHook(
      (input: UseCodingWorkbenchSafeActivityInput) => useCodingWorkbenchSafeActivity(input),
      {
        initialProps: {
          runId: "run-1",
          runState: "running",
          runtimeEventSignal: 0,
        } as UseCodingWorkbenchSafeActivityInput,
      },
    );
    await waitFor(() => expect(getSnapshotMock).toHaveBeenCalledOnce());
    view.rerender({ runId: "run-1", runState: "succeeded", runtimeEventSignal: 1 });
    await act(async () => {
      resolveSnapshot?.(snapshot());
    });
    await waitFor(() => expect(streamSnapshotsMock).toHaveBeenCalledOnce());
  });

  // Cross-run isolation: switching to a new runId must abandon the previous feed before it can
  // leak into the new run's view.
  it("drops the previous run's feed when runId changes", async () => {
    getSnapshotMock.mockImplementation(async (): Promise<CodingAppSessionChannelSnapshot> =>
      snapshot(0),
    );
    const view = renderHook(
      (input: UseCodingWorkbenchSafeActivityInput) => useCodingWorkbenchSafeActivity(input),
      {
        initialProps: {
          runId: "run-1",
          runState: "running",
          runtimeEventSignal: 0,
        } satisfies UseCodingWorkbenchSafeActivityInput,
      },
    );
    await waitFor(() => expect(view.result.current.status).toBe("live"));
    expect(view.result.current.feed?.runId).toBe("run-1");

    getSnapshotMock.mockImplementation(async (): Promise<CodingAppSessionChannelSnapshot> =>
      snapshot(0, "run-2"),
    );
    view.rerender({ runId: "run-2", runState: "running", runtimeEventSignal: 0 });
    // The old run-1 feed must not survive the switch even for one render — it would confuse the
    // caller that trusts the returned feed to belong to the current run.
    expect(view.result.current.feed?.runId).not.toBe("run-1");
    await waitFor(() => expect(view.result.current.feed?.runId).toBe("run-2"));
  });

  // U-11: a continuation is a new run in the same task, and the server's projection holds one run
  // at a time. The tool rows of the run before it stay, as standalone OpenCode keeps an earlier
  // turn's tool parts, whether that run was stopped or completed.
  function activitySnapshot(
    runId: string,
    toolState: "running" | "succeeded",
  ): CodingAppSessionChannelSnapshot {
    const base = snapshot(0, runId);
    const content = base.content;
    if (content?.kind !== "safe-activity" || !("feed" in content)) throw new TypeError("fixture");
    if (content.feed.availability !== "available") throw new TypeError("fixture");
    return {
      ...base,
      content: {
        ...content,
        feed: {
          ...content.feed,
          turns: [
            {
              turnId: `turn-${runId}`,
              messages: [],
              tools: [{ callId: `call-${runId}`, tool: "read", state: toolState, occurredAt: AT }],
              truncated: false,
            },
          ],
        },
      },
    };
  }

  it.each([
    ["stopped", "cancelled", "running", "cancelled"],
    ["completed", "succeeded", "succeeded", "succeeded"],
  ] as const)(
    "keeps the tool rows of a %s run when a continuation starts in the same task",
    async (_name, endState, toolState, shownState) => {
      getSnapshotMock.mockImplementation(async (): Promise<CodingAppSessionChannelSnapshot> =>
        activitySnapshot("run-1", toolState),
      );
      const view = renderHook(
        (input: UseCodingWorkbenchSafeActivityInput) => useCodingWorkbenchSafeActivity(input),
        {
          initialProps: {
            runId: "run-1",
            runState: "running",
            runtimeEventSignal: 0,
            conversationId: "task-1",
          } as UseCodingWorkbenchSafeActivityInput,
        },
      );
      await waitFor(() => expect(view.result.current.feed?.runId).toBe("run-1"));
      expect(view.result.current.earlierFeeds).toEqual([]);
      view.rerender({
        runId: "run-1",
        runState: endState,
        runtimeEventSignal: 1,
        conversationId: "task-1",
      });

      getSnapshotMock.mockImplementation(async (): Promise<CodingAppSessionChannelSnapshot> =>
        activitySnapshot("run-2", "running"),
      );
      view.rerender({
        runId: "run-2",
        runState: "running",
        runtimeEventSignal: 0,
        conversationId: "task-1",
      });
      await waitFor(() => expect(view.result.current.feed?.runId).toBe("run-2"));
      const earlier = view.result.current.earlierFeeds ?? [];
      expect(earlier.map((feed) => feed.runId)).toEqual(["run-1"]);
      expect(earlier[0]?.turns[0]?.tools.map((tool) => tool.state)).toEqual([shownState]);
    },
  );

  it("never offers the earlier feed of another task", async () => {
    getSnapshotMock.mockImplementation(async (): Promise<CodingAppSessionChannelSnapshot> =>
      activitySnapshot("run-1", "succeeded"),
    );
    const view = renderHook(
      (input: UseCodingWorkbenchSafeActivityInput) => useCodingWorkbenchSafeActivity(input),
      {
        initialProps: {
          runId: "run-1",
          runState: "succeeded",
          runtimeEventSignal: 0,
          conversationId: "task-1",
        } as UseCodingWorkbenchSafeActivityInput,
      },
    );
    await waitFor(() => expect(view.result.current.feed?.runId).toBe("run-1"));
    getSnapshotMock.mockImplementation(async (): Promise<CodingAppSessionChannelSnapshot> =>
      activitySnapshot("run-2", "running"),
    );
    view.rerender({
      runId: "run-2",
      runState: "running",
      runtimeEventSignal: 0,
      conversationId: "task-2",
    });
    await waitFor(() => expect(view.result.current.feed?.runId).toBe("run-2"));
    expect(view.result.current.earlierFeeds).toEqual([]);
  });

  type EarlierInput = UseCodingWorkbenchSafeActivityInput;
  type EarlierView = RenderHookResult<
    ReturnType<typeof useCodingWorkbenchSafeActivity>,
    EarlierInput
  >;

  async function showRun(
    view: EarlierView,
    input: EarlierInput,
    toolState: "running" | "succeeded" = "succeeded",
  ): Promise<void> {
    const runId = input.runId ?? "run-unnamed";
    getSnapshotMock.mockImplementation(async (): Promise<CodingAppSessionChannelSnapshot> =>
      activitySnapshot(runId, toolState),
    );
    view.rerender(input);
    await waitFor(() => expect(view.result.current.feed?.runId).toBe(runId));
  }

  function renderEarlier(initial: EarlierInput): EarlierView {
    return renderHook((input: EarlierInput) => useCodingWorkbenchSafeActivity(input), {
      initialProps: initial,
    });
  }

  it("keeps a run that is still live as it was, not settled as cancelled", async () => {
    const first: EarlierInput = {
      runId: "run-1",
      runState: "running",
      runtimeEventSignal: 0,
      conversationId: "task-1",
    };
    const view = renderEarlier(first);
    await showRun(view, first, "running");
    await showRun(view, { ...first, runId: "run-2" });
    const tools = view.result.current.earlierFeeds?.[0]?.turns[0]?.tools ?? [];
    expect(tools.map((tool) => tool.state)).toEqual(["running"]);
  });

  it("drops the feeds of other tasks when the shown task changes", async () => {
    const first: EarlierInput = {
      runId: "run-1",
      runState: "succeeded",
      runtimeEventSignal: 0,
      conversationId: "task-1",
    };
    const view = renderEarlier(first);
    await showRun(view, first);
    await showRun(view, { ...first, runId: "run-2" });
    expect(view.result.current.earlierFeeds?.map((feed) => feed.runId)).toEqual(["run-1"]);
    await showRun(view, { ...first, runId: "run-3", conversationId: "task-2" });
    expect(view.result.current.earlierFeeds).toEqual([]);
    await showRun(view, { ...first, runId: "run-4", conversationId: "task-1" });
    expect(view.result.current.earlierFeeds).toEqual([]);
  });

  it("keeps nothing for a run that names no task", async () => {
    const first: EarlierInput = { runId: "run-1", runState: "succeeded", runtimeEventSignal: 0 };
    const view = renderEarlier(first);
    await showRun(view, first);
    await showRun(view, { ...first, runId: "run-2" });
    expect(view.result.current.earlierFeeds).toEqual([]);
    await showRun(view, { ...first, runId: "run-3", conversationId: "task-1" });
    expect(view.result.current.earlierFeeds).toEqual([]);
  });

  it("holds at most the bound of earlier runs and evicts the oldest first", async () => {
    const first: EarlierInput = {
      runId: "run-1",
      runState: "succeeded",
      runtimeEventSignal: 0,
      conversationId: "task-1",
    };
    const view = renderEarlier(first);
    await showRun(view, first);
    const runs = CODING_WORKBENCH_EARLIER_RUN_FEED_LIMIT + 2;
    for (let run = 2; run <= runs; run += 1) {
      await showRun(view, { ...first, runId: `run-${String(run)}` });
    }
    const held = (view.result.current.earlierFeeds ?? []).map((feed) => feed.runId);
    expect(held).toHaveLength(CODING_WORKBENCH_EARLIER_RUN_FEED_LIMIT);
    expect(held[0]).toBe("run-2");
    expect(held.at(-1)).toBe(`run-${String(runs - 1)}`);
  });

  // Stability audit item 5: every reconnect used to blank the conversation until the snapshot read
  // answered, and a failed read then left it blank. The feed already held is kept, captioned by the
  // non-live status, until a new snapshot replaces it.
  it("keeps the previous feed, not live, while a reconnect reads its new snapshot", async () => {
    const view = renderHook(() =>
      useCodingWorkbenchSafeActivity({
        runId: "run-1",
        runState: "running",
        runtimeEventSignal: 0,
      }),
    );
    await waitFor(() => expect(view.result.current.status).toBe("live"));
    const confirmed = view.result.current.feed;
    expect(confirmed).not.toBeNull();

    getSnapshotMock.mockImplementation(
      () => new Promise<CodingAppSessionChannelSnapshot>(() => undefined),
    );
    act(() => view.result.current.retry());

    expect(view.result.current.status).toBe("loading");
    expect(view.result.current.feed).toBe(confirmed);
  });

  it("keeps the previous feed when the reconnect's snapshot read fails", async () => {
    const view = renderHook(() =>
      useCodingWorkbenchSafeActivity({
        runId: "run-1",
        runState: "running",
        runtimeEventSignal: 0,
      }),
    );
    await waitFor(() => expect(view.result.current.status).toBe("live"));
    const confirmed = view.result.current.feed;

    getSnapshotMock.mockRejectedValue(new TypeError("Network request failed"));
    act(() => view.result.current.retry());

    await waitFor(() => expect(view.result.current.status).toBe("offline"));
    expect(view.result.current.feed).toBe(confirmed);
  });

  it("does not relabel a held feed as live while its reconnect is still reading", async () => {
    const view = renderHook(
      ({ runState }: { readonly runState: "running" | "paused" }) =>
        useCodingWorkbenchSafeActivity({ runId: "run-1", runState, runtimeEventSignal: 0 }),
      { initialProps: { runState: "running" as "running" | "paused" } },
    );
    await waitFor(() => expect(view.result.current.status).toBe("live"));

    getSnapshotMock.mockImplementation(
      () => new Promise<CodingAppSessionChannelSnapshot>(() => undefined),
    );
    act(() => view.result.current.retry());
    view.rerender({ runState: "paused" });

    expect(view.result.current.status).toBe("loading");
  });

  // Audit item 14 relocates the Epic #3384 pin here: the window no longer calls `retry` when a run
  // id changes, because this hook already reconnects for the new run on its own, exactly once.
  it("reconnects for a new run id by itself, once, even from a disconnected state", async () => {
    getSnapshotMock.mockResolvedValue(snapshot(0, "run-1"));
    streamSnapshotsMock.mockResolvedValue(undefined);
    const view = renderHook(
      (input: UseCodingWorkbenchSafeActivityInput) => useCodingWorkbenchSafeActivity(input),
      {
        initialProps: {
          runId: "run-1",
          runState: "running",
          runtimeEventSignal: 0,
        } satisfies UseCodingWorkbenchSafeActivityInput,
      },
    );
    await waitFor(() => expect(view.result.current.status).toBe("disconnected"));
    expect(getSnapshotMock).toHaveBeenCalledTimes(1);

    getSnapshotMock.mockResolvedValue(snapshot(0, "run-2"));
    holdStreamUntilAbort();
    view.rerender({ runId: "run-2", runState: "running", runtimeEventSignal: 0 });

    await waitFor(() => expect(view.result.current.feed?.runId).toBe("run-2"));
    expect(view.result.current.status).toBe("live");
    expect(getSnapshotMock).toHaveBeenCalledTimes(2);
  });

  it("ignores a superseded initial read after a newer connection confirmed its feed", async () => {
    vi.useFakeTimers();
    let release!: (value: CodingAppSessionChannelSnapshot) => void;
    getSnapshotMock
      .mockImplementationOnce(
        () =>
          new Promise<CodingAppSessionChannelSnapshot>((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValueOnce(repliedSnapshot());
    const view = renderHook(() =>
      useCodingWorkbenchSafeActivity({
        runId: "run-1",
        runState: "running",
        runtimeEventSignal: 0,
      }),
    );
    try {
      await act(async () => vi.advanceTimersByTimeAsync(0));
      expect(getSnapshotMock).toHaveBeenCalledOnce();
      const oldSignal = getSnapshotMock.mock.calls[0]?.[0] as AbortSignal;
      act(() => view.result.current.retry());
      expect(oldSignal.aborted).toBe(true);
      await act(async () => vi.advanceTimersByTimeAsync(64));
      const confirmed = view.result.current.feed;
      expect(confirmed?.turns[0]?.messages[0]?.segments[0]).toHaveProperty(
        "text",
        "Current connection reply.",
      );
      await act(async () => release(snapshot()));
      expect(view.result.current.feed).toBe(confirmed);
      expect(getSnapshotMock).toHaveBeenCalledTimes(2);
    } finally {
      release(snapshot());
      view.unmount();
    }
  });

  it.each(["closed", "failed"] as const)(
    "does not let an aborted stream %s finalizer flush another connection's pending batch",
    async (outcome) => {
      vi.useFakeTimers();
      let resolveOld!: () => void;
      let rejectOld!: (error: Error) => void;
      let publishNew!: (value: CodingAppSessionChannelSnapshot) => void;
      streamSnapshotsMock
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve, reject) => {
              resolveOld = resolve;
              rejectOld = reject;
            }),
        )
        .mockImplementationOnce(
          ({ signal, onSnapshot }: CodingAppSessionStreamInput): Promise<void> => {
            publishNew = onSnapshot;
            return new Promise((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true }),
            );
          },
        );
      const view = renderHook(() =>
        useCodingWorkbenchSafeActivity({
          runId: "run-1",
          runState: "running",
          runtimeEventSignal: 0,
        }),
      );
      try {
        await act(async () => vi.advanceTimersByTimeAsync(64));
        expect(view.result.current.feed?.droppedEventCount).toBe(0);
        act(() => view.result.current.retry());
        await act(async () => vi.advanceTimersByTimeAsync(64));
        act(() => publishNew(snapshot(3)));
        await act(async () => {
          if (outcome === "closed") resolveOld();
          else rejectOld(new Error("superseded stream"));
        });
        expect(view.result.current.feed?.droppedEventCount).toBe(0);
        expect(view.result.current.status).toBe("live");
        await act(async () => vi.advanceTimersByTimeAsync(64));
        expect(view.result.current.feed?.droppedEventCount).toBe(3);
      } finally {
        resolveOld();
        view.unmount();
      }
    },
  );

  it("refuses a late valid frame from the stream replaced by a successful reconnect", async () => {
    vi.useFakeTimers();
    let publishOld!: (value: CodingAppSessionChannelSnapshot) => void;
    streamSnapshotsMock.mockImplementationOnce(
      ({ signal, onSnapshot }: CodingAppSessionStreamInput): Promise<void> => {
        publishOld = onSnapshot;
        return new Promise((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    );
    const view = renderHook(() =>
      useCodingWorkbenchSafeActivity({
        runId: "run-1",
        runState: "running",
        runtimeEventSignal: 0,
      }),
    );
    try {
      await act(async () => vi.advanceTimersByTimeAsync(64));
      getSnapshotMock.mockResolvedValueOnce(snapshot(3));
      act(() => view.result.current.retry());
      await act(async () => vi.advanceTimersByTimeAsync(64));
      expect(view.result.current.feed?.droppedEventCount).toBe(3);
      act(() => publishOld(snapshot()));
      await act(async () => vi.advanceTimersByTimeAsync(64));
      expect(view.result.current.feed?.droppedEventCount).toBe(3);
    } finally {
      view.unmount();
    }
  });

  it("fails closed when the channel returns an unavailable feed", async () => {
    getSnapshotMock.mockResolvedValue(unavailableSnapshot());
    streamSnapshotsMock.mockResolvedValue(undefined);
    const view = renderHook(() =>
      useCodingWorkbenchSafeActivity({
        runId: "run-1",
        runState: "running",
        runtimeEventSignal: 0,
      }),
    );

    await waitFor(() => expect(view.result.current.status).toBe("unavailable"));
    expect(view.result.current.feed).toBeNull();
  });

  it("reads a recovery-required run without a projection as needing attention, not as a lost connection (U-23)", async () => {
    getSnapshotMock.mockResolvedValue(unavailableSnapshot());
    streamSnapshotsMock.mockResolvedValue(undefined);
    const view = renderHook(() =>
      useCodingWorkbenchSafeActivity({
        runId: "run-1",
        runState: "recovery-required",
        runtimeEventSignal: 0,
      }),
    );

    await waitFor(() => expect(view.result.current.status).toBe("recovery"));
    expect(view.result.current.feed).toBeNull();
  });

  it("turns a recovery-required run without a projection into ended once it is cancelled (U-23)", async () => {
    getSnapshotMock.mockResolvedValue(unavailableSnapshot());
    streamSnapshotsMock.mockResolvedValue(undefined);
    const view = renderHook(
      ({ runState }: { readonly runState: "recovery-required" | "cancelled" }) =>
        useCodingWorkbenchSafeActivity({ runId: "run-1", runState, runtimeEventSignal: 0 }),
      { initialProps: { runState: "recovery-required" as "recovery-required" | "cancelled" } },
    );
    await waitFor(() => expect(view.result.current.status).toBe("recovery"));

    view.rerender({ runState: "cancelled" });

    expect(view.result.current.status).toBe("ended");
    expect(view.result.current.feed).toBeNull();
  });

  it("replaces the recovery status when a projection appears on the open channel later (U-23)", async () => {
    getSnapshotMock.mockResolvedValue(unavailableSnapshot());
    let publish: ((value: CodingAppSessionChannelSnapshot) => void) | undefined;
    streamSnapshotsMock.mockImplementation(
      ({
        signal,
        onSnapshot,
      }: {
        readonly signal: AbortSignal;
        readonly onSnapshot: typeof publish;
      }): Promise<void> => {
        publish = onSnapshot;
        return new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    );
    const view = renderHook(() =>
      useCodingWorkbenchSafeActivity({
        runId: "run-1",
        runState: "recovery-required",
        runtimeEventSignal: 0,
      }),
    );
    await waitFor(() => expect(view.result.current.status).toBe("recovery"));
    expect(view.result.current.feed).toBeNull();

    act(() => {
      publish?.(snapshot(1));
    });

    await waitFor(() => expect(view.result.current.feed).not.toBeNull());
    expect(view.result.current.status).toBe("recovery");
    view.unmount();
  });

  it("labels the projection as offline when the transport throws a TypeError", async () => {
    getSnapshotMock.mockRejectedValue(new TypeError("Network request failed"));
    const view = renderHook(() =>
      useCodingWorkbenchSafeActivity({
        runId: "run-1",
        runState: "running",
        runtimeEventSignal: 0,
      }),
    );

    await waitFor(() => expect(view.result.current.status).toBe("offline"));
    expect(view.result.current.errorCode).toBe("CODING_SAFE_ACTIVITY_STREAM_FAILED");
  });

  it("labels the projection as error when the transport throws a non-TypeError", async () => {
    getSnapshotMock.mockRejectedValue(new Error("bounded upstream 502"));
    const view = renderHook(() =>
      useCodingWorkbenchSafeActivity({
        runId: "run-1",
        runState: "running",
        runtimeEventSignal: 0,
      }),
    );

    await waitFor(() => expect(view.result.current.status).toBe("error"));
    expect(view.result.current.errorCode).toBe("CODING_SAFE_ACTIVITY_STREAM_FAILED");
  });

  // A page left open across an update reads snapshots its own contract rejects: the timeline says
  // only "Activity unavailable", so the Activity Log must name the class, the closed code and the
  // request (Windows 11 lab, 2026-11-26: the failure was invisible in the log).
  it("records a failed connection with its error class, closed code and correlation id", async () => {
    const failure = Object.assign(
      new ApiError("CONTRACT_VALIDATION_FAILED", "BFF response failed contract validation.", 502),
      { correlationId: "corr-activity-1" },
    );
    getSnapshotMock.mockRejectedValue(failure);
    const view = renderHook(() =>
      useCodingWorkbenchSafeActivity({
        runId: "run-1",
        runState: "running",
        runtimeEventSignal: 0,
      }),
    );

    await waitFor(() => expect(view.result.current.status).toBe("error"));
    expect(reportDiagnosticSpy).toHaveBeenCalledWith(
      "[keiko] coding safe activity connection failed: ApiError CONTRACT_VALIDATION_FAILED",
      { correlationId: "corr-activity-1" },
    );
    const [message] = reportDiagnosticSpy.mock.calls[0] ?? [""];
    expect(message).not.toContain("BFF response");
  });

  const CONNECTION_FAILED = "[keiko] coding safe activity connection failed: ApiError";

  async function failedDiagnostic(failure: Error): Promise<readonly unknown[]> {
    getSnapshotMock.mockRejectedValue(failure);
    const view = renderHook(() =>
      useCodingWorkbenchSafeActivity({
        runId: "run-1",
        runState: "running",
        runtimeEventSignal: 0,
      }),
    );
    await waitFor(() => expect(view.result.current.status).toBe("error"));
    return reportDiagnosticSpy.mock.calls[0] ?? [];
  }

  it.each([
    ["a path", "C:\\Users\\dev\\secret path"],
    ["a lowercase code", "contract_validation_failed"],
    ["a code longer than 64 characters", `A${"B".repeat(64)}`],
    ["an empty code", ""],
  ])("leaves %s out of the diagnostic", async (_label, code) => {
    const [message] = await failedDiagnostic(new ApiError(code, "BFF response failed.", 500));
    expect(message).toBe(CONNECTION_FAILED);
  });

  it("keeps a code of exactly 64 identifier characters", async () => {
    const code = `A${"B".repeat(63)}`;
    const [message] = await failedDiagnostic(new ApiError(code, "BFF response failed.", 500));
    expect(message).toBe(`${CONNECTION_FAILED} ${code}`);
  });

  it("passes whatever correlation id the error carries, none for a plain ApiError", async () => {
    const failure = new ApiError("CONTRACT_VALIDATION_FAILED", "BFF response failed.", 502);
    const [, meta] = await failedDiagnostic(failure);
    expect(meta).toEqual({ correlationId: correlationIdOf(failure) });
    expect(correlationIdOf(failure)).toBeUndefined();
  });

  it("records nothing when the connection is torn down on purpose", async () => {
    getSnapshotMock.mockImplementation(
      (signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const view = renderHook(() =>
      useCodingWorkbenchSafeActivity({
        runId: "run-1",
        runState: "running",
        runtimeEventSignal: 0,
      }),
    );
    await waitFor(() => expect(getSnapshotMock).toHaveBeenCalled());
    const pending = getSnapshotMock.mock.results[0]?.value as Promise<unknown>;
    view.unmount();
    // The hook's rejection handler was attached before this one, so it has run once this settles;
    // the extra flushes cover the async frames between the client call and that handler.
    await act(async () => {
      await pending.catch(() => undefined);
      for (let flush = 0; flush < 5; flush += 1) await Promise.resolve();
    });
    expect(reportDiagnosticSpy).not.toHaveBeenCalled();
  });

  // Resync: after a failed projection, a bumped runtimeEventSignal must debounce and reconnect,
  // and the debounced connect must NOT fire while the projection is still live.
  it("debounces the reconnect on a runtimeEventSignal change only when the projection is not live", async () => {
    vi.useFakeTimers();
    // First load rejects to force the failure state; second load succeeds so the reconnect can
    // recover.
    getSnapshotMock
      .mockRejectedValueOnce(new Error("bounded upstream 502"))
      .mockResolvedValueOnce(snapshot());

    const view = renderHook(
      (input: UseCodingWorkbenchSafeActivityInput) => useCodingWorkbenchSafeActivity(input),
      {
        initialProps: {
          runId: "run-1",
          runState: "running",
          runtimeEventSignal: 0,
        } satisfies UseCodingWorkbenchSafeActivityInput,
      },
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(view.result.current.status).toBe("error");
    expect(getSnapshotMock).toHaveBeenCalledTimes(1);

    // Bumping the runtime signal while the projection is failed queues a debounced reconnect.
    view.rerender({ runId: "run-1", runState: "running", runtimeEventSignal: 1 });
    // No reconnect until the debounce window elapses.
    expect(getSnapshotMock).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(getSnapshotMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(view.result.current.status).toBe("live");

    // With the projection live, a further runtime signal must NOT trigger another reconnect —
    // the resync effect exists specifically to recover failed projections, not to churn healthy
    // ones.
    view.rerender({ runId: "run-1", runState: "running", runtimeEventSignal: 2 });
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(getSnapshotMock).toHaveBeenCalledTimes(2);
  });

  // Keiko 1.3.0 test (#3897): a dropped live channel stayed "disconnected" until the next runtime
  // event or a click, so a quiet run looked lost. It now reconnects by itself, a bounded number of
  // times.
  async function settleConnection(): Promise<void> {
    await act(async () => {
      for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(50);
    });
  }

  it("reconnects a dropped channel by itself, with growing pauses and a bounded number of attempts", async () => {
    vi.useFakeTimers();
    streamSnapshotsMock.mockResolvedValue(undefined);
    const view = renderHook(() =>
      useCodingWorkbenchSafeActivity({
        runId: "run-1",
        runState: "running",
        runtimeEventSignal: 0,
      }),
    );
    await settleConnection();
    expect(view.result.current.status).toBe("disconnected");
    expect(getSnapshotMock).toHaveBeenCalledTimes(1);

    for (const [attempt, delay] of CODING_SAFE_ACTIVITY_RECONNECT_DELAYS_MS.entries()) {
      await act(async () => vi.advanceTimersByTimeAsync(delay - 100));
      expect(getSnapshotMock).toHaveBeenCalledTimes(attempt + 1);
      await act(async () => vi.advanceTimersByTimeAsync(100));
      await settleConnection();
      expect(getSnapshotMock).toHaveBeenCalledTimes(attempt + 2);
      expect(view.result.current.status).toBe("disconnected");
    }
    // A channel that closes as soon as it opens never earns a fresh budget: it stops here, and the
    // Reconnect action still works.
    await act(async () => vi.advanceTimersByTimeAsync(CODING_SAFE_ACTIVITY_RECONNECT_RESET_MS * 2));
    expect(getSnapshotMock).toHaveBeenCalledTimes(
      CODING_SAFE_ACTIVITY_RECONNECT_DELAYS_MS.length + 1,
    );
    act(() => view.result.current.retry());
    await settleConnection();
    expect(getSnapshotMock).toHaveBeenCalledTimes(
      CODING_SAFE_ACTIVITY_RECONNECT_DELAYS_MS.length + 2,
    );
  });

  it("recovers a failed connection by itself and keeps the recovered stream live", async () => {
    vi.useFakeTimers();
    getSnapshotMock
      .mockRejectedValueOnce(new TypeError("Network request failed"))
      .mockResolvedValue(snapshot());
    const view = renderHook(() =>
      useCodingWorkbenchSafeActivity({
        runId: "run-1",
        runState: "running",
        runtimeEventSignal: 0,
      }),
    );
    await settleConnection();
    expect(view.result.current.status).toBe("offline");

    await act(async () =>
      vi.advanceTimersByTimeAsync(CODING_SAFE_ACTIVITY_RECONNECT_DELAYS_MS[0] ?? 0),
    );
    await settleConnection();
    expect(view.result.current.status).toBe("live");
    await act(async () => vi.advanceTimersByTimeAsync(CODING_SAFE_ACTIVITY_RECONNECT_RESET_MS * 2));
    expect(getSnapshotMock).toHaveBeenCalledTimes(2);
  });

  it("gives a channel that stayed live a fresh reconnect budget", async () => {
    vi.useFakeTimers();
    const closes: (() => void)[] = [];
    streamSnapshotsMock.mockImplementation(
      (): Promise<void> =>
        new Promise((resolve) => {
          closes.push(resolve);
        }),
    );
    const view = renderHook(() =>
      useCodingWorkbenchSafeActivity({
        runId: "run-1",
        runState: "running",
        runtimeEventSignal: 0,
      }),
    );
    const delays = CODING_SAFE_ACTIVITY_RECONNECT_DELAYS_MS;
    // Spend every attempt but the last on channels that close at once.
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      await settleConnection();
      await act(async () => closes.at(-1)?.());
      await settleConnection();
      expect(view.result.current.status).toBe("disconnected");
      await act(async () => vi.advanceTimersByTimeAsync(delays[attempt] ?? 0));
    }
    await settleConnection();
    expect(view.result.current.status).toBe("live");
    await act(async () => vi.advanceTimersByTimeAsync(CODING_SAFE_ACTIVITY_RECONNECT_RESET_MS));
    const calls = getSnapshotMock.mock.calls.length;
    await act(async () => closes.at(-1)?.());
    await settleConnection();
    await act(async () => vi.advanceTimersByTimeAsync(delays[0] ?? 0));
    await settleConnection();
    expect(getSnapshotMock).toHaveBeenCalledTimes(calls + 1);
  });

  it("does not reconnect a finished run's channel or one with no projection", async () => {
    vi.useFakeTimers();
    streamSnapshotsMock.mockResolvedValue(undefined);
    getSnapshotMock.mockResolvedValue({ schemaVersion: "1", content: null });
    const view = renderHook(() =>
      useCodingWorkbenchSafeActivity({
        runId: "run-1",
        runState: "running",
        runtimeEventSignal: 0,
      }),
    );
    await settleConnection();
    expect(view.result.current.status).toBe("unavailable");
    await act(async () => vi.advanceTimersByTimeAsync(CODING_SAFE_ACTIVITY_RECONNECT_RESET_MS));
    expect(getSnapshotMock).toHaveBeenCalledTimes(1);

    getSnapshotMock.mockResolvedValue(snapshot());
    const finished = renderHook(() =>
      useCodingWorkbenchSafeActivity({
        runId: "run-2",
        runState: "succeeded",
        runtimeEventSignal: 0,
      }),
    );
    await settleConnection();
    expect(finished.result.current.status).toBe("ended");
    await act(async () => vi.advanceTimersByTimeAsync(CODING_SAFE_ACTIVITY_RECONNECT_RESET_MS));
    expect(getSnapshotMock).toHaveBeenCalledTimes(2);
  });
});
