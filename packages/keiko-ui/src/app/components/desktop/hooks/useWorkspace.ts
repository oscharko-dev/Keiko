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
  boundScopeOf,
  filesChatBindScope,
  makeConnectActions,
  makeLayoutActions,
  makeMutations,
  makeSnapActions,
} from "./workspaceActions";
import type { ChatConnectedScope, ChatLocalKnowledgeScope } from "@/lib/types";

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

export function nextContentZoomFromWheel(current: number, deltaY: number): number {
  return clampContentZoom(current * Math.exp(-deltaY * 0.0015));
}

export function applyContentWheelZoom(win: AppWindow, deltaY: number): AppWindow {
  const current = win.zoom ?? 1;
  const zoom = nextContentZoomFromWheel(current, deltaY);
  return zoom === current ? win : { ...win, zoom };
}

function windowIdFromWheelTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>(".window[data-window-id]")?.dataset.windowId ?? null;
}

interface UsePanZoomArgs {
  readonly wsRef: RefObject<HTMLElement | null>;
  readonly view: View;
  readonly winsRef: MutableRefObject<AppWindow[]>;
  readonly setView: Dispatch<SetStateAction<View>>;
  readonly setWins: Dispatch<SetStateAction<AppWindow[] | null>>;
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

function usePanZoom({ wsRef, view, winsRef, setView, setWins }: UsePanZoomArgs): PanZoomResult {
  const viewRef = useRef<View>(view);
  viewRef.current = view;
  const pendingViewRef = useRef<View | null>(null);
  const frameRef = useRef<number | null>(null);

  // The view is a tiny {zoom,x,y} object written with no sanitize pass, so a
  // per-frame setItem is negligible (unlike the windows/connections snapshots,
  // which are debounced). Kept synchronous so it never lags the live view.
  useEffect(() => {
    persistList(VIEW_LS, view);
  }, [view]);

  useEffect(
    () => () => {
      if (frameRef.current !== null && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(frameRef.current);
      }
    },
    [],
  );

  const queueView = useCallback(
    (next: View | ((current: View) => View)): void => {
      const base = pendingViewRef.current ?? viewRef.current;
      const resolved = typeof next === "function" ? next(base) : next;
      viewRef.current = resolved;
      pendingViewRef.current = resolved;

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
        pendingViewRef.current = null;
        if (pending !== null) setView(pending);
      });
    },
    [setView],
  );

  useEffect(() => {
    const el = wsRef.current;
    if (el === null) return;
    const onWheel = (e: WheelEvent): void => {
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        const windowId = windowIdFromWheelTarget(e.target);
        if (windowId !== null) {
          setWins((ws) =>
            ws === null
              ? ws
              : ws.map((w) => (w.id === windowId ? applyContentWheelZoom(w, e.deltaY) : w)),
          );
          return;
        }
        const r = el.getBoundingClientRect();
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
      queueView((v) => ({ ...v, x: v.x - delta.x, y: v.y - delta.y }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
    };
  }, [wsRef, setWins, queueView]);

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
    (dx: number, dy: number): void => queueView((v) => ({ ...v, x: v.x + dx, y: v.y + dy })),
    [queueView],
  );

  return { viewRef, worldVP, zoomTo, fitView, resetView, panBy, rect };
}

