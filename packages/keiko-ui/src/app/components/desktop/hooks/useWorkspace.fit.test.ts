import { describe, expect, it, vi } from "vitest";
import {
  applyContentWheelZoom,
  applyWheelZoomToWindows,
  createWheelContentZoomQueue,
  fitWorkspaceViewToWindows,
  fitWindowToViewport,
  fitWindowsToViewport,
  normalizeWheelDelta,
  nextContentZoomFromWheel,
} from "./useWorkspace";
import {
  WINDOW_RECOVERY_TITLEBAR_HEIGHT_PX,
  WINDOW_RECOVERY_VISIBLE_WIDTH_PX,
} from "../windowRecovery";
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
    expect(next.x).toBe(vp.x + vp.w - WINDOW_RECOVERY_VISIBLE_WIDTH_PX);
    expect(next.y).toBe(win.y);
  });

  it("pulls a window stranded left of the viewport back into reach", () => {
    const win = appWindow({ x: -2000 });
    const next = fitWindowToViewport(win, vp);
    expect(next.x).toBe(vp.x - (win.w - WINDOW_RECOVERY_VISIBLE_WIDTH_PX));
  });

  it("clamps the title bar back above the bottom edge", () => {
    const win = appWindow({ y: 1500 });
    const next = fitWindowToViewport(win, vp);
    expect(next.y).toBe(vp.y + vp.h - WINDOW_RECOVERY_TITLEBAR_HEIGHT_PX);
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
    const panned: ViewportWorld = { x: 300, y: 200, w: 600, h: 500 };
    const win = appWindow({ x: -1000, y: 0 });
    const next = fitWindowToViewport(win, panned);
    expect(next.x).toBe(panned.x - (win.w - WINDOW_RECOVERY_VISIBLE_WIDTH_PX));
    expect(next.y).toBe(panned.y);
  });

  it("keeps compact viewport clamping per-window instead of collapsing every window to one point", () => {
    const compact: ViewportWorld = { x: 100, y: 50, w: 300, h: 360 };
    const left = fitWindowToViewport(appWindow({ id: "left", x: -400, y: 40 }), compact);
    const right = fitWindowToViewport(appWindow({ id: "right", x: 900, y: 900 }), compact);

    expect(left).toMatchObject({ x: -400, y: compact.y });
    expect(right).toMatchObject({
      x: 280,
      y: compact.y + compact.h - WINDOW_RECOVERY_TITLEBAR_HEIGHT_PX,
    });
    expect(left.x).not.toBe(right.x);
    expect(left.y).not.toBe(right.y);
  });
});

