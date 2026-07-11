"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DependencyList,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";
import type { SnapZone } from "../windows/connectionUtils";
import { WIN_TYPES } from "../windows/WindowsRegistry";
import type { AppWindow, Connection, ConnectingState, SnapPrev, View } from "../windows/types";
import { clampWorkspaceWindowOrigin } from "../windowRecovery";
import type { UseWorkspaceResult, ViewportWorld, WorkspaceApi } from "./useWorkspace.types";
import {
  parsePersistedConnections,
  parsePersistedWindows,
  sanitizePersistedConnections,
  sanitizePersistedWindows,
} from "./workspace-persistence";
import {
  WORKSPACE_CLIPBOARD_PASTE_OFFSET_PX,
  buildWorkspaceClipboardPayload,
  duplicateWorkspaceClipboardWindows,
} from "./workspaceClipboard";
import {
  boundConnectorScopeOf,
  connectorChatBind,
  boundScopeOf,
  filesChatBindScope,
  isWorkspaceWindowSelectable,
  makeConnectActions,
  makeLayoutActions,
  makeMutations,
  makeSnapActions,
  moveSelectedWorkspaceWindows,
  normalizeWorkspaceSelection,
  replaceWorkspaceSelection,
  toggleWorkspaceSelection,
} from "./workspaceActions";
import type { ChatConnectedScope, ChatLocalKnowledgeScope } from "@/lib/types";
import type { WorkspaceUiSelectionState } from "@oscharko-dev/keiko-contracts";

export type { AppWindow, Connection, ConnectingState, SnapPrev, View };
export type { SnapZone } from "../windows/connectionUtils";
export type { UseWorkspaceResult, ViewportWorld, WorkspaceApi };

const WS_LS = "keiko.workspace.v4";
const CONN_LS = "keiko.conns.v1";
const VIEW_LS = "keiko.view";
const WORKSPACE_STATE_API = "/api/workspace/state";
const WORKSPACE_STATE_POLL_MS = 1_500;
// Exported so the zoom controls in Workspace.tsx can disable themselves at the
// clamp limits instead of swallowing clicks silently (audit C132/C361).
export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 2.5;
const CONTENT_MIN_ZOOM = 0.5;
const CONTENT_MAX_ZOOM = 2;
const MIN_CAMERA_ANIMATION_DURATION_MS = 90;
const MAX_CAMERA_ANIMATION_DURATION_MS = 280;
const DIRECT_PAN_SMOOTHNESS_SCALE = 0;
// GEN-PERF-WORKSPACE-004 — how long after the last wheel/pan/zoom view commit the
// data-view-active gesture flag lingers before the wallpaper draw resumes.
const VIEW_ACTIVE_SETTLE_MS = 160;

// Persisted view input is hostile: zoom was clamped but x/y only finite-checked,
// so a tampered keiko.view with e.g. x: 1e300 hydrated a pan the user can never
// navigate back from (and fed absurd values into every world/pixel conversion).
// Clamp — not reject — so a slightly out-of-range value recovers usably.
const MAX_VIEW_PAN = 1_000_000;

function clampViewPan(value: number): number {
  return Math.max(-MAX_VIEW_PAN, Math.min(MAX_VIEW_PAN, value));
}

function readView(): View {
  if (typeof window === "undefined") return { zoom: 1, x: 0, y: 0 };
  try {
    const raw = window.localStorage.getItem(VIEW_LS);
    if (raw === null) return { zoom: 1, x: 0, y: 0 };
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "zoom" in parsed &&
      typeof (parsed as { zoom: unknown }).zoom === "number"
    ) {
      const p = parsed as { zoom: number; x?: number; y?: number };
      return {
        zoom: Number.isFinite(p.zoom) ? clampViewZoom(p.zoom) : 1,
        x: typeof p.x === "number" && Number.isFinite(p.x) ? clampViewPan(p.x) : 0,
        y: typeof p.y === "number" && Number.isFinite(p.y) ? clampViewPan(p.y) : 0,
      };
    }
  } catch {
    /* ignore */
  }
  return { zoom: 1, x: 0, y: 0 };
}

function clampViewZoom(z: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
}

function clampContentZoom(z: number): number {
  return Math.max(CONTENT_MIN_ZOOM, Math.min(CONTENT_MAX_ZOOM, Math.round(z * 10) / 10));
}

function isFormField(el: Element | null): boolean {
  if (el === null) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

function topZ(ws: readonly AppWindow[]): AppWindow | null {
  let best: AppWindow | null = null;
  for (let i = 0; i < ws.length; i++) {
    const next = ws[i] as AppWindow;
    if (next.minimized === true) continue;
    if (best === null) {
      best = next;
      continue;
    }
    if (next.z > best.z) best = next;
  }
  return best;
}

function persistList<T>(key: string, value: T): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

// Issue #1580 — persistence is debounced so a drag/resize/pan (which mutates wins
// or view every animation frame) no longer fires a synchronous localStorage write
// and a server PUT per frame. A short trailing delay coalesces a whole gesture into
// a single write; a pagehide/visibility-hidden flush guarantees the final state is
// never lost if the tab closes mid-gesture.
const PERSIST_DEBOUNCE_MS = 300;

interface TrailingDebounce {
  readonly schedule: (run: () => void) => void;
  readonly flush: () => void;
  readonly cancel: () => void;
}

function createTrailingDebounce(delayMs: number): TrailingDebounce {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: (() => void) | null = null;
  const flush = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const run = pending;
    pending = null;
    if (run !== null) run();
  };
  const schedule = (run: () => void): void => {
    pending = run;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, delayMs);
  };
  const cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pending = null;
  };
  return { schedule, flush, cancel };
}

// Run `write` on a trailing debounce when `deps` change, and always flush the
// latest pending write on pagehide / visibility-hidden / unmount so a debounced
// localStorage write is never dropped (issue #1580 No-Data-Loss invariant).
function useDebouncedPersist(write: () => void, deps: DependencyList): void {
  const debounceRef = useRef<TrailingDebounce | null>(null);
  if (debounceRef.current === null)
    debounceRef.current = createTrailingDebounce(PERSIST_DEBOUNCE_MS);
  const writeRef = useRef(write);
  writeRef.current = write;

  useEffect(
    () => {
      debounceRef.current?.schedule(() => writeRef.current());
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are forwarded verbatim by the caller
    deps,
  );

  useEffect(() => {
    const debounce = debounceRef.current;
    if (debounce === null) return;
    const flushNow = (): void => debounce.flush();
    const flushOnHide = (): void => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden")
        debounce.flush();
    };
    window.addEventListener("pagehide", flushNow);
    document.addEventListener("visibilitychange", flushOnHide);
    return () => {
      window.removeEventListener("pagehide", flushNow);
      document.removeEventListener("visibilitychange", flushOnHide);
      debounce.flush();
    };
  }, []);
}

interface ArrowState {
  readonly key: string;
  readonly shift: boolean;
}

function applyArrowMove(
  win: AppWindow,
  rect: DOMRect,
  state: ArrowState,
): { x: number; y: number; w: number; h: number } {
  const step = state.shift ? 1 : 16;
  let x = win.x;
  let y = win.y;
  if (state.key === "ArrowRight") x += step;
  else if (state.key === "ArrowLeft") x -= step;
  else if (state.key === "ArrowDown") y += step;
  else if (state.key === "ArrowUp") y -= step;
  const clamped = clampWorkspaceWindowOrigin(
    { x, y, w: win.w },
    { x: 0, y: 0, w: rect.width, h: rect.height },
  );
  x = clamped.x;
  y = clamped.y;
  return { x, y, w: win.w, h: win.h };
}

function applyArrowResize(
  win: AppWindow,
  rect: DOMRect,
  state: ArrowState,
): { x: number; y: number; w: number; h: number } {
  const step = state.shift ? 1 : 16;
  let w = win.w;
  let h = win.h;
  if (state.key === "ArrowRight") w += step;
  else if (state.key === "ArrowLeft") w -= step;
  else if (state.key === "ArrowDown") h += step;
  else if (state.key === "ArrowUp") h -= step;
  const mn = WIN_TYPES[win.type].min;
  w = Math.max(mn.w, Math.min(rect.width, w));
  h = Math.max(mn.h, Math.min(rect.height, h));
  return { x: win.x, y: win.y, w, h };
}

function nextContentZoom(current: number, key: string): number {
  if (key === "0") return 1;
  if (key === "-" || key === "_") return clampContentZoom(current - 0.1);
  return clampContentZoom(current + 0.1);
}

export function nextContentZoomFromWheel(current: number, deltaY: number): number {
  return clampContentZoom(current * Math.exp(-deltaY * 0.0015));
}

export function applyContentWheelZoom(win: AppWindow, deltaY: number): AppWindow {
  const current = win.zoom ?? 1;
  const zoom = nextContentZoomFromWheel(current, deltaY);
  return zoom === current ? win : { ...win, zoom };
}

// GEN-UI-WORKSPACE-S2004 — extracted so the ctrl/cmd-wheel content-zoom updater
// passed to setWins does not nest a `.map()` closure inside the wheel handler
// inside the effect callback (SonarCloud S2004: nesting > 4 levels).
function applyWheelZoomToWindows(
  ws: AppWindow[] | null,
  windowId: string,
  deltaY: number,
): AppWindow[] | null {
  return ws === null
    ? ws
    : ws.map((w) => (w.id === windowId ? applyContentWheelZoom(w, deltaY) : w));
}

function windowIdFromWheelTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>(".window[data-window-id]")?.dataset.windowId ?? null;
}

