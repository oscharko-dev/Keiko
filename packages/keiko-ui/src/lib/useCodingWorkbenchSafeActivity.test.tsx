import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingAppSessionChannelSnapshot } from "@oscharko-dev/keiko-contracts";

import {
  useCodingWorkbenchSafeActivity,
  type UseCodingWorkbenchSafeActivityInput,
} from "./useCodingWorkbenchSafeActivity";

const getSnapshotMock = vi.hoisted(() => vi.fn());
const streamSnapshotsMock = vi.hoisted(() => vi.fn());

vi.mock("./coding-app-session-client", () => ({
  codingAppSessionPairingSettled: () => Promise.resolve(true),
}));

vi.mock("./coding-app-session-channel-api", () => ({
  getCodingAppSessionChannelSnapshot: getSnapshotMock,
  streamCodingAppSessionChannelSnapshots: streamSnapshotsMock,
}));

const AT = "2026-07-19T12:00:00.000Z";

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
});
