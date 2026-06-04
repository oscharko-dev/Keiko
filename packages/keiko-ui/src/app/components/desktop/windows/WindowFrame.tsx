"use client";

import {
  useCallback,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { ChatWindow } from "../ChatWindow";
import { Icons, type IconName } from "../Icons";
import { subText } from "./connectionUtils";
import { CHAT_MINI_W, CHAT_MINI_H, WIN_TYPES, type WindowType } from "./WindowsRegistry";
import type { AppWindow, ConnState, View } from "./types";
import type { WorkspaceApi } from "../hooks/useWorkspace.types";

const HANDLES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
type Handle = (typeof HANDLES)[number];

const PORTS = ["t", "r", "b", "l"] as const;
type Port = (typeof PORTS)[number];

const SNAP = 30;

const MIN_W_FALLBACK = 240;
const MIN_H_FALLBACK = 150;
const CONTENT_MIN_ZOOM = 0.5;
const CONTENT_MAX_ZOOM = 2;

interface WindowFrameProps {
  readonly win: AppWindow;
  readonly top: boolean;
  readonly connState: ConnState;
  readonly view: View;
  readonly api: WorkspaceApi;
  readonly wsRef: RefObject<HTMLElement | null>;
}

interface TooSmallProps {
  readonly icon: IconName;
  readonly label: string;
}

function TooSmall({ icon, label }: TooSmallProps): ReactNode {
  const Icon = Icons[icon];
  return (
    <div className="too-small">
      <div className="ts-ico">
        <Icon size={28} />
      </div>
      <div className="ts-title">Too small to show {label}</div>
      <div className="ts-sub">Enlarge the window or zoom out</div>
      <div className="ts-arrow" aria-hidden="true">
        <svg
          width="22"
          height="22"
          viewBox="0 0 22 22"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M8 8l8 8M16 11v5h-5" />
        </svg>
      </div>
    </div>
  );
}

function clampContentZoom(z: number): number {
  return Math.max(CONTENT_MIN_ZOOM, Math.min(CONTENT_MAX_ZOOM, Math.round(z * 10) / 10));
}

interface BodySelection {
  readonly mode: "full" | "mini" | "tiny";
  readonly node: ReactNode;
}

function selectBody(
  type: WindowType,
  ew: number,
  eh: number,
  cfg: Record<string, unknown>,
  linkedRoot: string | null,
  linkedFilePath: string | undefined,
  updateCfg: (patch: Record<string, string | number | boolean | undefined>) => void,
): BodySelection {
  if (type === "chat") {
    const mini = ew < CHAT_MINI_W || eh < CHAT_MINI_H;
    return { mode: mini ? "mini" : "full", node: <ChatWindow mini={mini} linkedRoot={linkedRoot} /> };
  }
  const def = WIN_TYPES[type];
  if (ew < def.tiny.w || eh < def.tiny.h) {
    return { mode: "tiny", node: <TooSmall icon={def.icon} label={def.title} /> };
  }
  return { mode: "full", node: def.render(cfg, { linkedRoot, linkedFilePath, updateCfg }) };
}

interface DragGeometry {
  readonly z: number;
  readonly vpx0: number;
  readonly vpy0: number;
  readonly vpw: number;
  readonly vph: number;
  readonly toWX: (cx: number) => number;
  readonly toWY: (cy: number) => number;
}

function makeDragGeometry(rect: DOMRect, view: View): DragGeometry {
  const z = view.zoom;
  const toWX = (cx: number): number => (cx - rect.left - view.x) / z;
  const toWY = (cy: number): number => (cy - rect.top - view.y) / z;
  return {
    z,
    vpx0: -view.x / z,
    vpy0: -view.y / z,
    vpw: rect.width / z,
    vph: rect.height / z,
    toWX,
    toWY,
  };
}

function detectSnapZone(
  px: number,
  py: number,
  geo: DragGeometry,
  threshold: number,
): "tl" | "tr" | "bl" | "br" | "left" | "right" | "maxi" | null {
  const nL = px - geo.vpx0 < threshold;
  const nR = geo.vpx0 + geo.vpw - px < threshold;
  const nT = py - geo.vpy0 < threshold;
  const nB = geo.vpy0 + geo.vph - py < threshold;
  if (nT && nL) return "tl";
  if (nT && nR) return "tr";
  if (nB && nL) return "bl";
  if (nB && nR) return "br";
  if (nL) return "left";
  if (nR) return "right";
  if (nT) return "maxi";
  return null;
}

interface DragSession {
  readonly winId: string;
  readonly offX: number;
  readonly offY: number;
  readonly W: number;
}

function attachDragListeners(api: WorkspaceApi, geo: DragGeometry, session: DragSession): void {
  const threshold = SNAP / geo.z;
  const move = (ev: PointerEvent): void => {
    const px = geo.toWX(ev.clientX);
    const py = geo.toWY(ev.clientY);
    let nx = px - session.offX;
    let ny = py - session.offY;
    nx = Math.max(geo.vpx0 - (session.W - 120), Math.min(geo.vpx0 + geo.vpw - 120, nx));
    ny = Math.max(geo.vpy0, Math.min(geo.vpy0 + geo.vph - 38, ny));
    api.setSnap(detectSnapZone(px, py, geo, threshold));
    api.update(session.winId, { x: nx, y: ny });
  };
  const up = (): void => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    api.commitSnap(session.winId);
    document.body.style.cursor = "";
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function resizeCursor(dir: Handle): string {
  if (dir === "n" || dir === "s") return "ns-resize";
  if (dir === "e" || dir === "w") return "ew-resize";
  if (dir === "ne" || dir === "sw") return "nesw-resize";
  return "nwse-resize";
}

interface ResizeStart {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

function applyResizeDelta(
  start: ResizeStart,
  dir: Handle,
  dx: number,
  dy: number,
  type: WindowType,
): { x: number; y: number; w: number; h: number } {
  let { x, y, w, h } = start;
  if (dir.includes("e")) w = start.w + dx;
  if (dir.includes("s")) h = start.h + dy;
  if (dir.includes("w")) {
    w = start.w - dx;
    x = start.x + dx;
  }
  if (dir.includes("n")) {
    h = start.h - dy;
    y = start.y + dy;
  }
  const mn = WIN_TYPES[type].min;
  const minW = mn.w > 0 ? mn.w : MIN_W_FALLBACK;
  const minH = mn.h > 0 ? mn.h : MIN_H_FALLBACK;
  if (w < minW) {
    if (dir.includes("w")) x -= minW - w;
    w = minW;
  }
  if (h < minH) {
    if (dir.includes("n")) y -= minH - h;
    h = minH;
  }
  return { x, y, w, h };
}

export function WindowFrame({
  win,
  top,
  connState,
  view,
  api,
  wsRef,
}: WindowFrameProps): ReactNode {
  const def = WIN_TYPES[win.type];
  const Icon = Icons[def.icon];
  const zoom = win.zoom ?? 1;
  const linkedRoot =
    win.type === "chat" || win.type === "agents" ? api.linkedFilesRoot(win.id) : null;
  const linkedFilePath =
    win.type === "agents" ? api.linkedFilesContext(win.id)?.activeFilePath : undefined;
  const ew = win.w / zoom;
  const eh = win.h / zoom;
  const updateCfg = useCallback(
    (patch: Record<string, string | number | boolean | undefined>): void => {
      api.update(win.id, { cfg: { ...win.cfg, ...patch } });
    },
    [api, win.cfg, win.id],
  );
  const { mode: bodyMode, node: body } = selectBody(
    win.type,
    ew,
    eh,
    win.cfg,
    linkedRoot,
    linkedFilePath,
    updateCfg,
  );

  const setZoom = useCallback(
    (z: number): void => api.update(win.id, { zoom: clampContentZoom(z) }),
    [api, win.id],
  );

  const onHeaderPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>): void => {
      if (e.button !== 0) return;
      // When this window is a valid drop target for an in-flight connect, the
      // bubbling onPointerDown on <section> below confirms the link — don't
      // also start a header-drag, which would tear the window away from the
      // user's cursor mid-click.
      if (connState === "valid") return;
      e.preventDefault();
      api.focus(win.id);
      const el = wsRef.current;
      if (el === null) return;
      const rect = el.getBoundingClientRect();
      const geo = makeDragGeometry(rect, view);
      const wasMax = win.max;
      const restoredW = wasMax ? (win.prev?.w ?? 480) : win.w;
      const restoredH = wasMax ? (win.prev?.h ?? 360) : win.h;
      const offX = wasMax ? restoredW / 2 : geo.toWX(e.clientX) - win.x;
      const offY = wasMax ? 18 : geo.toWY(e.clientY) - win.y;
      if (wasMax) api.update(win.id, { max: false, w: restoredW, h: restoredH });
      attachDragListeners(api, geo, { winId: win.id, offX, offY, W: restoredW });
    },
    [api, win.id, win.x, win.y, win.w, win.h, win.max, win.prev, view, wsRef, connState],
  );

  const startResize = useCallback(
    (dir: Handle) =>
      (e: ReactPointerEvent<HTMLDivElement>): void => {
        e.preventDefault();
        e.stopPropagation();
        api.focus(win.id);
        const start: ResizeStart = { x: win.x, y: win.y, w: win.w, h: win.h };
        const sx = e.clientX;
        const sy = e.clientY;
        const z = view.zoom;
        const move = (ev: PointerEvent): void => {
          const dx = (ev.clientX - sx) / z;
          const dy = (ev.clientY - sy) / z;
          const next = applyResizeDelta(start, dir, dx, dy, win.type);
          api.update(win.id, { ...next, max: false });
        };
        const up = (): void => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          document.body.style.cursor = "";
        };
        document.body.style.cursor = resizeCursor(dir);
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      },
    [api, win.id, win.x, win.y, win.w, win.h, win.type, view.zoom],
  );

  // Stop propagation BEFORE delegating, so the parent .window's onPointerDown
  // (focus + drag) cannot race with the port-initiated connect handshake.
  const startPortConnect = useCallback(
    (
      target: HTMLDivElement,
      event:
        | ReactPointerEvent<HTMLDivElement>
        | ReactKeyboardEvent<HTMLDivElement>,
    ): void => {
      const rect = target.getBoundingClientRect();
      api.startConnect(win.id, {
        clientX: "clientX" in event ? event.clientX : rect.left + rect.width / 2,
        clientY: "clientY" in event ? event.clientY : rect.top + rect.height / 2,
        preventDefault: () => event.preventDefault(),
        stopPropagation: () => event.stopPropagation(),
      } as ReactPointerEvent<Element>);
    },
    [api, win.id],
  );

  const onPortPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      e.preventDefault();
      e.stopPropagation();
      startPortConnect(e.currentTarget, e);
    },
    [startPortConnect],
  );

  const onPortKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
      e.preventDefault();
      e.stopPropagation();
      startPortConnect(e.currentTarget, e);
    },
    [startPortConnect],
  );

  const sub = bodyMode === "full" ? subText(win.type, win.cfg) : null;
  const bodyStyle: CSSProperties = bodyMode === "tiny" ? {} : { zoom };
  const sectionStyle: CSSProperties = {
    left: win.x,
    top: win.y,
    width: win.w,
    height: win.h,
    zIndex: win.z,
  };

  return (
    <section
      className="window"
      data-top={top ? "true" : "false"}
      data-max={win.max ? "true" : "false"}
      data-conn={connState ?? undefined}
      data-window-id={win.id}
      style={sectionStyle}
      onPointerDown={(e) => {
        if (connState === "valid") api.confirmConnect(win.id, e);
        api.focus(win.id);
      }}
    >
      {/* Header is a drag surface; keyboard equivalent is ⌘+Arrows handled by useKeyboardCtrls. */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <header
        className="win-head"
        onPointerDown={onHeaderPointerDown}
        onDoubleClick={() => api.maximize(win.id)}
      >
        <span
          className="win-ico"
          style={{ color: def.accent === true ? "var(--accent)" : "var(--fg-muted)" }}
        >
          <Icon size={14} />
        </span>
        <span className="win-title">{def.title}</span>
        {sub !== null ? <span className="win-sub mono">{sub}</span> : null}
        <span className="spacer" />
        <div className="win-zoom">
          <button
            type="button"
            className="win-zbtn"
            title="Zoom content out"
            aria-label="Zoom content out"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setZoom(zoom - 0.1)}
          >
            <Icons.zoomOut size={13} />
          </button>
          <button
            type="button"
            className="win-zpct"
            title="Reset zoom"
            aria-label="Reset content zoom"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => api.update(win.id, { zoom: 1 })}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            className="win-zbtn"
            title="Zoom content in"
            aria-label="Zoom content in"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setZoom(zoom + 0.1)}
          >
            <Icons.zoomIn size={13} />
          </button>
        </div>
        <button
          type="button"
          className="win-btn"
          title={win.max ? "Restore" : "Maximize"}
          aria-label={win.max ? "Restore window" : "Maximize window"}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => api.maximize(win.id)}
        >
          {win.max ? <Icons.restore size={13} /> : <Icons.maximize size={13} />}
        </button>
        <button
          type="button"
          className="win-btn win-close"
          title="Close"
          aria-label="Close window"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => api.close(win.id)}
        >
          <Icons.close size={14} />
        </button>
      </header>
      <div className="win-body" data-mode={bodyMode} style={bodyStyle}>
        {body}
      </div>
      {!win.max
        ? HANDLES.map((d: Handle) => (
            <div key={d} className={`wz wz-${d}`} onPointerDown={startResize(d)} />
          ))
        : null}
      {!win.max
        ? PORTS.map((d: Port) => (
            <div
              key={`p${d}`}
              className={`win-port wp-${d}`}
              title="Click to connect to another card"
              aria-label={`Connect from ${d === "t" ? "top" : d === "r" ? "right" : d === "b" ? "bottom" : "left"} edge`}
              role="button"
              tabIndex={0}
              onPointerDown={onPortPointerDown}
              onKeyDown={onPortKeyDown}
            />
          ))
        : null}
    </section>
  );
}
