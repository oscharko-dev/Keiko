// GEN-STAB-WINDOW-002 — bounded unhandled-rejection surfacing. Pins the three contract
// points: rejections are logged, the per-session cap stops a rejection storm from
// flooding the console, and unmount removes the listener.

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useUnhandledRejectionLog } from "./useUnhandledRejectionLog";

function dispatchRejection(reason: string): void {
  const event = new Event("unhandledrejection");
  Object.defineProperty(event, "reason", { value: reason });
  window.dispatchEvent(event);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useUnhandledRejectionLog", () => {
  it("logs an escaped rejection with the shell's console idiom", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const view = renderHook(() => {
      useUnhandledRejectionLog();
    });
    dispatchRejection("boom");
    // 0.3.0 audit (Qodo review on #2869): a rejection reason is uncontrolled content — it can carry
    // a token, a path, or anything the user typed — so only its TYPE travels, through the one client
    // diagnostic sink. The reason value itself is pinned as absent.
    expect(warnSpy).toHaveBeenCalledWith("[keiko] unhandled promise rejection: string");
    for (const call of warnSpy.mock.calls) {
      for (const argument of call) {
        expect(String(argument)).not.toContain("boom");
      }
    }
    view.unmount();
  });

  it("caps the log volume so a rejection storm cannot flood the console", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const view = renderHook(() => {
      useUnhandledRejectionLog();
    });
    for (let i = 0; i < 12; i += 1) dispatchRejection(`r${String(i)}`);
    expect(warnSpy).toHaveBeenCalledTimes(5);
    view.unmount();
  });

  it("removes the listener on unmount", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const view = renderHook(() => {
      useUnhandledRejectionLog();
    });
    view.unmount();
    dispatchRejection("after-unmount");
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
