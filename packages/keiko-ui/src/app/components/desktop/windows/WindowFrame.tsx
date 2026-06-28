"use client";

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type {
  QualityIntelligenceFigmaSnapshotSource,
  QualityIntelligenceImageSource,
  WorkspaceBinding,
} from "@oscharko-dev/keiko-contracts";
import { Icons, type IconName } from "../Icons";
import { useOptionalActiveWorkspace } from "../context/ActiveWorkspaceContext";
import {
  acquireGrabbingBodyStyle,
  isInteractiveControlTarget,
  isPrimaryActivationPointer,
  isTextEntryTarget,
  isWindowDragPointer,
} from "../interactionGuards";
import { hasConnectablePeer, subText } from "./connectionUtils";
import { CHAT_MINI_W, WIN_TYPES, type WindowType } from "./WindowsRegistry";
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
const HEADER_CONTROL_GUTTER_PX = 210;
const HEADER_ZOOM_MIN_WIDTH_PX = 340;
const AUTO_GROW_EPSILON_PX = 8;

interface WindowFrameProps {
  readonly win: AppWindow;
  readonly top: boolean;
  readonly connState: ConnState;
  readonly api: WorkspaceApi;
  readonly wsRef: RefObject<HTMLElement | null>;
  /**
   * Bumped by the parent whenever the cross-window link context changes (a
   * connection added/removed or any window's cfg/type mutated) but NOT on pure
   * geometry/z changes. Carried as a prop purely so React.memo re-renders this
   * window when context it derives from OTHER windows changes — without it the
   * memo would serve stale linked* context (issue #1580).
   */
  readonly linkRevision: number;
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
      {/* Tiny mode depends on window size and *content* zoom only — point at the
          content-zoom control, not the workspace "Zoom out" button (audit C300). */}
      <div className="ts-sub">Enlarge the window or zoom its content out</div>
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

function shouldMaximizeFromHeaderDoubleClick(event: ReactMouseEvent<HTMLElement>): boolean {
  const target = event.target;
  if (target instanceof Element && target.closest("button,[role='button']") !== null) return false;
  const rect = event.currentTarget.getBoundingClientRect();
  const controlGutter = Math.min(HEADER_CONTROL_GUTTER_PX, rect.width / 2);
  return event.clientX < rect.right - controlGutter;
}

interface BodySelection {
  readonly mode: "full" | "mini" | "tiny";
  readonly node: ReactNode;
}

function selectBody(
  windowId: string,
  type: WindowType,
  ew: number,
  eh: number,
  cfg: Record<string, unknown>,
  linkedRoot: string | null,
  linkedFilePath: string | undefined,
  linkedRoots: readonly string[],
  linkedCapsuleIds: readonly string[],
  linkedCapsuleSetIds: readonly string[],
  linkedFigmaSnapshotRunIds: readonly string[],
  linkedFigmaSnapshotSources: readonly QualityIntelligenceFigmaSnapshotSource[] | undefined,
  linkedImageSources: readonly QualityIntelligenceImageSource[] | undefined,
  activeRoot: string | null,
  activeBinding: WorkspaceBinding | null,
  updateCfg: (patch: AppWindow["cfg"]) => void,
  openWindow: (type: WindowType, cfg?: AppWindow["cfg"]) => string | null,
  focusWindow: (id: string) => void,
  updateWindow: (id: string, patch: Partial<AppWindow>) => void,
  openEditorFile: WorkspaceApi["openEditorFile"],
): BodySelection {
  const def = WIN_TYPES[type];
  if (type === "chat") {
    const compact = ew < 640;
    const barCompact = ew < 520;
    const minimalChat = ew < 360 || eh < 320;
    const footerControlsCompact = ew < 520;
    const controlsNarrow = footerControlsCompact;
    const workflowCompact = footerControlsCompact;
    const mini = ew < CHAT_MINI_W;
    return {
      mode: mini ? "mini" : "full",
      node: def.render(cfg, {
        windowId,
        mini,
        minimalChat,
        compact,
        controlsNarrow,
        barCompact,
        workflowCompact,
        linkedRoot,
        linkedFilePath,
        linkedRoots,
        linkedCapsuleIds,
        linkedCapsuleSetIds,
        linkedFigmaSnapshotRunIds,
        linkedFigmaSnapshotSources,
        linkedImageSources,
        activeRoot,
        activeBinding,
        updateCfg,
        openWindow,
        focusWindow,
        updateWindow,
        openEditorFile,
      }),
    };
  }
  if (ew < def.tiny.w || eh < def.tiny.h) {
    return { mode: "tiny", node: <TooSmall icon={def.icon} label={def.title} /> };
  }
  return {
    mode: "full",
    node: def.render(cfg, {
      windowId,
      linkedRoot,
      linkedFilePath,
      linkedRoots,
      linkedCapsuleIds,
      linkedCapsuleSetIds,
      linkedFigmaSnapshotRunIds,
      linkedFigmaSnapshotSources,
      linkedImageSources,
      activeRoot,
      activeBinding,
      updateCfg,
      openWindow,
      focusWindow,
      updateWindow,
      openEditorFile,
    }),
  };
}

function shouldAutoGrowWindow(type: WindowType, cfg: Record<string, unknown>): boolean {
  return (
    type === "figmaView" &&
    typeof cfg["selectedScreenIdsJson"] === "string" &&
    cfg["selectedScreenIdsJson"].length > 0
  );
}

function autoGrowContentKey(type: WindowType, cfg: Record<string, unknown>): string | null {
  if (!shouldAutoGrowWindow(type, cfg)) return null;
  const snapshotRunId = typeof cfg["snapshotRunId"] === "string" ? cfg["snapshotRunId"] : "";
  const selectedScreenIdsJson =
    typeof cfg["selectedScreenIdsJson"] === "string" ? cfg["selectedScreenIdsJson"] : "";
  const selectedScreenName =
    typeof cfg["selectedScreenName"] === "string" ? cfg["selectedScreenName"] : "";
  return `${snapshotRunId}\n${selectedScreenIdsJson}\n${selectedScreenName}`;
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

function attachDragListeners(
  api: WorkspaceApi,
  geo: DragGeometry,
  session: DragSession,
  onDragEnd?: (() => void) | undefined,
): void {
  const threshold = SNAP / geo.z;
  // Issue #1580 — coalesce raw pointermove to one commit per animation frame,
  // mirroring the resize path (scheduleResize/flushPendingResize). A raw move
  // fired setSnap + setWins (and, transitively, the localStorage/server persist
  // effects) on EVERY pointer event — up to 120-240 Hz on high-rate mice — which
  // is the dominant cost behind the "slower when moving windows" report.
  let pendingX = 0;
  let pendingY = 0;
  let pendingZone: ReturnType<typeof detectSnapZone> = null;
  let hasPending = false;
  let lastX: number | null = null;
  let lastY: number | null = null;
  // `undefined` (not null) so the very first flush always emits a zone, matching
  // the old "setSnap on every move" baseline at gesture start.
  let lastZone: ReturnType<typeof detectSnapZone> | undefined;
  let frame: number | null = null;
  const flush = (): void => {
    frame = null;
    if (!hasPending) return;
    hasPending = false;
    if (pendingZone !== lastZone) {
      lastZone = pendingZone;
      api.setSnap(pendingZone);
    }
    if (pendingX !== lastX || pendingY !== lastY) {
      lastX = pendingX;
      lastY = pendingY;
      api.update(session.winId, { x: pendingX, y: pendingY });
    }
  };
  const schedule = (): void => {
    if (frame !== null) return;
    frame =
      typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame(flush)
        : window.setTimeout(flush, 0);
  };
  const cancelFrame = (): void => {
    if (frame === null) return;
    if (typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(frame);
    } else {
      window.clearTimeout(frame);
    }
    frame = null;
  };
  const move = (ev: PointerEvent): void => {
    const px = geo.toWX(ev.clientX);
    const py = geo.toWY(ev.clientY);
    let nx = px - session.offX;
    let ny = py - session.offY;
    nx = Math.max(geo.vpx0 - (session.W - 120), Math.min(geo.vpx0 + geo.vpw - 120, nx));
    ny = Math.max(geo.vpy0, Math.min(geo.vpy0 + geo.vph - 38, ny));
    pendingX = nx;
    pendingY = ny;
    pendingZone = detectSnapZone(px, py, geo, threshold);
    hasPending = true;
    schedule();
  };
  const up = (): void => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    // Flush the final position synchronously BEFORE commitSnap so a free drag's
    // last coordinates are applied; commitSnap then overrides them only when a
    // snap zone is armed (it is a no-op for free drags). Cancel the scheduled
    // frame first so flush() cannot also run on the next tick.
    cancelFrame();
    flush();
    api.commitSnap(session.winId);
    releaseBodyStyle();
    onDragEnd?.();
  };
  // Audit C362 — the move listeners run on window without pointer capture, so a
  // fast drag leaves the header and the cursor flickered to default/text over
  // other surfaces. Pin the grabbing cursor globally for the gesture via the shared ref-counted
  // helper so a concurrent pan/drag does not clobber the restore order (up() releases).
  const releaseBodyStyle = acquireGrabbingBodyStyle();
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
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

function sameResizeGeometry(a: ResizeStart, b: ResizeStart): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
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

// Frozen shared empty so a window with no linked context of a given kind always
// yields the SAME array identity — required for the body useMemo below to hold
// across re-renders (issue #1580).
const EMPTY_STRINGS: readonly string[] = Object.freeze([]);

interface LinkedContext {
  readonly linkedRoot: string | null;
  readonly linkedFilePath: string | undefined;
  readonly linkedRoots: readonly string[];
  readonly linkedCapsuleIds: readonly string[];
  readonly linkedCapsuleSetIds: readonly string[];
  readonly linkedFigmaSnapshotRunIds: readonly string[];
  readonly linkedFigmaSnapshotSources:
    | readonly QualityIntelligenceFigmaSnapshotSource[]
    | undefined;
  readonly linkedImageSources: readonly QualityIntelligenceImageSource[] | undefined;
}

// Shared "no linked context" identity. A window with no connected sources resolves
// to this exact object on every recompute, so a `linkRevision` bump elsewhere does
// NOT churn its body memo — only windows that actually carry cross-window context
// rebuild on a context change (issue #1580).
const EMPTY_LINKED: LinkedContext = Object.freeze({
  linkedRoot: null,
  linkedFilePath: undefined,
  linkedRoots: EMPTY_STRINGS,
  linkedCapsuleIds: EMPTY_STRINGS,
  linkedCapsuleSetIds: EMPTY_STRINGS,
  linkedFigmaSnapshotRunIds: EMPTY_STRINGS,
  linkedFigmaSnapshotSources: undefined,
  linkedImageSources: undefined,
});

function isEmptyLinkedContext(c: LinkedContext): boolean {
  return (
    c.linkedRoot === null &&
    c.linkedFilePath === undefined &&
    c.linkedRoots.length === 0 &&
    c.linkedCapsuleIds.length === 0 &&
    c.linkedCapsuleSetIds.length === 0 &&
    c.linkedFigmaSnapshotRunIds.length === 0 &&
    (c.linkedFigmaSnapshotSources === undefined || c.linkedFigmaSnapshotSources.length === 0) &&
    (c.linkedImageSources === undefined || c.linkedImageSources.length === 0)
  );
}

// Resolve every cross-window linked* context a window of `type` reads. Pulled out
// of the render body so it can be wrapped in a single useMemo keyed on the link
// revision — the resolvers each scan conns+wins, so re-running them on every
// geometry/pan/zoom frame was a per-window O(conns) tax (issue #1580).
function computeLinkedContext(api: WorkspaceApi, type: WindowType, id: string): LinkedContext {
  const receivesFilesContext =
    type === "chat" ||
    type === "agents" ||
    type === "quality" ||
    type === "editor" ||
    type === "promptEnhancer";
  const receivesFocusedFileContext =
    type === "agents" || type === "quality" || type === "editor" || type === "promptEnhancer";
  const receivesConnectorContext = type === "quality" || type === "editor";
  const linkedRoot = receivesFilesContext ? api.linkedFilesRoot(id) : null;
  const linkedFilePath = receivesFocusedFileContext
    ? api.linkedFilesContext(id)?.activeFilePath
    : undefined;
  const linkedRoots =
    type === "quality" || type === "promptEnhancer"
      ? api.linkedAllFilesRoots(id)
      : linkedRoot !== null
        ? [linkedRoot]
        : EMPTY_STRINGS;
  const linkedCapsuleIds = receivesConnectorContext
    ? api.linkedConnectorCapsuleIds(id)
    : EMPTY_STRINGS;
  const linkedCapsuleSetIds = receivesConnectorContext
    ? api.linkedConnectorCapsuleSetIds(id)
    : EMPTY_STRINGS;
  const linkedFigmaSnapshotRunIds =
    type === "quality" ? api.linkedFigmaSnapshotRunIds(id) : EMPTY_STRINGS;
  const linkedFigmaSnapshotSources =
    type === "quality" ? api.linkedFigmaSnapshotSources?.(id) : undefined;
  const linkedImageSources = type === "quality" ? api.linkedImageSources?.(id) : undefined;
  const resolved: LinkedContext = {
    linkedRoot,
    linkedFilePath,
    linkedRoots,
    linkedCapsuleIds,
    linkedCapsuleSetIds,
    linkedFigmaSnapshotRunIds,
    linkedFigmaSnapshotSources,
    linkedImageSources,
  };
  return isEmptyLinkedContext(resolved) ? EMPTY_LINKED : resolved;
}

// `linkRevision` only feeds the React.memo comparison and the linked-context
// useMemo dependency below — it carries the "some other window's connection or
// cfg changed" signal so this window refreshes its derived cross-window context
// without re-rendering on every geometry/pan/zoom frame (issue #1580).
function WindowFrameImpl({
  win,
  top,
  connState,
  api,
  wsRef,
  linkRevision,
}: WindowFrameProps): ReactNode {
  const def = WIN_TYPES[win.type];
  const canStartConnection = hasConnectablePeer(win.type);
  const Icon = Icons[def.icon];
  // Issue #446 — the active task-workspace binding (null when no provider is mounted or unbound). It
  // is the single retarget choke point threaded into every window's render context below.
  const activeWorkspace = useOptionalActiveWorkspace();
  const activeRoot = activeWorkspace?.activeRoot ?? null;
  const activeBinding = activeWorkspace?.activeBinding ?? null;
  const [draggingWindow, setDraggingWindow] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const autoGrowSuppressedKeyRef = useRef<string | null>(null);
  const zoom = win.zoom ?? 1;
  const currentAutoGrowContentKey = autoGrowContentKey(win.type, win.cfg);
  // Cross-window linked* context: recompute only when this window's identity/type
  // changes or `linkRevision` signals a connection/cfg change elsewhere — NOT on a
  // pan/zoom/drag frame (issue #1580). api is referentially stable.
  const linked = useMemo<LinkedContext>(
    () => computeLinkedContext(api, win.type, win.id),
    // `linkRevision` is an intentional invalidation key, not a read value: the
    // resolvers inside read conns+wins through the stable `api`, which eslint
    // cannot see, so the revision is what tells this memo "recompute now".
    // eslint-disable-next-line react-hooks/exhaustive-deps -- linkRevision is the cross-window invalidation signal
    [api, win.type, win.id, linkRevision],
  );
  const ew = win.w / zoom;
  const eh = win.h / zoom;
  const updateCfg = useCallback(
    (patch: AppWindow["cfg"]): void => {
      api.update(win.id, { cfg: { ...win.cfg, ...patch } });
    },
    [api, win.cfg, win.id],
  );
  const openWindow = useCallback(
    (type: WindowType, cfg?: AppWindow["cfg"]): string | null => api.add(type, cfg),
    [api],
  );
  const openEditorFile = useCallback<WorkspaceApi["openEditorFile"]>(
    (request) => api.openEditorFile(request),
    [api],
  );
  const focusWindow = useCallback((id: string): void => api.focus(id), [api]);
  const updateWindow = useCallback(
    (id: string, patch: Partial<AppWindow>): void => api.update(id, patch),
    [api],
  );
  // Build the body element tree only when an input that actually shapes it changes.
  // `linked` is now a stable object, ew/eh drive the chat/tiny breakpoints, and
  // win.cfg is the content source — so a drag (x/y only) no longer rebuilds the
  // chat/Monaco subtree of the dragged window (issue #1580).
  const { mode: bodyMode, node: body } = useMemo(
    () =>
      selectBody(
        win.id,
        win.type,
        ew,
        eh,
        win.cfg,
        linked.linkedRoot,
        linked.linkedFilePath,
        linked.linkedRoots,
        linked.linkedCapsuleIds,
        linked.linkedCapsuleSetIds,
        linked.linkedFigmaSnapshotRunIds,
        linked.linkedFigmaSnapshotSources,
        linked.linkedImageSources,
        activeRoot,
        activeBinding,
        updateCfg,
        openWindow,
        focusWindow,
        updateWindow,
        openEditorFile,
      ),
    [
      win.id,
      win.type,
      win.cfg,
      ew,
      eh,
      linked,
      activeRoot,
      activeBinding,
      updateCfg,
      openWindow,
      focusWindow,
      updateWindow,
      openEditorFile,
    ],
  );

  const setZoom = useCallback(
    (z: number): void => api.update(win.id, { zoom: clampContentZoom(z) }),
    [api, win.id],
  );

  useEffect(() => {
    if (autoGrowSuppressedKeyRef.current !== currentAutoGrowContentKey) {
      autoGrowSuppressedKeyRef.current = null;
    }
  }, [currentAutoGrowContentKey]);

  const suppressAutoGrowForManualResize = useCallback((): void => {
    if (currentAutoGrowContentKey !== null) {
      autoGrowSuppressedKeyRef.current = currentAutoGrowContentKey;
    }
  }, [currentAutoGrowContentKey]);

  useEffect(() => {
    if (!shouldAutoGrowWindow(win.type, win.cfg) || win.max || bodyMode !== "full") return;
    if (currentAutoGrowContentKey === null) return;
    const body = bodyRef.current;
    if (body === null) return;
    let frame: number | null = null;
    const measure = (): void => {
      frame = null;
      if (autoGrowSuppressedKeyRef.current === currentAutoGrowContentKey) return;
      const overflow = body.scrollHeight - body.clientHeight;
      if (overflow <= AUTO_GROW_EPSILON_PX) return;
      const nextHeight = Math.ceil(win.h + overflow);
      if (nextHeight <= win.h + AUTO_GROW_EPSILON_PX) return;
      api.update(win.id, { h: nextHeight });
    };
    const schedule = (): void => {
      if (frame !== null) return;
      frame =
        typeof window.requestAnimationFrame === "function"
          ? window.requestAnimationFrame(measure)
          : window.setTimeout(measure, 0);
    };
    schedule();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    observer?.observe(body);
    const firstChild = body.firstElementChild;
    if (firstChild !== null) observer?.observe(firstChild);
    return () => {
      if (frame !== null) {
        if (typeof window.cancelAnimationFrame === "function") {
          window.cancelAnimationFrame(frame);
        } else {
          window.clearTimeout(frame);
        }
      }
      observer?.disconnect();
    };
  }, [api, bodyMode, currentAutoGrowContentKey, win.cfg, win.h, win.id, win.max, win.type]);

  useEffect(
    () => () => {
      resizeCleanupRef.current?.();
      resizeCleanupRef.current = null;
    },
    [],
  );

  const focusWindowForTarget = useCallback(
    (target: EventTarget | null): void => {
      if (isTextEntryTarget(target)) {
        window.setTimeout(() => api.focus(win.id), 180);
        return;
      }
      if (isInteractiveControlTarget(target)) {
        window.setTimeout(() => api.focus(win.id), 0);
        return;
      }
      api.focus(win.id);
    },
    [api, win.id],
  );

  const onHeaderPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>): void => {
      if (!isWindowDragPointer(e)) return;
      // When this window is a valid drop target for an in-flight connect, the
      // bubbling onPointerDown on <section> below confirms the link — don't
      // also start a header-drag, which would tear the window away from the
      // user's cursor mid-click.
      if (connState === "valid") return;
      e.preventDefault();
      focusWindowForTarget(e.target);
      const el = wsRef.current;
      if (el === null) return;
      const rect = el.getBoundingClientRect();
      // Issue #1580 — read the live view at gesture-start through the stable api
      // accessor instead of a per-frame `view` prop; the value is byte-identical
      // to what the prop held at this instant.
      const geo = makeDragGeometry(rect, api.currentView());
      const wasMax = win.max;
      const restoredW = wasMax ? (win.prev?.w ?? 480) : win.w;
      const restoredH = wasMax ? (win.prev?.h ?? 360) : win.h;
      const offX = wasMax ? restoredW / 2 : geo.toWX(e.clientX) - win.x;
      const offY = wasMax ? 18 : geo.toWY(e.clientY) - win.y;
      if (wasMax) api.update(win.id, { max: false, w: restoredW, h: restoredH });
      setDraggingWindow(true);
      attachDragListeners(api, geo, { winId: win.id, offX, offY, W: restoredW }, () =>
        setDraggingWindow(false),
      );
    },
    [
      api,
      win.id,
      win.x,
      win.y,
      win.w,
      win.h,
      win.max,
      win.prev,
      wsRef,
      connState,
      focusWindowForTarget,
    ],
  );

