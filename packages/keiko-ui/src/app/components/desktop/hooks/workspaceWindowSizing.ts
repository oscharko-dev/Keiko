"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { WIN_TYPES } from "../windows/WindowsRegistry";
import type { AppWindow, SnapPrev } from "../windows/types";
import { fitInitialWindowSize } from "./workspaceActions";
import type { ViewportWorld } from "./useWorkspace.types";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";

export interface AutomaticWindowSizing {
  readonly geometries: RefObject<Map<string, SnapPrev>>;
  readonly remember: (window: AppWindow) => void;
  readonly retire: () => void;
}

function geometryOf(window: AppWindow): SnapPrev {
  const { x, y, w, h } = window;
  return { x, y, w, h };
}

function sameGeometry(window: AppWindow, previous: SnapPrev): boolean {
  return (
    window.x === previous.x &&
    window.y === previous.y &&
    window.w === previous.w &&
    window.h === previous.h
  );
}

function retainsAutomaticGeometry(window: AppWindow, previous: SnapPrev): boolean {
  return !window.max && window.minimized !== true && sameGeometry(window, previous);
}

/** Only this session's new local frames remain automatic until a human changes their geometry. */
export function useAutomaticWindowSizing(
  windows: readonly AppWindow[] | null,
): AutomaticWindowSizing {
  const geometries = useRef(new Map<string, SnapPrev>());
  const remember = useCallback((window: AppWindow): void => {
    geometries.current.set(window.id, geometryOf(window));
  }, []);
  const retire = useCallback((): void => {
    if (geometries.current.size === 0) return;
    geometries.current.clear();
    reportClientDiagnostic("Workspace automatic sizing retired for restored layout.", {
      composerActivity: "workspace-window-sizing-retired",
    });
  }, []);
  useEffect(() => {
    const current = new Map(windows?.map((window) => [window.id, window]));
    for (const [id, previous] of geometries.current) {
      const window = current.get(id);
      if (window === undefined || !retainsAutomaticGeometry(window, previous))
        geometries.current.delete(id);
    }
  }, [windows]);
  return useMemo(() => ({ geometries, remember, retire }), [remember, retire]);
}

/** Saved, synchronized and manually sized frames retain the ordinary canvas recovery contract. */
export function fitAutomaticWindow(
  window: AppWindow,
  viewport: ViewportWorld,
  geometries: Map<string, SnapPrev>,
): AppWindow | undefined {
  const previous = geometries.get(window.id);
  if (previous === undefined) return undefined;
  if (!retainsAutomaticGeometry(window, previous)) {
    geometries.delete(window.id);
    return undefined;
  }
  const size = fitInitialWindowSize({ ...window, min: WIN_TYPES[window.type].min }, viewport);
  const fitted = {
    ...window,
    ...size,
    x: viewport.x + Math.max(16, Math.min(window.x - viewport.x, viewport.w - size.w - 16)),
    y: viewport.y + Math.max(16, Math.min(window.y - viewport.y, viewport.h - size.h - 16)),
  };
  if (sameGeometry(fitted, previous)) return window;
  if (fitted.w === window.w && fitted.h === window.h) {
    reportClientDiagnostic("Workspace window position fitted to available space.", {
      composerActivity: "workspace-viewport-fitted",
    });
  }
  geometries.set(window.id, geometryOf(fitted));
  return fitted;
}

/** A display-only frame for a stored window, valid while the stored frame is unchanged. */
export interface DisplayFit {
  readonly from: SnapPrev;
  readonly to: SnapPrev;
}

function overlapsViewport(window: AppWindow, vp: ViewportWorld): boolean {
  return (
    window.x < vp.x + vp.w &&
    window.x + window.w > vp.x &&
    window.y < vp.y + vp.h &&
    window.y + window.h > vp.y
  );
}

/**
 * Fits one floating window vertically into the visible workspace (the viewport already ends above
 * the dock): move it up first, then shrink it, never below its type's minimum height.
 */
function fitWindowVertically(window: AppWindow, vp: ViewportWorld): SnapPrev | undefined {
  const overflow = window.y + window.h - (vp.y + vp.h);
  if (overflow <= 0) return undefined;
  const minH = WIN_TYPES[window.type].min.h;
  const h = window.h <= vp.h ? window.h : Math.max(minH, vp.h);
  const y = Math.max(vp.y, Math.min(window.y, vp.y + vp.h - h));
  return { x: window.x, y, w: window.w, h };
}

/**
 * Computes display-only frames for restored windows that overflow the visible workspace. Stored
 * frames are never rewritten, so a later, larger screen shows the original geometry again.
 * Maximized and minimized windows, windows off screen, and zoomed-in views are left alone.
 */