// GEN-UI-KEYBOARD-006 — resolve which window a keyboard chord (move/resize/content
// zoom/snap) acts on from where focus currently is, instead of always the topmost
// window. Walk up from document.activeElement to the nearest
// `.window[data-window-id]` and use that window; return null when focus sits
// outside any window (so the chord no-ops rather than silently mutating a window
// the user is not looking at). The section itself carries tabIndex={-1}, so a
// window-section focus still resolves to its own id here — only a focus entirely
// outside every window falls through to the topZ tiebreak in the caller.
function focusedWindowId(): string | null {
  const active = typeof document === "undefined" ? null : document.activeElement;
  if (!(active instanceof Element)) return null;
  return active.closest<HTMLElement>(".window[data-window-id]")?.dataset.windowId ?? null;
}

interface UsePanZoomArgs {
  readonly wsRef: RefObject<HTMLElement | null>;
  readonly view: View;
  readonly cameraSmoothness: number;
  readonly winsRef: MutableRefObject<AppWindow[]>;
  readonly setView: Dispatch<SetStateAction<View>>;
  readonly setWins: Dispatch<SetStateAction<AppWindow[] | null>>;
}

interface QueueViewOptions {
  readonly smoothnessScale?: number;
  readonly minDurationMs?: number;
}

interface PanZoomResult {
  readonly viewRef: MutableRefObject<View>;
  readonly worldVP: () => ViewportWorld | null;
  readonly zoomTo: (z: number) => void;
  readonly fitView: () => void;
  readonly resetView: () => void;
  readonly panBy: (dx: number, dy: number) => void;
  readonly rect: () => DOMRect | null;
}

export function normalizeWheelDelta(e: WheelEvent): { readonly x: number; readonly y: number } {
  const multiplier = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : e.deltaMode === 2 ? 800 : 1;
  return { x: e.deltaX * multiplier, y: e.deltaY * multiplier };
}

export function fitWorkspaceViewToWindows(
  windows: readonly AppWindow[],
  rect: Pick<DOMRect, "width" | "height">,
): View {
  const visible = windows.filter((w) => w.minimized !== true);
  if (visible.length === 0) return { zoom: 1, x: 0, y: 0 };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const win of visible) {
    minX = Math.min(minX, win.x);
    minY = Math.min(minY, win.y);
    maxX = Math.max(maxX, win.x + win.w);
    maxY = Math.max(maxY, win.y + win.h);
  }

  const padding = 72;
  const contentW = Math.max(1, maxX - minX);
  const contentH = Math.max(1, maxY - minY);
  const availableW = Math.max(1, rect.width - padding * 2);
  const availableH = Math.max(1, rect.height - padding * 2);
  const zoom = clampViewZoom(Math.min(1, availableW / contentW, availableH / contentH));
  const contentCx = minX + contentW / 2;
  const contentCy = minY + contentH / 2;

  return {
    zoom,
    x: Math.round(rect.width / 2 - contentCx * zoom),
    y: Math.round(rect.height / 2 - contentCy * zoom),
  };
}

function prefersReducedCameraMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function easeCamera(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function interpolateView(from: View, to: View, progress: number): View {
  return {
    zoom: from.zoom + (to.zoom - from.zoom) * progress,
    x: from.x + (to.x - from.x) * progress,
    y: from.y + (to.y - from.y) * progress,
  };
}

function usePanZoom({
  wsRef,
  view,
  cameraSmoothness,
  winsRef,
  setView,
  setWins,
}: UsePanZoomArgs): PanZoomResult {
  const viewRef = useRef<View>(view);
  viewRef.current = view;
  const renderedViewRef = useRef<View>(view);
  renderedViewRef.current = view;
  const pendingViewRef = useRef<View | null>(null);
  const pendingViewSmoothnessScaleRef = useRef(1);
  const pendingViewMinDurationRef = useRef(MIN_CAMERA_ANIMATION_DURATION_MS);
  const frameRef = useRef<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const animationStartRef = useRef<View>(view);
  const animationTargetRef = useRef<View>(view);
  const animationStartedAtRef = useRef<number>(0);
  const viewPersistDebounceRef = useRef<TrailingDebounce | null>(null);
  if (viewPersistDebounceRef.current === null)
    viewPersistDebounceRef.current = createTrailingDebounce(PERSIST_DEBOUNCE_MS);

  const scheduleViewPersist = useCallback((): void => {
    viewPersistDebounceRef.current?.schedule(() => persistList(VIEW_LS, viewRef.current));
  }, []);

  // GEN-PERF-WORKSPACE-004 — flag the workspace host with data-view-active while a
  // wheel/trackpad pan or zoom gesture is in flight so WorkspaceShader can skip its
  // full-screen fbm draw for the gesture (the same suppression the background-pan
  // data-panning attribute already provides). Cleared a short settle after the last
  // view change (mirroring useZoomActive's settle) so the wallpaper resumes.
  const viewActiveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markViewActive = useCallback((): void => {
    const el = wsRef.current;
    if (el === null) return;
    el.dataset["viewActive"] = "true";
    if (viewActiveTimerRef.current !== null) clearTimeout(viewActiveTimerRef.current);
    viewActiveTimerRef.current = setTimeout(() => {
      viewActiveTimerRef.current = null;
      const host = wsRef.current;
      if (host !== null) delete host.dataset["viewActive"];
    }, VIEW_ACTIVE_SETTLE_MS);
  }, [wsRef]);
  useEffect(
    () => () => {
      if (viewActiveTimerRef.current !== null) clearTimeout(viewActiveTimerRef.current);
    },
    [],
  );

  // Issue #1580 follow-up — keep the live view synchronous through viewRef, but
  // take the durable localStorage write out of the pan/zoom frame path. Even this
  // tiny JSON setItem can contend on weaker Windows/iGPU systems when wheel/pan
  // frames arrive continuously; pagehide/visibility-hidden/unmount still flush the
  // latest value so reload state is not lost.
  useEffect(() => {
    const debounce = viewPersistDebounceRef.current;
    if (debounce === null) return;
    const flushNow = (): void => debounce.flush();
    const flushOnHide = (): void => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden")
        debounce.flush();
    };
    window.addEventListener("pagehide", flushNow);
    document.addEventListener("visibilitychange", flushOnHide);
    return () => {
      window.removeEventListener("pagehide", flushNow);
      document.removeEventListener("visibilitychange", flushOnHide);
      debounce.flush();
    };
  }, []);

  useEffect(
    () => () => {
      if (frameRef.current !== null && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(frameRef.current);
      }
      if (animationFrameRef.current !== null && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(animationFrameRef.current);
      }
    },
    [],
  );

  const animateView = useCallback(
    (target: View, smoothnessScale = 1, minDurationMs = MIN_CAMERA_ANIMATION_DURATION_MS): void => {
      const effectiveSmoothness = Math.min(100, Math.max(0, cameraSmoothness * smoothnessScale));
      if (
        effectiveSmoothness <= 0 ||
        prefersReducedCameraMotion() ||
        typeof window.requestAnimationFrame !== "function" ||
        typeof window.cancelAnimationFrame !== "function"
      ) {
        if (animationFrameRef.current !== null) {
          window.cancelAnimationFrame(animationFrameRef.current);
          animationFrameRef.current = null;
        }
        setView(target);
        return;
      }

      const durationMs =
        minDurationMs +
        ((MAX_CAMERA_ANIMATION_DURATION_MS - minDurationMs) * effectiveSmoothness) / 100;
      const now =
        typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now();
      animationStartRef.current =
        animationFrameRef.current === null
          ? renderedViewRef.current
          : interpolateView(
              animationStartRef.current,
              animationTargetRef.current,
              easeCamera(Math.min(1, (now - animationStartedAtRef.current) / durationMs)),
            );
      animationTargetRef.current = target;
      animationStartedAtRef.current = now;

      if (animationFrameRef.current !== null) return;
      const step = (time: number): void => {
        const progress = Math.min(
          1,
          Math.max(0, (time - animationStartedAtRef.current) / durationMs),
        );
        const eased = easeCamera(progress);
        if (progress >= 1) {
          animationFrameRef.current = null;
          setView(animationTargetRef.current);
          return;
        }
        setView(interpolateView(animationStartRef.current, animationTargetRef.current, eased));
        animationFrameRef.current = window.requestAnimationFrame(step);
      };
      animationFrameRef.current = window.requestAnimationFrame(step);
    },
    [cameraSmoothness, setView],
  );

  const settleCameraAnimation = useCallback((): void => {
    if (animationFrameRef.current !== null && typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
      setView(animationTargetRef.current);
      renderedViewRef.current = animationTargetRef.current;
    }
  }, [setView]);

  const queueView = useCallback(
    (next: View | ((current: View) => View), options: QueueViewOptions = {}): void => {
      const base = pendingViewRef.current ?? viewRef.current;
      const resolved = typeof next === "function" ? next(base) : next;
      const smoothnessScale = options.smoothnessScale ?? 1;
      const minDurationMs = options.minDurationMs ?? MIN_CAMERA_ANIMATION_DURATION_MS;
      viewRef.current = resolved;
      pendingViewRef.current = resolved;
      pendingViewSmoothnessScaleRef.current = smoothnessScale;
      pendingViewMinDurationRef.current = minDurationMs;
      scheduleViewPersist();
      markViewActive();

      if (
        typeof window.requestAnimationFrame !== "function" ||
        typeof window.cancelAnimationFrame !== "function"
      ) {
        pendingViewRef.current = null;
        setView(resolved);
        return;
      }

      if (frameRef.current !== null) return;
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        const pending = pendingViewRef.current;
        const pendingSmoothnessScale = pendingViewSmoothnessScaleRef.current;
        const pendingMinDurationMs = pendingViewMinDurationRef.current;
        pendingViewRef.current = null;
        pendingViewSmoothnessScaleRef.current = 1;
        pendingViewMinDurationRef.current = MIN_CAMERA_ANIMATION_DURATION_MS;
        if (pending !== null) animateView(pending, pendingSmoothnessScale, pendingMinDurationMs);
      });
    },
    [animateView, scheduleViewPersist, markViewActive, setView],
  );

  useEffect(() => {
    const el = wsRef.current;
    if (el === null) return;
    // GEN-PERF-WORKSPACE-005 — the ctrl/cmd-wheel zoom branch re-read
    // el.getBoundingClientRect() on EVERY wheel event. A Windows trackpad pinch
    // synthesizes ctrl-wheel at 60-120+Hz, so each step paid a synchronous layout
    // read (a forced reflow whenever anything — e.g. a streaming chat — dirtied
    // layout between events). Cache the rect with a TTL matching the view-active
    // settle window: at most one layout read per 160ms of continuous gesture, and
    // staleness is bounded by the same window (the workspace rect cannot
    // meaningfully change mid-pinch; a real resize refreshes within 160ms).
    let zoomRect: DOMRect | null = null;
    let zoomRectReadAt = 0;
    const gestureRect = (): DOMRect => {
      const now = Date.now();
      if (zoomRect === null || now - zoomRectReadAt > VIEW_ACTIVE_SETTLE_MS) {
        zoomRect = el.getBoundingClientRect();
        zoomRectReadAt = now;
      }
      return zoomRect;
    };
    const onWheel = (e: WheelEvent): void => {
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        const windowId = windowIdFromWheelTarget(e.target);
        if (windowId !== null) {
          settleCameraAnimation();
          setWins((ws) => applyWheelZoomToWindows(ws, windowId, e.deltaY));
          return;
        }
        const r = gestureRect();
        const v = viewRef.current;
        const delta = normalizeWheelDelta(e);
        const z2 = clampViewZoom(v.zoom * Math.exp(-delta.y * 0.0015));
        const wx = (e.clientX - r.left - v.x) / v.zoom;
        const wy = (e.clientY - r.top - v.y) / v.zoom;
        queueView({
          zoom: z2,
          x: e.clientX - r.left - wx * z2,
          y: e.clientY - r.top - wy * z2,
        });
        return;
      }
      const target = e.target;
      if (target instanceof Element && target.closest(".window") !== null) {
        return;
      }
      e.preventDefault();
      const delta = normalizeWheelDelta(e);
      queueView((v) => ({ ...v, x: v.x - delta.x, y: v.y - delta.y }), {
        minDurationMs: 0,
        smoothnessScale: DIRECT_PAN_SMOOTHNESS_SCALE,
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
    };
  }, [wsRef, setWins, queueView, settleCameraAnimation]);

  const rect = useCallback(
    (): DOMRect | null => (wsRef.current === null ? null : wsRef.current.getBoundingClientRect()),
    [wsRef],
  );

  const worldVP = useCallback((): ViewportWorld | null => {
    const r = rect();
    if (r === null) return null;
    const v = viewRef.current;
    return { x: -v.x / v.zoom, y: -v.y / v.zoom, w: r.width / v.zoom, h: r.height / v.zoom };
  }, [rect]);

  const zoomTo = useCallback(
    (z: number): void => {
      const r = rect();
      if (r === null) return;
      const v = viewRef.current;
      const cx = r.width / 2;
      const cy = r.height / 2;
      const wx = (cx - v.x) / v.zoom;
      const wy = (cy - v.y) / v.zoom;
      const z2 = clampViewZoom(z);
      queueView({ zoom: z2, x: cx - wx * z2, y: cy - wy * z2 });
    },
    [rect, queueView],
  );

  const fitView = useCallback((): void => {
    const r = rect();
    if (r === null) return;
    queueView(fitWorkspaceViewToWindows(winsRef.current, r));
  }, [rect, winsRef, queueView]);

  const resetView = useCallback((): void => queueView({ zoom: 1, x: 0, y: 0 }), [queueView]);
  const panBy = useCallback(
    (dx: number, dy: number): void =>
      queueView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }), {
        minDurationMs: 0,
        smoothnessScale: DIRECT_PAN_SMOOTHNESS_SCALE,
      }),
    [queueView],
  );

  return { viewRef, worldVP, zoomTo, fitView, resetView, panBy, rect };
}