  const startResize = useCallback(
    (dir: Handle) =>
      (e: ReactPointerEvent<HTMLDivElement>): void => {
        if (!isPrimaryActivationPointer(e)) return;
        e.preventDefault();
        e.stopPropagation();
        resizeCleanupRef.current?.();
        resizeCleanupRef.current = null;
        api.focus(win.id);
        const start: ResizeStart = { x: win.x, y: win.y, w: win.w, h: win.h };
        let last = start;
        const sx = e.clientX;
        const sy = e.clientY;
        const z = api.currentView().zoom;
        const previousCursor = document.body.style.cursor;
        let active = true;
        let pending: ResizeStart | null = null;
        let frame: number | null = null;
        const flushPendingResize = (): void => {
          frame = null;
          if (pending === null) return;
          const next = pending;
          pending = null;
          if (sameResizeGeometry(last, next)) return;
          last = next;
          api.update(win.id, { ...next, max: false });
        };
        const cancelScheduledResize = (): void => {
          if (frame === null) return;
          if (typeof window.cancelAnimationFrame === "function") {
            window.cancelAnimationFrame(frame);
          } else {
            window.clearTimeout(frame);
          }
          frame = null;
        };
        const scheduleResize = (next: ResizeStart): void => {
          if (pending !== null && sameResizeGeometry(pending, next)) return;
          if (pending === null && sameResizeGeometry(last, next)) return;
          suppressAutoGrowForManualResize();
          pending = next;
          if (frame !== null) return;
          frame =
            typeof window.requestAnimationFrame === "function"
              ? window.requestAnimationFrame(flushPendingResize)
              : window.setTimeout(flushPendingResize, 0);
        };
        const schedulePendingFlush = (): void => {
          if (pending === null || frame !== null) return;
          frame =
            typeof window.requestAnimationFrame === "function"
              ? window.requestAnimationFrame(flushPendingResize)
              : window.setTimeout(flushPendingResize, 0);
        };
        const cleanup = (flushPending = false): void => {
          if (!active) return;
          active = false;
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", end);
          window.removeEventListener("pointercancel", end);
          window.removeEventListener("blur", end);
          if (flushPending) {
            schedulePendingFlush();
          } else {
            cancelScheduledResize();
            pending = null;
          }
          document.body.style.cursor = previousCursor;
          if (resizeCleanupRef.current === cleanup) resizeCleanupRef.current = null;
        };
        const end = (): void => {
          cleanup(true);
        };
        const move = (ev: PointerEvent): void => {
          if (!active) return;
          if (ev.buttons === 0) {
            cleanup(true);
            return;
          }
          const dx = (ev.clientX - sx) / z;
          const dy = (ev.clientY - sy) / z;
          const next = applyResizeDelta(start, dir, dx, dy, win.type);
          scheduleResize(next);
        };
        document.body.style.cursor = resizeCursor(dir);
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", end);
        window.addEventListener("pointercancel", end);
        window.addEventListener("blur", end);
        resizeCleanupRef.current = cleanup;
      },
    [api, win.id, win.x, win.y, win.w, win.h, win.type, suppressAutoGrowForManualResize],
  );