describe("fitWindowsToViewport — array-identity preservation (GEN-PERF-WORKSPACE-001)", () => {
  it("returns the SAME array when no window changed (no-op resize)", () => {
    const wins = [appWindow({ id: "a", x: 100, y: 100 }), appWindow({ id: "b", x: 200, y: 120 })];
    // All windows already fit vp → every element identity is preserved → the whole
    // array reference must be preserved so React bails the state update (no re-render,
    // no persist chain, no server PUT for a no-op viewport resize).
    expect(fitWindowsToViewport(wins, vp)).toBe(wins);
  });

  it("returns a NEW array (and moves the stranded window) when a window changes", () => {
    const stranded = appWindow({ id: "stranded", x: 5000, y: 100 });
    const fine = appWindow({ id: "fine", x: 100, y: 100 });
    const wins = [stranded, fine];
    const next = fitWindowsToViewport(wins, vp);
    expect(next).not.toBe(wins);
    // The unchanged window keeps its identity; only the stranded one is a new object.
    expect(next.find((w) => w.id === "fine")).toBe(fine);
    expect(next.find((w) => w.id === "stranded")).not.toBe(stranded);
    expect(next.find((w) => w.id === "stranded")?.x).toBe(
      vp.x + vp.w - WINDOW_RECOVERY_VISIBLE_WIDTH_PX,
    );
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

  // Issue #2402 — applyWheelZoomToWindows replaces the targeted window's slot
  // with a new object, but every other window in the array must stay the SAME
  // object it already was. WindowFrame is memoized per window; a sibling that
  // gets a fresh object identity on every wheel tick of a NEIGHBORING window's
  // content zoom would re-render for no reason, exactly the per-event cost
  // #2402 exists to remove.
  it("replaces only the targeted window's object and preserves every sibling's identity", () => {
    const target = appWindow({ id: "target", zoom: 1 });
    const siblingA = appWindow({ id: "sibling-a", zoom: 1 });
    const siblingB = appWindow({ id: "sibling-b", zoom: 1 });
    const wins = [siblingA, target, siblingB];

    const next = applyWheelZoomToWindows(wins, "target", [-100]);

    expect(next).not.toBe(wins);
    expect(next?.find((w) => w.id === "sibling-a")).toBe(siblingA);
    expect(next?.find((w) => w.id === "sibling-b")).toBe(siblingB);
    const nextTarget = next?.find((w) => w.id === "target");
    expect(nextTarget).not.toBe(target);
    expect(nextTarget?.zoom).toBe(1.2);
  });

  it("returns the SAME array when the replayed deltas snap back to the same zoom", () => {
    const target = appWindow({ id: "target", zoom: 1 });
    const sibling = appWindow({ id: "sibling", zoom: 1 });
    const wins = [target, sibling];

    // deltaY 0 -> exp(0) = 1: the snapped zoom cannot move.
    const next = applyWheelZoomToWindows(wins, "target", [0]);

    expect(next).toBe(wins);
  });

  it("returns the SAME array when a multi-delta batch ends back at its starting zoom", () => {
    // A batch that moves the zoom and returns to where it started has no net
    // effect, so it must not flip the array identity either — that identity is
    // what drives the downstream render, persistence, connection-prune and
    // selection-normalization work #2402 exists to avoid. The clamp-boundary
    // case has exactly this shape: from 1.9, exp(0.45) overshoots the 2.0 cap
    // and pins there, then exp(-0.06) eases to ~1.8835, which the 0.1 snap
    // rounds back to 1.9 — the same value the batch started from. The expected
    // value is stated here rather than recomputed with the production helper,
    // which would make the assertion its own oracle.
    const target = appWindow({ id: "target", zoom: 1.9 });
    const wins = [target, appWindow({ id: "sibling", zoom: 1 })];

    const next = applyWheelZoomToWindows(wins, "target", [-300, 40]);

    expect(next).toBe(wins);
    expect(next?.find((win) => win.id === "target")?.zoom).toBe(1.9);
  });

  it("returns the SAME array unchanged when the targeted window id is not present", () => {
    const wins = [appWindow({ id: "only" })];

    const next = applyWheelZoomToWindows(wins, "missing", [-100]);

    expect(next).toBe(wins);
  });

  it("returns null unchanged when there is no windows array yet", () => {
    expect(applyWheelZoomToWindows(null, "any", [-100])).toBeNull();
  });

  // Reviewer finding on PR #3305 — the array-boundary case, direct: `ws.findIndex` on an empty
  // array is always -1, so `current` is `undefined` and the existing
  // `if (current === undefined) return ws;` guard already returns the SAME (empty) reference
  // untouched — the same guard the "id not present" case above exercises, just at length 0.
  it("returns the SAME array unchanged when the windows array is empty", () => {
    const wins: AppWindow[] = [];

    const next = applyWheelZoomToWindows(wins, "any", [-100]);

    expect(next).toBe(wins);
  });

  // Reviewer finding on PR #3305 — a hostile/malformed wheel delta must never let a window's zoom
  // become a non-finite number. nextContentZoomFromWheel's clampContentZoom resolves a
  // non-finite-but-not-NaN operand (±Infinity) to the nearer bound, because Math.exp saturates to
  // 0 or +Infinity first and Math.max/Math.min then clamp that finite-vs-infinite comparison
  // normally.
  it("clamps an Infinity or -Infinity content-zoom delta to a finite, in-range zoom", () => {
    const wins = [appWindow({ id: "target", zoom: 1 })];

    const fromPlusInfinity = applyWheelZoomToWindows(wins, "target", [Infinity]);
    const fromMinusInfinity = applyWheelZoomToWindows(wins, "target", [-Infinity]);
    const plusZoom = fromPlusInfinity?.find((w) => w.id === "target")?.zoom ?? Number.NaN;
    const minusZoom = fromMinusInfinity?.find((w) => w.id === "target")?.zoom ?? Number.NaN;

    expect(Number.isFinite(plusZoom)).toBe(true);
    expect(Number.isFinite(minusZoom)).toBe(true);
    // exp(-Infinity * 0.0015) underflows to 0, snapping to the CONTENT_MIN_ZOOM floor.
    expect(plusZoom).toBe(0.5);
    // exp(Infinity * 0.0015) overflows to Infinity, snapping to the CONTENT_MAX_ZOOM ceiling.
    expect(minusZoom).toBe(2);
  });

  // Unlike ±Infinity above, Math.max/Math.min propagate NaN instead of clamping it — a NaN
  // operand makes both return NaN (`Math.min(2, NaN) === NaN`), so without a dedicated guard
  // clampContentZoom's `Math.max(CONTENT_MIN_ZOOM, Math.min(CONTENT_MAX_ZOOM, ...))` would come
  // out the other end still NaN instead of landing on either bound. clampContentZoom's
  // `if (Number.isNaN(z)) return 1;` short-circuits before that chain for exactly this reason.
  it("never lets a NaN content-zoom delta produce a non-finite window zoom", () => {
    const wins = [appWindow({ id: "target", zoom: 1 })];

    const next = applyWheelZoomToWindows(wins, "target", [NaN]);
    const zoom = next?.find((w) => w.id === "target")?.zoom ?? Number.NaN;

    expect(Number.isFinite(zoom)).toBe(true);
  });
});

// Reviewer finding on PR #3305 — an unmount mid-gesture must not let a QUEUED (not yet flushed)
// content-zoom frame commit later. createWheelContentZoomQueue is exported specifically so this
// can pin the frame-cancellation bookkeeping directly, without wiring a DOM/wheel-event harness
// (useWorkspace.wheel.test.tsx pins the same guarantee end-to-end through the real onWheel
// listener).
describe("createWheelContentZoomQueue frame cancellation", () => {
  function mockAnimationFrames(): {
    readonly callbacks: FrameRequestCallback[];
    readonly cancelSpy: ReturnType<typeof vi.spyOn>;
  } {
    const callbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(
      (callback: FrameRequestCallback): number => {
        callbacks.push(callback);
        return callbacks.length;
      },
    );
    const cancelSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    return { callbacks, cancelSpy };
  }

  it("cancels its scheduled frame on cancel() so a stale callback can no longer commit", () => {
    const { callbacks, cancelSpy } = mockAnimationFrames();
    const applied: Array<{ windowId: string; deltas: readonly number[] }> = [];
    const queue = createWheelContentZoomQueue((windowId, deltas) => {
      applied.push({ windowId, deltas });
    });

    queue.queue("target", -100);
    expect(callbacks).toHaveLength(1);

    queue.cancel();

    expect(cancelSpy).toHaveBeenCalledWith(1);
    // This mock's cancelAnimationFrame is a no-op (unlike a real browser's), so invoking the
    // captured callback simulates a frame that fired despite the cancel request. cancel() already
    // cleared pendingWindowId/pendingDeltas, so flush() must see nothing pending and never call
    // `apply` — the queue is inert, not merely "asked the browser nicely".
    callbacks[0]?.(0);
    expect(applied).toEqual([]);

    vi.restoreAllMocks();
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
    const view = fitWorkspaceViewToWindows([appWindow({ x: 0, y: 0, w: 2000, h: 1000 })], {
      width: 1000,
      height: 800,
    });

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

  // Issue #2723 — DOM_DELTA_PAGE (deltaMode 2), the third of wheelDeltaMultiplier's three cases.
  it("normalizes page-based wheel events to stable pixel deltas", () => {
    const event = new WheelEvent("wheel", { deltaX: 1, deltaY: 2, deltaMode: 2 });

    expect(normalizeWheelDelta(event)).toEqual({ x: 800, y: 1600 });
  });
});
