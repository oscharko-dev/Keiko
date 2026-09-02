import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWindowStageEvidence } from "./useWindowStageEvidence";

const reportClientDiagnostic = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic }));

describe("useWindowStageEvidence", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("reports the stage start on mount and its settlement, with the elapsed time, on unmount", () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => {
      useWindowStageEvidence("chat bind");
    });

    expect(reportClientDiagnostic).toHaveBeenCalledTimes(1);
    expect(reportClientDiagnostic).toHaveBeenLastCalledWith("desktop chat bind: started");

    vi.advanceTimersByTime(1250);
    unmount();

    expect(reportClientDiagnostic).toHaveBeenCalledTimes(2);
    expect(reportClientDiagnostic).toHaveBeenLastCalledWith(
      "desktop chat bind: settled after 1250ms",
    );
  });

  // A stall is reconstructed from a `started` line with no `settled` line: the hook must not settle a
  // stage that is merely re-rendered, or the evidence would read as a fast bind that never was.
  it("does not settle a stage that is still mounted", () => {
    const { rerender } = renderHook(() => {
      useWindowStageEvidence("window chunk");
    });

    rerender();
    rerender();

    expect(reportClientDiagnostic).toHaveBeenCalledTimes(1);
    expect(reportClientDiagnostic).toHaveBeenLastCalledWith("desktop window chunk: started");
  });
});