  // Stop propagation BEFORE delegating, so the parent .window's onPointerDown
  // (focus + drag) cannot race with the port-initiated connect handshake.
  const startPortConnect = useCallback(
    (
      target: HTMLButtonElement,
      event: ReactPointerEvent<HTMLButtonElement> | ReactKeyboardEvent<HTMLButtonElement>,
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
    (e: ReactPointerEvent<HTMLButtonElement>): void => {
      if (!isPrimaryActivationPointer(e)) return;
      e.preventDefault();
      e.stopPropagation();
      startPortConnect(e.currentTarget, e);
    },
    [startPortConnect],
  );

  const onPortKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLButtonElement>): void => {
      if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
      // Keyboard completion of click-to-connect (WCAG 2.1.1, audit C004):
      // when this window is a valid target of an in-flight connect, Enter or
      // Space on its port confirms the link — mirroring the pointer path —
      // instead of starting a new flow from this window. confirmConnect only
      // reads preventDefault/stopPropagation off the event, so the same
      // adapter cast used by startPortConnect is safe here.
      if (connState === "valid") {
        api.confirmConnect(win.id, {
          preventDefault: () => e.preventDefault(),
          stopPropagation: () => e.stopPropagation(),
        } as ReactPointerEvent<Element>);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      startPortConnect(e.currentTarget, e);
    },
    [startPortConnect, connState, api, win.id],
  );