interface UseHydrateArgs {
  readonly wsRef: RefObject<HTMLElement | null>;
  readonly setWins: Dispatch<SetStateAction<AppWindow[] | null>>;
  readonly setConns: Dispatch<SetStateAction<Connection[]>>;
  readonly zc: MutableRefObject<number>;
  readonly lastAppliedSerializedRef: MutableRefObject<string | null>;
}

interface WorkspaceSnapshot {
  readonly wins: AppWindow[];
  readonly conns: Connection[];
}

interface ServerWorkspaceSnapshot {
  readonly revision: number;
  readonly windows: readonly unknown[];
  readonly connections: readonly unknown[];
}

function snapshotFromRaw(
  windows: readonly unknown[],
  connections: readonly unknown[],
): WorkspaceSnapshot {
  const wins = sanitizePersistedWindows(windows as readonly AppWindow[]);
  return {
    wins,
    conns: sanitizePersistedConnections(connections as readonly Connection[], wins),
  };
}

function readPersistedWorkspaceSnapshot(): {
  readonly wins: AppWindow[];
  readonly conns: Connection[];
} {
  let wins: AppWindow[] | null = null;
  try {
    wins = parsePersistedWindows(window.localStorage.getItem(WS_LS));
  } catch {
    wins = null;
  }
  const resolvedWins = wins ?? [];
  try {
    return {
      wins: resolvedWins,
      conns: parsePersistedConnections(window.localStorage.getItem(CONN_LS), resolvedWins),
    };
  } catch {
    return { wins: resolvedWins, conns: [] };
  }
}

function workspaceStateEtag(revision: number): string {
  return `"workspace-state-${String(revision)}"`;
}

function revisionFromWorkspaceEtag(value: string | null): number | null {
  const match = /^"workspace-state-(\d+)"$/u.exec(value ?? "");
  if (match === null) return null;
  return Number.parseInt(match[1]!, 10);
}

async function fetchServerWorkspaceSnapshot(
  knownRevision: number,
): Promise<ServerWorkspaceSnapshot | null> {
  if (typeof fetch !== "function") return null;
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    headers["If-None-Match"] = workspaceStateEtag(knownRevision);
    const response = await fetch(WORKSPACE_STATE_API, { headers });
    if (response.status === 304) {
      noteWorkspaceSyncRecovered();
      return null;
    }
    if (!response.ok) {
      surfaceWorkspaceSyncFailure("pull", `failed with status ${String(response.status)}`);
      return null;
    }
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("workspace" in body)) return null;
    const workspace = (body as { readonly workspace?: unknown }).workspace;
    if (typeof workspace !== "object" || workspace === null) return null;
    const record = workspace as Record<string, unknown>;
    if (
      // Number.isFinite, not typeof: a NaN/Infinity revision passes typeof "number"
      // and would poison every monotonic revision comparison downstream.
      !isFiniteRevision(record["revision"]) ||
      !Array.isArray(record["windows"]) ||
      !Array.isArray(record["connections"])
    ) {
      return null;
    }
    noteWorkspaceSyncRecovered();
    return {
      revision: record["revision"],
      windows: record["windows"],
      connections: record["connections"],
    };
  } catch {
    surfaceWorkspaceSyncFailure("pull", "failed (network error)");
    return null;
  }
}

function isFiniteRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

// The fetch keepalive body cap is 64KiB per origin (spec). Use a conservative
// budget so headers + the PUT body together stay under the limit; a keepalive
// request over this budget is rejected by the browser and the final flush is
// silently lost, so we fall back to a normal (non-keepalive) PUT (GEN-PERF-
// PERSISTENCE-005). The server's own hard cap is MAX_WORKSPACE_STATE_BODY_BYTES.
const KEEPALIVE_BODY_BUDGET_BYTES = 60 * 1024;

function serializedBodyByteLength(body: string): number {
  if (typeof Blob === "function") return new Blob([body]).size;
  if (typeof TextEncoder === "function") return new TextEncoder().encode(body).length;
  // Last-resort UTF-8 byte estimate.
  return unescape(encodeURIComponent(body)).length;
}

// Exported for tests (GEN-PERF-PERSISTENCE-005). A serialized body over the
// keepalive budget must not be sent with keepalive:true (the browser rejects it and
// the flush is silently lost).
export function keepaliveBodyFitsBudget(body: string): boolean {
  return serializedBodyByteLength(body) <= KEEPALIVE_BODY_BUDGET_BYTES;
}
export const WORKSPACE_KEEPALIVE_BODY_BUDGET_BYTES = KEEPALIVE_BODY_BUDGET_BYTES;
// Reset the overcap counter (tests only).
export function resetWorkspaceKeepaliveOvercapCount(): void {
  workspaceKeepaliveOvercapCount = 0;
}

// Surfaced (not swallowed) when the final flush cannot be delivered — a bounded
// per-origin console.warn so an oversize/rejected keepalive is observable rather
// than a silent data loss. Never logs body contents (SEC: no secret-shaped
// payloads escape). Counter is process-local and used by the perf/telemetry test.
let workspaceKeepaliveOvercapCount = 0;
export function readWorkspaceKeepaliveOvercapCount(): number {
  return workspaceKeepaliveOvercapCount;
}
function surfaceWorkspaceKeepaliveOvercap(byteLength: number): void {
  workspaceKeepaliveOvercapCount += 1;
  if (typeof console !== "undefined" && typeof console.warn === "function") {
    console.warn(
      `workspace-state: keepalive body ${String(byteLength)}B over budget; retrying without keepalive`,
    );
  }
}