interface UseHydrateArgs {
  readonly wsRef: RefObject<HTMLElement | null>;
  readonly setWins: Dispatch<SetStateAction<AppWindow[] | null>>;
  readonly setConns: Dispatch<SetStateAction<Connection[]>>;
  readonly zc: MutableRefObject<number>;
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

async function fetchServerWorkspaceSnapshot(): Promise<ServerWorkspaceSnapshot | null> {
  if (typeof fetch !== "function") return null;
  try {
    const response = await fetch(WORKSPACE_STATE_API, { headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("workspace" in body)) return null;
    const workspace = (body as { readonly workspace?: unknown }).workspace;
    if (typeof workspace !== "object" || workspace === null) return null;
    const record = workspace as Record<string, unknown>;
    if (
      typeof record["revision"] !== "number" ||
      !Array.isArray(record["windows"]) ||
      !Array.isArray(record["connections"])
    ) {
      return null;
    }
    return {
      revision: record["revision"],
      windows: record["windows"],
      connections: record["connections"],
    };
  } catch {
    return null;
  }
}

async function putServerWorkspaceSnapshot(
  wins: readonly AppWindow[],
  conns: readonly Connection[],
  opts: { readonly signal?: AbortSignal; readonly keepalive?: boolean } = {},
): Promise<number | null> {
  if (typeof fetch !== "function") return null;
  try {
    const response = await fetch(WORKSPACE_STATE_API, {
      method: "PUT",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Keiko-CSRF": "1",
      },
      body: JSON.stringify({ windows: wins, connections: conns }),
      // keepalive lets the final flush survive page unload (sanitize already drops
      // large data-URL payloads, so the body stays well under the 64KB limit).
      // sendBeacon cannot set the required X-Keiko-CSRF header, hence keepalive.
      ...(opts.keepalive === true ? { keepalive: true } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const workspace =
      typeof body === "object" && body !== null && "workspace" in body
        ? (body as { readonly workspace?: unknown }).workspace
        : undefined;
    if (typeof workspace !== "object" || workspace === null) return null;
    const revision = (workspace as Record<string, unknown>)["revision"];
    return typeof revision === "number" ? revision : null;
  } catch {
    return null;
  }
}

function applyPersistedWorkspaceSnapshot(
  snapshot: { readonly wins: AppWindow[]; readonly conns: Connection[] },
  setWins: Dispatch<SetStateAction<AppWindow[] | null>>,
  setConns: Dispatch<SetStateAction<Connection[]>>,
  zc: MutableRefObject<number>,
): void {
  zc.current = snapshot.wins.length === 0 ? 1 : Math.max(1, ...snapshot.wins.map((w) => w.z));
  setWins(snapshot.wins);
  setConns(snapshot.conns);
}

function useHydrate({ wsRef, setWins, setConns, zc }: UseHydrateArgs): void {
  useLayoutEffect(() => {
    const el = wsRef.current;
    if (el === null) return;
    // M1 (#532) — no seeded windows on first launch; the empty-state "New window" button
    // in Workspace.tsx and the FAB (+) are always reachable even when `wins` is [].
    applyPersistedWorkspaceSnapshot(readPersistedWorkspaceSnapshot(), setWins, setConns, zc);
  }, [wsRef, setWins, setConns, zc]);
}

interface UseStorageSyncArgs {
  readonly setWins: Dispatch<SetStateAction<AppWindow[] | null>>;
  readonly setConns: Dispatch<SetStateAction<Connection[]>>;
  readonly zc: MutableRefObject<number>;
  readonly beforeApplyRemote: () => void;
}

function useWorkspaceStorageSync({
  setWins,
  setConns,
  zc,
  beforeApplyRemote,
}: UseStorageSyncArgs): void {
  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.storageArea !== null && event.storageArea !== window.localStorage) return;
      if (event.key !== WS_LS && event.key !== CONN_LS) return;
      beforeApplyRemote();
      applyPersistedWorkspaceSnapshot(readPersistedWorkspaceSnapshot(), setWins, setConns, zc);
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
    };
  }, [setWins, setConns, zc, beforeApplyRemote]);
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

  const serverSyncEnabled = typeof navigator === "undefined" || navigator.webdriver !== true;

  // One sanitize+PUT of the LATEST snapshot (read from refs so a debounced/flush run
  // never sends stale geometry). Supersedes any in-flight PUT via AbortController and
  // advances the revision monotonically (issue #1580).
  const runServerPut = useCallback((keepalive: boolean): void => {
    const latestWins = winsRef.current;
    if (latestWins === null) return;
    const persistedWins = sanitizePersistedWindows(latestWins);
    const persistedConns = sanitizePersistedConnections(connsRef.current, persistedWins);
    putAbortRef.current?.abort();
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    putAbortRef.current = controller;
    void putServerWorkspaceSnapshot(persistedWins, persistedConns, {
      ...(controller !== null ? { signal: controller.signal } : {}),
      keepalive,
    }).then((revision) => {
      if (revision !== null && revision > revisionRef.current) revisionRef.current = revision;
    });
  }, []);

