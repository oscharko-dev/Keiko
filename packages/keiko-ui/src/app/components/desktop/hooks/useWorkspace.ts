"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";
import { defaultLayout } from "../windows/connectionUtils";
import type { SnapZone } from "../windows/connectionUtils";
import { WIN_TYPES } from "../windows/WindowsRegistry";
import type { AppWindow, Connection, ConnectingState, SnapPrev, View } from "../windows/types";
import type { UseWorkspaceResult, ViewportWorld, WorkspaceApi } from "./useWorkspace.types";
import {
  parsePersistedConnections,
  parsePersistedWindows,
  sanitizePersistedConnections,
  sanitizePersistedWindows,
} from "./workspace-persistence";
import {
  boundConnectorScopeOf,
  connectorChatBind,
  filesChatBindRoot,
  makeConnectActions,
  makeLayoutActions,
  makeMutations,
  makeSnapActions,
} from "./workspaceActions";
import type { ChatLocalKnowledgeScope } from "@/lib/types";

export type { AppWindow, Connection, ConnectingState, SnapPrev, View };
export type { SnapZone } from "../windows/connectionUtils";
export type { UseWorkspaceResult, ViewportWorld, WorkspaceApi };

const WS_LS = "keiko.workspace.v4";
const CONN_LS = "keiko.conns.v1";
const VIEW_LS = "keiko.view";
// Exported so the zoom controls in Workspace.tsx can disable themselves at the
// clamp limits instead of swallowing clicks silently (audit C132/C361).
export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 2.5;
const CONTENT_MIN_ZOOM = 0.5;
const CONTENT_MAX_ZOOM = 2;

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
        zoom: p.zoom,
        x: typeof p.x === "number" ? p.x : 0,
        y: typeof p.y === "number" ? p.y : 0,
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

function topZ(ws: readonly AppWindow[]): AppWindow {
  // Safe: callers gate on ws.length > 0.
  let best = ws[0] as AppWindow;
  for (let i = 1; i < ws.length; i++) {
    const next = ws[i] as AppWindow;
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
  x = Math.max(-(win.w - 120), Math.min(rect.width - 120, x));
  y = Math.max(0, Math.min(rect.height - 38, y));
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

interface UsePanZoomArgs {
  readonly wsRef: RefObject<HTMLElement | null>;
  readonly view: View;
  readonly setView: Dispatch<SetStateAction<View>>;
}

interface PanZoomResult {
  readonly viewRef: MutableRefObject<View>;
  readonly worldVP: () => ViewportWorld | null;
  readonly zoomTo: (z: number) => void;
  readonly resetView: () => void;
  readonly panBy: (dx: number, dy: number) => void;
  readonly rect: () => DOMRect | null;
}

function usePanZoom({ wsRef, view, setView }: UsePanZoomArgs): PanZoomResult {
  const viewRef = useRef<View>(view);
  viewRef.current = view;

  useEffect(() => {
    persistList(VIEW_LS, view);
  }, [view]);

  useEffect(() => {
    const el = wsRef.current;
    if (el === null) return;
    const onWheel = (e: WheelEvent): void => {
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        const r = el.getBoundingClientRect();
        const v = viewRef.current;
        const z2 = clampViewZoom(v.zoom * Math.exp(-e.deltaY * 0.0015));
        const wx = (e.clientX - r.left - v.x) / v.zoom;
        const wy = (e.clientY - r.top - v.y) / v.zoom;
        setView({ zoom: z2, x: e.clientX - r.left - wx * z2, y: e.clientY - r.top - wy * z2 });
        return;
      }
      const target = e.target;
      if (target instanceof Element && target.closest(".window") !== null) return;
      e.preventDefault();
      setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
    };
  }, [wsRef, setView]);

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
      setView({ zoom: z2, x: cx - wx * z2, y: cy - wy * z2 });
    },
    [rect, setView],
  );

  const resetView = useCallback((): void => setView({ zoom: 1, x: 0, y: 0 }), [setView]);
  const panBy = useCallback(
    (dx: number, dy: number): void => setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy })),
    [setView],
  );

  return { viewRef, worldVP, zoomTo, resetView, panBy, rect };
}

interface UseHydrateArgs {
  readonly wsRef: RefObject<HTMLElement | null>;
  readonly setWins: Dispatch<SetStateAction<AppWindow[] | null>>;
  readonly setConns: Dispatch<SetStateAction<Connection[]>>;
  readonly zc: MutableRefObject<number>;
}

