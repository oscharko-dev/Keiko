"use client";

import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
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