  const applyServerSnapshot = useCallback(
    (serverSnapshot: ServerWorkspaceSnapshot): void => {
      const snapshot = snapshotFromRaw(serverSnapshot.windows, serverSnapshot.connections);
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
      const serverSnapshot = await fetchServerWorkspaceSnapshot();
      if (stopped || serverSnapshot === null) return;
      if (serverSnapshot.revision <= revisionRef.current) return;
      if (
        revisionRef.current === 0 &&
        serverSnapshot.windows.length === 0 &&
        (winsRef.current?.length ?? 0) > 0
      ) {
        return;
      }
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
    if (top === null) return ws;
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
    if (top === null) return ws;
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
  if (vp.w < 520 || vp.h < 420) {
    const x = vp.x + 8;
    const y = vp.y + 8;
    return x === w.x && y === w.y ? w : { ...w, x, y };
  }
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
  readonly onScopeBind?:
    | ((chatWindowId: string, scope: ChatConnectedScope) => boolean | Promise<boolean>)
    | undefined;
  readonly onScopeUnbind?: ((chatWindowId: string, scope: ChatConnectedScope) => void) | undefined;
  readonly onConnectorBind?:
    | ((chatWindowId: string, scope: ChatLocalKnowledgeScope) => boolean | Promise<boolean>)
    | undefined;
  readonly onConnectorUnbind?:
    | ((chatWindowId: string, scope: ChatLocalKnowledgeScope) => void)
    | undefined;
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
  // Issue #1580 — destructure the optional scope-bind callbacks so the memoized
  // action factories below depend on their (stable) identities rather than on the
  // `opts` object, which defaults to a fresh `{}` every render and would otherwise
  // re-create the whole api each frame and defeat memoization.
  const { onScopeBind, onScopeUnbind, onConnectorBind, onConnectorUnbind } = opts;
  const zc = useRef<number>(3);
  const snapZone = useRef<SnapZone | null>(null);
  const suppressNextServerPersistRef = useRef(false);
  const beforeApplyRemote = useCallback((): void => {
    suppressNextServerPersistRef.current = true;
  }, []);

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

  const { viewRef, worldVP, zoomTo, fitView, resetView, panBy, rect } = usePanZoom({
    wsRef,
    view,
    winsRef,
    setView,
    setWins,
  });

  useHydrate({ wsRef, setWins, setConns, zc });
  useWorkspaceStorageSync({ setWins, setConns, zc, beforeApplyRemote });
  useWorkspaceServerSync({
    wins,
    conns,
    setWins,
    setConns,
    zc,
    suppressNextPersistRef: suppressNextServerPersistRef,
  });

  // Debounced localStorage persistence (issue #1580): a drag/resize mutates wins
  // every frame; without this each frame ran a synchronous sanitize + JSON.stringify
  // + setItem. The sanitize pipeline still runs in full on the eventual write, so
  // multi-tab byte-identity is preserved.
  useDebouncedPersist(() => {
    if (wins !== null) persistList(CONN_LS, sanitizePersistedConnections(conns, wins));
  }, [conns, wins]);

  useConnectionPrune(wins, setConns);

  useDebouncedPersist(() => {
    if (wins !== null) persistList(WS_LS, sanitizePersistedWindows(wins));
  }, [wins]);

  useKeyboardCtrls({ setWins, rect, cancelConnectRef });
  useFitMaximized({ wsRef, viewRef, setWins });

  // Issue #1580 — the WorkspaceApi object and all of its action closures are the
  // props that flow into every WindowFrame and the ConnectionsLayer. Built fresh
  // each render they change identity every pan/zoom rAF frame, which makes any
  // React.memo on those children a permanent no-op and re-renders all N windows
  // per frame. Every closure below already mutates via setWins functional updaters
  // and reads live state through winsRef/connsRef/viewRef/zc, so it captures NO
  // stale wins/conns/view and can be built ONCE. The only non-stable inputs are the
  // optional scope-bind callbacks, which are listed in the relevant deps so a parent
  // swapping a callback still rebinds.
  const mutations = useMemo(
    () => makeMutations({ setWins, zc, worldVP, winsRef }),
    [setWins, zc, worldVP, winsRef],
  );
  const layout = useMemo(() => makeLayoutActions({ setWins, worldVP }), [setWins, worldVP]);
  const snap = useMemo(
    () => makeSnapActions({ setSnapPrev, snapZone, worldVP, update: mutations.update }),
    [setSnapPrev, snapZone, worldVP, mutations],
  );
  const connectActions = useMemo(
    () =>
      makeConnectActions({
        wsRef,
        viewRef,
        winsRef,
        connsRef,
        connectingRef,
        connectCleanupRef,
        focus: mutations.focus,
        setConns,
        setConnecting,
        onScopeBind,
        onScopeUnbind,
        onConnectorBind,
        onConnectorUnbind,
      }),
    [
      wsRef,
      viewRef,
      winsRef,
      connsRef,
      connectingRef,
      connectCleanupRef,
      mutations,
      setConns,
      setConnecting,
      onScopeBind,
      onScopeUnbind,
      onConnectorBind,
      onConnectorUnbind,
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
          const chatWindowId =
            c.boundChatWindowId ??
            (win.type === "chat" ? win.id : other.type === "chat" ? other.id : null);
          const scope = boundScopeOf(c) ?? filesChatBindScope(win, other, Date.now());
          if (scope !== null && chatWindowId !== null) onScopeUnbind?.(chatWindowId, scope);
          const connectorScope = boundConnectorScopeOf(c) ?? connectorChatBind(win, other);
          if (connectorScope !== null && chatWindowId !== null) {
            onConnectorUnbind?.(chatWindowId, connectorScope);
          }
        }
      }
      mutations.close(id);
    },
    [winsRef, connsRef, mutations, onScopeUnbind, onConnectorUnbind],
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
      focus: mutations.focus,
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
      updateConnBoundScope,
      currentView,
      zoomTo,
      fitView,
      resetView,
      panBy,
      rect,
    ],
  );

  return { wins, snapPrev, palOpen, setPalOpen, conns, connecting, view, api };
}