// Server sync failures were swallowed by bare `catch { return null; }` — network
// errors, non-OK statuses (e.g. a 413 over the server body cap) and malformed
// payloads were indistinguishable and invisible, silently degrading the workspace
// to localStorage-only persistence. Surface ONE bounded, body-free console.warn
// per outage (re-armed by the next successful exchange, so a recovered-then-broken
// sync warns again) — the same bounded-surface pattern as the keepalive overcap
// above. Never logs snapshot contents. Counter is process-local for tests.
let workspaceSyncFailureCount = 0;
let workspaceSyncFailureSurfaced = false;
export function readWorkspaceSyncFailureCount(): number {
  return workspaceSyncFailureCount;
}
// Reset the sync-failure surface (tests only).
export function resetWorkspaceSyncFailureSurface(): void {
  workspaceSyncFailureCount = 0;
  workspaceSyncFailureSurfaced = false;
}
function surfaceWorkspaceSyncFailure(op: "pull" | "put", detail: string): void {
  workspaceSyncFailureCount += 1;
  if (workspaceSyncFailureSurfaced) return;
  workspaceSyncFailureSurfaced = true;
  if (typeof console !== "undefined" && typeof console.warn === "function") {
    console.warn(
      `workspace-state: ${op} ${detail}; workspace changes persist locally until sync recovers`,
    );
  }
}
function noteWorkspaceSyncRecovered(): void {
  workspaceSyncFailureSurfaced = false;
}

async function putServerWorkspaceSnapshot(
  wins: readonly AppWindow[],
  conns: readonly Connection[],
  opts: {
    readonly baseRevision: number;
    readonly signal?: AbortSignal;
    readonly keepalive?: boolean;
  },
): Promise<
  | { readonly kind: "ok"; readonly revision: number }
  | { readonly kind: "conflict"; readonly revision: number | null }
  | null
> {
  if (typeof fetch !== "function") return null;
  const serializedBody = JSON.stringify({ windows: wins, connections: conns });
  // GEN-PERF-PERSISTENCE-005 — a keepalive PUT whose body exceeds the 64KiB
  // keepalive cap is rejected by the browser and the flush is lost. If the body
  // is over the keepalive budget, drop keepalive and send a normal PUT (which
  // usually still completes on visibilitychange). Sanitize's data-URL/large-
  // payload dropping upstream keeps this rare; the guard makes it non-silent.
  let keepalive = opts.keepalive === true;
  if (keepalive) {
    const byteLength = serializedBodyByteLength(serializedBody);
    if (byteLength > KEEPALIVE_BODY_BUDGET_BYTES) {
      surfaceWorkspaceKeepaliveOvercap(byteLength);
      keepalive = false;
    }
  }
  try {
    const response = await fetch(WORKSPACE_STATE_API, {
      method: "PUT",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "If-Match": workspaceStateEtag(opts.baseRevision),
        "X-Keiko-CSRF": "1",
      },
      body: serializedBody,
      // keepalive lets the final flush survive page unload; disabled above when the
      // body is over the keepalive budget. sendBeacon cannot set the required
      // X-Keiko-CSRF header, hence keepalive.
      ...(keepalive ? { keepalive: true } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    if (response.status === 412 || response.status === 428) {
      // A revision conflict is a handled concurrency signal (the poll converges),
      // not an outage — and it proves the server is reachable.
      noteWorkspaceSyncRecovered();
      return {
        kind: "conflict",
        revision: revisionFromWorkspaceEtag(response.headers.get("etag")),
      };
    }
    if (!response.ok) {
      surfaceWorkspaceSyncFailure("put", `failed with status ${String(response.status)}`);
      return null;
    }
    const body: unknown = await response.json();
    const workspace =
      typeof body === "object" && body !== null && "workspace" in body
        ? (body as { readonly workspace?: unknown }).workspace
        : undefined;
    if (typeof workspace !== "object" || workspace === null) return null;
    const revision = (workspace as Record<string, unknown>)["revision"];
    if (!isFiniteRevision(revision)) return null;
    noteWorkspaceSyncRecovered();
    return { kind: "ok", revision };
  } catch {
    // An aborted PUT is deliberate supersession by a newer snapshot — not a failure.
    if (opts.signal?.aborted !== true) {
      surfaceWorkspaceSyncFailure("put", "failed (network error)");
    }
    return null;
  }
}

function buildServerWorkspaceSnapshot(
  wins: readonly AppWindow[],
  conns: readonly Connection[],
): {
  readonly wins: readonly AppWindow[];
  readonly conns: readonly Connection[];
  readonly serialized: string;
} {
  const persistedWins = sanitizePersistedWindows(wins);
  const persistedConns = sanitizePersistedConnections(conns, persistedWins);
  return {
    wins: persistedWins,
    conns: persistedConns,
    serialized: JSON.stringify({ windows: persistedWins, connections: persistedConns }),
  };
}

function applyPersistedWorkspaceSnapshot(
  snapshot: { readonly wins: AppWindow[]; readonly conns: Connection[] },
  setWins: Dispatch<SetStateAction<AppWindow[] | null>>,
  setConns: Dispatch<SetStateAction<Connection[]>>,
  zc: MutableRefObject<number>,
): void {
  zc.current = snapshot.wins.reduce((maxZ, win) => Math.max(maxZ, win.z), 1);
  setWins(snapshot.wins);
  setConns(snapshot.conns);
}

function useHydrate({
  wsRef,
  setWins,
  setConns,
  zc,
  lastAppliedSerializedRef,
}: UseHydrateArgs): void {
  useLayoutEffect(() => {
    const el = wsRef.current;
    if (el === null) return;
    // M1 (#532) — no seeded windows on first launch; the empty-state "New window" button
    // in Workspace.tsx and the FAB (+) are always reachable even when `wins` is [].
    const snapshot = readPersistedWorkspaceSnapshot();
    // GEN-PERF-PERSISTENCE-001 — seed the applied-serialization baseline from the
    // hydrated snapshot so an immediate cross-tab storage event echoing this exact
    // value is recognised as a no-op (before the debounced local persist runs).
    lastAppliedSerializedRef.current = serializePersistedSnapshot(snapshot);
    applyPersistedWorkspaceSnapshot(snapshot, setWins, setConns, zc);
  }, [wsRef, setWins, setConns, zc, lastAppliedSerializedRef]);
}

interface UseStorageSyncArgs {
  readonly setWins: Dispatch<SetStateAction<AppWindow[] | null>>;
  readonly setConns: Dispatch<SetStateAction<Connection[]>>;
  readonly zc: MutableRefObject<number>;
  readonly beforeApplyRemote: () => void;
  readonly lastAppliedSerializedRef: MutableRefObject<string | null>;
  readonly suppressNextLocalPersistRef: MutableRefObject<boolean>;
}

// Serialize a persisted snapshot to a stable equality key. Uses the sanitize path
// so the comparison matches exactly what the debounced localStorage write emits.
function serializePersistedSnapshot(snapshot: {
  readonly wins: readonly AppWindow[];
  readonly conns: readonly Connection[];
}): string {
  const persistedWins = sanitizePersistedWindows(snapshot.wins);
  return JSON.stringify({
    windows: persistedWins,
    connections: sanitizePersistedConnections(snapshot.conns, persistedWins),
  });
}

function useWorkspaceStorageSync({
  setWins,
  setConns,
  zc,
  beforeApplyRemote,
  lastAppliedSerializedRef,
  suppressNextLocalPersistRef,
}: UseStorageSyncArgs): void {
  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.storageArea !== null && event.storageArea !== window.localStorage) return;
      if (event.key !== WS_LS && event.key !== CONN_LS) return;
      const snapshot = readPersistedWorkspaceSnapshot();
      // GEN-PERF-PERSISTENCE-001 — a cross-tab storage event unconditionally
      // re-applied the whole snapshot with brand-new object identities (defeating
      // every WindowFrame memo and bumping useLinkRevision) even when the incoming
      // serialized value equalled what is already applied. Skip the re-apply when
      // the sanitized serialization is unchanged.
      const serialized = serializePersistedSnapshot(snapshot);
      if (serialized === lastAppliedSerializedRef.current) return;
      lastAppliedSerializedRef.current = serialized;
      beforeApplyRemote();
      // GEN-PERF-PERSISTENCE-012 (storage path) — a just-applied remote snapshot
      // must not be immediately re-written to localStorage (echoing back exactly
      // what the sibling tab wrote). suppressNextServerPersistRef already guards
      // the server PUT; this guards the localStorage write.
      suppressNextLocalPersistRef.current = true;
      applyPersistedWorkspaceSnapshot(snapshot, setWins, setConns, zc);
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
    };
  }, [
    setWins,
    setConns,
    zc,
    beforeApplyRemote,
    lastAppliedSerializedRef,
    suppressNextLocalPersistRef,
  ]);
}

interface UseServerSyncArgs {
  readonly wins: AppWindow[] | null;
  readonly conns: readonly Connection[];
  readonly setWins: Dispatch<SetStateAction<AppWindow[] | null>>;
  readonly setConns: Dispatch<SetStateAction<Connection[]>>;
  readonly zc: MutableRefObject<number>;
  readonly suppressNextPersistRef: MutableRefObject<boolean>;
}

