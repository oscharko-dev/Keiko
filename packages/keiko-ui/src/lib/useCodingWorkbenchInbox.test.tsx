import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CodingWorkbenchRuntimeInboxChannelPayload,
  CodingWorkbenchRuntimeInboxItem,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";

import {
  CODING_WORKBENCH_INBOX_REFRESH_DEBOUNCE_MS,
  useCodingWorkbenchInbox,
  type UseCodingWorkbenchInboxInput,
} from "./useCodingWorkbenchInbox";

const fetchInboxMock = vi.hoisted(() => vi.fn());
const pairingSettledMock = vi.hoisted(() => vi.fn());

vi.mock("./coding-app-session-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./coding-app-session-client")>()),
  codingAppSessionPairingSettled: pairingSettledMock,
}));

vi.mock("./coding-workbench-runtime-api", () => ({
  fetchCodingWorkbenchRuntimeInbox: fetchInboxMock,
}));

const FIRST: CodingWorkbenchRuntimeInboxItem = {
  itemId: "msg_16b08469d001DaT0xxHG2PAKe6",
  delivery: "steer",
  preview: "Use the new logger",
};
const SECOND: CodingWorkbenchRuntimeInboxItem = {
  itemId: "msg_16b08469d002DaT0xxHG2PAKe6",
  delivery: "queue",
  preview: "Then update the docs",
};

const LIVE: UseCodingWorkbenchInboxInput = {
  runId: "run-1",
  live: true,
  revision: 4,
  deliveredSignal: 1,
};

function active(
  items: readonly CodingWorkbenchRuntimeInboxItem[] | undefined = [FIRST, SECOND],
): CodingWorkbenchRuntimeInboxChannelPayload {
  return { session: "active", items };
}

async function elapse(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(CODING_WORKBENCH_INBOX_REFRESH_DEBOUNCE_MS);
  });
}

