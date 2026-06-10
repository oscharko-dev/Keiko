"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode, RefObject } from "react";
import { Icons } from "./Icons";
import { WorkspaceShader } from "./WorkspaceShader";
import { ConnectionsLayer } from "./windows/ConnectionsLayer";
import { WindowFrame } from "./windows/WindowFrame";
import { WIN_TYPES } from "./windows/WindowsRegistry";
import { canConnect, relLabel } from "./windows/connectionUtils";
import type { AppWindow, ConnState, ConnectingState, Connection } from "./windows/types";
import { MAX_ZOOM, MIN_ZOOM } from "./hooks/useWorkspace";
import type { UseWorkspaceResult } from "./hooks/useWorkspace.types";

interface WorkspaceProps {
  readonly ws: UseWorkspaceResult;
  readonly wsRef: RefObject<HTMLDivElement>;
  readonly openPalette: () => void;
  readonly palette?: ReactNode;
}

function isInteractive(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest(".window") !== null ||
    target.closest(".ws-zoom") !== null ||
    target.closest(".ws-fab") !== null ||
    target.closest(".ws-empty-btn") !== null ||
    target.closest(".conn-badge") !== null
  );
}

// Step the view zoom by ±0.2, snapping onto 100% when a step would jump across
// it — after hitting the 30% floor the ±0.2 ladder is offset (30→50→70→90→110)
// and 100% would otherwise only be reachable via reset (audit C361).
function stepViewZoom(current: number, delta: number): number {
  const next = current + delta;
  if ((current < 1 && next > 1) || (current > 1 && next < 1)) return 1;
  return next;
}

function topWindow(wins: readonly AppWindow[] | null): AppWindow | null {
  if (wins === null || wins.length === 0) return null;
  let best = wins[0] as AppWindow;
  for (let i = 1; i < wins.length; i++) {
    const next = wins[i] as AppWindow;
    if (next.z > best.z) best = next;
  }
  return best;
}