function useWorkspaceServerSync({
  wins,
  conns,
  setWins,
  setConns,
  zc,
  suppressNextPersistRef,
}: UseServerSyncArgs): void {
  const revisionRef = useRef(0);
  const winsRef = useRef<AppWindow[] | null>(wins);
  winsRef.current = wins;
  const connsRef = useRef<readonly Connection[]>(conns);
  connsRef.current = conns;
  const putDebounceRef = useRef<TrailingDebounce | null>(null);
  if (putDebounceRef.current === null)
    putDebounceRef.current = createTrailingDebounce(PERSIST_DEBOUNCE_MS);
  const putAbortRef = useRef<AbortController | null>(null);
  const localDirtyRef = useRef(false);
  const lastAcknowledgedSnapshotRef = useRef<string | null>(null);
  if (wins !== null && wins.length > 0 && lastAcknowledgedSnapshotRef.current === null) {
    localDirtyRef.current = true;
  }

  const serverSyncEnabled = typeof navigator === "undefined" || navigator.webdriver !== true;

  // One sanitize+PUT of the LATEST snapshot (read from refs so a debounced/flush run
  // never sends stale geometry). Supersedes any in-flight PUT via AbortController and
  // advances the revision monotonically (issue #1580).
  const runServerPut = useCallback((keepalive: boolean): void => {
    const latestWins = winsRef.current;
    if (latestWins === null) return;
    const snapshot = buildServerWorkspaceSnapshot(latestWins, connsRef.current);
    if (snapshot.serialized === lastAcknowledgedSnapshotRef.current) {
      localDirtyRef.current = false;
      return;
    }
    putAbortRef.current?.abort();
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    putAbortRef.current = controller;
    const baseRevision = revisionRef.current;
    void putServerWorkspaceSnapshot(snapshot.wins, snapshot.conns, {
      baseRevision,
      ...(controller !== null ? { signal: controller.signal } : {}),
      keepalive,
    }).then((result) => {
      if (result?.kind === "conflict") {
        if (result.revision !== null && result.revision > revisionRef.current) {
          revisionRef.current = result.revision;
        }
        return;
      }
      if (result?.kind !== "ok") return;
      lastAcknowledgedSnapshotRef.current = snapshot.serialized;
      localDirtyRef.current = false;
      if (result.revision > revisionRef.current) revisionRef.current = result.revision;
    });
  }, []);

  const applyServerSnapshot = useCallback(
    (serverSnapshot: ServerWorkspaceSnapshot): void => {
      const snapshot = snapshotFromRaw(serverSnapshot.windows, serverSnapshot.connections);
      lastAcknowledgedSnapshotRef.current = JSON.stringify({
        windows: snapshot.wins,
        connections: snapshot.conns,
      });
      localDirtyRef.current = false;
      if (serverSnapshot.revision > revisionRef.current) {
        revisionRef.current = serverSnapshot.revision;
      }
      suppressNextPersistRef.current = true;
      applyPersistedWorkspaceSnapshot(snapshot, setWins, setConns, zc);
    },
    [setWins, setConns, zc, suppressNextPersistRef],
  );

  useEffect(() => {
    if (!serverSyncEnabled) return;
    let stopped = false;
    let interval: number | null = null;
    const pull = async (): Promise<void> => {
      const serverSnapshot = await fetchServerWorkspaceSnapshot(revisionRef.current);
      if (stopped || serverSnapshot === null) return;
      if (serverSnapshot.revision <= revisionRef.current) return;
      if (
        revisionRef.current === 0 &&
        serverSnapshot.windows.length === 0 &&
        (winsRef.current?.length ?? 0) > 0
      ) {
        return;
      }
      if (localDirtyRef.current) return;
      applyServerSnapshot(serverSnapshot);
    };
    const startPolling = (): void => {
      if (interval !== null) return;
      interval = window.setInterval(() => {
        void pull();
      }, WORKSPACE_STATE_POLL_MS);
    };
    const stopPolling = (): void => {
      if (interval === null) return;
      window.clearInterval(interval);
      interval = null;
    };
    // Issue #1580 — only poll while the document is visible; the old fixed interval
    // kept fetching/parsing forever in background tabs. Returning to visible does an
    // immediate catch-up pull so multi-tab convergence is unchanged.
    const sync = (): void => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        stopPolling();
      } else {
        void pull();
        startPolling();
      }
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      stopped = true;
      stopPolling();
      document.removeEventListener("visibilitychange", sync);
    };
  }, [applyServerSnapshot, serverSyncEnabled]);

  // Debounced server PUT (issue #1580): an uncoalesced drag previously fired one
  // full-snapshot PUT per pointer frame. The echo-suppression flag is consumed
  // SYNCHRONOUSLY here so a snapshot just applied from server/storage is never
  // echoed back; the actual PUT is deferred to the trailing flush.
  useEffect(() => {
    if (!serverSyncEnabled) return;
    if (wins === null) return;
    if (suppressNextPersistRef.current) {
      suppressNextPersistRef.current = false;
      return;
    }
    const snapshot = buildServerWorkspaceSnapshot(wins, conns);
    if (
      lastAcknowledgedSnapshotRef.current === null &&
      snapshot.wins.length === 0 &&
      snapshot.conns.length === 0
    ) {
      lastAcknowledgedSnapshotRef.current = snapshot.serialized;
      localDirtyRef.current = false;
      return;
    }
    if (snapshot.serialized === lastAcknowledgedSnapshotRef.current) {
      localDirtyRef.current = false;
      return;
    }
    localDirtyRef.current = true;
    putDebounceRef.current?.schedule(() => runServerPut(false));
  }, [wins, conns, suppressNextPersistRef, serverSyncEnabled, runServerPut]);

  // Guarantee the final snapshot reaches the server even if the tab closes during a
  // gesture: cancel the pending debounce and send one keepalive PUT on unload, and
  // flush any pending PUT on unmount.
  useEffect(() => {
    if (!serverSyncEnabled) return;
    const debounce = putDebounceRef.current;
    const flushKeepalive = (): void => {
      debounce?.cancel();
      runServerPut(true);
    };
    const onHide = (): void => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden")
        flushKeepalive();
    };
    window.addEventListener("pagehide", flushKeepalive);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", flushKeepalive);
      document.removeEventListener("visibilitychange", onHide);
      debounce?.flush();
    };
  }, [serverSyncEnabled, runServerPut]);
}

interface SnapChordActions {
  readonly setSnap: (zone: SnapZone | null) => void;
  readonly commitSnap: (id: string) => void;
}

interface UseKeyboardArgs {
  readonly setWins: Dispatch<SetStateAction<AppWindow[] | null>>;
  readonly rect: () => DOMRect | null;
  readonly cancelConnectRef: MutableRefObject<() => void>;
  // GEN-UI-KEYBOARD-009 — the snap actions the keyboard snap chords drive. Held in
  // a ref because the snap actions are assembled after this hook is called; the ref
  // is populated in the same render before any keydown can fire.
  readonly snapRef: MutableRefObject<SnapChordActions | null>;
}

// GEN-UI-KEYBOARD-009 — the keyboard equivalent of an edge/quadrant drag snap.
// Cmd/Ctrl+Alt+Arrow snaps the focused window to a half/maximized region using the
// exact same api.setSnap → api.commitSnap path a pointer drag arms, so the snapped
// geometry (and the maximize/restore prev snapshot) is identical. Left/Right tile
// to that half; Up maximizes. Down is intentionally unbound (no lower snap zone).
const SNAP_ARROW_ZONES: Readonly<Record<string, SnapZone | null>> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "maxi",
  ArrowDown: null,
};

function handleSnapChord(snap: SnapChordActions, zone: SnapZone, targetId: string): void {
  snap.setSnap(zone);
  snap.commitSnap(targetId);
}

// Audit C296 — the content-zoom chord matches event.code, not event.key: macOS
// Option composes characters (Option+- yields "–", Option+0 yields "º"), so a
// key-based comparison would make the alt chord unmatchable on Macs — the same
// trap audit C125 fixed in useKeyboardShortcuts. Maps to the logical key that
// nextContentZoom understands.
const CONTENT_ZOOM_CODES: Readonly<Record<string, string>> = {
  Equal: "=",
  NumpadAdd: "+",
  Minus: "-",
  NumpadSubtract: "-",
  Digit0: "0",
  Numpad0: "0",
};

// GEN-UI-KEYBOARD-006 — pick the window a keyboard chord acts on: the window that
// currently holds focus (targetId) when it resolves to a live, non-minimized
// window; otherwise the topZ frontmost window as the tiebreak. The caller passes
// targetId=null when focus is outside every window, in which case this returns
// null and the chord is a no-op.
function chordTargetWindow(ws: readonly AppWindow[], targetId: string | null): AppWindow | null {
  if (targetId !== null) {
    const focused = ws.find((w) => w.id === targetId);
    return focused !== undefined && focused.minimized !== true ? focused : null;
  }
  return topZ(ws);
}

function handleContentZoomKey(
  setWins: Dispatch<SetStateAction<AppWindow[] | null>>,
  key: string,
  targetId: string | null,
): void {
  setWins((ws) => {
    if (ws === null || ws.length === 0) return ws;
    const target = chordTargetWindow(ws, targetId);
    if (target === null) return ws;
    const z = nextContentZoom(target.zoom ?? 1, key);
    return ws.map((w) => (w.id === target.id ? { ...w, zoom: z } : w));
  });
}

function handleArrowKey(
  setWins: Dispatch<SetStateAction<AppWindow[] | null>>,
  rect: DOMRect,
  arrow: ArrowState,
  size: boolean,
  targetId: string | null,
): void {
  setWins((ws) => {
    if (ws === null || ws.length === 0) return ws;
    const target = chordTargetWindow(ws, targetId);
    if (target === null) return ws;
    const next = size ? applyArrowResize(target, rect, arrow) : applyArrowMove(target, rect, arrow);
    return ws.map((w) => (w.id === target.id ? { ...w, ...next, max: false } : w));
  });
}

// S3776 — the content-zoom chord's guard condition is split from its action so the
// keydown dispatcher below stays a flat sequence of early returns; the compound
// boolean and the nested "only act with a live target" check live here instead.
function isContentZoomChord(e: KeyboardEvent, zoomKey: string | undefined): zoomKey is string {
  return (e.metaKey || e.ctrlKey) && e.altKey && zoomKey !== undefined;
}