describe("useCodingWorkbenchInbox", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pairingSettledMock.mockResolvedValue(undefined);
    fetchInboxMock.mockResolvedValue(active());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("shows the waiting messages of a running turn, in the server's order, once the debounced read answers", async () => {
    const { result } = renderHook(() => useCodingWorkbenchInbox(LIVE));
    expect(result.current).toMatchObject({ status: "loading", items: [] });

    await elapse();

    expect(result.current).toMatchObject({ status: "ready", items: [FIRST, SECOND] });
    expect(fetchInboxMock).toHaveBeenCalledExactlyOnceWith("run-1", {
      signal: expect.any(AbortSignal) as unknown,
    });
  });

  it("reads nothing, and shows nothing, for a run that is not running or not known", async () => {
    for (const input of [
      { ...LIVE, live: false },
      { ...LIVE, runId: undefined },
    ]) {
      const { result } = renderHook(() => useCodingWorkbenchInbox(input));
      await elapse();
      expect(result.current).toMatchObject({ status: "idle", items: [] });
    }
    expect(fetchInboxMock).not.toHaveBeenCalled();
  });

  it("reads again when the revision moves, which is how a cancel or Send now shows up", async () => {
    const { result, rerender } = renderHook(
      (input: UseCodingWorkbenchInboxInput) => useCodingWorkbenchInbox(input),
      { initialProps: LIVE },
    );
    await elapse();
    expect(result.current.items).toEqual([FIRST, SECOND]);

    fetchInboxMock.mockResolvedValue(active([{ ...SECOND, delivery: "steer" }]));
    rerender({ ...LIVE, revision: 5 });
    await elapse();

    expect(result.current.items).toEqual([{ ...SECOND, delivery: "steer" }]);
    expect(fetchInboxMock).toHaveBeenCalledTimes(2);
  });

  it("reads again when the turn takes a waiting message, without polling", async () => {
    const { result, rerender } = renderHook(
      (input: UseCodingWorkbenchInboxInput) => useCodingWorkbenchInbox(input),
      { initialProps: LIVE },
    );
    await elapse();

    fetchInboxMock.mockResolvedValue(active([SECOND]));
    rerender({ ...LIVE, deliveredSignal: 2 });
    await elapse();
    expect(result.current.items).toEqual([SECOND]);

    // Time alone triggers nothing: no read follows without a new signal.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchInboxMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the rows of the last read while the next one is in flight, so a refresh does not flicker", async () => {
    const { result, rerender } = renderHook(
      (input: UseCodingWorkbenchInboxInput) => useCodingWorkbenchInbox(input),
      { initialProps: LIVE },
    );
    await elapse();

    fetchInboxMock.mockReturnValue(new Promise(() => undefined));
    rerender({ ...LIVE, revision: 5 });
    await elapse();

    expect(result.current).toMatchObject({ status: "ready", items: [FIRST, SECOND] });
  });

  it("coalesces a burst of revisions and delivered messages into one read", async () => {
    const { rerender } = renderHook(
      (input: UseCodingWorkbenchInboxInput) => useCodingWorkbenchInbox(input),
      { initialProps: LIVE },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CODING_WORKBENCH_INBOX_REFRESH_DEBOUNCE_MS - 50);
    });
    rerender({ ...LIVE, deliveredSignal: 2 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CODING_WORKBENCH_INBOX_REFRESH_DEBOUNCE_MS - 50);
    });
    rerender({ ...LIVE, deliveredSignal: 3, revision: 5 });
    await elapse();

    expect(fetchInboxMock).toHaveBeenCalledOnce();
  });

  it.each([
    ["a run that holds none", { session: "active" } as const],
    ["an empty list", { session: "active", items: [] } as const],
  ])("shows nothing waiting for %s", async (_name, payload) => {
    fetchInboxMock.mockResolvedValue(payload);
    const { result } = renderHook(() => useCodingWorkbenchInbox(LIVE));

    await elapse();

    expect(result.current).toMatchObject({ status: "ready", items: [] });
  });

  it("reports an unpaired window as a retryable error, never as an empty list", async () => {
    fetchInboxMock.mockResolvedValue({ session: "unpaired" });
    const { result } = renderHook(() => useCodingWorkbenchInbox(LIVE));

    await elapse();

    expect(result.current).toMatchObject({ status: "error", items: [] });
  });

  it("reports a failed read as a retryable error with a body-free diagnostic, and reads again on retry", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchInboxMock.mockRejectedValueOnce(new Error("private failure text"));
    const { result } = renderHook(() => useCodingWorkbenchInbox(LIVE));

    await elapse();

    expect(result.current).toMatchObject({ status: "error", items: [] });
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain("inbox channel read failed");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private failure text");

    act(() => {
      result.current.retry();
    });
    await elapse();

    expect(result.current).toMatchObject({ status: "ready", items: [FIRST, SECOND] });
    expect(fetchInboxMock).toHaveBeenCalledTimes(2);
  });

  it("never shows another run's messages, nor those of a run that stopped running", async () => {
    const { result, rerender } = renderHook(
      (input: UseCodingWorkbenchInboxInput) => useCodingWorkbenchInbox(input),
      { initialProps: LIVE },
    );
    await elapse();
    expect(result.current.items).toEqual([FIRST, SECOND]);

    fetchInboxMock.mockReturnValue(new Promise(() => undefined));
    rerender({ ...LIVE, runId: "run-2", revision: 1 });
    expect(result.current).toMatchObject({ status: "loading", items: [] });

    rerender({ ...LIVE, runId: "run-2", live: false, revision: 2 });
    expect(result.current).toMatchObject({ status: "idle", items: [] });
  });

  it("drops an answer that arrives after the run changed", async () => {
    let settle: ((payload: CodingWorkbenchRuntimeInboxChannelPayload) => void) | undefined;
    fetchInboxMock.mockReturnValueOnce(
      new Promise<CodingWorkbenchRuntimeInboxChannelPayload>((resolve) => {
        settle = resolve;
      }),
    );
    const { result, rerender } = renderHook(
      (input: UseCodingWorkbenchInboxInput) => useCodingWorkbenchInbox(input),
      { initialProps: LIVE },
    );
    await elapse();
    rerender({ ...LIVE, runId: "run-2" });
    await act(async () => {
      settle?.(active([{ ...FIRST, itemId: "msg_answer_of_the_old_run" }]));
      await Promise.resolve();
    });

    expect(result.current).toMatchObject({ status: "loading", items: [] });
  });
});