  // Audit C148 — closing a window removed the focused Close button from the DOM
  // and dropped keyboard focus to <body>; the user had to re-tab from the top of
  // the document. Move focus deterministically to the next top window (focusable
  // via tabIndex={-1} on the section) or the New-window FAB once React committed
  // the close. preventScroll guards against any residual scroll-on-focus.
  const closeWithFocusRestore = useCallback((): void => {
    api.close(win.id);
    requestAnimationFrame(() => {
      const next =
        document.querySelector<HTMLElement>('.window[data-top="true"]') ??
        document.querySelector<HTMLElement>(".ws-fab");
      next?.focus({ preventScroll: true });
    });
  }, [api, win.id]);

  const minimizeWithFocusRestore = useCallback((): void => {
    api.minimize(win.id);
    requestAnimationFrame(() => {
      const next =
        document.querySelector<HTMLElement>('.window[data-top="true"]') ??
        document.querySelector<HTMLElement>(".ws-fab");
      next?.focus({ preventScroll: true });
    });
  }, [api, win.id]);

  const sub = bodyMode === "full" ? subText(win.type, win.cfg) : null;
  const showHeaderZoom = bodyMode === "full" && ew >= HEADER_ZOOM_MIN_WIDTH_PX;
  // Issue #1580 — bound per-window layout/style recalc (item 8: `contain`) so a
  // scene-zoom relayout or an intra-window reflow does not cascade across all N
  // windows, and skip layout/paint for windows panned off the viewport (item 10:
  // `content-visibility`). The exact `contain-intrinsic-size` from the rendered
  // window box prevents any placeholder jump when a window scrolls back into view.
  // content-visibility is limited to full-mode windows (mini/tiny are already
  // cheap) and skipped for the editor so an off-screen Monaco never mis-measures.
  const enableContentVisibility = bodyMode === "full" && win.type !== "editor";
  const bodyStyle = useMemo<CSSProperties>(
    () =>
      enableContentVisibility
        ? {
            contain: "layout style",
            contentVisibility: "auto",
            containIntrinsicSize: `${String(Math.round(ew))}px ${String(Math.round(eh))}px`,
          }
        : { contain: "layout style" },
    [enableContentVisibility, ew, eh],
  );
  const sectionStyle = useMemo<CSSProperties>(
    () => ({
      left: win.x,
      top: win.y,
      width: ew,
      height: eh,
      zIndex: win.z,
      transform: `scale(${String(zoom)})`,
      transformOrigin: "0 0",
    }),
    [win.x, win.y, ew, eh, win.z, zoom],
  );