function runContentZoomChord(
  e: KeyboardEvent,
  setWins: Dispatch<SetStateAction<AppWindow[] | null>>,
  zoomKey: string,
  targetId: string | null,
): void {
  e.preventDefault();
  if (targetId !== null) handleContentZoomKey(setWins, zoomKey, targetId);
}

// GEN-UI-KEYBOARD-009 sibling — the snap chord's guard and its action (zone lookup +
// the nested "only commit with a live snap + target" check), split out for the same
// reason as isContentZoomChord/runContentZoomChord above.
function isSnapChord(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && e.altKey;
}

function runSnapChordKey(
  e: KeyboardEvent,
  snapRef: MutableRefObject<SnapChordActions | null>,
  targetId: string | null,
): void {
  // ArrowDown maps to null (no lower snap zone); an unmapped key is undefined.
  const zone = SNAP_ARROW_ZONES[e.key];
  e.preventDefault();
  const snap = snapRef.current;
  if (zone != null && snap !== null && targetId !== null) {
    handleSnapChord(snap, zone, targetId);
  }
}

function isArrowChordActive(e: KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey || e.altKey;
}

function runArrowChordKey(
  e: KeyboardEvent,
  setWins: Dispatch<SetStateAction<AppWindow[] | null>>,
  rect: () => DOMRect | null,
  targetId: string | null,
): void {
  const size = e.altKey;
  e.preventDefault();
  if (targetId === null) return;
  const r = rect();
  if (r === null) return;
  handleArrowKey(setWins, r, { key: e.key, shift: e.shiftKey }, size, targetId);
}

function useKeyboardCtrls({ setWins, rect, cancelConnectRef, snapRef }: UseKeyboardArgs): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Escape must cancel an in-flight connect even when focus sits in a form
      // field (e.g. the chat composer) — the form-field guard below otherwise
      // swallows the cancel. cancelConnect is a no-op when no connect is
      // active, so other Escape consumers stay unaffected (audit C298).
      if (e.key === "Escape") {
        cancelConnectRef.current();
        return;
      }
      if (isFormField(document.activeElement)) return;
      // GEN-UI-KEYBOARD-006 — every geometry/content chord now acts on the window
      // that currently holds focus, not the topmost window regardless of focus.
      // `null` means focus is outside any window, in which case the chord no-ops
      // (it must never silently mutate a window the user is not operating).
      const targetId = focusedWindowId();
      // Audit C296 — plain Cmd/Ctrl+Plus/Minus/0 used to be preventDefault'ed
      // app-wide, hijacking the browser's page zoom (the primary text-scaling
      // tool, WCAG 1.4.4) for a single-window content zoom. Content zoom now
      // requires Alt as well (consistent with Alt = resize on the arrow chords);
      // the browser chords pass through untouched.
      const zoomKey = CONTENT_ZOOM_CODES[e.code];
      if (isContentZoomChord(e, zoomKey)) {
        runContentZoomChord(e, setWins, zoomKey, targetId);
        return;
      }
      if (!/^Arrow/.test(e.key)) return;
      // GEN-UI-KEYBOARD-009 — Cmd/Ctrl+Alt+Arrow snaps the focused window to a
      // half/maximized region (the keyboard equivalent of an edge/quadrant drag
      // snap). Checked before the move/resize branch below because it shares the
      // Alt modifier with resize; it wins only when Cmd/Ctrl is also held.
      if (isSnapChord(e)) {
        runSnapChordKey(e, snapRef, targetId);
        return;
      }
      if (!isArrowChordActive(e)) return;
      runArrowChordKey(e, setWins, rect, targetId);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [setWins, rect, cancelConnectRef, snapRef]);
}

interface UseFitMaximizedArgs {
  readonly wsRef: RefObject<HTMLElement | null>;
  readonly viewRef: MutableRefObject<View>;
  readonly setWins: Dispatch<SetStateAction<AppWindow[] | null>>;
}

// Exported for tests. Maximized windows track the viewport exactly; floating
// windows are clamped so at least a 120px-wide strip of the title bar (38px
// tall) stays inside the visible workspace — the same margins as the drag
// clamp in WindowFrame. Without this, shrinking the viewport could strand a
// window entirely off-screen with no visible recovery path (audit C132).
export function fitWindowToViewport(w: AppWindow, vp: ViewportWorld): AppWindow {
  if (w.max) return { ...w, x: vp.x, y: vp.y, w: vp.w, h: vp.h };
  const { x, y } = clampWorkspaceWindowOrigin(w, vp);
  return x === w.x && y === w.y ? w : { ...w, x, y };
}

// Exported for tests (audit GEN-PERF-WORKSPACE-001). fitWindowToViewport already
// identity-preserves per unchanged window, but a plain `.map` still allocates a
// new array on every ResizeObserver tick — so a no-op resize committed a fresh
// `wins` identity, re-rendering the whole shell and re-firing the persist chain.
// Return the ORIGINAL array when no element changed identity so React bails the
// state update entirely (true no-op resize).
export function fitWindowsToViewport(
  wins: readonly AppWindow[],
  vp: ViewportWorld,
): readonly AppWindow[] {
  const next = wins.map((w) => fitWindowToViewport(w, vp));
  return next.every((w, i) => w === wins[i]) ? wins : next;
}

