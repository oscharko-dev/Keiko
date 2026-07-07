"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  RefObject,
} from "react";
import { EmptyWorkspaceBlob } from "./EmptyWorkspaceBlob";
import { Icons } from "./Icons";
import {
  acquireGrabbingBodyStyle,
  isCanvasPanPointer,
  isHandToolKeyIgnoredTarget,
  isInteractiveSurfaceTarget,
  isPrimaryActivationPointer,
  isTextEntryTarget,
  workspaceInteractionLocked,
} from "./interactionGuards";
import { ConnectionsLayer } from "./windows/ConnectionsLayer";
import { WindowFrame } from "./windows/WindowFrame";
import { WIN_TYPES } from "./windows/WindowsRegistry";
import { canConnect, relLabel } from "./windows/connectionUtils";
import type { AppWindow, ConnState, ConnectingState, Connection } from "./windows/types";
import { MAX_ZOOM, MIN_ZOOM } from "./hooks/useWorkspace";
import { useLinkRevision } from "./hooks/useLinkRevision";
import type { UseWorkspaceResult } from "./hooks/useWorkspace.types";
import {
  LOCAL_KNOWLEDGE_CONNECTOR_DROP_EVENT,
  parseLocalKnowledgeConnectorDrag,
  type LocalKnowledgeConnectorDragPayload,
  type LocalKnowledgeConnectorDropDetail,
} from "../../local-knowledge/connector-drag";
import {
  FIGMA_VIEW_DROP_EVENT,
  parseFigmaViewDrag,
  type FigmaViewDragPayload,
  type FigmaViewDropDetail,
} from "./figma-view-drag";
import {
  FIGMA_JSON_DROP_EVENT,
  parseFigmaJsonDrag,
  type FigmaJsonDragPayload,
  type FigmaJsonDropDetail,
} from "./figma-json-drag";
import {
  FIGMA_IMAGE_DROP_EVENT,
  parseFigmaImageDrag,
  type FigmaImageDragPayload,
  type FigmaImageDropDetail,
} from "./figma-image-drag";
import { syncPdfCitationPreviewWindowRegistry } from "./widgets/cards/pdf-citation-preview-session";
import selectionStyles from "./WorkspaceSelection.module.css";

const WorkspaceShader = dynamic(
  () => import("./WorkspaceShader").then((mod) => mod.WorkspaceShader),
  {
    ssr: false,
    loading: () => null,
  },
);

interface WorkspaceProps {
  readonly ws: UseWorkspaceResult;
  readonly wsRef: RefObject<HTMLDivElement>;
  readonly openPalette: () => void;
  readonly palette?: ReactNode;
  readonly children?: ReactNode;
}

export const KNOWLEDGE_CONNECTOR_NODE_SIZE = { w: 260, h: 220 } as const;
export const FIGMA_VIEW_NODE_SIZE = { w: 360, h: 360 } as const;
export const FIGMA_JSON_NODE_SIZE = { w: 520, h: 540 } as const;
export const FIGMA_IMAGE_NODE_SIZE = { w: 560, h: 420 } as const;

