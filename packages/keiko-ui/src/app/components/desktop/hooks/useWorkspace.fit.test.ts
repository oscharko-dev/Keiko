import { describe, expect, it } from "vitest";
import {
  applyContentWheelZoom,
  fitWorkspaceViewToWindows,
  fitWindowToViewport,
  normalizeWheelDelta,
  nextContentZoomFromWheel,
} from "./useWorkspace";
import type { ViewportWorld } from "./useWorkspace.types";
import type { AppWindow } from "../windows/types";

function appWindow(patch: Partial<AppWindow>): AppWindow {
  return {
    id: "w1",
    type: "agents",
    x: 40,
    y: 40,
    w: 664,
    h: 420,
    z: 1,
    cfg: {},
    max: false,
    zoom: 1,
    ...patch,
  };
}

const vp: ViewportWorld = { x: 0, y: 0, w: 712, h: 900 };

describe("fitWindowToViewport — capture windows on viewport shrink (audit C132)", () => {
  it("pulls a window stranded right of the viewport back to a grabbable strip", () => {
    // Live repro: 1440->768 resize left a window at x=721 while main.right=712
    // (0 visible title-bar pixels). At least 120px must stay reachable.
    const win = appWindow({ x: 721 });
    const next = fitWindowToViewport(win, vp);
    expect(next.x).toBe(vp.x + vp.w - 120);
    expect(next.y).toBe(win.y);
  });

  it("pulls a window stranded left of the viewport back into reach", () => {
    const win = appWindow({ x: -2000 });
    const next = fitWindowToViewport(win, vp);
    expect(next.x).toBe(vp.x - (win.w - 120));
  });

  it("clamps the title bar back above the bottom edge", () => {
    const win = appWindow({ y: 1500 });
    const next = fitWindowToViewport(win, vp);
    expect(next.y).toBe(vp.y + vp.h - 38);
  });

  it("returns the same object when the window is already visible", () => {
    const win = appWindow({ x: 100, y: 100 });
    expect(fitWindowToViewport(win, vp)).toBe(win);
  });

  it("keeps maximized windows tracking the viewport exactly", () => {
    const win = appWindow({ max: true, x: 5, y: 5, w: 50, h: 50 });
    const next = fitWindowToViewport(win, vp);
    expect(next).toMatchObject({ x: vp.x, y: vp.y, w: vp.w, h: vp.h });
  });

  it("respects a panned/zoomed viewport origin", () => {
    const panned: ViewportWorld = { x: 300, y: 200, w: 600, h: 400 };
    const win = appWindow({ x: -1000, y: 0 });
    const next = fitWindowToViewport(win, panned);
    expect(next.x).toBe(panned.x - (win.w - 120));
    expect(next.y).toBe(panned.y);
  });
});

describe("content wheel zoom", () => {
  it("maps Command/Ctrl wheel deltas to the same clamped content zoom scale", () => {
    expect(nextContentZoomFromWheel(1, -100)).toBe(1.2);
    expect(nextContentZoomFromWheel(1, 100)).toBe(0.9);
    expect(nextContentZoomFromWheel(1.9, -1000)).toBe(2);
    expect(nextContentZoomFromWheel(0.6, 1000)).toBe(0.5);
  });

  it("updates only window content zoom and preserves frame geometry", () => {
    const win = appWindow({
      x: 123,
      y: 234,
      w: 456,
      h: 345,
      max: false,
      zoom: 1,
    });

    const next = applyContentWheelZoom(win, -100);

    expect(next).toMatchObject({
      id: win.id,
      type: win.type,
      x: win.x,
      y: win.y,
      w: win.w,
      h: win.h,
      max: win.max,
      zoom: 1.2,
    });
  });
});

describe("workspace view fitting", () => {
  it("centers a small visible window group at 100% zoom", () => {
    const view = fitWorkspaceViewToWindows(
      [
        appWindow({ id: "a", x: 0, y: 0, w: 100, h: 100 }),
        appWindow({ id: "b", x: 200, y: 100, w: 100, h: 100 }),
      ],
      { width: 1000, height: 800 },
    );

    expect(view).toEqual({ zoom: 1, x: 350, y: 300 });
  });

  it("zooms out and keeps large window groups inside padded workspace bounds", () => {
    const view = fitWorkspaceViewToWindows(
      [appWindow({ x: 0, y: 0, w: 2000, h: 1000 })],
      { width: 1000, height: 800 },
    );

    expect(view.zoom).toBeCloseTo(0.428, 3);
    expect(view.x).toBe(72);
    expect(view.y).toBe(186);
  });

  it("ignores minimized windows when fitting the workspace view", () => {
    const view = fitWorkspaceViewToWindows(
      [
        appWindow({ id: "visible", x: 0, y: 0, w: 100, h: 100 }),
        appWindow({ id: "minimized", minimized: true, x: 2000, y: 2000, w: 900, h: 900 }),
      ],
      { width: 1000, height: 800 },
    );

    expect(view).toEqual({ zoom: 1, x: 450, y: 350 });
  });

  it("falls back to the default view when no visible windows are present", () => {
    expect(
      fitWorkspaceViewToWindows([appWindow({ minimized: true })], { width: 1000, height: 800 }),
    ).toEqual({ zoom: 1, x: 0, y: 0 });
  });
});

describe("wheel delta normalization", () => {
  it("normalizes line-based wheel events to stable pixel deltas", () => {
    const event = new WheelEvent("wheel", { deltaX: 2, deltaY: 3, deltaMode: 1 });

    expect(normalizeWheelDelta(event)).toEqual({ x: 32, y: 48 });
  });
});