function startBgPan(
  panBy: (dx: number, dy: number) => void,
  event: ReactPointerEvent<HTMLDivElement>,
): void {
  let lastX = event.clientX;
  let lastY = event.clientY;
  document.body.style.cursor = "grabbing";
  const move = (moveEvent: PointerEvent): void => {
    panBy(moveEvent.clientX - lastX, moveEvent.clientY - lastY);
    lastX = moveEvent.clientX;
    lastY = moveEvent.clientY;
  };
  const up = (): void => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    document.body.style.cursor = "";
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function windowIdFromEventTarget(target: EventTarget | null): string | undefined {
  if (!(target instanceof Element)) return undefined;
  const windowElement = target.closest<HTMLElement>(".window[data-window-id]");
  return windowElement?.dataset.windowId;
}

interface ConnectAnnouncerProps {
  readonly wins: readonly AppWindow[] | null;
  readonly connecting: ConnectingState | null;
  readonly conns: readonly Connection[];
}

// The click-to-connect state machine is otherwise purely visual (crosshair
// cursor, rubber-band path, valid/invalid window rings). This visually-hidden
// live region announces start, completion and cancellation of a connect flow
// for screen-reader users (audit C298/C004).
function ConnectAnnouncer({ wins, connecting, conns }: ConnectAnnouncerProps): ReactNode {
  const [message, setMessage] = useState("");
  const prevConnecting = useRef<ConnectingState | null>(null);
  const prevConnsLen = useRef(conns.length);

  useEffect(() => {
    const was = prevConnecting.current;
    prevConnecting.current = connecting;
    const wasLen = prevConnsLen.current;
    prevConnsLen.current = conns.length;
    if (was === null && connecting !== null) {
      const from = wins?.find((w) => w.id === connecting.from);
      const title = from !== undefined ? WIN_TYPES[from.type].title : "window";
      setMessage(`Connecting from ${title} — select a highlighted window, press Escape to cancel`);
      return;
    }
    if (was !== null && connecting === null) {
      if (conns.length > wasLen) {
        const added = conns[conns.length - 1];
        const a = added !== undefined ? wins?.find((w) => w.id === added.a) : undefined;
        const b = added !== undefined ? wins?.find((w) => w.id === added.b) : undefined;
        setMessage(
          a !== undefined && b !== undefined ? `Connected: ${relLabel(a, b)}` : "Connected",
        );
      } else {
        setMessage("Connection cancelled");
      }
    }
  }, [connecting, conns, wins]);

  return (
    <div className="sr-only" aria-live="polite">
      {message}
    </div>
  );
}

export function Workspace({ ws, wsRef, openPalette, palette }: WorkspaceProps): ReactNode {
  const { wins, view, snapPrev, conns, connecting, api } = ws;
  const top = topWindow(wins);
  const connFrom: AppWindow | null =
    connecting !== null && wins !== null
      ? (wins.find((w) => w.id === connecting.from) ?? null)
      : null;

  const connStateFor = (w: AppWindow): ConnState => {
    if (connFrom === null) return null;
    if (w.id === connFrom.id) return "source";
    return canConnect(connFrom.type, w.type) ? "valid" : "invalid";
  };

  const onBgPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    if (isInteractive(event.target)) return;
    if (connecting !== null) {
      api.cancelConnect();
      return;
    }
    startBgPan(api.panBy, event);
  };

  const bgStyle: CSSProperties = useMemo(
    () => ({
      backgroundSize: `${String(22 * view.zoom)}px ${String(22 * view.zoom)}px`,
      backgroundPosition: `${String(view.x)}px ${String(view.y)}px`,
    }),
    [view],
  );

  // Scale the scene with the CSS `zoom` property instead of `transform: scale()`
  // so children re-layout (and text/SVG re-rasterize) at the new pixel grid —
  // otherwise the browser samples a once-rasterized bitmap of the scene at its
  // natural size and upscales it, blurring widget content at zoom > 1 (#305).
  // Translation stays in `transform`; `transform` values are in outer pixels
  // and are not themselves affected by the element's own `zoom`, so the visual
  // mapping (worldPt -> workspaceLeft + view.x + worldPt * view.zoom) and the
  // pan/zoom/drag math in useWorkspace/WindowFrame are preserved.
  const sceneStyle: CSSProperties = useMemo(
    () => ({
      transform: `translate(${String(view.x)}px, ${String(view.y)}px)`,
      transformOrigin: "0 0",
      zoom: view.zoom,
    }),
    [view],
  );

  const onWorkspacePointerDownCapture = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || connecting === null || connFrom === null || wins === null) return;
    const targetId = windowIdFromEventTarget(event.target);
    if (targetId === undefined || targetId === connFrom.id) return;
    const target = wins.find((w) => w.id === targetId);
    if (target !== undefined && canConnect(connFrom.type, target.type)) {
      api.confirmConnect(target.id, event);
    }
  };

  const empty = wins !== null && wins.length === 0;

  return (
    <main
      className="workspace"
      ref={wsRef}
      aria-label="Workspace surface"
      data-connecting={connecting !== null ? "true" : undefined}
      onPointerDownCapture={onWorkspacePointerDownCapture}
      onPointerDown={onBgPointerDown}
    >
      <WorkspaceShader />
      <div className="ws-grid" style={bgStyle} aria-hidden="true" />
      <ConnectAnnouncer wins={wins} connecting={connecting} conns={conns} />
      {connecting !== null ? (
        // Visible counterpart to ConnectAnnouncer for sighted users — connect
        // mode otherwise only signals via cursor/dimming, leaving the exits
        // (Escape, background click) undiscoverable (audit F052/C411).
        // aria-hidden: the live region above already announces this.
        <div className="ws-connect-hint" aria-hidden="true">
          Click a highlighted window to connect — Esc to cancel
        </div>
      ) : null}
      {empty ? (
        <div className="ws-empty">
          {/* eslint-disable-next-line @next/next/no-img-element -- design CSS sizes the raw SVG directly */}
          <img className="ws-empty-logo" src="/assets/keiko-logo.svg" alt="" />
          <div className="ws-empty-title">Empty workspace</div>
          <div className="ws-empty-sub">Open a window to start working</div>
          <button type="button" className="ws-empty-btn" onClick={openPalette}>
            <Icons.add size={15} /> New window
          </button>
        </div>
      ) : null}

      <div className="ws-scene" style={sceneStyle}>
        {snapPrev !== null ? (
          <div
            className="snap-ghost"
            style={{ left: snapPrev.x, top: snapPrev.y, width: snapPrev.w, height: snapPrev.h }}
          />
        ) : null}
        {wins !== null ? (
          <ConnectionsLayer wins={wins} conns={conns} connecting={connecting} api={api} />
        ) : null}
        {wins !== null
          ? wins.map((w) => (
              <WindowFrame
                key={w.id}
                win={w}
                top={top !== null && w.id === top.id}
                connState={connStateFor(w)}
                view={view}
                api={api}
                wsRef={wsRef}
              />
            ))
          : null}
      </div>

      <div className="ws-zoom">
        <button
          type="button"
          className="ws-zoom-btn"
          onClick={() => api.zoomTo(stepViewZoom(view.zoom, -0.2))}
          disabled={view.zoom <= MIN_ZOOM}
          aria-label="Zoom out"
          title="Zoom out"
        >
          <Icons.zoomOut size={15} />
        </button>
        <button
          type="button"
          className="ws-zoom-pct mono"
          onClick={api.resetView}
          aria-label={`${String(Math.round(view.zoom * 100))}% — reset view`}
          title="Reset view to 100%"
        >
          {Math.round(view.zoom * 100)}%
        </button>
        <button
          type="button"
          className="ws-zoom-btn"
          onClick={() => api.zoomTo(stepViewZoom(view.zoom, 0.2))}
          disabled={view.zoom >= MAX_ZOOM}
          aria-label="Zoom in"
          title="Zoom in"
        >
          <Icons.zoomIn size={15} />
        </button>
      </div>

      <button
        type="button"
        className="ws-fab"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={openPalette}
        aria-label="New window"
        title="New window"
      >
        <Icons.add size={20} />
      </button>

      {palette ?? null}
    </main>
  );
}
