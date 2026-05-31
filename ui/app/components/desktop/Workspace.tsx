"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { Icons } from "./Icons";
import { ChatWindow } from "./ChatWindow";
import { ChatSessionProvider } from "./context/ChatSessionContext";
import type { UseChatSessionResult } from "./hooks/useChatSession";

interface View {
  zoom: number;
  x: number;
  y: number;
}

const STORAGE_KEY = "keiko.view";
const DEFAULT_VIEW: View = { zoom: 1, x: 0, y: 0 };
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2.5;

function readStoredView(): View {
  if (typeof window === "undefined") return DEFAULT_VIEW;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_VIEW;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "zoom" in parsed &&
      "x" in parsed &&
      "y" in parsed
    ) {
      const candidate = parsed as Record<string, unknown>;
      const zoom = typeof candidate.zoom === "number" ? candidate.zoom : DEFAULT_VIEW.zoom;
      const x = typeof candidate.x === "number" ? candidate.x : DEFAULT_VIEW.x;
      const y = typeof candidate.y === "number" ? candidate.y : DEFAULT_VIEW.y;
      return { zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom)), x, y };
    }
    return DEFAULT_VIEW;
  } catch {
    return DEFAULT_VIEW;
  }
}

function clampZoom(z: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
}

function isInteractive(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest(".window") !== null ||
    target.closest(".ws-zoom") !== null ||
    target.closest(".ws-fab") !== null
  );
}

interface WorkspaceProps {
  session: UseChatSessionResult;
  openPalette: () => void;
}

export function Workspace({ session, openPalette }: WorkspaceProps): ReactNode {
  const wsRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<View>(readStoredView);
  const viewRef = useRef<View>(view);
  viewRef.current = view;

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(view));
    } catch {
      /* localStorage may be unavailable */
    }
  }, [view]);

  useEffect(() => {
    const element = wsRef.current;
    if (element === null) return;
    const onWheel = (event: WheelEvent): void => {
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        const rect = element.getBoundingClientRect();
        const current = viewRef.current;
        const z2 = clampZoom(current.zoom * Math.exp(-event.deltaY * 0.0015));
        const wx = (event.clientX - rect.left - current.x) / current.zoom;
        const wy = (event.clientY - rect.top - current.y) / current.zoom;
        setView({
          zoom: z2,
          x: event.clientX - rect.left - wx * z2,
          y: event.clientY - rect.top - wy * z2,
        });
        return;
      }
      if (!(event.target instanceof Element) || event.target.closest(".window") === null) {
        event.preventDefault();
        setView((current) => ({
          ...current,
          x: current.x - event.deltaX,
          y: current.y - event.deltaY,
        }));
      }
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      element.removeEventListener("wheel", onWheel);
    };
  }, []);

  const zoomBy = useCallback((delta: number) => {
    const element = wsRef.current;
    if (element === null) return;
    const rect = element.getBoundingClientRect();
    const current = viewRef.current;
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const wx = (cx - current.x) / current.zoom;
    const wy = (cy - current.y) / current.zoom;
    const z2 = clampZoom(current.zoom + delta);
    setView({ zoom: z2, x: cx - wx * z2, y: cy - wy * z2 });
  }, []);

  const resetView = useCallback(() => setView(DEFAULT_VIEW), []);

  const onBgPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    if (isInteractive(event.target)) return;
    let lastX = event.clientX;
    let lastY = event.clientY;
    document.body.style.cursor = "grabbing";
    const move = (moveEvent: PointerEvent): void => {
      setView((current) => ({
        ...current,
        x: current.x + (moveEvent.clientX - lastX),
        y: current.y + (moveEvent.clientY - lastY),
      }));
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

  // Wave-1 shim coordinates: chat-window placeholder sits at fixed canvas-relative
  // position until Welle 2 introduces WindowFrame + window-manager state.
  const chatShimStyle: CSSProperties = {
    position: "absolute",
    left: 80,
    top: 60,
    width: 720,
    height: 560,
    display: "flex",
    flexDirection: "column",
  };

  return (
    <div
      className="workspace"
      ref={wsRef}
      style={bgStyle}
      onPointerDown={onBgPointerDown}
    >
      <div className="ws-scene" style={sceneStyle}>
        {/* Welle-2-TODO: wrap ChatWindow in WindowFrame so it becomes a real draggable window. */}
        <section
          className="window"
          data-top="true"
          style={chatShimStyle}
          aria-label="GPT OSS chat window"
        >
          <ChatSessionProvider value={session}>
            <ChatWindow />
          </ChatSessionProvider>
        </section>
      </div>

      <div className="ws-zoom">
        <button
          type="button"
          className="ws-zoom-btn"
          onClick={() => zoomBy(-0.2)}
          aria-label="Zoom out"
          title="Zoom out"
        >
          <Icons.zoomOut size={15} />
        </button>
        <button
          type="button"
          className="ws-zoom-pct mono"
          onClick={resetView}
          aria-label="Reset view"
          title="Reset view"
        >
          {Math.round(view.zoom * 100)}%
        </button>
        <button
          type="button"
          className="ws-zoom-btn"
          onClick={() => zoomBy(0.2)}
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
    </div>
  );
}
