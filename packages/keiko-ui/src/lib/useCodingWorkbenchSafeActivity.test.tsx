import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingAppSessionChannelSnapshot } from "@oscharko-dev/keiko-contracts";

import { useCodingWorkbenchSafeActivity } from "./useCodingWorkbenchSafeActivity";

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

function snapshot(droppedEventCount = 0): CodingAppSessionChannelSnapshot {
  return {
    schemaVersion: "1",
    content: {
      kind: "safe-activity",
      feed: {
        schemaVersion: "1",
        availability: "available",
        runId: "run-1",
        updatedAt: AT,
        turns: [],
        truncated: false,
        droppedEventCount,
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

  it("coalesces a burst of stream snapshots to the latest bounded projection", async () => {
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
        runState: "running",
        runtimeEventSignal: 0,
      }),
    );
    await waitFor(() => expect(view.result.current.status).toBe("live"));

    act(() => {
      publish?.(snapshot(1));
      publish?.(snapshot(2));
      publish?.(snapshot(3));
    });
    await waitFor(() => expect(view.result.current.feed?.droppedEventCount).toBe(3));
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
});
