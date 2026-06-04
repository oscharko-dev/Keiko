"use client";

import { useMemo } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode, RefObject } from "react";
import { Icons } from "./Icons";
import { WorkspaceShader } from "./WorkspaceShader";
import { ConnectionsLayer } from "./windows/ConnectionsLayer";
import { WindowFrame } from "./windows/WindowFrame";
import { canConnect } from "./windows/connectionUtils";
import type { AppWindow, ConnState } from "./windows/types";
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
    target.closest(".conn-badge") !== null
  );
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

  const sceneStyle: CSSProperties = useMemo(
    () => ({
      transform: `translate(${String(view.x)}px, ${String(view.y)}px) scale(${String(view.zoom)})`,
      transformOrigin: "0 0",
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
    <div
      className="workspace"
      ref={wsRef}
      data-connecting={connecting !== null ? "true" : undefined}
      onPointerDownCapture={onWorkspacePointerDownCapture}
      onPointerDown={onBgPointerDown}
    >
      <WorkspaceShader />
      <div className="ws-grid" style={bgStyle} aria-hidden="true" />
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
          onClick={() => api.zoomTo(view.zoom - 0.2)}
          aria-label="Zoom out"
          title="Zoom out"
        >
          <Icons.zoomOut size={15} />
        </button>
        <button
          type="button"
          className="ws-zoom-pct mono"
          onClick={api.resetView}
          aria-label="Reset view"
          title="Reset view"
        >
          {Math.round(view.zoom * 100)}%
        </button>
        <button
          type="button"
          className="ws-zoom-btn"
          onClick={() => api.zoomTo(view.zoom + 0.2)}
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
    </div>
  );
}