export function computeDisplayFits(
  windows: readonly AppWindow[],
  vp: ViewportWorld,
  zoom: number,
): ReadonlyMap<string, DisplayFit> {
  const fits = new Map<string, DisplayFit>();
  if (zoom > 1 || vp.w <= 0 || vp.h <= 0) return fits;
  for (const window of windows) {
    if (window.max || window.minimized === true || !overlapsViewport(window, vp)) continue;
    const to = fitWindowVertically(window, vp);
    if (to !== undefined) fits.set(window.id, { from: geometryOf(window), to });
  }
  return fits;
}

/**
 * Applies fits whose stored frame is still current. A window the person only moved keeps the fitted
 * size at its new position (a drag stores x/y alone, so dropping the size would grow it back below
 * the visible area); one the person resized is shown as stored.
 */
export function applyDisplayFits(
  windows: readonly AppWindow[],
  fits: ReadonlyMap<string, DisplayFit>,
): readonly AppWindow[] {
  if (fits.size === 0) return windows;
  let changed = false;
  const next = windows.map((window) => {
    const fit = fits.get(window.id);
    if (fit === undefined) return window;
    if (!sameGeometry(window, fit.from)) {
      if (window.w !== fit.from.w || window.h !== fit.from.h) return window;
      changed = true;
      return { ...window, w: fit.to.w, h: fit.to.h };
    }
    changed = true;
    return { ...window, ...fit.to };
  });
  return changed ? next : windows;
}

function isHiddenWindow(window: AppWindow): boolean {
  return window.max || window.minimized === true;
}

function worldViewport(
  size: { readonly w: number; readonly h: number },
  view: { readonly x: number; readonly y: number; readonly zoom: number },
): ViewportWorld {
  return {
    x: -view.x / view.zoom,
    y: -view.y / view.zoom,
    w: size.w / view.zoom,
    h: size.h / view.zoom,
  };
}

function mergeFits(
  current: ReadonlyMap<string, DisplayFit>,
  ids: readonly string[],
  next: ReadonlyMap<string, DisplayFit>,
): ReadonlyMap<string, DisplayFit> {
  const merged = new Map(current);
  for (const id of ids) merged.delete(id);
  for (const [id, fit] of next) merged.set(id, fit);
  return merged;
}

function useObservedSize(wsRef: RefObject<HTMLElement | null>): {
  readonly w: number;
  readonly h: number;
} {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = wsRef.current;
    if (el === null || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      setSize((prev) =>
        prev.w === rect.width && prev.h === rect.height ? prev : { w: rect.width, h: rect.height },
      );
    });
    observer.observe(el);
    return (): void => {
      observer.disconnect();
    };
  }, [wsRef]);
  return size;
}

/**
 * Display fits are computed only at three moments: layout restore, workspace resize (every
 * window), and when a window reappears (un-minimized or un-maximized, that window only). Pan and
 * zoom never recompute them, so a window the person deliberately panned below the fold stays put.
 */
export function useDisplayFittedWindows(
  wsRef: RefObject<HTMLElement | null>,
  windows: readonly AppWindow[] | null,
  view: { readonly x: number; readonly y: number; readonly zoom: number },
): readonly AppWindow[] | null {
  const [fits, setFits] = useState<ReadonlyMap<string, DisplayFit>>(new Map());
  const size = useObservedSize(wsRef);
  const latest = useRef({ windows, view, size });
  latest.current = { windows, view, size };
  const hidden = useRef(new Map<string, boolean>());
  const restored = windows !== null;
  useEffect(() => {
    const { windows: current, view: v } = latest.current;
    if (current === null || size.w <= 0 || size.h <= 0) return;
    setFits(computeDisplayFits(current, worldViewport(size, v), v.zoom));
  }, [size, restored]);
  useEffect(() => {
    if (windows === null) return;
    const previous = hidden.current;
    hidden.current = new Map(windows.map((w) => [w.id, isHiddenWindow(w)]));
    const reappeared = windows.filter((w) => previous.get(w.id) === true && !isHiddenWindow(w));
    const { size: s, view: v } = latest.current;
    if (reappeared.length === 0 || s.w <= 0 || s.h <= 0) return;
    const next = computeDisplayFits(reappeared, worldViewport(s, v), v.zoom);
    setFits((current) =>
      mergeFits(
        current,
        reappeared.map((w) => w.id),
        next,
      ),
    );
  }, [windows]);
  return useMemo(
    () => (windows === null ? null : applyDisplayFits(windows, fits)),
    [windows, fits],
  );
}