function useFitMaximized({ wsRef, viewRef, setWins }: UseFitMaximizedArgs): void {
  useEffect(() => {
    const el = wsRef.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const v = viewRef.current;
      const vp: ViewportWorld = {
        x: -v.x / v.zoom,
        y: -v.y / v.zoom,
        w: r.width / v.zoom,
        h: r.height / v.zoom,
      };
      setWins((ws) => (ws === null ? ws : fitWindowsToViewport(ws, vp)) as AppWindow[] | null);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [wsRef, viewRef, setWins]);
}

function useConnectionPrune(
  wins: AppWindow[] | null,
  setConns: Dispatch<SetStateAction<Connection[]>>,
): void {
  useEffect(() => {
    if (wins === null) return;
    const windowIds = new Set(wins.map((win) => win.id));
    setConns((cs) => {
      const filtered = cs.filter((c) => windowIds.has(c.a) && windowIds.has(c.b));
      return filtered.length === cs.length ? cs : filtered;
    });
  }, [wins, setConns]);
}

// Epic #532 — optional Files↔Chat scope-binding callbacks. The composition root (AppShell) wires
// these to the active chat's connectedScopes so a relationship edge grounds the chat against a folder.
// Epic #189 Slice 3 M3 — optional Connector↔Chat scope-binding callbacks. The composition root
// (AppShell) wires these to the active chat's localKnowledgeScopes.
// Release 0.2.0 — bind callbacks return whether the bind was ACCEPTED; `false` (source limit
// reached or persistence failed) vetoes the edge so no dangling ungrounded edge is drawn.
export interface UseWorkspaceOptions {
  readonly cameraSmoothness?: number | undefined;
  readonly onScopeBind?:
    ((chatWindowId: string, scope: ChatConnectedScope) => boolean | Promise<boolean>) | undefined;
  readonly onScopeUnbind?: ((chatWindowId: string, scope: ChatConnectedScope) => void) | undefined;
  readonly onConnectorBind?:
    | ((chatWindowId: string, scope: ChatLocalKnowledgeScope) => boolean | Promise<boolean>)
    | undefined;
  readonly onConnectorUnbind?:
    ((chatWindowId: string, scope: ChatLocalKnowledgeScope) => void) | undefined;
}

// S3776 — closeWithTeardown's per-connection unbind logic (below) used to run inside a
// `for` loop inside an `if`, so every ternary/`??`/guard inside it paid double nesting.
// Extracting the per-connection work into its own function resets that nesting to zero;
// the helpers below match the three independent derivations closeWithTeardown made
// inline (the other endpoint, the chat window id, and the Files↔Chat unbind scope).
function connectionOtherEndpoint(conn: Connection, closedWindowId: string): string | null {
  if (conn.a === closedWindowId) return conn.b;
  if (conn.b === closedWindowId) return conn.a;
  return null;
}

// Release 0.2.0 — prefer the bind-time snapshot on the Connection: the window's current
// cfg may have moved on (Files window navigated elsewhere, another capsule selected) and
// re-deriving from it would unbind the WRONG source. cfg-derivation remains the fallback
// for edges persisted before the snapshot fields existed.
function connectionChatWindowId(conn: Connection, win: AppWindow, other: AppWindow): string | null {
  if (conn.boundChatWindowId !== undefined) return conn.boundChatWindowId;
  if (win.type === "chat") return win.id;
  if (other.type === "chat") return other.id;
  return null;
}

function connectionUnbindScope(
  conn: Connection,
  win: AppWindow,
  other: AppWindow,
): ChatConnectedScope | null {
  const bound = boundScopeOf(conn);
  if (bound !== null) return bound;
  if (conn.boundScopeElided === true) return null;
  return filesChatBindScope(win, other, Date.now());
}

function unbindClosedWindowConnection(
  closedWindowId: string,
  closedWin: AppWindow,
  conn: Connection,
  winsById: ReadonlyMap<string, AppWindow>,
  unbindScope: (chatWindowId: string, scope: ChatConnectedScope) => void,
  unbindConnectorScope: (chatWindowId: string, scope: ChatLocalKnowledgeScope) => void,
): void {
  const otherId = connectionOtherEndpoint(conn, closedWindowId);
  if (otherId === null) return;
  const other = winsById.get(otherId);
  if (other === undefined) return;
  const chatWindowId = connectionChatWindowId(conn, closedWin, other);
  const scope = connectionUnbindScope(conn, closedWin, other);
  if (scope !== null && chatWindowId !== null) unbindScope(chatWindowId, scope);
  const connectorScope = boundConnectorScopeOf(conn) ?? connectorChatBind(closedWin, other);
  if (connectorScope !== null && chatWindowId !== null) {
    unbindConnectorScope(chatWindowId, connectorScope);
  }
}

export function useWorkspace(
  wsRef: RefObject<HTMLElement | null>,
  opts: UseWorkspaceOptions = {},
): UseWorkspaceResult {
  const [wins, setWins] = useState<AppWindow[] | null>(null);
  const [selection, setSelection] = useState<WorkspaceUiSelectionState>({
    focusedWindowId: null,
    selectedWindowIds: [],
  });
  const [snapPrev, setSnapPrev] = useState<SnapPrev | null>(null);
  const [palOpen, setPalOpen] = useState(false);
  const [conns, setConns] = useState<Connection[]>([]);
  const [connecting, setConnecting] = useState<ConnectingState | null>(null);
  const [view, setView] = useState<View>(readView);
  // Issue #1580 — destructure the optional scope-bind callbacks so the memoized
  // action factories below depend on their (stable) identities rather than on the
  // `opts` object, which defaults to a fresh `{}` every render and would otherwise
  // re-create the whole api each frame and defeat memoization.
  const {
    cameraSmoothness = 0,
    onScopeBind,
    onScopeUnbind,
    onConnectorBind,
    onConnectorUnbind,
  } = opts;
  // GEN-PERF-RENDER-001 — route the optional scope-bind callbacks through refs so the
  // connectActions/api memos never rebind when a parent (AppShell) passes NEW callback
  // identities per render (its scope-bind callbacks depend on the whole `session`,
  // which changes on every keystroke/SSE token). The stable wrappers below read the
  // live callback each call, preserving behaviour (`?? true` on bind, no-op on unbind
  // when the underlying callback is absent) while keeping api referentially stable.
  const onScopeBindRef = useRef(onScopeBind);
  onScopeBindRef.current = onScopeBind;
  const onScopeUnbindRef = useRef(onScopeUnbind);
  onScopeUnbindRef.current = onScopeUnbind;
  const onConnectorBindRef = useRef(onConnectorBind);
  onConnectorBindRef.current = onConnectorBind;
  const onConnectorUnbindRef = useRef(onConnectorUnbind);
  onConnectorUnbindRef.current = onConnectorUnbind;
  const stableScopeBind = useCallback(
    (chatWindowId: string, scope: ChatConnectedScope): boolean | Promise<boolean> =>
      onScopeBindRef.current?.(chatWindowId, scope) ?? true,
    [],
  );
  const stableScopeUnbind = useCallback((chatWindowId: string, scope: ChatConnectedScope): void => {
    onScopeUnbindRef.current?.(chatWindowId, scope);
  }, []);
  const stableConnectorBind = useCallback(
    (chatWindowId: string, scope: ChatLocalKnowledgeScope): boolean | Promise<boolean> =>
      onConnectorBindRef.current?.(chatWindowId, scope) ?? true,
    [],
  );
  const stableConnectorUnbind = useCallback(
    (chatWindowId: string, scope: ChatLocalKnowledgeScope): void => {
      onConnectorUnbindRef.current?.(chatWindowId, scope);
    },
    [],
  );

  const zc = useRef<number>(3);
  const snapZone = useRef<SnapZone | null>(null);
  const suppressNextServerPersistRef = useRef(false);
  // GEN-PERF-PERSISTENCE-001/012 — the last sanitized snapshot serialization that is
  // currently applied, and a flag suppressing the immediate localStorage rewrite of a
  // snapshot that just arrived from persistence (cross-tab storage event).
  const lastAppliedSerializedRef = useRef<string | null>(null);
  const suppressNextLocalPersistRef = useRef(false);
  const beforeApplyRemote = useCallback((): void => {
    suppressNextServerPersistRef.current = true;
  }, []);

  const winsRef = useRef<AppWindow[]>([]);
  winsRef.current = wins ?? [];
  const winsReadyRef = useRef(false);
  winsReadyRef.current = wins !== null;
  const selectionRef = useRef<WorkspaceUiSelectionState>(selection);
  selectionRef.current = selection;
  const workspaceClipboardRef = useRef<string | null>(null);
  const workspaceClipboardPasteCountRef = useRef(1);
  const connsRef = useRef<Connection[]>([]);
  connsRef.current = conns;
  const winsById = useMemo<ReadonlyMap<string, AppWindow>>(
    () => new Map((wins ?? []).map((win) => [win.id, win])),
    [wins],
  );
  const connsById = useMemo<ReadonlyMap<string, Connection>>(
    () => new Map(conns.map((conn) => [conn.id, conn])),
    [conns],
  );
  const connsByEndpoint = useMemo<ReadonlyMap<string, readonly Connection[]>>(() => {
    const next = new Map<string, Connection[]>();
    for (const conn of conns) {
      const a = next.get(conn.a);
      if (a === undefined) next.set(conn.a, [conn]);
      else a.push(conn);
      const b = next.get(conn.b);
      if (b === undefined) next.set(conn.b, [conn]);
      else b.push(conn);
    }
    return next;
  }, [conns]);
  const winsByIdRef = useRef<ReadonlyMap<string, AppWindow>>(winsById);
  winsByIdRef.current = winsById;
  const connsByIdRef = useRef<ReadonlyMap<string, Connection>>(connsById);
  connsByIdRef.current = connsById;
  const connsByEndpointRef = useRef<ReadonlyMap<string, readonly Connection[]>>(connsByEndpoint);
  connsByEndpointRef.current = connsByEndpoint;
  // Refs for the click-to-connect flow. connectingRef is a synchronous view of
  // the `connecting` state for handlers fired from child components (confirm).
  // connectCleanupRef stores the global pointermove listener disposer so we
  // can tear it down from cancel/confirm without re-attaching effects.
  const connectingRef = useRef<ConnectingState | null>(null);
  connectingRef.current = connecting;
  const connectCleanupRef = useRef<(() => void) | null>(null);
  const cancelConnectRef = useRef<() => void>(() => undefined);
  // GEN-UI-KEYBOARD-009 — the keyboard snap chords drive the same setSnap/commitSnap
  // path as a pointer drag snap. The snap actions are assembled below (after this
  // ref is created); the ref is populated in the same render before any keydown.
  const snapChordRef = useRef<SnapChordActions | null>(null);

  const { viewRef, worldVP, zoomTo, fitView, resetView, panBy, rect } = usePanZoom({
    wsRef,
    view,
    cameraSmoothness,
    winsRef,
    setView,
    setWins,
  });

  useHydrate({ wsRef, setWins, setConns, zc, lastAppliedSerializedRef });
  useWorkspaceStorageSync({
    setWins,
    setConns,
    zc,
    beforeApplyRemote,
    lastAppliedSerializedRef,
    suppressNextLocalPersistRef,
  });
  useWorkspaceServerSync({
    wins,
    conns,
    setWins,
    setConns,
    zc,
    suppressNextPersistRef: suppressNextServerPersistRef,
  });

  useConnectionPrune(wins, setConns);

  useEffect(() => {
    if (wins === null) {
      setSelection((current) =>
        current.focusedWindowId === null && current.selectedWindowIds.length === 0
          ? current
          : { focusedWindowId: null, selectedWindowIds: [] },
      );
      return;
    }
    setSelection((current) => normalizeWorkspaceSelection(wins, current));
  }, [wins]);

  // Debounced localStorage persistence (issue #1580): a drag/resize mutates wins
  // every frame; without this each frame ran a synchronous sanitize + JSON.stringify
  // + setItem. Sanitize windows once and reuse the result for connection pruning/persistence.
  useDebouncedPersist(() => {
    if (wins === null) return;
    // GEN-PERF-PERSISTENCE-012 — a snapshot that just arrived from a sibling tab's
    // storage event was immediately re-written to localStorage (a byte-identical
    // echo). Skip that single rewrite; a genuine later local mutation clears the
    // flag and persists normally.
    if (suppressNextLocalPersistRef.current) {
      suppressNextLocalPersistRef.current = false;
      return;
    }
    const persistedWins = sanitizePersistedWindows(wins);
    const persistedConns = sanitizePersistedConnections(conns, persistedWins);
    persistList(WS_LS, persistedWins);
    persistList(CONN_LS, persistedConns);
    // Track what is now durably applied so a cross-tab storage event echoing this
    // exact value is recognised as a no-op (PERSISTENCE-001 equality guard).
    lastAppliedSerializedRef.current = JSON.stringify({
      windows: persistedWins,
      connections: persistedConns,
    });
  }, [conns, wins]);

  useKeyboardCtrls({ setWins, rect, cancelConnectRef, snapRef: snapChordRef });
  useFitMaximized({ wsRef, viewRef, setWins });

  // Issue #1580 — the WorkspaceApi object and all of its action closures are the
  // props that flow into every WindowFrame and the ConnectionsLayer. Built fresh
  // each render they change identity every pan/zoom rAF frame, which makes any
  // React.memo on those children a permanent no-op and re-renders all N windows
  // per frame. Every closure below already mutates via setWins functional updaters
  // and reads live state through winsRef/connsRef/viewRef/zc, so it captures NO
  // stale wins/conns/view and can be built ONCE. The optional scope-bind callbacks are
  // now routed through refs (stable* wrappers, GEN-PERF-RENDER-001), so even a parent
  // swapping their identities every render no longer rebinds connectActions/api.
  const mutations = useMemo(
    () => makeMutations({ setWins, zc, worldVP, winsRef }),
    [setWins, zc, worldVP, winsRef],
  );
  const focusWindow = useCallback<WorkspaceApi["focus"]>(
    (id) => {
      const target = winsByIdRef.current.get(id);
      if (target !== undefined && isWorkspaceWindowSelectable(target)) {
        setSelection((current) =>
          normalizeWorkspaceSelection(winsRef.current, {
            ...current,
            focusedWindowId: id,
          }),
        );
      }
      mutations.focus(id);
    },
    [mutations, winsByIdRef, winsRef],
  );
  const layout = useMemo(() => makeLayoutActions({ setWins, worldVP }), [setWins, worldVP]);
  const snap = useMemo(
    () => makeSnapActions({ setSnapPrev, snapZone, worldVP, update: mutations.update }),
    [setSnapPrev, snapZone, worldVP, mutations],
  );
  // GEN-UI-KEYBOARD-009 — publish the snap actions to the keyboard-chord ref so
  // Cmd/Ctrl+Alt+Arrow can arm and commit a snap without re-attaching the keydown
  // listener when the (memoized) snap actions change identity.
  snapChordRef.current = snap;
  const connectActions = useMemo(
    () =>
      makeConnectActions({
        wsRef,
        viewRef,
        winsRef,
        connsRef,
        winsByIdRef,
        connsByIdRef,
        connsByEndpointRef,
        connectingRef,
        connectCleanupRef,
        focus: focusWindow,
        setConns,
        setConnecting,
        onScopeBind: stableScopeBind,
        onScopeUnbind: stableScopeUnbind,
        onConnectorBind: stableConnectorBind,
        onConnectorUnbind: stableConnectorUnbind,
      }),
    [
      wsRef,
      viewRef,
      winsRef,
      connsRef,
      winsByIdRef,
      connsByIdRef,
      connsByEndpointRef,
      connectingRef,
      connectCleanupRef,
      focusWindow,
      setConns,
      setConnecting,
      stableScopeBind,
      stableScopeUnbind,
      stableConnectorBind,
      stableConnectorUnbind,
    ],
  );
  cancelConnectRef.current = connectActions.cancelConnect;

  // uiux-fix F008 C120 — closing a connected window must fire the same unbind callbacks as
  // removing the edge badge (removeConn), otherwise the visible relationship disappears while
  // the chat stays server-side grounded against the folder/capsule. useConnectionPrune cannot
  // do this: by the time it runs, the closed window is gone from winsRef and the bind roots can
  // no longer be derived — so the teardown runs here, BEFORE the window list shrinks. The prune
  // effect afterwards only sweeps the now-orphaned edge objects.
  const closeWithTeardown = useCallback<WorkspaceApi["close"]>(
    (id) => {
      const win = winsByIdRef.current.get(id);
      if (win !== undefined) {
        for (const c of connsByEndpointRef.current.get(id) ?? []) {
          unbindClosedWindowConnection(
            id,
            win,
            c,
            winsByIdRef.current,
            stableScopeUnbind,
            stableConnectorUnbind,
          );
        }
      }
      mutations.close(id);
    },
    [winsByIdRef, connsByEndpointRef, mutations, stableScopeUnbind, stableConnectorUnbind],
  );

  const updateConnBoundScope = useCallback<WorkspaceApi["updateConnBoundScope"]>(
    (connId, scope) => {
      setConns((cs) =>
        cs.map((conn) =>
          conn.id === connId
            ? {
                ...conn,
                boundScopeKind: scope.kind,
                ...(scope.root !== undefined ? { boundRoot: scope.root } : {}),
                ...(scope.relativePaths[0] !== undefined
                  ? { boundRelativePath: scope.relativePaths[0] }
                  : {}),
              }
            : conn,
        ),
      );
    },
    [setConns],
  );

  // Issue #1580 — stable accessor for the live view (mirrors rect()); lets window
  // children read pan/zoom at gesture-start without a per-frame `view` prop.
  const currentView = useCallback((): View => viewRef.current, [viewRef]);
  const currentSelection = useCallback<WorkspaceApi["currentSelection"]>(
    () => selectionRef.current,
    [selectionRef],
  );
  const replaceSelection = useCallback<WorkspaceApi["replaceSelection"]>(
    (windowIds) => {
      setSelection((current) => {
        const next = replaceWorkspaceSelection(winsRef.current, windowIds);
        return next.focusedWindowId === current.focusedWindowId &&
          next.selectedWindowIds.length === current.selectedWindowIds.length &&
          next.selectedWindowIds.every((id, index) => id === current.selectedWindowIds[index])
          ? current
          : next;
      });
    },
    [winsRef],
  );
  const toggleWindowSelection = useCallback<WorkspaceApi["toggleWindowSelection"]>(
    (windowId) => {
      setSelection((current) => toggleWorkspaceSelection(winsRef.current, current, windowId));
    },
    [winsRef],
  );
  const clearSelection = useCallback<WorkspaceApi["clearSelection"]>(() => {
    setSelection((current) =>
      current.focusedWindowId === null && current.selectedWindowIds.length === 0
        ? current
        : { focusedWindowId: null, selectedWindowIds: [] },
    );
  }, []);
  const moveSelectedWindowsBy = useCallback<WorkspaceApi["moveSelectedWindowsBy"]>(
    (dx, dy) => {
      const vp = worldVP();
      if (vp === null) return { dx: 0, dy: 0 };
      const result = moveSelectedWorkspaceWindows(
        winsRef.current,
        selectionRef.current.selectedWindowIds,
        { dx, dy },
        vp,
      );
      if (result.wins !== winsRef.current) {
        winsRef.current = result.wins as AppWindow[];
        setWins(result.wins as AppWindow[]);
      }
      return result.appliedDelta;
    },
    [selectionRef, setWins, winsRef, worldVP],
  );
  const copySelectedWindows = useCallback<WorkspaceApi["copySelectedWindows"]>(() => {
    if (!winsReadyRef.current) return false;
    const payload = buildWorkspaceClipboardPayload(
      winsRef.current,
      selectionRef.current.selectedWindowIds,
    );
    if (payload === null) return false;
    workspaceClipboardRef.current = payload;
    workspaceClipboardPasteCountRef.current = 1;
    return true;
  }, [selectionRef, winsReadyRef, winsRef]);
  const pasteCopiedWindows = useCallback<WorkspaceApi["pasteCopiedWindows"]>(() => {
    if (!winsReadyRef.current || workspaceClipboardRef.current === null) return false;
    const vp = worldVP();
    if (vp === null) return false;
    const result = duplicateWorkspaceClipboardWindows({
      wins: winsRef.current,
      payload: workspaceClipboardRef.current,
      viewport: vp,
      zStart: zc.current,
      nowMs: Date.now(),
      pasteOffsetPx: WORKSPACE_CLIPBOARD_PASTE_OFFSET_PX * workspaceClipboardPasteCountRef.current,
    });
    if (result === null) return false;
    zc.current = result.nextZ;
    workspaceClipboardPasteCountRef.current += 1;
    setWins(result.wins as AppWindow[]);
    setSelection(replaceWorkspaceSelection(result.wins, result.pastedWindowIds));
    return true;
  }, [setWins, winsReadyRef, winsRef, worldVP, zc]);

  // Component unmount must also drop the global listener.
  useEffect(
    () => () => {
      if (connectCleanupRef.current !== null) {
        connectCleanupRef.current();
        connectCleanupRef.current = null;
      }
    },
    [],
  );

  // Issue #1580 — assemble the api once per stable-input change. Because every
  // member above is now referentially stable across pan/zoom/drag frames, this
  // object keeps a constant identity during gestures, which is what lets the
  // React.memo on WindowFrame/ConnectionsLayer collapse the per-frame re-render
  // storm from O(N windows) to O(windows that actually changed).
  const api = useMemo<WorkspaceApi>(
    () => ({
      add: mutations.add,
      openEditorFile: mutations.openEditorFile,
      toggleTool: mutations.toggleTool,
      focus: focusWindow,
      currentSelection,
      replaceSelection,
      toggleWindowSelection,
      clearSelection,
      moveSelectedWindowsBy,
      copySelectedWindows,
      pasteCopiedWindows,
      close: closeWithTeardown,
      minimize: mutations.minimize,
      restore: mutations.restore,
      maximize: mutations.maximize,
      update: mutations.update,
      setSnap: snap.setSnap,
      commitSnap: snap.commitSnap,
      tileAll: layout.tileAll,
      splitFront: layout.splitFront,
      cascade: layout.cascade,
      startConnect: connectActions.startConnect,
      confirmConnect: connectActions.confirmConnect,
      cancelConnect: connectActions.cancelConnect,
      removeConn: connectActions.removeConn,
      updateConnBoundScope,
      connect: connectActions.connect,
      linkedFilesRoot: connectActions.linkedFilesRoot,
      linkedFilesContext: connectActions.linkedFilesContext,
      linkedAllFilesRoots: connectActions.linkedAllFilesRoots,
      linkedConnectorCapsuleIds: connectActions.linkedConnectorCapsuleIds,
      linkedConnectorCapsuleSetIds: connectActions.linkedConnectorCapsuleSetIds,
      linkedFigmaSnapshotRunIds: connectActions.linkedFigmaSnapshotRunIds,
      linkedFigmaSnapshotSources: connectActions.linkedFigmaSnapshotSources,
      linkedImageSources: connectActions.linkedImageSources,
      currentFilesContext: connectActions.currentFilesContext,
      zoomTo,
      fitView,
      resetView,
      panBy,
      rect,
      currentView,
    }),
    [
      mutations,
      snap,
      layout,
      connectActions,
      closeWithTeardown,
      focusWindow,
      currentSelection,
      replaceSelection,
      toggleWindowSelection,
      clearSelection,
      moveSelectedWindowsBy,
      copySelectedWindows,
      pasteCopiedWindows,
      updateConnBoundScope,
      currentView,
      zoomTo,
      fitView,
      resetView,
      panBy,
      rect,
    ],
  );

  return {
    wins,
    winsById,
    snapPrev,
    palOpen,
    setPalOpen,
    conns,
    connecting,
    selection,
    view,
    api,
  };
}
