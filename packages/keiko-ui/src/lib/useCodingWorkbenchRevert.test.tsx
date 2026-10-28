import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingWorkbenchRuntimeRevertChannelPayload } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";

import {
  CODING_WORKBENCH_REVERT_REFRESH_DEBOUNCE_MS,
  useCodingWorkbenchRevert,
  type UseCodingWorkbenchRevertInput,
} from "./useCodingWorkbenchRevert";

const getRevertStateMock = vi.hoisted(() => vi.fn());
const pairingSettledMock = vi.hoisted(() => vi.fn());

vi.mock("./coding-app-session-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./coding-app-session-client")>()),
  codingAppSessionPairingSettled: pairingSettledMock,
}));

vi.mock("./coding-workbench-runtime-api", () => ({
  getCodingWorkbenchRuntimeRevertState: getRevertStateMock,
}));

const STATE = { staged: false, fileCount: 2, additions: 12, deletions: 4 } as const;

const LIVE: UseCodingWorkbenchRevertInput = {
  runId: "run-1",
  live: true,
  revision: 4,
  changeSignal: null,
};

function active(
  revert: CodingWorkbenchRuntimeRevertChannelPayload["revert"] = STATE,
): CodingWorkbenchRuntimeRevertChannelPayload {
  return { session: "active", revert };
}

async function elapse(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(CODING_WORKBENCH_REVERT_REFRESH_DEBOUNCE_MS);
  });
}

describe("useCodingWorkbenchRevert", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pairingSettledMock.mockResolvedValue(undefined);
    getRevertStateMock.mockResolvedValue(active());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("shows the counts of a live run once the debounced read answers", async () => {
    const { result } = renderHook(() => useCodingWorkbenchRevert(LIVE));
    expect(result.current.revert).toBeNull();

    await elapse();

    expect(result.current.revert).toEqual(STATE);
    expect(getRevertStateMock).toHaveBeenCalledExactlyOnceWith("run-1", expect.any(AbortSignal));
  });

  it("reads nothing, and shows nothing, for a run that is not live or not known", async () => {
    for (const input of [
      { ...LIVE, live: false },
      { ...LIVE, runId: undefined },
    ]) {
      const { result } = renderHook(() => useCodingWorkbenchRevert(input));
      await elapse();
      expect(result.current.revert).toBeNull();
    }
    expect(getRevertStateMock).not.toHaveBeenCalled();
  });

  it("coalesces a burst of revisions and settled tools into one read", async () => {
    const { rerender } = renderHook(
      (input: UseCodingWorkbenchRevertInput) => useCodingWorkbenchRevert(input),
      { initialProps: LIVE },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CODING_WORKBENCH_REVERT_REFRESH_DEBOUNCE_MS - 50);
    });
    rerender({ ...LIVE, changeSignal: "a|1" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CODING_WORKBENCH_REVERT_REFRESH_DEBOUNCE_MS - 50);
    });
    rerender({ ...LIVE, changeSignal: "a|2", revision: 5 });
    await elapse();

    expect(getRevertStateMock).toHaveBeenCalledOnce();
  });

  it("reads again when the revision moves, which is how an undo or restore shows up", async () => {
    const { result, rerender } = renderHook(
      (input: UseCodingWorkbenchRevertInput) => useCodingWorkbenchRevert(input),
      { initialProps: LIVE },
    );
    await elapse();
    expect(result.current.revert).toEqual(STATE);

    getRevertStateMock.mockResolvedValue(active({ ...STATE, staged: true }));
    rerender({ ...LIVE, revision: 5 });
    await elapse();

    expect(result.current.revert).toEqual({ ...STATE, staged: true });
    expect(getRevertStateMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["an unpaired window", { session: "unpaired" } as const],
    ["a run that offers no undo", { session: "active" } as const],
  ])("shows no control for %s", async (_name, payload) => {
    getRevertStateMock.mockResolvedValue(payload);
    const { result } = renderHook(() => useCodingWorkbenchRevert(LIVE));

    await elapse();

    expect(result.current.revert).toBeNull();
  });

  it("shows no control and records a body-free diagnostic when the read fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    getRevertStateMock.mockRejectedValue(new Error("private failure text"));
    const { result } = renderHook(() => useCodingWorkbenchRevert(LIVE));

    await elapse();

    expect(result.current.revert).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain("revert channel refresh failed");
  });

  it("never shows another run's counts, nor those of a run that stopped being live", async () => {
    const { result, rerender } = renderHook(
      (input: UseCodingWorkbenchRevertInput) => useCodingWorkbenchRevert(input),
      { initialProps: LIVE },
    );
    await elapse();
    expect(result.current.revert).toEqual(STATE);

    getRevertStateMock.mockReturnValue(new Promise(() => undefined));
    rerender({ ...LIVE, runId: "run-2", revision: 1 });
    expect(result.current.revert).toBeNull();

    rerender({ ...LIVE, runId: "run-2", live: false, revision: 2 });
    expect(result.current.revert).toBeNull();
  });

  it("drops an answer that arrives after the run changed", async () => {
    let settle: ((payload: CodingWorkbenchRuntimeRevertChannelPayload) => void) | undefined;
    getRevertStateMock.mockReturnValueOnce(
      new Promise<CodingWorkbenchRuntimeRevertChannelPayload>((resolve) => {
        settle = resolve;
      }),
    );
    const { result, rerender } = renderHook(
      (input: UseCodingWorkbenchRevertInput) => useCodingWorkbenchRevert(input),
      { initialProps: LIVE },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CODING_WORKBENCH_REVERT_REFRESH_DEBOUNCE_MS);
    });
    rerender({ ...LIVE, runId: "run-2" });
    await act(async () => {
      settle?.(active({ ...STATE, fileCount: 9 }));
      await Promise.resolve();
    });

    expect(result.current.revert).toBeNull();
  });
});