  return (
    <section
      className="window"
      // Audit C408 — a name turns the section into a named region, so AT users
      // can perceive window boundaries and jump between windows; C297 — the sub
      // (path/URL/title) disambiguates multiple windows of the same type.
      aria-label={sub !== null ? `${def.title} — ${sub}` : def.title}
      aria-roledescription="window"
      data-top={top ? "true" : "false"}
      data-max={win.max ? "true" : "false"}
      data-conn={connState ?? undefined}
      data-dragging={draggingWindow ? "true" : undefined}
      data-window-id={win.id}
      style={sectionStyle}
      tabIndex={-1}
      onPointerDown={(e) => {
        if (connState === "valid") api.confirmConnect(win.id, e);
        focusWindowForTarget(e.target);
      }}
      // Audit C061 / WCAG 2.4.11 — tabbing into a lower, overlapped window must
      // raise it, or the focused control (and its focus ring) stays fully hidden
      // behind the top window; Cmd/Alt+Arrows also only act on the topZ window.
      // The !top guard matters: makeFocus bumps z unconditionally, so without it
      // every Tab step inside the top window would trigger a state update.
      onFocusCapture={() => {
        if (!top) window.setTimeout(() => api.focus(win.id), 0);
      }}
    >
      {/* Header is a drag surface; keyboard equivalent is ⌘+Arrows handled by useKeyboardCtrls. */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <header
        className="win-head"
        onPointerDown={onHeaderPointerDown}
        onDoubleClick={(e) => {
          if (shouldMaximizeFromHeaderDoubleClick(e)) api.maximize(win.id);
        }}
      >
        <span
          className="win-ico"
          style={{ color: def.accent === true ? "var(--accent)" : "var(--fg-muted)" }}
        >
          <Icon size={14} />
        </span>
        <span className="win-title">{def.title}</span>
        {/* Audit C159 — the badge ellipsizes at 150px; title= keeps the full
            path/URL reachable for mouse users. */}
        {sub !== null ? (
          <span className="win-sub mono" title={sub}>
            <span className="win-sub-text">{sub}</span>
          </span>
        ) : null}
        <span className="spacer" />
        {/* Audit C297 — every window carried word-identical control labels; with
            several windows open, screen-reader and voice-control users could not
            tell WHICH window a Close/Zoom/Connect control acts on (WCAG 2.4.6).
            def.title scopes each label; the visible chrome is unchanged. */}
        {showHeaderZoom ? (
          <div className="win-zoom">
            <button
              type="button"
              className="win-zbtn ui-tip"
              data-tip="Zoom content out"
              aria-label={`Zoom ${def.title} content out`}
              disabled={zoom <= CONTENT_MIN_ZOOM}
              onPointerDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => {
                e.stopPropagation();
              }}
              onClick={() => setZoom(zoom - 0.1)}
            >
              <Icons.zoomOut size={13} />
            </button>
            <button
              type="button"
              className="win-zpct ui-tip"
              data-tip="Reset content zoom to 100%"
              aria-label={`${String(Math.round(zoom * 100))}% — reset ${def.title} content zoom`}
              onPointerDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => {
                e.stopPropagation();
              }}
              onClick={() => api.update(win.id, { zoom: 1 })}
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              className="win-zbtn ui-tip"
              data-tip="Zoom content in"
              aria-label={`Zoom ${def.title} content in`}
              disabled={zoom >= CONTENT_MAX_ZOOM}
              onPointerDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => {
                e.stopPropagation();
              }}
              onClick={() => setZoom(zoom + 0.1)}
            >
              <Icons.zoomIn size={13} />
            </button>
          </div>
        ) : null}
        <div className="win-traffic" role="group" aria-label={`${def.title} window controls`}>
          <button
            type="button"
            className="win-traffic-btn win-traffic-minimize ui-tip"
            data-tip="Minimize"
            aria-label={`Minimize ${def.title} window`}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => {
              e.stopPropagation();
            }}
            onClick={minimizeWithFocusRestore}
          >
            <Icons.minimize size={17} />
          </button>
          <button
            type="button"
            className="win-traffic-btn win-traffic-maximize ui-tip"
            data-tip={win.max ? "Restore" : "Full screen"}
            aria-label={win.max ? `Restore ${def.title} window` : `Full screen ${def.title} window`}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => {
              e.stopPropagation();
            }}
            onClick={() => api.maximize(win.id)}
          >
            {win.max ? <Icons.restore size={17} /> : <Icons.maximize size={17} />}
          </button>
          <button
            type="button"
            className="win-traffic-btn win-traffic-close ui-tip"
            data-tip="Close"
            aria-label={`Close ${def.title} window`}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => {
              e.stopPropagation();
            }}
            onClick={closeWithFocusRestore}
          >
            <Icons.close size={17} />
          </button>
        </div>
      </header>
      <div ref={bodyRef} className="win-body" data-mode={bodyMode} style={bodyStyle}>
        {body}
      </div>
      {!win.max
        ? HANDLES.map((d: Handle) => (
            <div key={d} className={`wz wz-${d}`} onPointerDown={startResize(d)} />
          ))
        : null}
      {!win.max && canStartConnection
        ? PORTS.map((d: Port) => (
            <button
              key={`p${d}`}
              type="button"
              className={`win-port wp-${d}`}
              title="Click to connect to another window"
              aria-label={`Connect ${def.title} from ${d === "t" ? "top" : d === "r" ? "right" : d === "b" ? "bottom" : "left"} edge`}
              onPointerDown={onPortPointerDown}
              onKeyDown={onPortKeyDown}
            />
          ))
        : null}
    </section>
  );
}

// Issue #1580 — memoized so a pan/zoom/drag frame that does not change THIS
// window's props skips re-rendering it (and its full content subtree). The props
// are all referentially stable now: `win` keeps identity for unchanged windows
// (makeUpdate returns the same object), `api` is useMemo'd, `wsRef` is a ref, and
// `top`/`connState`/`linkRevision` are primitives. Default shallow comparison is
// therefore sufficient and correct — `linkRevision` covers cross-window context.
export const WindowFrame = memo(WindowFrameImpl);