function useHydrate({ wsRef, setWins, setConns, zc }: UseHydrateArgs): void {
  useLayoutEffect(() => {
    const el = wsRef.current;
    if (el === null) return;
    const r = el.getBoundingClientRect();
    let init: AppWindow[] | null = null;
    try {
      init = parsePersistedWindows(window.localStorage.getItem(WS_LS));
    } catch {
      init = null;
    }
    // M1 (#532) — no seeded windows on first launch; the empty-state "New window" button
    // in Workspace.tsx and the FAB (+) are always reachable even when `wins` is [].
    if (init === null) init = [];
    zc.current = init.length === 0 ? 1 : Math.max(1, ...init.map((w) => w.z));
    setWins(init);
    try {
      setConns(parsePersistedConnections(window.localStorage.getItem(CONN_LS), init));
    } catch {
      /* ignore */
    }
  }, [wsRef, setWins, setConns, zc]);
}

interface UseKeyboardArgs {
  readonly setWins: Dispatch<SetStateAction<AppWindow[] | null>>;
  readonly rect: () => DOMRect | null;
  readonly cancelConnectRef: MutableRefObject<() => void>;
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

function handleContentZoomKey(
  setWins: Dispatch<SetStateAction<AppWindow[] | null>>,
  key: string,
): void {
  setWins((ws) => {
    if (ws === null || ws.length === 0) return ws;
    const top = topZ(ws);
    const z = nextContentZoom(top.zoom ?? 1, key);
    return ws.map((w) => (w.id === top.id ? { ...w, zoom: z } : w));
  });
}

function handleArrowKey(
  setWins: Dispatch<SetStateAction<AppWindow[] | null>>,
  rect: DOMRect,
  arrow: ArrowState,
  size: boolean,
): void {
  setWins((ws) => {
    if (ws === null || ws.length === 0) return ws;
    const top = topZ(ws);
    const next = size ? applyArrowResize(top, rect, arrow) : applyArrowMove(top, rect, arrow);
    return ws.map((w) => (w.id === top.id ? { ...w, ...next, max: false } : w));
  });
}

function useKeyboardCtrls({ setWins, rect, cancelConnectRef }: UseKeyboardArgs): void {
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
      // Audit C296 — plain Cmd/Ctrl+Plus/Minus/0 used to be preventDefault'ed
      // app-wide, hijacking the browser's page zoom (the primary text-scaling
      // tool, WCAG 1.4.4) for a single-window content zoom. Content zoom now
      // requires Alt as well (consistent with Alt = resize on the arrow chords);
      // the browser chords pass through untouched.
      const zoomKey = CONTENT_ZOOM_CODES[e.code];
      if ((e.metaKey || e.ctrlKey) && e.altKey && zoomKey !== undefined) {
        e.preventDefault();
        handleContentZoomKey(setWins, zoomKey);
        return;
      }
      if (!/^Arrow/.test(e.key)) return;
      const move = e.metaKey || e.ctrlKey;
      const size = e.altKey;
      if (!move && !size) return;
      e.preventDefault();
      const r = rect();
      if (r === null) return;
      handleArrowKey(setWins, r, { key: e.key, shift: e.shiftKey }, size);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [setWins, rect, cancelConnectRef]);
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
  const x = Math.max(vp.x - (w.w - 120), Math.min(vp.x + vp.w - 120, w.x));
  const y = Math.max(vp.y, Math.min(vp.y + vp.h - 38, w.y));
  return x === w.x && y === w.y ? w : { ...w, x, y };
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
      setWins((ws) => (ws === null ? ws : ws.map((w) => fitWindowToViewport(w, vp))));
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
    setConns((cs) => {
      const filtered = cs.filter(
        (c) =>
          wins.find((w) => w.id === c.a) !== undefined &&
          wins.find((w) => w.id === c.b) !== undefined,
      );
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
  readonly onScopeBind?: ((filesRoot: string) => boolean | Promise<boolean>) | undefined;
  readonly onScopeUnbind?: ((filesRoot: string) => void) | undefined;
  readonly onConnectorBind?:
    | ((scope: ChatLocalKnowledgeScope) => boolean | Promise<boolean>)
    | undefined;
  readonly onConnectorUnbind?: ((scope: ChatLocalKnowledgeScope) => void) | undefined;
}

export function useWorkspace(
  wsRef: RefObject<HTMLElement | null>,
  opts: UseWorkspaceOptions = {},
): UseWorkspaceResult {
  const [wins, setWins] = useState<AppWindow[] | null>(null);
  const [snapPrev, setSnapPrev] = useState<SnapPrev | null>(null);
  const [palOpen, setPalOpen] = useState(false);
  const [conns, setConns] = useState<Connection[]>([]);
  const [connecting, setConnecting] = useState<ConnectingState | null>(null);
  const [view, setView] = useState<View>(readView);
  const zc = useRef<number>(3);
  const snapZone = useRef<SnapZone | null>(null);

  const winsRef = useRef<AppWindow[]>([]);
  winsRef.current = wins ?? [];
  const connsRef = useRef<Connection[]>([]);
  connsRef.current = conns;
  // Refs for the click-to-connect flow. connectingRef is a synchronous view of
  // the `connecting` state for handlers fired from child components (confirm).
  // connectCleanupRef stores the global pointermove listener disposer so we
  // can tear it down from cancel/confirm without re-attaching effects.
  const connectingRef = useRef<ConnectingState | null>(null);
  connectingRef.current = connecting;
  const connectCleanupRef = useRef<(() => void) | null>(null);
  const cancelConnectRef = useRef<() => void>(() => undefined);

  const { viewRef, worldVP, zoomTo, resetView, panBy, rect } = usePanZoom({ wsRef, view, setView });

  useHydrate({ wsRef, setWins, setConns, zc });

  useEffect(() => {
    if (wins === null) return;
    persistList(CONN_LS, sanitizePersistedConnections(conns, wins));
  }, [conns, wins]);

  useConnectionPrune(wins, setConns);

  useEffect(() => {
    if (wins !== null) persistList(WS_LS, sanitizePersistedWindows(wins));
  }, [wins]);

  useKeyboardCtrls({ setWins, rect, cancelConnectRef });
  useFitMaximized({ wsRef, viewRef, setWins });

  const { update, focus, close, maximize, add, toggleTool } = makeMutations({
    setWins,
    zc,
    worldVP,
  });
  const { tileAll, splitFront, cascade } = makeLayoutActions({ setWins, worldVP });
  const { setSnap, commitSnap } = makeSnapActions({ setSnapPrev, snapZone, worldVP, update });
  const {
    startConnect,
    confirmConnect,
    cancelConnect,
    removeConn,
    connect,
    linkedFilesRoot,
    linkedFilesContext,
    linkedAllFilesRoots,
    linkedConnectorCapsuleIds,
    linkedConnectorCapsuleSetIds,
    linkedFigmaSnapshotRunIds,
    currentFilesContext,
  } = makeConnectActions({
    wsRef,
    viewRef,
    winsRef,
    connsRef,
    connectingRef,
    connectCleanupRef,
    focus,
    setConns,
    setConnecting,
    onScopeBind: opts.onScopeBind,
    onScopeUnbind: opts.onScopeUnbind,
    onConnectorBind: opts.onConnectorBind,
    onConnectorUnbind: opts.onConnectorUnbind,
  });
  cancelConnectRef.current = cancelConnect;

  // uiux-fix F008 C120 — closing a connected window must fire the same unbind callbacks as
  // removing the edge badge (removeConn), otherwise the visible relationship disappears while
  // the chat stays server-side grounded against the folder/capsule. useConnectionPrune cannot
  // do this: by the time it runs, the closed window is gone from winsRef and the bind roots can
  // no longer be derived — so the teardown runs here, BEFORE the window list shrinks. The prune
  // effect afterwards only sweeps the now-orphaned edge objects.
  const closeWithTeardown: WorkspaceApi["close"] = (id) => {
    const win = winsRef.current.find((w) => w.id === id);
    if (win !== undefined) {
      for (const c of connsRef.current) {
        const otherId = c.a === id ? c.b : c.b === id ? c.a : null;
        if (otherId === null) continue;
        const other = winsRef.current.find((w) => w.id === otherId);
        if (other === undefined) continue;
        // Release 0.2.0 — prefer the bind-time snapshot on the Connection: the window's current
        // cfg may have moved on (Files window navigated elsewhere, another capsule selected) and
        // re-deriving from it would unbind the WRONG source. cfg-derivation remains the fallback
        // for edges persisted before the snapshot fields existed.
        const root = c.boundRoot ?? filesChatBindRoot(win, other);
        if (root !== null) opts.onScopeUnbind?.(root);
        const scope = boundConnectorScopeOf(c) ?? connectorChatBind(win, other);
        if (scope !== null) opts.onConnectorUnbind?.(scope);
      }
    }
    close(id);
  };

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

  const api: WorkspaceApi = {
    add,
    toggleTool,
    focus,
    close: closeWithTeardown,
    maximize,
    update,
    setSnap,
    commitSnap,
    tileAll,
    splitFront,
    cascade,
    startConnect,
    confirmConnect,
    cancelConnect,
    removeConn,
    connect,
    linkedFilesRoot,
    linkedFilesContext,
    linkedAllFilesRoots,
    linkedConnectorCapsuleIds,
    linkedConnectorCapsuleSetIds,
    linkedFigmaSnapshotRunIds,
    currentFilesContext,
    zoomTo,
    resetView,
    panBy,
    rect,
  };

  return { wins, snapPrev, palOpen, setPalOpen, conns, connecting, view, api };
}