export function workspaceDropPointToWindowOrigin({
  clientX,
  clientY,
  rect,
  view,
  size = KNOWLEDGE_CONNECTOR_NODE_SIZE,
}: {
  readonly clientX: number;
  readonly clientY: number;
  readonly rect: DOMRect;
  readonly view: UseWorkspaceResult["view"];
  readonly size?: { readonly w: number; readonly h: number };
}): { x: number; y: number } {
  return {
    x: Math.round((clientX - rect.left - view.x) / view.zoom - size.w / 2),
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
  const kind = payloadRecord["kind"];
  return (kind === "capsule" || kind === "capsule-set") && typeof payloadRecord["id"] === "string";
}

function isFigmaViewDropDetail(detail: unknown): detail is FigmaViewDropDetail {
  if (typeof detail !== "object" || detail === null) return false;
  const record = detail as Record<string, unknown>;
  const payload = record["payload"];
  if (typeof record["clientX"] !== "number" || typeof record["clientY"] !== "number") return false;
  if (typeof payload !== "object" || payload === null) return false;
  const payloadRecord = payload as Record<string, unknown>;
  return (
    typeof payloadRecord["snapshotRunId"] === "string" &&
    typeof payloadRecord["screenId"] === "string" &&
    typeof payloadRecord["name"] === "string"
  );
}

function isFigmaJsonDropDetail(detail: unknown): detail is FigmaJsonDropDetail {
  if (typeof detail !== "object" || detail === null) return false;
  const record = detail as Record<string, unknown>;
  const payload = record["payload"];
  if (typeof record["clientX"] !== "number" || typeof record["clientY"] !== "number") return false;
  if (typeof payload !== "object" || payload === null) return false;
  const payloadRecord = payload as Record<string, unknown>;
  return (
    typeof payloadRecord["snapshotRunId"] === "string" &&
    typeof payloadRecord["screenId"] === "string" &&
    typeof payloadRecord["name"] === "string" &&
    (payloadRecord["sourceWindowId"] === undefined ||
      typeof payloadRecord["sourceWindowId"] === "string")
  );
}

function isFigmaImageDropDetail(detail: unknown): detail is FigmaImageDropDetail {
  if (typeof detail !== "object" || detail === null) return false;
  const record = detail as Record<string, unknown>;
  const payload = record["payload"];
  if (typeof record["clientX"] !== "number" || typeof record["clientY"] !== "number") return false;
  if (typeof payload !== "object" || payload === null) return false;
  const payloadRecord = payload as Record<string, unknown>;
  return (
    typeof payloadRecord["snapshotRunId"] === "string" &&
    typeof payloadRecord["screenId"] === "string" &&
    typeof payloadRecord["name"] === "string" &&
    typeof payloadRecord["imageSrc"] === "string" &&
    (payloadRecord["sourceWindowId"] === undefined ||
      typeof payloadRecord["sourceWindowId"] === "string")
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
  setPanning: (panning: boolean) => void,
): void {
  event.preventDefault();
  const target = event.currentTarget;
  target.setPointerCapture?.(event.pointerId);
  let lastX = event.clientX;
  let lastY = event.clientY;
  const releaseBodyStyle = acquireGrabbingBodyStyle();
  setPanning(true);
  const move = (moveEvent: PointerEvent): void => {
    panBy(moveEvent.clientX - lastX, moveEvent.clientY - lastY);
    lastX = moveEvent.clientX;
    lastY = moveEvent.clientY;
  };
  const up = (): void => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    setPanning(false);
    if (target.hasPointerCapture?.(event.pointerId) === true) {
      target.releasePointerCapture?.(event.pointerId);
    }
    releaseBodyStyle();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
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
      // GEN-UI-KEYBOARD-011 — spell out the keyboard completion path so it is
      // discoverable to screen-reader/keyboard users: Tab to a highlighted target
      // window, then Enter (on the window or one of its connection ports) to
      // complete, or Escape to cancel. Sighted users get the ws-connect-hint below.
      setMessage(
        `Connecting from ${title}. Tab to a highlighted window and press Enter on it or one of its connection ports to connect. Press Escape to cancel.`,
      );
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

// Issue #1580/#2004 — the zoom value the scene's CSS `zoom` property is pinned to.
// It trails the live view.zoom by a short settle delay: while a zoom gesture is in
// flight the pinned value does NOT change (so the layout-affecting `zoom` property
// stays byte-identical and NO relayout fires at gesture start); ~160ms after the
// last zoom change it catches up, which is the single crisp re-layout per gesture
// (#305 anti-blur). A gesture that returns to the settled zoom triggers no layout
// at all. Pan-only changes (zoom unchanged) never touch it.
const ZOOM_SETTLE_MS = 160;
const MARQUEE_DRAG_THRESHOLD_PX = 4;

interface MarqueeRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface MarqueeSession {
  readonly startX: number;
  readonly startY: number;
  readonly mode: "replace" | "add" | "toggle";
  readonly rect: MarqueeRect;
}

function useSettledZoom(zoom: number): number {
  const [settled, setSettled] = useState(zoom);
  const prevZoomRef = useRef(zoom);
  const idleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (zoom === prevZoomRef.current) return;
    prevZoomRef.current = zoom;
    if (idleRef.current !== null) clearTimeout(idleRef.current);
    idleRef.current = setTimeout(() => {
      idleRef.current = null;
      setSettled(zoom);
    }, ZOOM_SETTLE_MS);
  }, [zoom]);
  useEffect(
    () => () => {
      if (idleRef.current !== null) clearTimeout(idleRef.current);
    },
    [],
  );
  return settled;
}

function marqueeMode(event: ReactPointerEvent<HTMLElement>): MarqueeSession["mode"] {
  if (event.metaKey || event.ctrlKey) return "toggle";
  if (event.shiftKey) return "add";
  return "replace";
}

function marqueeRect(
  startX: number,
  startY: number,
  currentX: number,
  currentY: number,
): MarqueeRect {
  return {
    left: Math.min(startX, currentX),
    top: Math.min(startY, currentY),
    width: Math.abs(currentX - startX),
    height: Math.abs(currentY - startY),
  };
}

function marqueeIsActive(rect: MarqueeRect): boolean {
  return rect.width >= MARQUEE_DRAG_THRESHOLD_PX || rect.height >= MARQUEE_DRAG_THRESHOLD_PX;
}

function clientRectToWorldRect(
  rect: MarqueeRect,
  view: UseWorkspaceResult["view"],
): {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
} {
  const left = (rect.left - view.x) / view.zoom;
  const top = (rect.top - view.y) / view.zoom;
  return {
    left,
    top,
    right: left + rect.width / view.zoom,
    bottom: top + rect.height / view.zoom,
  };
}

function windowIntersectsRect(
  win: AppWindow,
  rect: ReturnType<typeof clientRectToWorldRect>,
): boolean {
  const right = win.x + win.w;
  const bottom = win.y + win.h;
  return win.x <= rect.right && right >= rect.left && win.y <= rect.bottom && bottom >= rect.top;
}

function selectableMarqueeHits(
  wins: readonly AppWindow[] | null,
  rect: MarqueeRect,
  view: UseWorkspaceResult["view"],
): readonly string[] {
  if (wins === null || !marqueeIsActive(rect)) return [];
  const worldRect = clientRectToWorldRect(rect, view);
  return wins
    .filter(
      (win) => win.minimized !== true && win.max !== true && windowIntersectsRect(win, worldRect),
    )
    .map((win) => win.id);
}

function mergeMarqueeSelection(
  current: readonly string[],
  hits: readonly string[],
  mode: MarqueeSession["mode"],
): readonly string[] {
  if (mode === "replace") return hits;
  if (mode === "add") return [...current, ...hits];
  const hitSet = new Set(hits);
  const kept = current.filter((id) => !hitSet.has(id));
  const currentSet = new Set(current);
  return [...kept, ...hits.filter((id) => !currentSet.has(id))];
}

export function Workspace({
  ws,
  wsRef,
  openPalette,
  palette,
  children,
}: WorkspaceProps): ReactNode {
  const { wins, view, snapPrev, conns, connecting, selection, api } = ws;
  // GEN-PERF-WORKSPACE-003 — the four drop-handler add*Node callbacks read the live
  // `view` for drop-point→world conversion. Closing over `view` forced it into their
  // dep arrays, so each pan/zoom rAF frame re-created the callbacks and tore down +
  // re-added all four window-level drop listeners. Read `view` through a ref instead
  // so the callbacks (and their listener effects) stay identity-stable across frames.
  const viewRef = useRef(view);
  viewRef.current = view;
  const [panning, setPanning] = useState(false);
  const [handTool, setHandTool] = useState(false);
  const [marquee, setMarquee] = useState<MarqueeSession | null>(null);
  const handToolRef = useRef(false);
  const settledZoom = useSettledZoom(view.zoom);
  const visibleWins = useMemo(
    () => (wins === null ? null : wins.filter((w) => w.minimized !== true)),
    [wins],
  );
  const linkRevision = useLinkRevision(wins, conns);
  const top = topWindow(visibleWins);
  const selectedWindowIds = useMemo(
    () => new Set(selection.selectedWindowIds),
    [selection.selectedWindowIds],
  );
  const connFrom: AppWindow | null =
    connecting !== null && visibleWins !== null
      ? (visibleWins.find((w) => w.id === connecting.from) ?? null)
      : null;
  const connStateById = useMemo(() => {
    const stateById = new Map<string, ConnState>();
    if (connFrom === null || visibleWins === null) return stateById;
    for (const win of visibleWins) {
      stateById.set(
        win.id,
        win.id === connFrom.id
          ? "source"
          : canConnect(connFrom.type, win.type)
            ? "valid"
            : "invalid",
      );
    }
    return stateById;
  }, [connFrom, visibleWins]);

  const startMarqueeSelection = (
    event: ReactPointerEvent<HTMLDivElement>,
    surfaceRect: DOMRect,
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    target.setPointerCapture?.(event.pointerId);
    const startX = event.clientX - surfaceRect.left;
    const startY = event.clientY - surfaceRect.top;
    const mode = marqueeMode(event);
    let latestRect = marqueeRect(startX, startY, startX, startY);
    setMarquee({ startX, startY, mode, rect: latestRect });
    const move = (moveEvent: PointerEvent): void => {
      const currentX = moveEvent.clientX - surfaceRect.left;
      const currentY = moveEvent.clientY - surfaceRect.top;
      latestRect = marqueeRect(startX, startY, currentX, currentY);
      setMarquee((current) =>
        current === null
          ? current
          : {
              ...current,
              rect: latestRect,
            },
      );
    };
    const cleanup = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      if (target.hasPointerCapture?.(event.pointerId) === true) {
        target.releasePointerCapture?.(event.pointerId);
      }
      setMarquee(null);
    };
    const up = (): void => {
      const hits = selectableMarqueeHits(visibleWins, latestRect, viewRef.current);
      const next = mergeMarqueeSelection(selection.selectedWindowIds, hits, mode);
      api.replaceSelection(next);
      cleanup();
    };
    const cancel = (): void => {
      cleanup();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  };

  const onBgPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (workspaceInteractionLocked()) return;
    if (isInteractiveSurfaceTarget(event.target)) return;
    if (connecting !== null) {
      if (isPrimaryActivationPointer(event)) {
        api.cancelConnect();
      }
      return;
    }
    if (!isCanvasPanPointer(event)) return;
    if (isPrimaryActivationPointer(event)) {
      startMarqueeSelection(event, event.currentTarget.getBoundingClientRect());
      return;
    }
    startBgPan(api.panBy, event, setPanning);
  };

  useEffect(() => {
    const setHandToolActive = (active: boolean): void => {
      handToolRef.current = active;
      setHandTool(active);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== "Space" || isHandToolKeyIgnoredTarget(event.target)) return;
      event.preventDefault();
      if (!handToolRef.current) setHandToolActive(true);
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.code !== "Space") return;
      setHandToolActive(false);
    };
    const onBlur = (): void => {
      setHandToolActive(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // WCAG 2.1.1 (WC-01): keyboard pan when the workspace surface itself is
  // focused. Guard event.target === event.currentTarget so arrow keys inside a
  // focused window child are not captured here (those are handled by WindowFrame).
  const onSurfaceKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.target !== event.currentTarget) return;
    const key = event.key.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
      if (key === "c") {
        if (api.copySelectedWindows()) event.preventDefault();
        return;
      }
      if (key === "v") {
        if (api.pasteCopiedWindows()) event.preventDefault();
        return;
      }
    }
    const base = 48;
    const step = event.shiftKey ? base * 4 : base;
    switch (event.key) {
      case "ArrowLeft":
        api.panBy(step, 0);
        break;
      case "ArrowRight":
        api.panBy(-step, 0);
        break;
      case "ArrowUp":
        api.panBy(0, step);
        break;
      case "ArrowDown":
        api.panBy(0, -step);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const bgStyle: CSSProperties = useMemo(
    () => ({
      backgroundSize: `${String(22 * view.zoom)}px ${String(22 * view.zoom)}px`,
      backgroundPosition: `${String(view.x)}px ${String(view.y)}px`,
    }),
    [view],
  );

  // At rest, scale the scene with the CSS `zoom` property instead of `transform:
  // scale()` so children re-layout (and text/SVG re-rasterize) at the new pixel
  // grid — otherwise the browser samples a once-rasterized bitmap of the scene at
  // its natural size and upscales it, blurring widget content at zoom > 1 (#305).
  // Chrome applies CSS `zoom` to the transform translation as well, so the stored
  // outer-pixel pan is divided by the zoom to keep the visual mapping:
  //   worldPt -> workspaceLeft + view.x + worldPt * view.zoom.
  //
  // Issue #1580/#2004 — the CSS `zoom` property is PINNED to the settled zoom at
  // all times; a gesture's in-flight zoom renders as a compositor-only
  // `scale(view.zoom / settledZoom)` correction on top. Under `zoom: zS` a child at
  // world point p lays out at p·zS device px and the translate is multiplied by zS,
  // so `translate(view.x/zS) scale(view.zoom/zS)` places it at
  // `view.x + p·view.zoom` — byte-identical to the settled mapping, only the
  // rasterization differs. Because the layout-affecting `zoom` value never changes
  // while the gesture runs, a wheel-zoom triggers ZERO relayouts at gesture start
  // and exactly ONE when the settled zoom catches up ~160ms after the last step
  // (none at all if the gesture ends back on the settled zoom) — the previous form
  // dropped/re-added the `zoom` property per gesture, forcing two full relayouts of
  // every window, which is the stutter reported in #2004.
  const sceneStyle: CSSProperties = useMemo(() => {
    const scale = view.zoom / settledZoom;
    const translate = `translate(${String(view.x / settledZoom)}px, ${String(view.y / settledZoom)}px)`;
    return {
      transform: scale === 1 ? translate : `${translate} scale(${String(scale)})`,
      transformOrigin: "0 0",
      zoom: settledZoom,
    };
  }, [view, settledZoom]);

  const onWorkspacePointerDownCapture = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (workspaceInteractionLocked()) return;
    if (
      handToolRef.current &&
      isPrimaryActivationPointer(event) &&
      connecting === null &&
      !isTextEntryTarget(event.target) &&
      !isInteractiveSurfaceTarget(event.target)
    ) {
      startBgPan(api.panBy, event, setPanning);
      event.stopPropagation();
      return;
    }
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
          view: viewRef.current,
        }),
        ...KNOWLEDGE_CONNECTOR_NODE_SIZE,
      });
    },
    [api],
  );

  const addFigmaViewNode = useCallback(
    (payload: FigmaViewDragPayload, clientX: number, clientY: number, rect: DOMRect): void => {
      const id = api.add("figmaView", {
        snapshotRunId: payload.snapshotRunId,
        selectedScreenIdsJson: JSON.stringify([payload.screenId]),
        selectedScreenName: payload.name,
      });
      if (id === null) return;
      api.update(id, {
        ...workspaceDropPointToWindowOrigin({
          clientX,
          clientY,
          rect,
          view: viewRef.current,
          size: FIGMA_VIEW_NODE_SIZE,
        }),
        ...FIGMA_VIEW_NODE_SIZE,
      });
    },
    [api],
  );

  const qualityConnectionsForSource = useCallback(
    (
      sourceWindowId: string,
    ): readonly { readonly connId: string; readonly qualityId: string }[] => {
      if (wins === null) return [];
      const byId = new Map(wins.map((win) => [win.id, win]));
      const result: { connId: string; qualityId: string }[] = [];
      for (const conn of conns) {
        const otherId =
          conn.a === sourceWindowId ? conn.b : conn.b === sourceWindowId ? conn.a : null;
        if (otherId === null) continue;
        const other = byId.get(otherId);
        if (other?.type !== "quality") continue;
        result.push({ connId: conn.id, qualityId: other.id });
      }
      return result;
    },
    [conns, wins],
  );

  const addFigmaJsonNode = useCallback(
    (payload: FigmaJsonDragPayload, clientX: number, clientY: number, rect: DOMRect): void => {
      const id = api.add("figmaJson", {
        snapshotRunId: payload.snapshotRunId,
        screenId: payload.screenId,
        selectedScreenIdsJson: JSON.stringify([payload.screenId]),
        selectedScreenName: payload.name,
      });
      if (id === null) return;
      api.update(id, {
        ...workspaceDropPointToWindowOrigin({
          clientX,
          clientY,
          rect,
          view: viewRef.current,
          size: FIGMA_JSON_NODE_SIZE,
        }),
        ...FIGMA_JSON_NODE_SIZE,
      });
      if (payload.sourceWindowId === undefined) return;
      const migrated = qualityConnectionsForSource(payload.sourceWindowId);
      if (migrated.length === 0) return;
      for (const edge of migrated) api.removeConn(edge.connId);
      window.setTimeout(() => {
        for (const edge of migrated) api.connect(id, edge.qualityId);
      }, 0);
    },
    [api, qualityConnectionsForSource],
  );

  const addFigmaImageNode = useCallback(
    (payload: FigmaImageDragPayload, clientX: number, clientY: number, rect: DOMRect): void => {
      const id = api.add("figmaImage", {
        snapshotRunId: payload.snapshotRunId,
        screenId: payload.screenId,
        selectedScreenName: payload.name,
        imageSrc: payload.imageSrc,
      });
      if (id === null) return;
      api.update(id, {
        ...workspaceDropPointToWindowOrigin({
          clientX,
          clientY,
          rect,
          view: viewRef.current,
          size: FIGMA_IMAGE_NODE_SIZE,
        }),
        ...FIGMA_IMAGE_NODE_SIZE,
      });
      if (payload.sourceWindowId === undefined) return;
      const migrated = qualityConnectionsForSource(payload.sourceWindowId);
      if (migrated.length === 0) return;
      for (const edge of migrated) api.removeConn(edge.connId);
      window.setTimeout(() => {
        for (const edge of migrated) api.connect(id, edge.qualityId);
      }, 0);
    },
    [api, qualityConnectionsForSource],
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

  useEffect(() => {
    const handleFigmaViewDrop = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      if (!isFigmaViewDropDetail(event.detail)) return;
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
      addFigmaViewNode(payload, clientX, clientY, rect);
    };
    window.addEventListener(FIGMA_VIEW_DROP_EVENT, handleFigmaViewDrop);
    return () => {
      window.removeEventListener(FIGMA_VIEW_DROP_EVENT, handleFigmaViewDrop);
    };
  }, [addFigmaViewNode, wsRef]);

  useEffect(() => {
    const handleFigmaJsonDrop = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      if (!isFigmaJsonDropDetail(event.detail)) return;
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
      addFigmaJsonNode(payload, clientX, clientY, rect);
    };
    window.addEventListener(FIGMA_JSON_DROP_EVENT, handleFigmaJsonDrop);
    return () => {
      window.removeEventListener(FIGMA_JSON_DROP_EVENT, handleFigmaJsonDrop);
    };
  }, [addFigmaJsonNode, wsRef]);

  useEffect(() => {
    const handleFigmaImageDrop = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      if (!isFigmaImageDropDetail(event.detail)) return;
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
      addFigmaImageNode(payload, clientX, clientY, rect);
    };
    window.addEventListener(FIGMA_IMAGE_DROP_EVENT, handleFigmaImageDrop);
    return () => {
      window.removeEventListener(FIGMA_IMAGE_DROP_EVENT, handleFigmaImageDrop);
    };
  }, [addFigmaImageNode, wsRef]);

  // GEN-PERF-WORKSPACE-002 — the pdf-citation registry only reads the fields it keys
  // on (window id+type, plus a chat window's chatId and minimized flag), yet keying
  // this effect on the whole `ws.wins` array re-ran it on every drag rAF frame (wins
  // identity churns per geometry commit). Key on a cheap signature of exactly those
  // fields so a geometry-only drag frame no longer re-syncs the registry; it runs
  // only when membership / a read field actually changes.
  const winMembershipSignature = useMemo(
    () =>
      wins === null
        ? ""
        : wins
            .map(
              (w) =>
                `${w.id}:${w.type}:${w.minimized === true ? "1" : "0"}:${
                  typeof w.cfg["chatId"] === "string" ? w.cfg["chatId"] : ""
                }`,
            )
            .join("|"),
    [wins],
  );
  useEffect(() => {
    syncPdfCitationPreviewWindowRegistry(wins);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- winMembershipSignature is the stable membership key; wins is read fresh
  }, [winMembershipSignature]);

  const onDragOver = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (
      parseLocalKnowledgeConnectorDrag(event.dataTransfer) === null &&
      parseFigmaViewDrag(event.dataTransfer) === null &&
      parseFigmaJsonDrag(event.dataTransfer) === null &&
      parseFigmaImageDrag(event.dataTransfer) === null
    ) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const onDrop = (event: ReactDragEvent<HTMLDivElement>): void => {
    const connectorPayload = parseLocalKnowledgeConnectorDrag(event.dataTransfer);
    const figmaPayload = parseFigmaViewDrag(event.dataTransfer);
    const figmaJsonPayload = parseFigmaJsonDrag(event.dataTransfer);
    const figmaImagePayload = parseFigmaImageDrag(event.dataTransfer);
    if (
      connectorPayload === null &&
      figmaPayload === null &&
      figmaJsonPayload === null &&
      figmaImagePayload === null
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    if (connectorPayload !== null) {
      addKnowledgeConnectorNode(connectorPayload, event.clientX, event.clientY, rect);
      return;
    }
    if (figmaPayload !== null) {
      addFigmaViewNode(figmaPayload, event.clientX, event.clientY, rect);
      return;
    }
    if (figmaJsonPayload !== null) {
      addFigmaJsonNode(figmaJsonPayload, event.clientX, event.clientY, rect);
      return;
    }
    if (figmaImagePayload !== null) {
      addFigmaImageNode(figmaImagePayload, event.clientX, event.clientY, rect);
    }
  };

  const empty = wins !== null && wins.length === 0;
  const hasMaximizedWindow = wins?.some((win) => win.max) ?? false;

  /* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- the workspace landmark is also the OS-style drop target for connector payloads (interactions) and requires tabIndex={0} for WCAG 2.1.1 keyboard pan (WC-01). */
  return (
    <main
      className="workspace"
      ref={wsRef}
      aria-label="Workspace surface"
      tabIndex={0}
      data-window-maxed={hasMaximizedWindow ? "true" : undefined}
      data-canvas-overlays-hidden={hasMaximizedWindow ? "true" : "false"}
      data-connecting={connecting !== null ? "true" : undefined}
      data-panning={panning ? "true" : undefined}
      data-hand-tool={handTool ? "true" : undefined}
      data-marquee={marquee !== null ? "true" : undefined}
      onPointerDownCapture={onWorkspacePointerDownCapture}
      onPointerDown={onBgPointerDown}
      onKeyDown={onSurfaceKeyDown}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <WorkspaceShader />
      <div className="ws-grid" style={bgStyle} aria-hidden="true" />
      {marquee !== null && marqueeIsActive(marquee.rect) ? (
        <div
          className={selectionStyles.marquee}
          style={{
            left: marquee.rect.left,
            top: marquee.rect.top,
            width: marquee.rect.width,
            height: marquee.rect.height,
          }}
          aria-hidden="true"
          data-testid="workspace-marquee"
        />
      ) : null}
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
          <EmptyWorkspaceBlob onNewWindow={openPalette} />
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
                connState={connStateById.get(w.id) ?? null}
                api={api}
                wsRef={wsRef}
                linkRevision={linkRevision}
                selected={selectedWindowIds.has(w.id)}
                selectedWindowCount={selectedWindowIds.size}
              />
            ))
          : null}
      </div>

      <div className="ws-zoom">
        <button
          type="button"
          className="ws-zoom-btn ui-tip cmp-tip-start"
          onClick={() => api.zoomTo(stepViewZoom(view.zoom, -0.2))}
          disabled={view.zoom <= MIN_ZOOM}
          aria-label="Zoom out"
          data-tip="Zoom out"
        >
          <Icons.zoomOut size={15} />
        </button>
        <button
          type="button"
          className="ws-zoom-btn ui-tip cmp-tip-start"
          onClick={api.fitView}
          disabled={visibleWins === null || visibleWins.length === 0}
          aria-label="Fit workspace to windows"
          data-tip="Fit workspace to windows"
        >
          <Icons.expand size={15} />
        </button>
        <button
          type="button"
          className="ws-zoom-pct mono ui-tip"
          onClick={api.resetView}
          aria-label={`${String(Math.round(view.zoom * 100))}% — reset`}
          data-tip="Reset"
        >
          {Math.round(view.zoom * 100)}%
        </button>
        <button
          type="button"
          className="ws-zoom-btn ui-tip cmp-tip-end"
          onClick={() => api.zoomTo(stepViewZoom(view.zoom, 0.2))}
          disabled={view.zoom >= MAX_ZOOM}
          aria-label="Zoom in"
          data-tip="Zoom in"
        >
          <Icons.zoomIn size={15} />
        </button>
      </div>

      <button
        type="button"
        className="ws-fab ui-tip cmp-tip-end"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={openPalette}
        aria-label="New window"
        data-tip="New window"
      >
        <Icons.add size={20} />
      </button>

      {hasMaximizedWindow ? null : (palette ?? null)}
      {children}
    </main>
  );
  /* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
}
