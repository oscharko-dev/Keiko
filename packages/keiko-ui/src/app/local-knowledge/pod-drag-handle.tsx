"use client";

import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { isPrimaryActivationPointer } from "@/app/components/desktop/interactionGuards";
import {
  dispatchConnectorDrop,
  isWorkspaceDropTarget,
  LOCAL_KNOWLEDGE_CONNECTOR_DRAG_TYPE,
  serializeLocalKnowledgeConnectorDrag,
  type LocalKnowledgeConnectorDragPayload,
} from "./connector-drag";
import { PodIcon } from "./pod-icon";

type Position = { readonly clientX: number; readonly clientY: number };
interface HandleProps {
  readonly payload: LocalKnowledgeConnectorDragPayload;
  readonly name: string;
  readonly label: string;
  readonly title?: string;
  readonly disabled?: boolean;
}

// Buffer high-frequency pointer moves: one ghost render per frame, last position wins.
function trackGhost(
  start: Position,
  setGhost: (point: Position | null) => void,
): {
  move: (event: Position) => void;
  clear: () => void;
  dragged: () => boolean;
} {
  let dragging = false;
  let frame: number | undefined;
  let latest = start;
  const previousCursor = document.body.style.cursor;
  return {
    move: (event): void => {
      if (!dragging && Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) < 6)
        return;
      dragging = true;
      document.body.style.cursor = "grabbing";
      latest = { clientX: event.clientX, clientY: event.clientY };
      frame ??= requestAnimationFrame(() => {
        frame = undefined;
        setGhost(latest);
      });
    },
    clear: (): void => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      document.body.style.cursor = previousCursor;
      setGhost(null);
    },
    dragged: (): boolean => dragging,
  };
}

function listenForDrag(
  start: Position,
  setGhost: (point: Position | null) => void,
  onDrop: (point: Position) => void,
  onEnd: () => void,
): () => void {
  const tracker = trackGhost(start, setGhost);
  const pointer = "PointerEvent" in window;
  const move = tracker.move;
  const cleanup = (): void => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cleanup);
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    window.removeEventListener("blur", cleanup);
    tracker.clear();
    onEnd();
  };
  const up = (event: PointerEvent | MouseEvent): void => {
    const dragged = tracker.dragged();
    cleanup();
    if (dragged && isWorkspaceDropTarget(event.clientX, event.clientY)) onDrop(event);
  };
  if (pointer) {
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cleanup);
  } else {
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }
  window.addEventListener("blur", cleanup);
  return cleanup;
}

function nativeDragHandlers(
  { payload, name, disabled }: HandleProps,
  emit: (point: Position) => void,
): {
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: (event: DragEvent<HTMLElement>) => void;
} {
  return {
    onDragStart: (event): void => {
      if (disabled) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData(
        LOCAL_KNOWLEDGE_CONNECTOR_DRAG_TYPE,
        serializeLocalKnowledgeConnectorDrag(payload),
      );
      event.dataTransfer.setData("text/plain", name);
    },
    onDragEnd: (event): void => {
      if (!disabled && isWorkspaceDropTarget(event.clientX, event.clientY)) emit(event);
    },
  };
}

function usePodDrag(props: HandleProps): {
  ghost: Position | null;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onMouseDown: (event: ReactMouseEvent<HTMLElement>) => void;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: (event: DragEvent<HTMLElement>) => void;
} {
  const [ghost, setGhost] = useState<Position | null>(null);
  const teardown = useRef<(() => void) | undefined>(undefined);
  const lastDrop = useRef(Number.NEGATIVE_INFINITY);
  useEffect(() => (): void => teardown.current?.(), []);
  const emit = (point: Position): void => {
    const now = performance.now();
    if (now - lastDrop.current < 250) return;
    lastDrop.current = now;
    dispatchConnectorDrop(props.payload, point);
  };
  const start = (event: ReactPointerEvent<HTMLElement> | ReactMouseEvent<HTMLElement>): void => {
    if (props.disabled || teardown.current !== undefined || !isPrimaryActivationPointer(event))
      return;
    event.preventDefault();
    event.stopPropagation();
    teardown.current = listenForDrag(event, setGhost, emit, () => {
      teardown.current = undefined;
    });
  };
  return {
    ghost,
    onPointerDown: start,
    onMouseDown: (event): void => {
      if (!("PointerEvent" in window)) start(event);
    },
    ...nativeDragHandlers(props, emit),
  };
}

/** Shared identity and drag gesture; the adjacent Add button provides keyboard access. */
export function PodDragHandle(props: HandleProps): ReactNode {
  const { ghost, ...handlers } = usePodDrag(props);
  return (
    <>
      <button
        type="button"
        className="lk-capsule-drag-handle"
        tabIndex={-1}
        aria-label={props.label}
        title={props.title}
        disabled={props.disabled}
        {...handlers}
        draggable={!props.disabled}
      >
        <span className="lk-capsule-icon">
          <PodIcon kind={props.payload.kind} />
        </span>
        <span className="lk-capsule-info">
          <span className="lk-capsule-name" title={props.name}>
            {props.name}
          </span>
        </span>
      </button>
      {ghost === null
        ? null
        : createPortal(
            <div
              className="lk-connector-drag-ghost"
              style={{ left: ghost.clientX + 14, top: ghost.clientY + 14 }}
              aria-hidden="true"
            >
              <span className="lk-connector-drag-ghost-icon">
                <PodIcon kind={props.payload.kind} />
              </span>
              <span className="lk-connector-drag-ghost-copy">{props.name}</span>
            </div>,
            document.body,
          )}
    </>
  );
}
