"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  RefObject,
} from "react";
import { Icons } from "./Icons";
import { WorkspaceShader } from "./WorkspaceShader";
import { ConnectionsLayer } from "./windows/ConnectionsLayer";
import { WindowFrame } from "./windows/WindowFrame";
import { WIN_TYPES } from "./windows/WindowsRegistry";
import { canConnect, relLabel } from "./windows/connectionUtils";
import type { AppWindow, ConnState, ConnectingState, Connection } from "./windows/types";
import { MAX_ZOOM, MIN_ZOOM } from "./hooks/useWorkspace";
import type { UseWorkspaceResult } from "./hooks/useWorkspace.types";
import {
  LOCAL_KNOWLEDGE_CONNECTOR_DROP_EVENT,
  parseLocalKnowledgeConnectorDrag,
  type LocalKnowledgeConnectorDragPayload,
  type LocalKnowledgeConnectorDropDetail,
} from "../../local-knowledge/connector-drag";

interface WorkspaceProps {
  readonly ws: UseWorkspaceResult;
  readonly wsRef: RefObject<HTMLDivElement>;
  readonly openPalette: () => void;
  readonly palette?: ReactNode;
}

export const KNOWLEDGE_CONNECTOR_NODE_SIZE = { w: 260, h: 220 } as const;

export function workspaceDropPointToWindowOrigin({
  clientX,
  clientY,
  rect,
  view,
}: {
  readonly clientX: number;
  readonly clientY: number;
  readonly rect: DOMRect;
  readonly view: UseWorkspaceResult["view"];
}): { x: number; y: number } {
  return {
    x: Math.round((clientX - rect.left - view.x) / view.zoom - KNOWLEDGE_CONNECTOR_NODE_SIZE.w / 2),
    y: Math.round((clientY - rect.top - view.y) / view.zoom - 28),
  };
}

function isLocalKnowledgeConnectorDropDetail(
  detail: unknown,
): detail is LocalKnowledgeConnectorDropDetail {
  if (typeof detail !== "object" || detail === null) return false;
  const record = detail as Record<string, unknown>;
  const payload = record["payload"];
  if (typeof record["clientX"] !== "number" || typeof record["clientY"] !== "number") return false;
  if (typeof payload !== "object" || payload === null) return false;
  const payloadRecord = payload as Record<string, unknown>;
  return payloadRecord["kind"] === "capsule" && typeof payloadRecord["id"] === "string";
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
  let best: AppWindow | null = null;
  for (let i = 0; i < wins.length; i++) {
    const next = wins[i] as AppWindow;
    if (next.minimized === true) continue;
    if (best === null) {
      best = next;
      continue;
    }
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
  const visibleWins = useMemo(
    () => (wins === null ? null : wins.filter((w) => w.minimized !== true)),
    [wins],
  );
  const top = topWindow(visibleWins);
  const connFrom: AppWindow | null =
    connecting !== null && visibleWins !== null
      ? (visibleWins.find((w) => w.id === connecting.from) ?? null)
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
  // Chrome applies CSS `zoom` to the transform translation as well. Divide the
  // stored outer-pixel pan by the zoom so the visual mapping stays:
  // worldPt -> workspaceLeft + view.x + worldPt * view.zoom.
  // Without this compensation, maximized windows at non-100% workspace zoom are
  // placed outside the workspace because worldVP math and rendered geometry diverge.
  const sceneStyle: CSSProperties = useMemo(
    () => ({
      transform: `translate(${String(view.x / view.zoom)}px, ${String(view.y / view.zoom)}px)`,
      transformOrigin: "0 0",
      zoom: view.zoom,
    }),
    [view],
  );

  const onWorkspacePointerDownCapture = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || connecting === null || connFrom === null || visibleWins === null)
      return;
    const targetId = windowIdFromEventTarget(event.target);
    if (targetId === undefined || targetId === connFrom.id) return;
    const target = visibleWins.find((w) => w.id === targetId);
    if (target !== undefined && canConnect(connFrom.type, target.type)) {
      api.confirmConnect(target.id, event);
    }
  };

  const addKnowledgeConnectorNode = useCallback(
    (
      payload: LocalKnowledgeConnectorDragPayload,
      clientX: number,
      clientY: number,
      rect: DOMRect,
    ): void => {
      const id = api.add("connector", {
        presentation: "node",
        selectedKind: payload.kind,
        selectedId: payload.id,
        ...(payload.label !== undefined ? { selectedLabel: payload.label } : {}),
        ...(payload.lifecycleState !== undefined ? { selectedState: payload.lifecycleState } : {}),
      });
      if (id === null) return;
      api.update(id, {
        ...workspaceDropPointToWindowOrigin({
          clientX,
          clientY,
          rect,
          view,
        }),
        ...KNOWLEDGE_CONNECTOR_NODE_SIZE,
      });
    },
    [api, view],
  );

  useEffect(() => {
    const handleConnectorDrop = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      if (!isLocalKnowledgeConnectorDropDetail(event.detail)) return;
      const rect = wsRef.current?.getBoundingClientRect();
      if (rect === undefined) return;
      const { clientX, clientY, payload } = event.detail;
      if (
        clientX < rect.left ||
        clientX > rect.right ||
        clientY < rect.top ||
        clientY > rect.bottom
      ) {
        return;
      }
      addKnowledgeConnectorNode(payload, clientX, clientY, rect);
    };
    window.addEventListener(LOCAL_KNOWLEDGE_CONNECTOR_DROP_EVENT, handleConnectorDrop);
    return () => {
      window.removeEventListener(LOCAL_KNOWLEDGE_CONNECTOR_DROP_EVENT, handleConnectorDrop);
    };
  }, [addKnowledgeConnectorNode, wsRef]);

  const onDragOver = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (parseLocalKnowledgeConnectorDrag(event.dataTransfer) === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const onDrop = (event: ReactDragEvent<HTMLDivElement>): void => {
    const payload = parseLocalKnowledgeConnectorDrag(event.dataTransfer);
    if (payload === null) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    addKnowledgeConnectorNode(payload, event.clientX, event.clientY, rect);
  };

  const empty = wins !== null && wins.length === 0;

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the workspace landmark is also the OS-style drop target for connector payloads.
    <main
      className="workspace"
      ref={wsRef}
      aria-label="Workspace surface"
      data-connecting={connecting !== null ? "true" : undefined}
      onPointerDownCapture={onWorkspacePointerDownCapture}
      onPointerDown={onBgPointerDown}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <WorkspaceShader />
      <div className="ws-grid" style={bgStyle} aria-hidden="true" />
      <ConnectAnnouncer wins={visibleWins} connecting={connecting} conns={conns} />
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
        {visibleWins !== null ? (
          <ConnectionsLayer wins={visibleWins} conns={conns} connecting={connecting} api={api} />
        ) : null}
        {visibleWins !== null
          ? visibleWins.map((w) => (
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
