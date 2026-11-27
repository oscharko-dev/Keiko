import { describe, expect, it } from "vitest";
import type { AppWindow } from "../windows/types";
import { WIN_TYPES } from "../windows/WindowsRegistry";
import { applyDisplayFits, computeDisplayFits } from "./workspaceWindowSizing";

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

  it("shows the original frame again on a larger screen", () => {
    const stored = chat();
    const larger = { x: 0, y: 0, w: 1800, h: 1100 };
    expect(applyDisplayFits([stored], computeDisplayFits([stored], larger, 1))[0]).toBe(stored);
  });
});
