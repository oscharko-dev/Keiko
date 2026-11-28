import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppWindow } from "../windows/types";
import { WIN_TYPES } from "../windows/WindowsRegistry";
import {
  applyDisplayFits,
  computeDisplayFits,
  useDisplayFittedWindows,
} from "./workspaceWindowSizing";

// A 1400x824 visible workspace (the viewport already ends above the 76px dock).
const vp = { x: 0, y: 0, w: 1400, h: 824 };

function chat(patch: Partial<AppWindow> = {}): AppWindow {
  return {
    id: "chat-1",
    type: "chat",
    x: 40,
    y: 24,
    w: 600,
    h: 820,
    z: 1,
    cfg: {},
    max: false,
    ...patch,
  };
}

describe("display fits for restored window frames", () => {
  it("moves a window that overflows the bottom up, without changing its size", () => {
    const fits = computeDisplayFits([chat({ y: 300, h: 700 })], vp, 1);
    expect(fits.get("chat-1")?.to).toMatchObject({ y: 124, h: 700 });
  });

  it("shrinks a window taller than the workspace, never below the type minimum", () => {
    const tall = chat({ h: 900 });
    const [shown] = applyDisplayFits([tall], computeDisplayFits([tall], vp, 1));
    expect(shown?.y).toBe(0);
    expect(shown?.h).toBe(824);
    const tiny = { x: 0, y: 0, w: 1400, h: 100 };
    const [small] = applyDisplayFits([tall], computeDisplayFits([tall], tiny, 1));
    expect(small?.h).toBe(WIN_TYPES.chat.min.h);
  });

  it("leaves maximized, minimized, off-screen, fitting and zoomed-in windows alone", () => {
    const wins = [
      chat({ id: "a", max: true }),
      chat({ id: "b", minimized: true }),
      chat({ id: "c", y: 5000 }),
      chat({ id: "d", y: 0, h: 500 }),
    ];
    expect(computeDisplayFits(wins, vp, 1).size).toBe(0);
    expect(computeDisplayFits([chat()], vp, 2).size).toBe(0);
  });

  it("never rewrites the stored window and drops the fit once the person moves it", () => {
    const stored = chat();
    const fits = computeDisplayFits([stored], vp, 1);
    expect(stored.h).toBe(820);
    expect(applyDisplayFits([stored], fits)[0]).toMatchObject({ y: 4, h: 820 });
    expect(applyDisplayFits([{ ...stored, x: 80 }], fits)[0]?.y).toBe(24);
  });

  // Review #4573 finding 35: a horizontal drag stores x/y only and must keep the fitted height.
  it("keeps the fitted size when the person only moves the window, and not after a resize", () => {
    const stored = chat({ h: 900 });
    const fits = computeDisplayFits([stored], vp, 1);
    const dragged = { ...stored, x: 45, y: 0 };
    expect(applyDisplayFits([dragged], fits)[0]).toMatchObject({ x: 45, y: 0, h: 824 });
    expect(applyDisplayFits([{ ...dragged, h: 700 }], fits)[0]?.h).toBe(700);
    expect(applyDisplayFits([{ ...dragged, w: 700 }], fits)[0]?.h).toBe(900);
  });

  it("shows the original frame again on a larger screen", () => {
    const stored = chat();
    const larger = { x: 0, y: 0, w: 1800, h: 1100 };
    expect(applyDisplayFits([stored], computeDisplayFits([stored], larger, 1))[0]).toBe(stored);
  });
});

describe("useDisplayFittedWindows", () => {
  let fireResize: () => void = () => undefined;
  let height = 824;

  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          fireResize = callback;
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    height = 824;
  });

  function render(initial: readonly AppWindow[] | null): {
    readonly result: { current: readonly AppWindow[] | null };
    readonly rerender: (wins: readonly AppWindow[] | null) => void;
  } {
    const el = document.createElement("div");
    el.getBoundingClientRect = (): DOMRect => ({ width: 1400, height }) as DOMRect;
    const wsRef = { current: el };
    const view = { x: 0, y: 0, zoom: 1 };
    const hook = renderHook(
      ({ wins }: { wins: readonly AppWindow[] | null }) =>
        useDisplayFittedWindows(wsRef, wins, view),
      { initialProps: { wins: initial } },
    );
    return { result: hook.result, rerender: (wins) => hook.rerender({ wins }) };
  }

  it("fits a restored overflowing window once the workspace is measured, then follows resize", () => {
    const stored = chat();
    const { result, rerender } = render(null);
    rerender([stored]);
    act(() => {
      fireResize();
    });
    expect(result.current?.[0]).toMatchObject({ y: 4, h: 820 });
    expect(stored.y).toBe(24);

    height = 1100;
    act(() => {
      fireResize();
    });
    expect(result.current?.[0]).toBe(stored);
  });

  it("fits a window again when it is un-minimized, but not a window the person left alone", () => {
    const panned = chat({ id: "panned", y: 700, h: 400 });
    const hidden = chat({ id: "hidden", minimized: true });
    const { result, rerender } = render([hidden]);
    act(() => {
      fireResize();
    });
    rerender([{ ...hidden, minimized: false }]);
    expect(result.current?.[0]).toMatchObject({ y: 4, h: 820 });
    // Windows that never reappear are not re-fitted by later list changes.
    rerender([{ ...hidden, minimized: false }, panned]);
    expect(result.current?.[1]).toBe(panned);
  });
});
