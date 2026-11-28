import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const activate = vi.hoisted(() => vi.fn());
const notify = vi.hoisted(() => vi.fn());
const report = vi.hoisted(() => vi.fn());

vi.mock("./api", () => ({ activateChatModelFromSurface: activate }));
vi.mock("@/app/components/desktop/widgets/shared/gatewaySetupBus", () => ({
  notifyGatewayModelReadinessUpdated: notify,
}));
vi.mock("./client-diagnostics", () => ({ reportClientDiagnostic: report }));

import { MODEL_ACTIVATION_DEADLINE_MS, useModelActivation } from "./useModelActivation";

// A POST whose answer never comes; it settles only when the caller's signal ends it.
function hangingRequest(
  _modelId: string,
  _surface: string,
  signal: AbortSignal | undefined,
): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

describe("useModelActivation deadline and cancellation (review #4573 finding 38)", () => {
  beforeEach((): void => {
    vi.useFakeTimers();
    activate.mockReset();
    notify.mockReset();
    report.mockReset();
  });
  afterEach((): void => {
    vi.useRealTimers();
  });

  it("ends a request that never answers at its deadline and re-reads the activation state", async (): Promise<void> => {
    activate.mockImplementation(hangingRequest);
    const { result } = renderHook(() => useModelActivation("coding-workbench"));
    act((): void => result.current.activate("model-a"));
    expect(result.current.state).toEqual({ status: "running", modelId: "model-a" });
    await act(async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(MODEL_ACTIVATION_DEADLINE_MS - 1);
    });
    expect(result.current.state.status).toBe("running");
    expect(notify).not.toHaveBeenCalled();
    await act(async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current.state).toEqual({
      status: "failed",
      modelId: "model-a",
      failure: "request-failed",
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("aborts the request when the window closes and still re-reads the activation state", async (): Promise<void> => {
    let signal: AbortSignal | undefined;
    activate.mockImplementation((id: string, surface: string, given: AbortSignal | undefined) => {
      signal = given;
      return hangingRequest(id, surface, given);
    });
    const { result, unmount } = renderHook(() => useModelActivation("coding-workbench"));
    act((): void => result.current.activate("model-a"));
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
    await act(async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("clears the deadline once the check answered", async (): Promise<void> => {
    activate.mockResolvedValue("passed");
    const { result } = renderHook(() => useModelActivation("coding-workbench"));
    act((): void => result.current.activate("model-a"));
    await act(async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.state).toEqual({ status: "idle" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
