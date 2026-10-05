import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchHealth, type HealthSnapshot } from "@/lib/api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { HEALTH_POLL_INTERVAL_MS, useBackendHealth } from "./useBackendHealth";

vi.mock("@/lib/api", () => ({ fetchHealth: vi.fn() }));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));
const fetch = vi.mocked(fetchHealth);
const ready: HealthSnapshot = { status: "ok", version: "1.2.3" };

beforeEach(() => {
  vi.useFakeTimers();
  fetch.mockResolvedValue(ready);
});
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("useBackendHealth", () => {
  it("keeps the same snapshot identity for unchanged successful and failed polls", async () => {
    const view = renderHook(useBackendHealth);
    await act(async () => await Promise.resolve());
    const loaded = view.result.current;
    fetch.mockResolvedValueOnce({ ...ready });
    await act(async () => await vi.advanceTimersByTimeAsync(HEALTH_POLL_INTERVAL_MS));
    expect(view.result.current).toBe(loaded);
    fetch.mockRejectedValue(new TypeError("offline"));
    await act(async () => await vi.advanceTimersByTimeAsync(HEALTH_POLL_INTERVAL_MS));
    const unavailable = view.result.current;
    await act(async () => await vi.advanceTimersByTimeAsync(HEALTH_POLL_INTERVAL_MS));
    expect(view.result.current).toBe(unavailable);
  });

  it("polls once per interval and clears the timer on unmount", async () => {
    const view = renderHook(useBackendHealth);
    await act(async () => await Promise.resolve());
    expect(view.result.current).toEqual({ state: "loaded", health: ready });
    await act(async () => await vi.advanceTimersByTimeAsync(HEALTH_POLL_INTERVAL_MS));
    expect(fetch).toHaveBeenCalledTimes(2);
    view.unmount();
    await vi.advanceTimersByTimeAsync(HEALTH_POLL_INTERVAL_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reports a failure once per streak and resumes after recovery", async () => {
    fetch.mockRejectedValue(new TypeError("private endpoint"));
    const view = renderHook(useBackendHealth);
    await act(async () => await Promise.resolve());
    await act(async () => await vi.advanceTimersByTimeAsync(HEALTH_POLL_INTERVAL_MS));
    expect(view.result.current).toEqual({ state: "unavailable" });
    expect(reportClientDiagnostic).toHaveBeenCalledOnce();
    expect(vi.mocked(reportClientDiagnostic).mock.calls[0]?.[0]).toBe(
      "[keiko] health read failed: TypeError",
    );
    expect(vi.mocked(reportClientDiagnostic).mock.calls[0]?.[0]).not.toContain("private endpoint");
    fetch.mockResolvedValueOnce(ready);
    await act(async () => await vi.advanceTimersByTimeAsync(HEALTH_POLL_INTERVAL_MS));
    expect(view.result.current).toEqual({ state: "loaded", health: ready });
    await act(async () => await vi.advanceTimersByTimeAsync(HEALTH_POLL_INTERVAL_MS));
    expect(reportClientDiagnostic).toHaveBeenCalledTimes(2);
  });

  it("does not publish a late failure after the workspace has unmounted", async () => {
    let rejectPending: ((error: unknown) => void) | undefined;
    fetch.mockReturnValueOnce(
      new Promise<HealthSnapshot>((_resolve, reject) => {
        rejectPending = reject;
      }),
    );
    const view = renderHook(useBackendHealth);
    view.unmount();
    await act(async () => {
      rejectPending?.(new TypeError("offline"));
      await Promise.resolve();
    });
    expect(reportClientDiagnostic).not.toHaveBeenCalled();
  });
});

it("reports invalid diagnostics once without discarding the installed version", async () => {
  fetch.mockResolvedValue({ ...ready, diagnosticsInvalid: true });
  const view = renderHook(useBackendHealth);
  await act(async () => await Promise.resolve());
  await act(async () => await vi.advanceTimersByTimeAsync(HEALTH_POLL_INTERVAL_MS));
  expect(view.result.current).toEqual({
    state: "loaded",
    health: { ...ready, diagnosticsInvalid: true },
  });
  expect(reportClientDiagnostic).toHaveBeenCalledExactlyOnceWith(
    "[keiko] health diagnostics invalid: TypeError",
    { errorKind: "validation-failed" },
  );
});

it("does not overlap health polls or allow an older response to replace a newer snapshot", async () => {
  let finish: ((value: HealthSnapshot) => void) | undefined;
  fetch.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = renderHook(useBackendHealth);
  await act(async () => await vi.advanceTimersByTimeAsync(HEALTH_POLL_INTERVAL_MS * 2));
  expect(fetch).toHaveBeenCalledOnce();
  await act(async () => finish?.(ready));
  await act(async () => await vi.advanceTimersByTimeAsync(HEALTH_POLL_INTERVAL_MS));
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(view.result.current).toEqual({ state: "loaded", health: ready });
});
