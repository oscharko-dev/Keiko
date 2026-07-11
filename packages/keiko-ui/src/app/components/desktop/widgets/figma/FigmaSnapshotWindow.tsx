"use client";

// Figma Snapshot Workspace window (Epic #750, Issue #756).
//
// Surface: paste a board link → trigger a server-side snapshot-build → view the captured
// screens (IR summary + metadata) → surface the reduction ("N screens from M detected") →
// re-snapshot on demand. The window stores the resulting snapshotRunId in its cfg so a
// connected QI hub can read it via the relationship edge.
//
// Security invariant: the PAT is resolved server-side only. The board link travels to the BFF;
// the BFF resolves the token from vault/config/env, builds the snapshot, and returns a
// token-free summary. This component NEVER holds or transmits the PAT.
//
// No page route — this is a Workspace window only (consistent with the QI hub architecture).
//
// Accessibility:
//   - <form> with a <label> for the board-link input (id association).
//   - Progress and error states live in an aria-live="polite" region.
//   - The trigger button carries aria-busy during the build.
//   - Screen gallery items are <article> elements with a visible heading.
//   - Re-snapshot button has an explicit aria-label.
//   - Focus-visible is delegated to the design system (outline tokens).
//   - All interactive targets are ≥ 24 × 24 px (WCAG 2.5.8).

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type MutableRefObject,
  type PointerEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import Image from "next/image";
import { Icons } from "../../Icons";
import { ApiError } from "@/lib/api";
import { formatBytes, formatDate } from "@/lib/format";
import {
  triggerFigmaSnapshot,
  loadFigmaSnapshotSummary,
  loadFigmaSnapshotScreenJson,
  listFigmaSnapshots,
  updateFigmaSnapshotMetadata,
  deleteFigmaSnapshot,
  figmaSnapshotScreenImageUrl,
  generateFigmaCode,
  revokeFigmaToken,
} from "@/lib/figma-snapshot-api";
import type {
  FigmaSnapshotSummary,
  FigmaSnapshotListEntry,
  FigmaSnapshotScreenJsonResponse,
  FigmaCodegenResponse,
  FigmaRevokeTokenResult,
  DeleteFigmaSnapshotResult,
  FigmaSnapshotManagementSummary,
  FigmaScreenSummary,
  FigmaStructuralScreenSummary,
} from "@/lib/figma-snapshot-api";
import {
  FIGMA_VIEW_DRAG_TYPE,
  FIGMA_VIEW_DROP_EVENT,
  serializeFigmaViewDrag,
  type FigmaViewDragPayload,
  type FigmaViewDropDetail,
} from "../../figma-view-drag";
import {
  FIGMA_JSON_DRAG_TYPE,
  FIGMA_JSON_DROP_EVENT,
  serializeFigmaJsonDrag,
  type FigmaJsonDragPayload,
  type FigmaJsonDropDetail,
} from "../../figma-json-drag";
import {
  FIGMA_IMAGE_DRAG_TYPE,
  FIGMA_IMAGE_DROP_EVENT,
  serializeFigmaImageDrag,
  type FigmaImageDragPayload,
  type FigmaImageDropDetail,
} from "../../figma-image-drag";
import { JsonSyntaxBlock, jsonTextByteLength } from "./JsonSyntaxBlock";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const INITIAL_GALLERY_LIMIT = 24;
const EMPTY_SELECTED_SCREEN_IDS: readonly string[] = [];
const JSON_DRAG_THRESHOLD_PX = 6;

/**
 * Client-side Figma URL validator. Accepts:
 *   https://www.figma.com/design/{key}/{name}?node-id={id}
 *   https://www.figma.com/file/{key}/{name}?node-id={id}
 *
 * The node-id param is REQUIRED — a whole-file link would pull too many nodes
 * and the server's parseFigmaTarget would reject it anyway.
 */
function isValidFigmaLink(raw: string): boolean {
  try {
    const url = new URL(raw.trim());
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:") return false;
    if (host !== "figma.com" && host !== "www.figma.com") return false;
    if (!/^\/(design|file)\//u.test(url.pathname)) return false;
    const nodeId = url.searchParams.get("node-id");
    return nodeId !== null && nodeId.length > 0;
  } catch {
    return false;
  }
}

interface FigmaSnapshotScope {
  readonly fileKey: string;
  readonly nodeId: string;
}

function parseFigmaScope(raw: string): FigmaSnapshotScope | null {
  try {
    const url = new URL(raw.trim());
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:") return null;
    if (host !== "figma.com" && host !== "www.figma.com") return null;
    const [, kind, fileKey] = url.pathname.split("/");
    if ((kind !== "design" && kind !== "file") || fileKey === undefined || fileKey.length === 0) {
      return null;
    }
    const nodeId = url.searchParams.get("node-id");
    if (nodeId === null || nodeId.length === 0) return null;
    return { fileKey, nodeId };
  } catch {
    return null;
  }
}

function boardLinkFromSnapshot(snapshot: {
  readonly fileKey: string;
  readonly nodeId: string;
  readonly version?: string | undefined;
}): string {
  const url = new URL(`https://www.figma.com/design/${snapshot.fileKey}/board`);
  url.searchParams.set("node-id", snapshot.nodeId);
  if (snapshot.version !== undefined && snapshot.version.length > 0) {
    url.searchParams.set("version", snapshot.version);
  }
  return url.toString();
}

function snapshotDisplayName(snapshot: {
  readonly displayName?: string | undefined;
  readonly fetchedAt: string;
}): string {
  return snapshot.displayName ?? `Snapshot ${formatDate(snapshot.fetchedAt)}`;
}

function snapshotVersionLabel(version: string | undefined): string {
  return version === undefined || version.length === 0 ? "Latest" : version;
}

function shortIntegrityHash(hash: string): string {
  return hash.length <= 16 ? hash : `${hash.slice(0, 12)}…`;
}

function snapshotManagement(snapshot: {
  readonly management?: FigmaSnapshotManagementSummary | undefined;
}): FigmaSnapshotManagementSummary {
  return snapshot.management ?? {};
}

function listEntryWithSummaryManagement(
  entry: FigmaSnapshotListEntry,
  summary: FigmaSnapshotSummary,
): FigmaSnapshotListEntry {
  return {
    runId: entry.runId,
    ...(summary.displayName !== undefined ? { displayName: summary.displayName } : {}),
    management: snapshotManagement(summary),
    fileKey: entry.fileKey,
    nodeId: entry.nodeId,
    version: entry.version,
    fetchedAt: entry.fetchedAt,
    screenCount: entry.screenCount,
    skippedCount: entry.skippedCount,
    ...(entry.structuralOnlyCount !== undefined
      ? { structuralOnlyCount: entry.structuralOnlyCount }
      : {}),
    reductionHint: entry.reductionHint,
    integrityHash: entry.integrityHash,
  };
}

interface SnapshotErrorNotice {
  readonly title: string;
  readonly detail: string;
  readonly status?: string | undefined;
  readonly remediation?: string | undefined;
  readonly assertive?: boolean | undefined;
  // Issue #1399: PAT/credential failures the operator can resolve by opening the Figma access-token
  // settings. When true, the error card offers a click-through to that configuration.
  readonly tokenConfig?: boolean | undefined;
}

interface DetachedBuild {
  readonly link: string;
  readonly isResnapshot: boolean;
}

type SnapshotDashboardTab = "board" | "recent";

// ── Fix #8: full external-dependency error taxonomy (including new codes from the
// parallel agent landing FIGMA_NETWORK_UNREACHABLE / FIGMA_EGRESS_TIMEOUT /
// FIGMA_EGRESS_FAILED / FIGMA_PROXY_AUTH_REQUIRED / FIGMA_PROXY_BLOCKED_BY_POLICY).
// FIGMA_UPSTREAM_UNAVAILABLE is intentionally NOT in this set (fix #4 below).
const FIGMA_PROXY_ERRORS: ReadonlySet<string> = new Set([
  "FIGMA_PROXY_EGRESS_FAILED",
  "FIGMA_PROXY_UNREACHABLE",
  "FIGMA_PROXY_AUTH_REQUIRED",
  "FIGMA_PROXY_BLOCKED_BY_POLICY",
]);

const FIGMA_CA_ERRORS: ReadonlySet<string> = new Set(["FIGMA_TLS_CA_FAILURE"]);

// Direct network/timeout errors — no proxy involvement.
const FIGMA_NETWORK_ERRORS: ReadonlySet<string> = new Set([
  "FIGMA_NETWORK_UNREACHABLE",
  "FIGMA_EGRESS_TIMEOUT",
  "FIGMA_EGRESS_FAILED",
]);

// Issue #1399: PAT/credential failures the operator resolves by setting or rotating the Figma
// access token in Settings. FIGMA_CONSENT_REQUIRED is excluded — it is answered by the in-form
// read-only acknowledgement checkbox, not the token configuration.
const FIGMA_PAT_ERRORS: ReadonlySet<string> = new Set([
  "FIGMA_TOKEN_MISSING",
  "FIGMA_TOKEN_INVALID",
  "FIGMA_TOKEN_EXPIRED",
  "FIGMA_TOKEN_REVOKED",
  "FIGMA_INSUFFICIENT_SCOPE",
]);

function formatSnapshotError(err: unknown): SnapshotErrorNotice {
  if (err instanceof ApiError) {
    // Issue #1399: surface PAT/credential problems as an actionable alert that links straight to
    // the Figma access-token settings, so the operator does not have to hunt for the setting.
    if (FIGMA_PAT_ERRORS.has(err.code)) {
      return {
        title: "Figma access token needs attention",
        detail: `${err.code}: ${err.message}`,
        status: `HTTP ${err.status.toString()}`,
        remediation:
          "Open the Figma access token settings to add or rotate the read-only token, then retry. No snapshot was stored.",
        assertive: true,
        tokenConfig: true,
      };
    }
    // Fix #4: FIGMA_UPSTREAM_UNAVAILABLE is a plain Figma outage — not a proxy/CA issue.
    if (err.code === "FIGMA_UPSTREAM_UNAVAILABLE") {
      return {
        title: "Figma is currently unavailable",
        detail: `${err.code}: ${err.message}`,
        status: `HTTP ${err.status.toString()}`,
        remediation: "Retry later — no snapshot was stored.",
        assertive: true,
      };
    }
    if (FIGMA_PROXY_ERRORS.has(err.code)) {
      return {
        title: "Figma snapshot blocked by outbound egress",
        detail: `${err.code}: ${err.message}`,
        status: `HTTP ${err.status.toString()}`,
        remediation:
          "Check the configured proxy, NO_PROXY rules, and CA bundle, then retry. No snapshot was stored.",
        assertive: true,
      };
    }
    if (FIGMA_CA_ERRORS.has(err.code)) {
      return {
        title: "Figma snapshot blocked by outbound egress",
        detail: `${err.code}: ${err.message}`,
        status: `HTTP ${err.status.toString()}`,
        remediation:
          "A TLS certificate verification failure blocked the request. Check the CA bundle configuration, then retry. No snapshot was stored.",
        assertive: true,
      };
    }
    if (FIGMA_NETWORK_ERRORS.has(err.code)) {
      return {
        title: "Figma snapshot blocked by outbound egress",
        detail: `${err.code}: ${err.message}`,
        status: `HTTP ${err.status.toString()}`,
        remediation:
          "The outbound network request to Figma failed. Check DNS resolution and network connectivity, then retry. No snapshot was stored.",
        assertive: true,
      };
    }
    return {
      title: "Figma snapshot failed",
      detail: err.message,
    };
  }
  if (err instanceof Error) {
    return { title: "Figma snapshot failed", detail: err.message };
  }
  return { title: "Figma snapshot failed", detail: "An unexpected error occurred." };
}

function formatError(err: unknown): string {
  const notice = formatSnapshotError(err);
  return notice.status === undefined ? notice.detail : `${notice.detail} (${notice.status})`;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m ${String(seconds)}s`;
  if (minutes > 0) return `${String(minutes)}m ${String(seconds)}s`;
  return `${String(seconds)}s`;
}

/**
 * Differentiated validation microcopy (WCAG 3.3.1 Error Identification) for a
 * non-empty, invalid board link. Returns null when the link is empty or valid.
 */
function figmaLinkValidationMessage(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || isValidFigmaLink(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol === "https:" &&
      (host === "figma.com" || host === "www.figma.com") &&
      /^\/(design|file)\//u.test(url.pathname)
    ) {
      return "Add a node-id by selecting a frame or section in Figma and copying its link (Copy link to selection).";
    }
  } catch {
    // not parseable as a URL — fall through to the generic message
  }
  return "This doesn't look like a Figma board link. Use a figma.com design/file link that includes a node-id parameter.";
}

// ─── Sub-components ────────────────────────────────────────────────────────────

interface ScreenCardProps {
  readonly index: number;
  readonly screenId: string;
  readonly name: string;
  readonly irSummary: string;
  readonly imageSrc?: string | undefined;
  readonly imageByteLength?: number | undefined;
  readonly structuralReason?: string | undefined;
  readonly onAddSource?: (() => void) | undefined;
  readonly isSourceSelected?: boolean | undefined;
  readonly dragPayload?: FigmaViewDragPayload | undefined;
}

function isWorkspaceDropTarget(clientX: number, clientY: number): boolean {
  const target = document.elementFromPoint(clientX, clientY);
  if (!(target instanceof Element)) return false;
  return target.closest("main.workspace") !== null && target.closest(".window") === null;
}

function dispatchFigmaViewDrop(
  payload: FigmaViewDragPayload,
  event: { readonly clientX: number; readonly clientY: number },
): void {
  const detail: FigmaViewDropDetail = {
    payload,
    clientX: event.clientX,
    clientY: event.clientY,
  };
  window.dispatchEvent(new CustomEvent(FIGMA_VIEW_DROP_EVENT, { detail }));
}

function dispatchFigmaJsonDrop(
  payload: FigmaJsonDragPayload,
  event: { readonly clientX: number; readonly clientY: number },
): void {
  const detail: FigmaJsonDropDetail = {
    payload,
    clientX: event.clientX,
    clientY: event.clientY,
  };
  window.dispatchEvent(new CustomEvent(FIGMA_JSON_DROP_EVENT, { detail }));
}

function dispatchFigmaImageDrop(
  payload: FigmaImageDragPayload,
  event: { readonly clientX: number; readonly clientY: number },
): void {
  const detail: FigmaImageDropDetail = {
    payload,
    clientX: event.clientX,
    clientY: event.clientY,
  };
  window.dispatchEvent(new CustomEvent(FIGMA_IMAGE_DROP_EVENT, { detail }));
}

// ─── Shared drag-session helpers ───────────────────────────────────────────────
//
// The pointer- and mouse-based "drag a card to the workspace" gesture is identical across
// ScreenCard and the JSON drag surface in FigmaSnapshotWindow — extracted once here (S3776:
// keeping the gesture logic out of the component body keeps cognitive complexity in the
// component itself down to the guard clause that decides whether the gesture is enabled).

interface DragPointerSession {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
}

function beginDragPointerSession(
  event: PointerEvent<HTMLElement>,
  sessionRef: MutableRefObject<DragPointerSession | null>,
  suppressNextMouseDropRef: MutableRefObject<boolean>,
): void {
  suppressNextMouseDropRef.current = false;
  sessionRef.current = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
  };
  event.currentTarget.setPointerCapture(event.pointerId);
}

function trackDragPointerMove(
  event: PointerEvent<HTMLElement>,
  sessionRef: MutableRefObject<DragPointerSession | null>,
): void {
  const session = sessionRef.current;
  if (session === null || session.pointerId !== event.pointerId) return;
  const moved = Math.hypot(event.clientX - session.startX, event.clientY - session.startY);
  if (moved >= JSON_DRAG_THRESHOLD_PX) event.preventDefault();
}

function cancelDragPointerSession(
  event: PointerEvent<HTMLElement>,
  sessionRef: MutableRefObject<DragPointerSession | null>,
): void {
  const session = sessionRef.current;
  if (session === null || session.pointerId !== event.pointerId) return;
  sessionRef.current = null;
  event.currentTarget.releasePointerCapture(event.pointerId);
}

interface EndDragPointerSessionParams<TPayload> {
  readonly event: PointerEvent<HTMLElement>;
  readonly sessionRef: MutableRefObject<DragPointerSession | null>;
  readonly suppressNextMouseDropRef: MutableRefObject<boolean>;
  readonly payload: TPayload | undefined;
  readonly dispatchDrop: (
    payload: TPayload,
    event: { readonly clientX: number; readonly clientY: number },
  ) => void;
  readonly onBeforeDispatch?: (() => void) | undefined;
}

function endDragPointerSession<TPayload>(params: EndDragPointerSessionParams<TPayload>): void {
  const { event, sessionRef, suppressNextMouseDropRef, payload, dispatchDrop, onBeforeDispatch } =
    params;
  const session = sessionRef.current;
  if (session === null || session.pointerId !== event.pointerId) return;
  sessionRef.current = null;
  event.currentTarget.releasePointerCapture(event.pointerId);
  const moved = Math.hypot(event.clientX - session.startX, event.clientY - session.startY);
  if (moved >= JSON_DRAG_THRESHOLD_PX) suppressNextMouseDropRef.current = true;
  if (
    moved >= JSON_DRAG_THRESHOLD_PX &&
    payload !== undefined &&
    isWorkspaceDropTarget(event.clientX, event.clientY)
  ) {
    event.preventDefault();
    onBeforeDispatch?.();
    dispatchDrop(payload, event);
  }
}

interface StartMouseDragTrackingParams<TPayload> {
  readonly payload: TPayload;
  readonly startX: number;
  readonly startY: number;
  readonly suppressNextMouseDropRef: MutableRefObject<boolean>;
  readonly mouseDragCleanupRef: MutableRefObject<(() => void) | null>;
  readonly dispatchDrop: (
    payload: TPayload,
    event: { readonly clientX: number; readonly clientY: number },
  ) => void;
  readonly onBeforeDispatch?: (() => void) | undefined;
}

function startMouseDragTracking<TPayload>(params: StartMouseDragTrackingParams<TPayload>): void {
  const {
    payload,
    startX,
    startY,
    suppressNextMouseDropRef,
    mouseDragCleanupRef,
    dispatchDrop,
    onBeforeDispatch,
  } = params;
  function handleMove(moveEvent: globalThis.MouseEvent): void {
    const moved = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY);
    if (moved >= JSON_DRAG_THRESHOLD_PX) moveEvent.preventDefault();
  }
  function cleanup(): void {
    window.removeEventListener("mousemove", handleMove);
    window.removeEventListener("mouseup", handleUp);
    if (mouseDragCleanupRef.current === cleanup) mouseDragCleanupRef.current = null;
  }
  function handleUp(upEvent: globalThis.MouseEvent): void {
    cleanup();
    if (suppressNextMouseDropRef.current) {
      suppressNextMouseDropRef.current = false;
      return;
    }
    const moved = Math.hypot(upEvent.clientX - startX, upEvent.clientY - startY);
    if (
      moved >= JSON_DRAG_THRESHOLD_PX &&
      isWorkspaceDropTarget(upEvent.clientX, upEvent.clientY)
    ) {
      upEvent.preventDefault();
      onBeforeDispatch?.();
      dispatchDrop(payload, upEvent);
    }
  }
  window.addEventListener("mousemove", handleMove);
  window.addEventListener("mouseup", handleUp);
  mouseDragCleanupRef.current = cleanup;
}

// uiux-fix F045 C313: app-wide byte convention via lib/format (B/KB/MB) instead of an ad-hoc
// "KiB" — the only surface that used that spelling.
function screenCardSizeLabel(
  imageByteLength: number | undefined,
  structuralReason: string | undefined,
): string {
  if (imageByteLength !== undefined) return formatBytes(imageByteLength);
  return `Structural IR only${structuralReason !== undefined ? ` (${structuralReason})` : ""}`;
}

function screenCardSourceAriaLabel(name: string, isSourceSelected: boolean): string {
  return isSourceSelected
    ? `${name} is already the active scoped source`
    : `Add screen ${name} to the workspace as a Quality Intelligence source`;
}

interface ScreenCardPreviewProps {
  readonly imageSrc: string | undefined;
  readonly name: string;
}

function ScreenCardPreview({ imageSrc, name }: ScreenCardPreviewProps): ReactNode {
  if (imageSrc !== undefined) {
    return (
      <Image
        className="figma-snapshot-screen-image"
        src={imageSrc}
        alt={`Captured preview for ${name}`}
        loading="lazy"
        width={72}
        height={54}
      />
    );
  }
  return (
    <div
      className="figma-snapshot-screen-image figma-snapshot-screen-placeholder"
      aria-label={`Structural data only for ${name}`}
      role="img"
    >
      <Icons.layers className="figma-snapshot-screen-frame-icon" aria-hidden="true" />
      <span className="figma-snapshot-screen-placeholder-label">IR</span>
    </div>
  );
}

interface ScreenCardSourceActionProps {
  readonly name: string;
  readonly isSourceSelected: boolean;
  readonly onAddSource: () => void;
}

function ScreenCardSourceAction({
  name,
  isSourceSelected,
  onAddSource,
}: ScreenCardSourceActionProps): ReactNode {
  return (
    <div className="figma-snapshot-screen-actions">
      <button
        type="button"
        className="figma-snapshot-screen-source-btn"
        onClick={onAddSource}
        disabled={isSourceSelected}
        aria-disabled={isSourceSelected ? "true" : undefined}
        aria-label={screenCardSourceAriaLabel(name, isSourceSelected)}
      >
        {isSourceSelected ? "Source active" : "Add to workspace"}
      </button>
    </div>
  );
}

function ScreenCard({
  index,
  screenId,
  name,
  irSummary,
  imageSrc,
  imageByteLength,
  structuralReason,
  onAddSource,
  isSourceSelected = false,
  dragPayload,
}: ScreenCardProps): ReactNode {
  const pointerDragRef = useRef<DragPointerSession | null>(null);
  const suppressNextMouseDropRef = useRef(false);
  const suppressNextClickRef = useRef(false);
  const mouseDragCleanupRef = useRef<(() => void) | null>(null);
  const canDrag = dragPayload !== undefined && onAddSource !== undefined && !isSourceSelected;
  useEffect(
    () => () => {
      mouseDragCleanupRef.current?.();
      mouseDragCleanupRef.current = null;
    },
    [],
  );
  const previewLabel = isSourceSelected
    ? `${name} preview is already the active scoped source`
    : `Drag screen ${name} to the workspace, or click to add it as a Quality Intelligence source`;
  const handleAddClick = (event: MouseEvent<HTMLElement>): void => {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onAddSource?.();
  };
  const onDragStart = (event: DragEvent<HTMLElement>): void => {
    if (!canDrag) return;
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(FIGMA_VIEW_DRAG_TYPE, serializeFigmaViewDrag(dragPayload));
    event.dataTransfer.setData("text/plain", name);
  };
  const onDragEnd = (event: DragEvent<HTMLElement>): void => {
    if (!canDrag) return;
    if (isWorkspaceDropTarget(event.clientX, event.clientY)) {
      dispatchFigmaViewDrop(dragPayload, event);
    }
  };
  const handlePointerDown = (event: PointerEvent<HTMLElement>): void => {
    if (!canDrag || event.button !== 0) return;
    beginDragPointerSession(event, pointerDragRef, suppressNextMouseDropRef);
  };
  const handlePointerMove = (event: PointerEvent<HTMLElement>): void => {
    trackDragPointerMove(event, pointerDragRef);
  };
  const handlePointerUp = (event: PointerEvent<HTMLElement>): void => {
    endDragPointerSession({
      event,
      sessionRef: pointerDragRef,
      suppressNextMouseDropRef,
      payload: dragPayload,
      dispatchDrop: dispatchFigmaViewDrop,
      onBeforeDispatch: () => {
        suppressNextClickRef.current = true;
      },
    });
  };
  const handlePointerCancel = (event: PointerEvent<HTMLElement>): void => {
    cancelDragPointerSession(event, pointerDragRef);
  };
  const handleMouseDown = (event: MouseEvent<HTMLElement>): void => {
    if (!canDrag || event.button !== 0 || dragPayload === undefined) return;
    mouseDragCleanupRef.current?.();
    startMouseDragTracking({
      payload: dragPayload,
      startX: event.clientX,
      startY: event.clientY,
      suppressNextMouseDropRef,
      mouseDragCleanupRef,
      dispatchDrop: dispatchFigmaViewDrop,
      onBeforeDispatch: () => {
        suppressNextClickRef.current = true;
      },
    });
  };
  const preview = <ScreenCardPreview imageSrc={imageSrc} name={name} />;
  return (
    <article
      className="figma-snapshot-screen-card"
      aria-label={`Screen ${String(index + 1)}: ${name}`}
    >
      {onAddSource !== undefined ? (
        <button
          type="button"
          className="figma-snapshot-screen-preview-btn"
          onClick={handleAddClick}
          disabled={isSourceSelected}
          aria-disabled={isSourceSelected ? "true" : undefined}
          aria-label={previewLabel}
          draggable={canDrag}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onMouseDown={handleMouseDown}
        >
          {preview}
        </button>
      ) : (
        preview
      )}
      <div className="figma-snapshot-screen-meta">
        {/* uiux-fix F045 C252: the name is ellipsised user content — title makes the
            full name reachable on hover for mouse users. */}
        <h3 className="figma-snapshot-screen-name" title={name}>
          {name}
        </h3>
        <p className="figma-snapshot-screen-summary">{irSummary}</p>
        <p className="figma-snapshot-screen-size">
          {screenCardSizeLabel(imageByteLength, structuralReason)}
        </p>
        <p className="figma-snapshot-screen-id">{screenId}</p>
        {onAddSource !== undefined ? (
          <ScreenCardSourceAction
            name={name}
            isSourceSelected={isSourceSelected}
            onAddSource={onAddSource}
          />
        ) : null}
      </div>
    </article>
  );
}

interface FigmaViewSourceCardProps {
  readonly name: string;
  readonly screenId: string;
  readonly irSummary: string;
  readonly imageSrc?: string | undefined;
  readonly imageByteLength?: number | undefined;
  readonly structuralReason?: string | undefined;
  readonly snapshotRunId: string;
  readonly capturedAt: string;
  readonly imageDragPayload?: FigmaImageDragPayload | undefined;
}

function FigmaViewSourceCard({
  name,
  screenId,
  irSummary,
  imageSrc,
  imageByteLength,
  structuralReason,
  snapshotRunId,
  capturedAt,
  imageDragPayload,
}: FigmaViewSourceCardProps): ReactNode {
  const imagePointerDragRef = useRef<{
    readonly pointerId: number;
    readonly startX: number;
    readonly startY: number;
  } | null>(null);
  const suppressNextMouseDropRef = useRef(false);
  const imageMouseDragCleanupRef = useRef<(() => void) | null>(null);
  const canDragImage = imageSrc !== undefined && imageDragPayload !== undefined;
  useEffect(
    () => () => {
      imageMouseDragCleanupRef.current?.();
      imageMouseDragCleanupRef.current = null;
    },
    [],
  );

  const handleImageDragStart = (event: DragEvent<HTMLElement>): void => {
    if (!canDragImage) return;
    event.dataTransfer.effectAllowed = "copyMove";
    event.dataTransfer.setData(FIGMA_IMAGE_DRAG_TYPE, serializeFigmaImageDrag(imageDragPayload));
    event.dataTransfer.setData("text/plain", `${imageDragPayload.name}.png`);
  };
  const handleImageDragEnd = (event: DragEvent<HTMLElement>): void => {
    if (!canDragImage) return;
    if (isWorkspaceDropTarget(event.clientX, event.clientY)) {
      dispatchFigmaImageDrop(imageDragPayload, event);
    }
  };
  const handleImageKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (!canDragImage) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    dispatchFigmaImageDrop(imageDragPayload, {
      clientX: rect.right + 24,
      clientY: rect.top + rect.height / 2,
    });
  };
  const handleImagePointerDown = (event: PointerEvent<HTMLElement>): void => {
    if (!canDragImage || event.button !== 0) return;
    suppressNextMouseDropRef.current = false;
    imagePointerDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handleImagePointerMove = (event: PointerEvent<HTMLElement>): void => {
    const session = imagePointerDragRef.current;
    if (session === null || session.pointerId !== event.pointerId) return;
    const moved = Math.hypot(event.clientX - session.startX, event.clientY - session.startY);
    if (moved >= JSON_DRAG_THRESHOLD_PX) event.preventDefault();
  };
  const handleImagePointerUp = (event: PointerEvent<HTMLElement>): void => {
    const session = imagePointerDragRef.current;
    if (session === null || session.pointerId !== event.pointerId) return;
    imagePointerDragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    const moved = Math.hypot(event.clientX - session.startX, event.clientY - session.startY);
    if (moved >= JSON_DRAG_THRESHOLD_PX) suppressNextMouseDropRef.current = true;
    if (
      moved >= JSON_DRAG_THRESHOLD_PX &&
      canDragImage &&
      isWorkspaceDropTarget(event.clientX, event.clientY)
    ) {
      event.preventDefault();
      dispatchFigmaImageDrop(imageDragPayload, event);
    }
  };
  const handleImagePointerCancel = (event: PointerEvent<HTMLElement>): void => {
    const session = imagePointerDragRef.current;
    if (session === null || session.pointerId !== event.pointerId) return;
    imagePointerDragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const handleImageMouseDown = (event: MouseEvent<HTMLElement>): void => {
    if (!canDragImage || event.button !== 0 || imageDragPayload === undefined) return;
    const payload = imageDragPayload;
    imageMouseDragCleanupRef.current?.();
    const startX = event.clientX;
    const startY = event.clientY;
    function handleMove(moveEvent: globalThis.MouseEvent): void {
      const moved = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY);
      if (moved >= JSON_DRAG_THRESHOLD_PX) moveEvent.preventDefault();
    }
    function cleanup(): void {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      if (imageMouseDragCleanupRef.current === cleanup) imageMouseDragCleanupRef.current = null;
    }
    function handleUp(upEvent: globalThis.MouseEvent): void {
      cleanup();
      if (suppressNextMouseDropRef.current) {
        suppressNextMouseDropRef.current = false;
        return;
      }
      const moved = Math.hypot(upEvent.clientX - startX, upEvent.clientY - startY);
      if (
        moved >= JSON_DRAG_THRESHOLD_PX &&
        isWorkspaceDropTarget(upEvent.clientX, upEvent.clientY)
      ) {
        upEvent.preventDefault();
        dispatchFigmaImageDrop(payload, upEvent);
      }
    }
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    imageMouseDragCleanupRef.current = cleanup;
  };
  const previewContent =
    imageSrc !== undefined ? (
      <Image
        className="figma-view-preview-image"
        src={imageSrc}
        alt={`Captured preview for ${name}`}
        loading="lazy"
        width={360}
        height={240}
        draggable={false}
      />
    ) : (
      <div
        className="figma-view-preview-image figma-view-preview-placeholder"
        aria-label={`Structural data only for ${name}`}
        role="img"
      >
        <Icons.layers className="figma-view-preview-icon" aria-hidden="true" />
        <span>Structural IR</span>
      </div>
    );

  return (
    <article className="figma-view-source-card" aria-label={`Figma view source: ${name}`}>
      {canDragImage ? (
        <button
          type="button"
          className="figma-view-preview figma-view-preview-drag-surface"
          draggable
          onDragStart={handleImageDragStart}
          onDragEnd={handleImageDragEnd}
          onKeyDown={handleImageKeyDown}
          onPointerDown={handleImagePointerDown}
          onPointerMove={handleImagePointerMove}
          onPointerUp={handleImagePointerUp}
          onPointerCancel={handleImagePointerCancel}
          onMouseDown={handleImageMouseDown}
          aria-label={`Create a standalone image source for ${name}`}
          title={`Drag image for ${name} to the workspace`}
        >
          {previewContent}
        </button>
      ) : (
        <div className="figma-view-preview">{previewContent}</div>
      )}
      <div className="figma-view-source-meta">
        <p className="figma-view-source-kicker">QI view source</p>
        <h2 className="figma-view-source-title" title={name}>
          {name}
        </h2>
        <p className="figma-view-source-summary">{irSummary}</p>
        <dl className="figma-view-source-facts">
          <div>
            <dt>Screen</dt>
            <dd>{screenId}</dd>
          </div>
          <div>
            <dt>Snapshot</dt>
            <dd>{snapshotRunId}</dd>
          </div>
          <div>
            <dt>Captured</dt>
            <dd>{capturedAt}</dd>
          </div>
          <div>
            <dt>Preview</dt>
            <dd>
              {imageByteLength !== undefined
                ? formatBytes(imageByteLength)
                : `Structural IR${structuralReason !== undefined ? ` (${structuralReason})` : ""}`}
            </dd>
          </div>
        </dl>
      </div>
    </article>
  );
}

// ─── Props ─────────────────────────────────────────────────────────────────────

export interface FigmaSnapshotWindowProps {
  /** Workspace window id used to migrate an existing QI edge when JSON is dragged out. */
  readonly sourceWindowId?: string | undefined;
  /**
   * Current snapshotRunId from the window's cfg. Populated by the window itself after a
   * successful build via updateCfg; read by the QI hub via linkedFigmaSnapshotRunIds.
   */
  readonly snapshotRunId?: string | undefined;
  /** Optional screen ids scoped into this window when it represents a single-mask QI source. */
  readonly selectedScreenIds?: readonly string[] | undefined;
  /** Human-readable selected screen name persisted in the workspace cfg for source labels. */
  readonly selectedScreenName?: string | undefined;
  /** Opens a new Figma View card scoped to one screen from the loaded snapshot. */
  readonly openScreenSource?:
    | ((input: {
        readonly snapshotRunId: string;
        readonly screenId: string;
        readonly name: string;
      }) => void)
    | undefined;
  /**
   * Issue #1399: opens the Figma access-token settings (Settings → gateway setup, Figma section)
   * so the operator can resolve a PAT/credential error without searching for the setting. Wired by
   * the workspace window host; absent (e.g. in tests) the PAT error simply renders without the
   * click-through action.
   */
  readonly openTokenSettings?: (() => void) | undefined;
  /**
   * Persists a patch into the window's cfg. Used to store snapshotRunId after a
   * successful snapshot-build so the relationship edge can propagate it to QI.
   */
  readonly updateCfg: (patch: Record<string, string | number | boolean | undefined>) => void;
  /** Injectable for tests — defaults to the real BFF call. */
  readonly triggerImpl?: typeof triggerFigmaSnapshot;
  /** Injectable for tests — defaults to the real BFF call. */
  readonly loadImpl?: typeof loadFigmaSnapshotSummary;
  /** Injectable for tests — defaults to the real list BFF call. */
  readonly listImpl?: typeof listFigmaSnapshots;
  /** Injectable for tests — defaults to the real mutable metadata BFF call. */
  readonly updateMetadataImpl?: typeof updateFigmaSnapshotMetadata;
  /** Injectable for tests — defaults to the real snapshot deletion BFF call. */
  readonly deleteImpl?: typeof deleteFigmaSnapshot;
  /** Injectable for tests — defaults to the real scoped screen-JSON BFF call. */
  readonly loadScreenJsonImpl?: typeof loadFigmaSnapshotScreenJson;
  /** Injectable for tests — defaults to the real design-to-code BFF call (#755). */
  readonly codegenImpl?: typeof generateFigmaCode;
  /** Injectable for tests — defaults to the real PAT revoke call (#758). */
  readonly revokeImpl?: typeof revokeFigmaToken;
}

// ─── Component ────────────────────────────────────────────────────────────────

// "loading" is the stored-snapshot read path — it never contacts Figma and must not
// reuse the "building" copy ("fetching screens from Figma…").
type BuildState = "idle" | "loading" | "building" | "done" | "error";

// ─── State-update helpers (S3776) ──────────────────────────────────────────────
//
// FigmaSnapshotWindow owns a large amount of state; the branching logic that used to live
// inline inside its hooks is extracted to these module-scope functions so the hook bodies stay
// thin delegations. Each function takes only the refs/setters/values it actually needs.

type Setter<T> = Dispatch<SetStateAction<T>>;

type FigmaDisplayedScreenEntry =
  | {
      readonly kind: "rendered";
      readonly screen: FigmaScreenSummary;
      readonly imageIndex: number;
    }
  | { readonly kind: "structural"; readonly screen: FigmaStructuralScreenSummary };

function computeShowLoadStored(
  snapshotRunId: string | undefined,
  summary: FigmaSnapshotSummary | null,
  buildState: BuildState,
): boolean {
  if (snapshotRunId === undefined || snapshotRunId.length === 0) return false;
  if (summary !== null) return false;
  return buildState === "idle" || buildState === "loading" || buildState === "error";
}

interface ComputeFigmaJsonDragPayloadParams {
  readonly screenJsonRunId: string | undefined;
  readonly screenJsonScreenId: string | undefined;
  readonly screenJsonScreenName: string | undefined;
  readonly summaryRunId: string | undefined;
  readonly snapshotRunId: string | undefined;
  readonly inspectableScreenId: string | undefined;
  readonly selectedScreenName: string | undefined;
  readonly sourceWindowId: string | undefined;
}

// Reads the same individual screenJson fields the caller's useMemo dependency array lists
// (rather than the whole screenJson object) so the memo only recomputes when one of those
// fields actually changes.
function computeFigmaJsonDragPayload(
  params: ComputeFigmaJsonDragPayloadParams,
): FigmaJsonDragPayload | null {
  const {
    screenJsonRunId,
    screenJsonScreenId,
    screenJsonScreenName,
    summaryRunId,
    snapshotRunId,
    inspectableScreenId,
    selectedScreenName,
    sourceWindowId,
  } = params;
  const runId = screenJsonRunId ?? summaryRunId ?? snapshotRunId;
  const screen = screenJsonScreenId ?? inspectableScreenId;
  const name = screenJsonScreenName ?? selectedScreenName ?? screen;
  if (
    runId === undefined ||
    runId.length === 0 ||
    screen === undefined ||
    screen.length === 0 ||
    name === undefined ||
    name.length === 0
  ) {
    return null;
  }
  return {
    snapshotRunId: runId,
    screenId: screen,
    name,
    ...(sourceWindowId !== undefined ? { sourceWindowId } : {}),
  };
}

// ── Build flow ──────────────────────────────────────────────────────────────

interface HandleFigmaSnapshotBuildErrorParams {
  readonly err: unknown;
  readonly link: string;
  readonly isResnapshot: boolean;
  readonly activeBuildRef: MutableRefObject<DetachedBuild | null>;
  readonly flagConsentRequired: () => void;
  readonly setBuildStartedAt: Setter<number | null>;
  readonly setBuildElapsedMs: Setter<number>;
  readonly setErrorNotice: Setter<SnapshotErrorNotice | null>;
  readonly setDetachedBuild: Setter<DetachedBuild | null>;
  readonly setBuildState: Setter<BuildState>;
}

function handleFigmaSnapshotBuildError(params: HandleFigmaSnapshotBuildErrorParams): void {
  const {
    err,
    link,
    isResnapshot,
    activeBuildRef,
    flagConsentRequired,
    setBuildStartedAt,
    setBuildElapsedMs,
    setErrorNotice,
    setDetachedBuild,
    setBuildState,
  } = params;
  if (err instanceof DOMException && err.name === "AbortError") {
    return;
  }
  setBuildStartedAt(null);
  setBuildElapsedMs(0);
  // uiux-fix F038 C210: the server's 428 message names the policy but not the control —
  // extend it with an instruction that points at the checkbox, and highlight + focus it.
  if (err instanceof ApiError && err.code === "FIGMA_CONSENT_REQUIRED") {
    const notice = formatSnapshotError(err);
    setErrorNotice({
      ...notice,
      detail: `${notice.detail} Tick the acknowledgement checkbox below, then snapshot again.`,
    });
    flagConsentRequired();
  } else if (err instanceof ApiError && err.code === "FIGMA_BUILD_TIMEOUT") {
    setDetachedBuild({ link, isResnapshot });
    setErrorNotice({
      title: "Figma snapshot is still running",
      detail:
        "This window stopped waiting for the snapshot result. The server may still finish the build in the background.",
      status: `HTTP ${err.status.toString()}`,
      remediation:
        "Reconnect to the same board to keep waiting, or close this window and return later.",
    });
  } else {
    setErrorNotice(formatSnapshotError(err));
  }
  setBuildState("error");
  activeBuildRef.current = null;
}

interface RunFigmaSnapshotBuildParams {
  readonly link: string;
  readonly isResnapshot: boolean;
  readonly triggerImpl: typeof triggerFigmaSnapshot;
  readonly consentChecked: boolean;
  readonly updateCfg: (patch: Record<string, string | number | boolean | undefined>) => void;
  readonly flagConsentRequired: () => void;
  readonly abortRef: MutableRefObject<AbortController | null>;
  readonly codeAbortRef: MutableRefObject<AbortController | null>;
  readonly screenJsonAbortRef: MutableRefObject<AbortController | null>;
  readonly activeBuildRef: MutableRefObject<DetachedBuild | null>;
  readonly setBuildState: Setter<BuildState>;
  readonly setErrorNotice: Setter<SnapshotErrorNotice | null>;
  readonly setDetachedBuild: Setter<DetachedBuild | null>;
  readonly setBuildStartedAt: Setter<number | null>;
  readonly setBuildElapsedMs: Setter<number>;
  readonly setCodeState: Setter<"idle" | "generating" | "done" | "error">;
  readonly setCode: Setter<FigmaCodegenResponse | null>;
  readonly setScreenJsonState: Setter<"idle" | "loading" | "done" | "error">;
  readonly setScreenJson: Setter<FigmaSnapshotScreenJsonResponse | null>;
  readonly setScreenJsonError: Setter<string | null>;
  readonly setScreenJsonCopyStatus: Setter<string | null>;
  readonly setSummary: Setter<FigmaSnapshotSummary | null>;
  readonly setBoardLink: Setter<string>;
}

async function runFigmaSnapshotBuild(params: RunFigmaSnapshotBuildParams): Promise<void> {
  const {
    link,
    isResnapshot,
    triggerImpl,
    consentChecked,
    updateCfg,
    flagConsentRequired,
    abortRef,
    codeAbortRef,
    screenJsonAbortRef,
    activeBuildRef,
    setBuildState,
    setErrorNotice,
    setDetachedBuild,
    setBuildStartedAt,
    setBuildElapsedMs,
    setCodeState,
    setCode,
    setScreenJsonState,
    setScreenJson,
    setScreenJsonError,
    setScreenJsonCopyStatus,
    setSummary,
    setBoardLink,
  } = params;
  // Abort any previous in-flight request before starting a new one.
  abortRef.current?.abort();
  codeAbortRef.current?.abort();
  screenJsonAbortRef.current?.abort();
  codeAbortRef.current = null;
  screenJsonAbortRef.current = null;
  const controller = new AbortController();
  abortRef.current = controller;
  activeBuildRef.current = { link, isResnapshot };

  setBuildState("building");
  setErrorNotice(null);
  setDetachedBuild(null);
  setBuildStartedAt(Date.now());
  setBuildElapsedMs(0);
  setCodeState("idle");
  setCode(null);
  setScreenJsonState("idle");
  setScreenJson(null);
  setScreenJsonError(null);
  setScreenJsonCopyStatus(null);
  try {
    const result = await triggerImpl(link, {
      acknowledgeReadOnly: consentChecked,
      isResnapshot,
      signal: controller.signal,
    });
    setSummary(result);
    setBoardLink(boardLinkFromSnapshot(result));
    updateCfg({ snapshotRunId: result.runId });
    setBuildState("done");
    setBuildStartedAt(null);
    setBuildElapsedMs(0);
    activeBuildRef.current = null;
  } catch (err) {
    handleFigmaSnapshotBuildError({
      err,
      link,
      isResnapshot,
      activeBuildRef,
      flagConsentRequired,
      setBuildStartedAt,
      setBuildElapsedMs,
      setErrorNotice,
      setDetachedBuild,
      setBuildState,
    });
  }
}

interface SubmitFigmaBoardLinkParams {
  readonly linkValid: boolean;
  readonly busy: boolean;
  readonly consentChecked: boolean;
  readonly boardLink: string;
  readonly runBuild: (link: string, isResnapshot: boolean) => Promise<void>;
  readonly flagConsentRequired: () => void;
  readonly setErrorNotice: Setter<SnapshotErrorNotice | null>;
  readonly setBuildState: Setter<BuildState>;
}

function submitFigmaBoardLink(params: SubmitFigmaBoardLinkParams): void {
  const {
    linkValid,
    busy,
    consentChecked,
    boardLink,
    runBuild,
    flagConsentRequired,
    setErrorNotice,
    setBuildState,
  } = params;
  if (!linkValid || busy) return;
  if (!consentChecked) {
    // The server enforces the acknowledgement with FIGMA_CONSENT_REQUIRED (HTTP 428) on the
    // first build for a board — fail inline instead of letting the first-run happy path end in
    // a guaranteed server-error roundtrip.
    setErrorNotice({
      title: "Figma snapshot failed",
      detail: "Tick the read-only acknowledgement checkbox below, then snapshot again.",
    });
    setBuildState("error");
    // uiux-fix F038 C210: point at the control, don't just describe it — highlight the checkbox
    // and move focus onto it so the fix is one keypress away.
    flagConsentRequired();
    return;
  }
  void runBuild(boardLink, false);
}

// ── Stored-snapshot loading ─────────────────────────────────────────────────

interface HandleLoadStoredFigmaSnapshotErrorParams {
  readonly err: unknown;
  readonly runId: string;
  readonly currentSnapshotRunId: string | undefined;
  readonly updateCfg: (patch: Record<string, string | number | boolean | undefined>) => void;
  readonly setErrorNotice: Setter<SnapshotErrorNotice | null>;
  readonly setBuildState: Setter<BuildState>;
}

function handleLoadStoredFigmaSnapshotError(
  params: HandleLoadStoredFigmaSnapshotErrorParams,
): void {
  const { err, runId, currentSnapshotRunId, updateCfg, setErrorNotice, setBuildState } = params;
  if (err instanceof DOMException && err.name === "AbortError") return;
  if (err instanceof ApiError && err.code === "FIGMA_SNAPSHOT_NOT_FOUND") {
    if (currentSnapshotRunId === runId) updateCfg({ snapshotRunId: undefined });
    setErrorNotice({
      ...formatSnapshotError(err),
      detail:
        currentSnapshotRunId === runId
          ? `${err.message} The stored run ID has been cleared.`
          : err.message,
    });
  } else {
    setErrorNotice(formatSnapshotError(err));
  }
  setBuildState("error");
}

interface LoadStoredFigmaSnapshotParams {
  readonly runId: string;
  readonly busy: boolean;
  readonly loadImpl: typeof loadFigmaSnapshotSummary;
  readonly currentSnapshotRunId: string | undefined;
  readonly updateCfg: (patch: Record<string, string | number | boolean | undefined>) => void;
  readonly abortRef: MutableRefObject<AbortController | null>;
  readonly setBuildState: Setter<BuildState>;
  readonly setErrorNotice: Setter<SnapshotErrorNotice | null>;
  readonly setDetachedBuild: Setter<DetachedBuild | null>;
  readonly setCodeState: Setter<"idle" | "generating" | "done" | "error">;
  readonly setCode: Setter<FigmaCodegenResponse | null>;
  readonly setCodeError: Setter<string | null>;
  readonly setScreenJsonState: Setter<"idle" | "loading" | "done" | "error">;
  readonly setScreenJson: Setter<FigmaSnapshotScreenJsonResponse | null>;
  readonly setScreenJsonError: Setter<string | null>;
  readonly setScreenJsonCopyStatus: Setter<string | null>;
  readonly setSummary: Setter<FigmaSnapshotSummary | null>;
  readonly setBoardLink: Setter<string>;
}

function loadStoredFigmaSnapshot(params: LoadStoredFigmaSnapshotParams): void {
  const {
    runId,
    busy,
    loadImpl,
    currentSnapshotRunId,
    updateCfg,
    abortRef,
    setBuildState,
    setErrorNotice,
    setDetachedBuild,
    setCodeState,
    setCode,
    setCodeError,
    setScreenJsonState,
    setScreenJson,
    setScreenJsonError,
    setScreenJsonCopyStatus,
    setSummary,
    setBoardLink,
  } = params;
  if (runId.length === 0 || busy) return;
  abortRef.current?.abort();
  const controller = new AbortController();
  abortRef.current = controller;

  setBuildState("loading");
  setErrorNotice(null);
  setDetachedBuild(null);
  setCodeState("idle");
  setCode(null);
  setCodeError(null);
  setScreenJsonState("idle");
  setScreenJson(null);
  setScreenJsonError(null);
  setScreenJsonCopyStatus(null);

  loadImpl(runId, controller.signal)
    .then((result) => {
      setSummary(result);
      setBoardLink(boardLinkFromSnapshot(result));
      updateCfg({ snapshotRunId: result.runId });
      setBuildState("done");
    })
    .catch((err: unknown) => {
      handleLoadStoredFigmaSnapshotError({
        err,
        runId,
        currentSnapshotRunId,
        updateCfg,
        setErrorNotice,
        setBuildState,
      });
    });
}

// ── Dashboard list refresh ──────────────────────────────────────────────────

interface RefreshRecentFigmaSnapshotsParams {
  readonly listImpl: typeof listFigmaSnapshots;
  readonly controller: AbortController;
  readonly dashboardAbortRef: MutableRefObject<AbortController | null>;
  readonly setRecentSnapshots: Setter<readonly FigmaSnapshotListEntry[]>;
  readonly setRecentSnapshotsLoading: Setter<boolean>;
  readonly setRecentSnapshotsError: Setter<string | null>;
}

function refreshRecentFigmaSnapshots(params: RefreshRecentFigmaSnapshotsParams): void {
  const {
    listImpl,
    controller,
    dashboardAbortRef,
    setRecentSnapshots,
    setRecentSnapshotsLoading,
    setRecentSnapshotsError,
  } = params;
  setRecentSnapshotsLoading(true);
  setRecentSnapshotsError(null);
  void listImpl({ limit: 12, signal: controller.signal })
    .then((snapshots) => {
      setRecentSnapshots(snapshots);
    })
    .catch((err: unknown) => {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setRecentSnapshots([]);
      setRecentSnapshotsError(formatError(err));
    })
    .finally(() => {
      if (dashboardAbortRef.current === controller) setRecentSnapshotsLoading(false);
    });
}

interface RefreshBoardFigmaSnapshotsParams {
  readonly listImpl: typeof listFigmaSnapshots;
  readonly controller: AbortController;
  readonly dashboardAbortRef: MutableRefObject<AbortController | null>;
  readonly currentScopeFileKey: string | undefined;
  readonly currentScopeNodeId: string | undefined;
  readonly setBoardSnapshots: Setter<readonly FigmaSnapshotListEntry[]>;
  readonly setBoardSnapshotsLoading: Setter<boolean>;
  readonly setBoardSnapshotsError: Setter<string | null>;
}

function refreshBoardFigmaSnapshots(params: RefreshBoardFigmaSnapshotsParams): void {
  const {
    listImpl,
    controller,
    dashboardAbortRef,
    currentScopeFileKey,
    currentScopeNodeId,
    setBoardSnapshots,
    setBoardSnapshotsLoading,
    setBoardSnapshotsError,
  } = params;
  if (currentScopeFileKey === undefined || currentScopeNodeId === undefined) {
    setBoardSnapshots([]);
    setBoardSnapshotsError(null);
    setBoardSnapshotsLoading(false);
    return;
  }

  setBoardSnapshotsLoading(true);
  setBoardSnapshotsError(null);
  void listImpl({
    fileKey: currentScopeFileKey,
    nodeId: currentScopeNodeId,
    limit: 12,
    signal: controller.signal,
  })
    .then((snapshots) => {
      setBoardSnapshots(snapshots);
    })
    .catch((err: unknown) => {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setBoardSnapshots([]);
      setBoardSnapshotsError(formatError(err));
    })
    .finally(() => {
      if (dashboardAbortRef.current === controller) setBoardSnapshotsLoading(false);
    });
}

// ── Design-to-code + screen-JSON inspection ─────────────────────────────────

interface GenerateFigmaCodeForSnapshotParams {
  readonly runId: string | undefined;
  readonly codeState: "idle" | "generating" | "done" | "error";
  readonly codegenImpl: typeof generateFigmaCode;
  readonly codeAbortRef: MutableRefObject<AbortController | null>;
  readonly setCodeState: Setter<"idle" | "generating" | "done" | "error">;
  readonly setCode: Setter<FigmaCodegenResponse | null>;
  readonly setCodeError: Setter<string | null>;
}

function generateFigmaCodeForSnapshot(params: GenerateFigmaCodeForSnapshotParams): void {
  const { runId, codeState, codegenImpl, codeAbortRef, setCodeState, setCode, setCodeError } =
    params;
  if (runId === undefined || runId.length === 0 || codeState === "generating") return;
  const controller = new AbortController();
  codeAbortRef.current = controller;
  setCodeState("generating");
  setCodeError(null);
  codegenImpl(runId, controller.signal)
    .then((result) => {
      setCode(result);
      setCodeState("done");
    })
    .catch((err: unknown) => {
      if (err instanceof DOMException && err.name === "AbortError") {
        setCodeState("idle");
        return;
      }
      setCodeError(formatError(err));
      setCodeState("error");
    })
    .finally(() => {
      if (codeAbortRef.current === controller) codeAbortRef.current = null;
    });
}

interface LoadFigmaScreenJsonForInspectionParams {
  readonly runId: string | undefined;
  readonly screenId: string | undefined;
  readonly screenJsonState: "idle" | "loading" | "done" | "error";
  readonly loadScreenJsonImpl: typeof loadFigmaSnapshotScreenJson;
  readonly screenJsonAbortRef: MutableRefObject<AbortController | null>;
  readonly setScreenJsonState: Setter<"idle" | "loading" | "done" | "error">;
  readonly setScreenJson: Setter<FigmaSnapshotScreenJsonResponse | null>;
  readonly setScreenJsonError: Setter<string | null>;
  readonly setScreenJsonCopyStatus: Setter<string | null>;
}

function loadFigmaScreenJsonForInspection(params: LoadFigmaScreenJsonForInspectionParams): void {
  const {
    runId,
    screenId,
    screenJsonState,
    loadScreenJsonImpl,
    screenJsonAbortRef,
    setScreenJsonState,
    setScreenJson,
    setScreenJsonError,
    setScreenJsonCopyStatus,
  } = params;
  if (runId === undefined || runId.length === 0 || screenId === undefined) return;
  if (screenJsonState === "loading") return;
  screenJsonAbortRef.current?.abort();
  const controller = new AbortController();
  screenJsonAbortRef.current = controller;
  setScreenJsonState("loading");
  setScreenJsonError(null);
  setScreenJsonCopyStatus(null);
  loadScreenJsonImpl(runId, screenId, controller.signal)
    .then((result) => {
      setScreenJson(result);
      setScreenJsonState("done");
    })
    .catch((err: unknown) => {
      if (err instanceof DOMException && err.name === "AbortError") {
        setScreenJsonState("idle");
        return;
      }
      setScreenJson(null);
      setScreenJsonError(formatError(err));
      setScreenJsonState("error");
    })
    .finally(() => {
      if (screenJsonAbortRef.current === controller) screenJsonAbortRef.current = null;
    });
}

function copyFigmaScreenJson(params: {
  readonly screenJsonText: string;
  readonly setScreenJsonCopyStatus: Setter<string | null>;
}): void {
  const { screenJsonText, setScreenJsonCopyStatus } = params;
  if (screenJsonText.length === 0) return;
  if (navigator.clipboard === undefined) {
    setScreenJsonCopyStatus("Clipboard unavailable");
    return;
  }
  navigator.clipboard
    .writeText(screenJsonText)
    .then(() => {
      setScreenJsonCopyStatus("Copied");
    })
    .catch(() => {
      setScreenJsonCopyStatus("Copy failed");
    });
}

// ── Snapshot management (rename / delete) ───────────────────────────────────

interface RenameFigmaSnapshotParams {
  readonly runId: string;
  readonly controller: AbortController;
  readonly renameValue: string;
  readonly summaryRunId: string | undefined;
  readonly updateMetadataImpl: typeof updateFigmaSnapshotMetadata;
  readonly snapshotManagementAbortRef: MutableRefObject<AbortController | null>;
  readonly setSummary: Setter<FigmaSnapshotSummary | null>;
  readonly setBoardSnapshots: Setter<readonly FigmaSnapshotListEntry[]>;
  readonly setRecentSnapshots: Setter<readonly FigmaSnapshotListEntry[]>;
  readonly setRenamingSnapshotRunId: Setter<string | null>;
  readonly setRenameValue: Setter<string>;
  readonly setSnapshotManagementError: Setter<string | null>;
  readonly setSnapshotManagementBusyRunId: Setter<string | null>;
}

// The AbortController and the snapshotManagementAbortRef assignment are handled by the caller
// (kept in the component body) so the ref has a single, statically visible write site there —
// see handleRenameSnapshot / handleDeleteSnapshot.
function renameFigmaSnapshot(params: RenameFigmaSnapshotParams): void {
  const {
    runId,
    controller,
    renameValue,
    summaryRunId,
    updateMetadataImpl,
    snapshotManagementAbortRef,
    setSummary,
    setBoardSnapshots,
    setRecentSnapshots,
    setRenamingSnapshotRunId,
    setRenameValue,
    setSnapshotManagementError,
    setSnapshotManagementBusyRunId,
  } = params;
  setSnapshotManagementBusyRunId(runId);
  setSnapshotManagementError(null);
  const nextDisplayName = renameValue.trim();
  updateMetadataImpl(
    runId,
    nextDisplayName.length === 0 ? null : nextDisplayName,
    controller.signal,
  )
    .then((result) => {
      if (summaryRunId === runId) setSummary(result);
      setBoardSnapshots((snapshots) =>
        snapshots.map((snapshot) =>
          snapshot.runId === runId ? listEntryWithSummaryManagement(snapshot, result) : snapshot,
        ),
      );
      setRecentSnapshots((snapshots) =>
        snapshots.map((snapshot) =>
          snapshot.runId === runId ? listEntryWithSummaryManagement(snapshot, result) : snapshot,
        ),
      );
      setRenamingSnapshotRunId(null);
      setRenameValue("");
    })
    .catch((err: unknown) => {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setSnapshotManagementError(formatError(err));
    })
    .finally(() => {
      if (snapshotManagementAbortRef.current === controller) {
        snapshotManagementAbortRef.current = null;
      }
      setSnapshotManagementBusyRunId(null);
    });
}

interface DeleteFigmaSnapshotByRunIdParams {
  readonly runId: string;
  readonly controller: AbortController;
  readonly summaryRunId: string | undefined;
  readonly currentSnapshotRunId: string | undefined;
  readonly deleteImpl: typeof deleteFigmaSnapshot;
  readonly updateCfg: (patch: Record<string, string | number | boolean | undefined>) => void;
  readonly snapshotManagementAbortRef: MutableRefObject<AbortController | null>;
  readonly setSummary: Setter<FigmaSnapshotSummary | null>;
  readonly setBuildState: Setter<BuildState>;
  readonly setCodeState: Setter<"idle" | "generating" | "done" | "error">;
  readonly setCode: Setter<FigmaCodegenResponse | null>;
  readonly setScreenJsonState: Setter<"idle" | "loading" | "done" | "error">;
  readonly setScreenJson: Setter<FigmaSnapshotScreenJsonResponse | null>;
  readonly setBoardSnapshots: Setter<readonly FigmaSnapshotListEntry[]>;
  readonly setRecentSnapshots: Setter<readonly FigmaSnapshotListEntry[]>;
  readonly setDeleteConfirmRunId: Setter<string | null>;
  readonly setRenamingSnapshotRunId: Setter<string | null>;
  readonly setDetailsSnapshotRunId: Setter<string | null>;
  readonly setSnapshotManagementError: Setter<string | null>;
  readonly setSnapshotManagementBusyRunId: Setter<string | null>;
}

function applyFigmaSnapshotDeletion(runId: string, params: DeleteFigmaSnapshotByRunIdParams): void {
  const {
    summaryRunId,
    currentSnapshotRunId,
    updateCfg,
    setSummary,
    setBuildState,
    setCodeState,
    setCode,
    setScreenJsonState,
    setScreenJson,
    setBoardSnapshots,
    setRecentSnapshots,
    setDeleteConfirmRunId,
    setRenamingSnapshotRunId,
    setDetailsSnapshotRunId,
  } = params;
  setBoardSnapshots((snapshots) => snapshots.filter((snapshot) => snapshot.runId !== runId));
  setRecentSnapshots((snapshots) => snapshots.filter((snapshot) => snapshot.runId !== runId));
  setDeleteConfirmRunId(null);
  setRenamingSnapshotRunId(null);
  setDetailsSnapshotRunId(null);
  if (summaryRunId === runId) {
    setSummary(null);
    setBuildState("idle");
    setCodeState("idle");
    setCode(null);
    setScreenJsonState("idle");
    setScreenJson(null);
  }
  if (summaryRunId === runId || currentSnapshotRunId === runId) {
    updateCfg({ snapshotRunId: undefined });
  }
}

// The AbortController and the snapshotManagementAbortRef assignment are handled by the caller
// (kept in the component body) so the ref has a single, statically visible write site there —
// see handleRenameSnapshot / handleDeleteSnapshot.
function deleteFigmaSnapshotByRunId(params: DeleteFigmaSnapshotByRunIdParams): void {
  const {
    runId,
    controller,
    deleteImpl,
    snapshotManagementAbortRef,
    setSnapshotManagementError,
    setSnapshotManagementBusyRunId,
  } = params;
  setSnapshotManagementBusyRunId(runId);
  setSnapshotManagementError(null);
  deleteImpl(runId, controller.signal)
    .then((_result: DeleteFigmaSnapshotResult) => {
      applyFigmaSnapshotDeletion(runId, params);
    })
    .catch((err: unknown) => {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setSnapshotManagementError(formatError(err));
    })
    .finally(() => {
      if (snapshotManagementAbortRef.current === controller) {
        snapshotManagementAbortRef.current = null;
      }
      setSnapshotManagementBusyRunId(null);
    });
}

// ─── Dashboard sub-components ──────────────────────────────────────────────────

function figmaSnapshotItemMetaLabel(snapshot: FigmaSnapshotListEntry): string {
  const screensLabel = `${snapshot.screenCount.toString()} screen${snapshot.screenCount !== 1 ? "s" : ""}`;
  const skippedLabel =
    snapshot.skippedCount > 0
      ? `, ${snapshot.skippedCount.toString()} skipped`
      : ", no skipped renders";
  return `${screensLabel}${skippedLabel}`;
}

interface FigmaSnapshotDashboardRenameFormProps {
  readonly title: string;
  readonly runId: string;
  readonly renameValue: string;
  readonly itemBusy: boolean;
  readonly onRenameValueChange: (value: string) => void;
  readonly onRenameSubmit: (runId: string) => void;
  readonly onCancelRename: () => void;
}

function FigmaSnapshotDashboardRenameForm({
  title,
  runId,
  renameValue,
  itemBusy,
  onRenameValueChange,
  onRenameSubmit,
  onCancelRename,
}: FigmaSnapshotDashboardRenameFormProps): ReactNode {
  return (
    <form
      className="figma-snapshot-dashboard-rename"
      onSubmit={(event) => {
        event.preventDefault();
        onRenameSubmit(runId);
      }}
    >
      <input
        type="text"
        className="figma-snapshot-dashboard-rename-input"
        value={renameValue}
        onChange={(event) => onRenameValueChange(event.target.value)}
        maxLength={120}
        disabled={itemBusy}
        aria-label={`Snapshot name for ${title}`}
        placeholder="Snapshot name"
      />
      <button
        type="submit"
        className="figma-snapshot-dashboard-rename-save"
        disabled={itemBusy}
        aria-busy={itemBusy}
      >
        Save
      </button>
      <button
        type="button"
        className="figma-snapshot-dashboard-rename-cancel"
        onClick={onCancelRename}
        disabled={itemBusy}
      >
        Cancel
      </button>
    </form>
  );
}

interface FigmaSnapshotDashboardDeleteConfirmProps {
  readonly runId: string;
  readonly itemBusy: boolean;
  readonly onConfirmDelete: (runId: string) => void;
  readonly onCancelDelete: () => void;
}

function FigmaSnapshotDashboardDeleteConfirm({
  runId,
  itemBusy,
  onConfirmDelete,
  onCancelDelete,
}: FigmaSnapshotDashboardDeleteConfirmProps): ReactNode {
  return (
    <div className="figma-snapshot-dashboard-delete-confirm">
      <span>Delete this snapshot?</span>
      <button
        type="button"
        className="figma-snapshot-dashboard-delete-confirm-btn"
        onClick={() => onConfirmDelete(runId)}
        disabled={itemBusy}
        aria-busy={itemBusy}
      >
        Delete
      </button>
      <button
        type="button"
        className="figma-snapshot-dashboard-delete-cancel-btn"
        onClick={onCancelDelete}
        disabled={itemBusy}
      >
        Cancel
      </button>
    </div>
  );
}

interface FigmaSnapshotDashboardItemDetailsProps {
  readonly snapshot: FigmaSnapshotListEntry;
  readonly management: FigmaSnapshotManagementSummary;
}

function FigmaSnapshotDashboardItemDetails({
  snapshot,
  management,
}: FigmaSnapshotDashboardItemDetailsProps): ReactNode {
  return (
    <dl className="figma-snapshot-dashboard-details">
      <div>
        <dt>Run</dt>
        <dd>{snapshot.runId}</dd>
      </div>
      <div>
        <dt>Version</dt>
        <dd>{snapshotVersionLabel(snapshot.version)}</dd>
      </div>
      <div>
        <dt>Integrity</dt>
        <dd title={snapshot.integrityHash}>{shortIntegrityHash(snapshot.integrityHash)}</dd>
      </div>
      <div>
        <dt>Structural</dt>
        <dd>{(snapshot.structuralOnlyCount ?? 0).toString()}</dd>
      </div>
      {management.updatedAt !== undefined ? (
        <div>
          <dt>Name updated</dt>
          <dd>{formatDate(management.updatedAt)}</dd>
        </div>
      ) : null}
    </dl>
  );
}

interface FigmaSnapshotDashboardItemProps {
  readonly snapshot: FigmaSnapshotListEntry;
  readonly showScope: boolean;
  readonly currentRunId: string | undefined;
  readonly busy: boolean;
  readonly isLoading: boolean;
  readonly loadingRunId: string | undefined;
  readonly snapshotManagementBusyRunId: string | null;
  readonly detailsSnapshotRunId: string | null;
  readonly renamingSnapshotRunId: string | null;
  readonly deleteConfirmRunId: string | null;
  readonly renameValue: string;
  readonly onLoad: (runId: string) => void;
  readonly onStartRename: (snapshot: FigmaSnapshotListEntry) => void;
  readonly onToggleDetails: (runId: string) => void;
  readonly onRequestDelete: (runId: string) => void;
  readonly onRenameValueChange: (value: string) => void;
  readonly onRenameSubmit: (runId: string) => void;
  readonly onCancelRename: () => void;
  readonly onConfirmDelete: (runId: string) => void;
  readonly onCancelDelete: () => void;
}

function FigmaSnapshotDashboardItem({
  snapshot,
  showScope,
  currentRunId,
  busy,
  isLoading,
  loadingRunId,
  snapshotManagementBusyRunId,
  detailsSnapshotRunId,
  renamingSnapshotRunId,
  deleteConfirmRunId,
  renameValue,
  onLoad,
  onStartRename,
  onToggleDetails,
  onRequestDelete,
  onRenameValueChange,
  onRenameSubmit,
  onCancelRename,
  onConfirmDelete,
  onCancelDelete,
}: FigmaSnapshotDashboardItemProps): ReactNode {
  const isCurrent = currentRunId === snapshot.runId;
  const title = snapshotDisplayName(snapshot);
  const management = snapshotManagement(snapshot);
  const itemBusy = snapshotManagementBusyRunId === snapshot.runId;
  const detailsOpen = detailsSnapshotRunId === snapshot.runId;
  const renameOpen = renamingSnapshotRunId === snapshot.runId;
  const deleteOpen = deleteConfirmRunId === snapshot.runId;
  return (
    <article
      className="figma-snapshot-dashboard-item"
      role="listitem"
      aria-current={isCurrent ? "true" : undefined}
      aria-busy={isLoading && loadingRunId === snapshot.runId ? "true" : undefined}
    >
      <div className="figma-snapshot-dashboard-item-head">
        <div className="figma-snapshot-dashboard-item-title-block">
          <h3 className="figma-snapshot-dashboard-item-title" title={title}>
            {title}
          </h3>
          <span className="figma-snapshot-dashboard-item-date">
            {formatDate(snapshot.fetchedAt)}
          </span>
        </div>
        {isCurrent && <span className="figma-snapshot-dashboard-item-badge">Current</span>}
        <div className="figma-snapshot-dashboard-item-actions">
          <button
            type="button"
            className="figma-snapshot-dashboard-load"
            onClick={() => {
              onLoad(snapshot.runId);
            }}
            disabled={busy}
            aria-disabled={busy ? "true" : undefined}
            aria-label={`Load snapshot ${title}`}
          >
            Load
          </button>
          <button
            type="button"
            className="figma-snapshot-dashboard-icon-btn"
            onClick={() => onStartRename(snapshot)}
            disabled={itemBusy}
            aria-label={`Rename snapshot ${title}`}
            title="Rename"
          >
            <Icons.edit aria-hidden="true" />
          </button>
          <button
            type="button"
            className="figma-snapshot-dashboard-icon-btn"
            onClick={() => onToggleDetails(snapshot.runId)}
            aria-expanded={detailsOpen}
            aria-label={`${detailsOpen ? "Hide" : "Show"} metadata for snapshot ${title}`}
            title="Metadata"
          >
            <Icons.info aria-hidden="true" />
          </button>
          <button
            type="button"
            className="figma-snapshot-dashboard-icon-btn figma-snapshot-dashboard-icon-btn-danger"
            onClick={() => onRequestDelete(snapshot.runId)}
            disabled={itemBusy}
            aria-label={`Delete snapshot ${title}`}
            title="Delete"
          >
            <Icons.trash aria-hidden="true" />
          </button>
        </div>
      </div>
      <p className="figma-snapshot-dashboard-item-hint">{snapshot.reductionHint}</p>
      <p className="figma-snapshot-dashboard-item-meta">{figmaSnapshotItemMetaLabel(snapshot)}</p>
      {showScope && (
        <p className="figma-snapshot-dashboard-item-scope">
          {snapshot.fileKey} · {snapshot.nodeId}
        </p>
      )}
      {renameOpen ? (
        <FigmaSnapshotDashboardRenameForm
          title={title}
          runId={snapshot.runId}
          renameValue={renameValue}
          itemBusy={itemBusy}
          onRenameValueChange={onRenameValueChange}
          onRenameSubmit={onRenameSubmit}
          onCancelRename={onCancelRename}
        />
      ) : null}
      {deleteOpen ? (
        <FigmaSnapshotDashboardDeleteConfirm
          runId={snapshot.runId}
          itemBusy={itemBusy}
          onConfirmDelete={onConfirmDelete}
          onCancelDelete={onCancelDelete}
        />
      ) : null}
      {detailsOpen ? (
        <FigmaSnapshotDashboardItemDetails snapshot={snapshot} management={management} />
      ) : null}
    </article>
  );
}

interface FigmaSnapshotDashboardListProps {
  readonly snapshots: readonly FigmaSnapshotListEntry[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly emptyTitle: string;
  readonly emptyDetail: string;
  readonly showScope: boolean;
  readonly currentRunId: string | undefined;
  readonly busy: boolean;
  readonly isLoading: boolean;
  readonly loadingRunId: string | undefined;
  readonly snapshotManagementBusyRunId: string | null;
  readonly detailsSnapshotRunId: string | null;
  readonly renamingSnapshotRunId: string | null;
  readonly deleteConfirmRunId: string | null;
  readonly renameValue: string;
  readonly onLoad: (runId: string) => void;
  readonly onStartRename: (snapshot: FigmaSnapshotListEntry) => void;
  readonly onToggleDetails: (runId: string) => void;
  readonly onRequestDelete: (runId: string) => void;
  readonly onRenameValueChange: (value: string) => void;
  readonly onRenameSubmit: (runId: string) => void;
  readonly onCancelRename: () => void;
  readonly onConfirmDelete: (runId: string) => void;
  readonly onCancelDelete: () => void;
}

function FigmaSnapshotDashboardList({
  snapshots,
  loading,
  error,
  emptyTitle,
  emptyDetail,
  showScope,
  ...itemProps
}: FigmaSnapshotDashboardListProps): ReactNode {
  if (loading) {
    return <p className="figma-snapshot-dashboard-status">Loading snapshots…</p>;
  }
  if (error !== null) {
    return (
      <p className="figma-snapshot-dashboard-status figma-snapshot-dashboard-status-error">
        {error}
      </p>
    );
  }
  if (snapshots.length === 0) {
    return (
      <div className="figma-snapshot-dashboard-empty">
        <p className="figma-snapshot-dashboard-empty-title">{emptyTitle}</p>
        <p className="figma-snapshot-dashboard-empty-detail">{emptyDetail}</p>
      </div>
    );
  }
  return (
    <div className="figma-snapshot-dashboard-list" role="list">
      {snapshots.map((snapshot) => (
        <FigmaSnapshotDashboardItem
          key={snapshot.runId}
          snapshot={snapshot}
          showScope={showScope}
          {...itemProps}
        />
      ))}
    </div>
  );
}

// ─── View-source-mode sub-components ───────────────────────────────────────────

interface FigmaViewJsonInspectorProps {
  readonly screenJson: FigmaSnapshotScreenJsonResponse;
  readonly screenJsonBytes: number;
  readonly screenJsonCopyStatus: string | null;
  readonly screenJsonText: string;
  readonly jsonDragPayload: FigmaJsonDragPayload | null;
  readonly handleJsonDragStart: (event: DragEvent<HTMLElement>) => void;
  readonly handleJsonDragEnd: (event: DragEvent<HTMLElement>) => void;
  readonly handleJsonDragSurfaceKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  readonly handleJsonPointerDown: (event: PointerEvent<HTMLElement>) => void;
  readonly handleJsonPointerMove: (event: PointerEvent<HTMLElement>) => void;
  readonly handleJsonPointerUp: (event: PointerEvent<HTMLElement>) => void;
  readonly handleJsonPointerCancel: (event: PointerEvent<HTMLElement>) => void;
  readonly handleJsonMouseDown: (event: MouseEvent<HTMLElement>) => void;
  readonly handleCopyJson: () => void;
}

function FigmaViewJsonInspector({
  screenJson,
  screenJsonBytes,
  screenJsonCopyStatus,
  screenJsonText,
  jsonDragPayload,
  handleJsonDragStart,
  handleJsonDragEnd,
  handleJsonDragSurfaceKeyDown,
  handleJsonPointerDown,
  handleJsonPointerMove,
  handleJsonPointerUp,
  handleJsonPointerCancel,
  handleJsonMouseDown,
  handleCopyJson,
}: FigmaViewJsonInspectorProps): ReactNode {
  return (
    <section
      className="figma-view-json-inspector"
      aria-label={`Scoped JSON for ${screenJson.screen.name}`}
    >
      <div className="figma-view-json-inspector-header">
        <div
          className="figma-view-json-drag-surface"
          role="button"
          tabIndex={jsonDragPayload !== null ? 0 : -1}
          draggable={false}
          onDragStart={handleJsonDragStart}
          onDragEnd={handleJsonDragEnd}
          onKeyDown={handleJsonDragSurfaceKeyDown}
          onPointerDown={handleJsonPointerDown}
          onPointerMove={handleJsonPointerMove}
          onPointerUp={handleJsonPointerUp}
          onPointerCancel={handleJsonPointerCancel}
          onMouseDown={handleJsonMouseDown}
          aria-label={`Create a standalone JSON source for ${screenJson.screen.name}`}
          aria-disabled={jsonDragPayload === null ? "true" : undefined}
          title={`Drag JSON for ${screenJson.screen.name} to the workspace`}
        >
          <p className="figma-view-json-kicker">Stored Screen-IR JSON</p>
          <h2 className="figma-view-json-title">{screenJson.screen.screenId}</h2>
          <p className="figma-view-json-meta">
            {screenJson.screen.kind} · {formatBytes(screenJsonBytes)} ·{" "}
            {screenJson.relatedLinks.length.toString()} related link
            {screenJson.relatedLinks.length !== 1 ? "s" : ""}
          </p>
        </div>
        <button type="button" className="figma-view-json-copy-btn" onClick={handleCopyJson}>
          Copy JSON
        </button>
      </div>
      {screenJsonCopyStatus !== null ? (
        <p className="figma-view-json-copy-status" role="status">
          {screenJsonCopyStatus}
        </p>
      ) : null}
      <JsonSyntaxBlock
        text={screenJsonText}
        className="figma-view-json-code"
        ariaLabel={`Screen-IR JSON for ${screenJson.screen.screenId}`}
      />
    </section>
  );
}

interface FigmaViewSourceModeSectionProps {
  readonly selectedScreenName: string | undefined;
  readonly selectedScreenIds: readonly string[];
  readonly inspectableScreenId: string | undefined;
  readonly summary: FigmaSnapshotSummary | null;
  readonly snapshotRunId: string | undefined;
  readonly screenJsonState: "idle" | "loading" | "done" | "error";
  readonly statusId: string;
  readonly isLoading: boolean;
  readonly buildState: BuildState;
  readonly errorNotice: SnapshotErrorNotice | null;
  readonly displayedScreens: readonly FigmaDisplayedScreenEntry[];
  readonly sourceWindowId: string | undefined;
  readonly screenJsonError: string | null;
  readonly screenJson: FigmaSnapshotScreenJsonResponse | null;
  readonly jsonDragPayload: FigmaJsonDragPayload | null;
  readonly handleLoadStored: () => void;
  readonly handleInspectJson: () => void;
  readonly handleJsonDragStart: (event: DragEvent<HTMLElement>) => void;
  readonly handleJsonDragEnd: (event: DragEvent<HTMLElement>) => void;
  readonly handleJsonDragSurfaceKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  readonly handleJsonPointerDown: (event: PointerEvent<HTMLElement>) => void;
  readonly handleJsonPointerMove: (event: PointerEvent<HTMLElement>) => void;
  readonly handleJsonPointerUp: (event: PointerEvent<HTMLElement>) => void;
  readonly handleJsonPointerCancel: (event: PointerEvent<HTMLElement>) => void;
  readonly handleJsonMouseDown: (event: MouseEvent<HTMLElement>) => void;
  readonly handleCopyJson: () => void;
  readonly screenJsonBytes: number;
  readonly screenJsonCopyStatus: string | null;
  readonly screenJsonText: string;
}

function FigmaViewSourceModeSection({
  selectedScreenName,
  selectedScreenIds,
  inspectableScreenId,
  summary,
  snapshotRunId,
  screenJsonState,
  statusId,
  isLoading,
  buildState,
  errorNotice,
  displayedScreens,
  sourceWindowId,
  screenJsonError,
  screenJson,
  jsonDragPayload,
  handleLoadStored,
  handleInspectJson,
  handleJsonDragStart,
  handleJsonDragEnd,
  handleJsonDragSurfaceKeyDown,
  handleJsonPointerDown,
  handleJsonPointerMove,
  handleJsonPointerUp,
  handleJsonPointerCancel,
  handleJsonMouseDown,
  handleCopyJson,
  screenJsonBytes,
  screenJsonCopyStatus,
  screenJsonText,
}: FigmaViewSourceModeSectionProps): ReactNode {
  const sourceName = selectedScreenName ?? selectedScreenIds.join(", ");
  const canInspectJson =
    inspectableScreenId !== undefined &&
    (summary?.runId ?? snapshotRunId) !== undefined &&
    screenJsonState !== "loading";
  return (
    <section
      className="figma-snapshot-window figma-view-window"
      aria-label={`Figma view source ${sourceName}`}
    >
      <div className="figma-view-source-header">
        <div>
          <p className="figma-view-source-eyebrow">Figma view</p>
          <h1 className="figma-view-source-heading" title={sourceName}>
            {sourceName}
          </h1>
        </div>
        <div className="figma-view-source-actions">
          <span className="figma-view-source-badge">QI source</span>
          <button
            type="button"
            className="figma-view-json-btn"
            onClick={handleInspectJson}
            disabled={!canInspectJson}
            aria-disabled={!canInspectJson ? "true" : undefined}
            aria-busy={screenJsonState === "loading" ? "true" : undefined}
          >
            {screenJsonState === "loading" ? "Loading JSON…" : "Inspect JSON"}
          </button>
        </div>
      </div>

      <div
        id={statusId}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="figma-snapshot-status"
      >
        {isLoading && <p className="figma-snapshot-progress">Loading view preview…</p>}
        {buildState === "error" && errorNotice !== null && (
          <p className="figma-snapshot-error">{errorNotice.detail}</p>
        )}
        {buildState === "done" && summary !== null && (
          <p className="sr-only">Figma view loaded — {sourceName}.</p>
        )}
      </div>

      {summary === null ? (
        <div className="figma-view-source-empty">
          <p className="figma-view-source-empty-title">
            {isLoading ? "Loading the selected view…" : "Selected view preview not loaded."}
          </p>
          {!isLoading && (
            <button type="button" className="figma-snapshot-load-btn" onClick={handleLoadStored}>
              Load view
            </button>
          )}
        </div>
      ) : displayedScreens.length > 0 ? (
        displayedScreens.map((entry) => {
          const imageSrc =
            entry.kind === "rendered"
              ? figmaSnapshotScreenImageUrl(summary.runId, entry.imageIndex)
              : undefined;
          const imageDragPayload: FigmaImageDragPayload | undefined =
            imageSrc === undefined
              ? undefined
              : {
                  snapshotRunId: summary.runId,
                  screenId: entry.screen.screenId,
                  name: entry.screen.name,
                  imageSrc,
                  ...(sourceWindowId !== undefined ? { sourceWindowId } : {}),
                };
          return (
            <FigmaViewSourceCard
              key={entry.screen.screenId}
              name={entry.screen.name}
              screenId={entry.screen.screenId}
              irSummary={entry.screen.irSummary}
              imageSrc={imageSrc}
              imageByteLength={entry.kind === "rendered" ? entry.screen.imageByteLength : undefined}
              structuralReason={entry.kind === "structural" ? entry.screen.reason : undefined}
              snapshotRunId={summary.runId}
              capturedAt={formatDate(summary.fetchedAt)}
              imageDragPayload={imageDragPayload}
            />
          );
        })
      ) : (
        <div className="lk-empty">
          <p className="lk-empty-body">
            The selected screen is not present in this stored snapshot.
          </p>
        </div>
      )}

      {screenJsonState === "error" && screenJsonError !== null ? (
        <p className="figma-snapshot-error" role="alert">
          {screenJsonError}
        </p>
      ) : null}

      {screenJsonState === "done" && screenJson !== null ? (
        <FigmaViewJsonInspector
          screenJson={screenJson}
          screenJsonBytes={screenJsonBytes}
          screenJsonCopyStatus={screenJsonCopyStatus}
          screenJsonText={screenJsonText}
          jsonDragPayload={jsonDragPayload}
          handleJsonDragStart={handleJsonDragStart}
          handleJsonDragEnd={handleJsonDragEnd}
          handleJsonDragSurfaceKeyDown={handleJsonDragSurfaceKeyDown}
          handleJsonPointerDown={handleJsonPointerDown}
          handleJsonPointerMove={handleJsonPointerMove}
          handleJsonPointerUp={handleJsonPointerUp}
          handleJsonPointerCancel={handleJsonPointerCancel}
          handleJsonMouseDown={handleJsonMouseDown}
          handleCopyJson={handleCopyJson}
        />
      ) : null}
    </section>
  );
}

// ─── Main-view sub-components ──────────────────────────────────────────────────

interface FigmaSnapshotBoardFormProps {
  readonly inputId: string;
  readonly validationId: string;
  readonly statusId: string;
  readonly boardLink: string;
  readonly setBoardLink: Setter<string>;
  readonly errorNotice: SnapshotErrorNotice | null;
  readonly setErrorNotice: Setter<SnapshotErrorNotice | null>;
  readonly buildState: BuildState;
  readonly setBuildState: Setter<BuildState>;
  readonly detachedBuild: DetachedBuild | null;
  readonly setDetachedBuild: Setter<DetachedBuild | null>;
  readonly consentInvalid: boolean;
  readonly setConsentInvalid: Setter<boolean>;
  readonly linkError: string | null;
  readonly busy: boolean;
  readonly linkValid: boolean;
  readonly isBuilding: boolean;
  readonly consentChecked: boolean;
  readonly setConsentChecked: Setter<boolean>;
  readonly consentRef: MutableRefObject<HTMLInputElement | null>;
  readonly handleSubmit: (e: FormEvent<HTMLFormElement>) => void;
}

function FigmaSnapshotBoardForm({
  inputId,
  validationId,
  statusId,
  boardLink,
  setBoardLink,
  errorNotice,
  setErrorNotice,
  buildState,
  setBuildState,
  detachedBuild,
  setDetachedBuild,
  consentInvalid,
  setConsentInvalid,
  linkError,
  busy,
  linkValid,
  isBuilding,
  consentChecked,
  setConsentChecked,
  consentRef,
  handleSubmit,
}: FigmaSnapshotBoardFormProps): ReactNode {
  return (
    <form className="figma-snapshot-form" onSubmit={handleSubmit} noValidate>
      <label className="figma-snapshot-label" htmlFor={inputId}>
        Board link
      </label>
      <div className="figma-snapshot-input-row">
        <input
          id={inputId}
          type="url"
          className="figma-snapshot-input"
          placeholder="https://www.figma.com/design/…?node-id=…"
          value={boardLink}
          onChange={(e) => {
            setBoardLink(e.target.value);
            // Editing the link invalidates any previous error — clear it so stale
            // and current feedback never contradict each other.
            if (errorNotice !== null) setErrorNotice(null);
            if (buildState === "error") setBuildState("idle");
            if (detachedBuild !== null) setDetachedBuild(null);
            if (consentInvalid) setConsentInvalid(false);
          }}
          aria-describedby={linkError !== null ? `${validationId} ${statusId}` : statusId}
          aria-invalid={linkError !== null ? "true" : undefined}
          readOnly={busy}
          autoComplete="off"
          spellCheck={false}
        />
        {/* While busy the button stays enabled (aria-disabled + handler guard) so the
            browser does not drop focus of the just-activated control to <body>. */}
        <button
          type="submit"
          className="figma-snapshot-trigger-btn"
          disabled={!linkValid && !busy}
          aria-disabled={!linkValid || busy ? "true" : undefined}
          aria-busy={isBuilding}
        >
          {isBuilding ? "Building…" : "Snapshot"}
        </button>
      </div>
      {linkError !== null && (
        <p id={validationId} className="figma-snapshot-link-error" role="alert">
          {linkError}
        </p>
      )}
      {/* Explicit read-only-scope acknowledgement (#760): recorded server-side before the first
          fetch for a board. The connector reads files + renders images — it never writes. */}
      <label className="figma-snapshot-consent">
        <input
          type="checkbox"
          className="figma-snapshot-consent-checkbox"
          ref={consentRef}
          checked={consentChecked}
          // uiux-fix F038 C210: a consent-blocked snapshot marks THIS control invalid so the
          // error visibly points at the checkbox (focus moves here too, see flagConsentRequired).
          aria-invalid={consentInvalid ? "true" : undefined}
          onChange={(e) => {
            setConsentChecked(e.target.checked);
            // Checking the box answers a consent error — clear stale feedback.
            if (errorNotice !== null) setErrorNotice(null);
            if (buildState === "error") setBuildState("idle");
            setConsentInvalid(false);
          }}
          disabled={isBuilding}
        />
        <span>
          I acknowledge the configured Figma PAT is read-only and least-privilege (
          <code>file_content:read</code>).{" "}
          <span className="figma-snapshot-consent-required">
            Required before the first snapshot of a board.
          </span>
        </span>
      </label>
      <p className="figma-snapshot-hint">
        Paste a Figma board link with a node-id param (section or frame anchor). The access token is
        resolved server-side — it never reaches this page.
      </p>
    </form>
  );
}

interface FigmaSnapshotAssertiveErrorCardProps {
  readonly buildState: BuildState;
  readonly errorNotice: SnapshotErrorNotice | null;
  readonly statusId: string;
  readonly openTokenSettings: (() => void) | undefined;
}

// ── Fix #5: assertive egress alert is a SIBLING of the status region, not nested ──
function FigmaSnapshotAssertiveErrorCard({
  buildState,
  errorNotice,
  statusId,
  openTokenSettings,
}: FigmaSnapshotAssertiveErrorCardProps): ReactNode {
  if (buildState !== "error" || errorNotice === null || errorNotice.assertive !== true) {
    return null;
  }
  return (
    <div
      className="figma-snapshot-error-card"
      role="alert"
      aria-labelledby={`${statusId}-error-title`}
    >
      <p id={`${statusId}-error-title`} className="figma-snapshot-error-title">
        {errorNotice.title}
      </p>
      <p className="figma-snapshot-error-detail">{errorNotice.detail}</p>
      {errorNotice.status !== undefined && (
        <p className="figma-snapshot-error-status">{errorNotice.status}</p>
      )}
      {errorNotice.remediation !== undefined && (
        <p className="figma-snapshot-error-remediation">{errorNotice.remediation}</p>
      )}
      {/* Issue #1399: PAT/credential errors get a direct click-through to the Figma access-token
          settings so the operator does not have to search for the setting. Focus is deliberately
          NOT moved here (unlike the consent/revoke flows, which point at a specific form control):
          this is an async build result like the sibling egress alerts above, so role="alert"
          announces the button text and the user reaches it as the next tab stop — stealing focus
          on an async network outcome would be an unexpected context change (WCAG 3.2.5). */}
      {errorNotice.tokenConfig === true && openTokenSettings !== undefined && (
        <button type="button" className="figma-snapshot-error-action" onClick={openTokenSettings}>
          Open Figma access token settings
        </button>
      )}
    </div>
  );
}

interface FigmaSnapshotStatusRegionProps {
  readonly statusId: string;
  readonly isBuilding: boolean;
  readonly buildElapsedLabel: string | null;
  readonly isLoading: boolean;
  readonly buildState: BuildState;
  readonly summary: FigmaSnapshotSummary | null;
  readonly codeState: "idle" | "generating" | "done" | "error";
  readonly code: FigmaCodegenResponse | null;
  readonly errorNotice: SnapshotErrorNotice | null;
}

function FigmaSnapshotStatusRegion({
  statusId,
  isBuilding,
  buildElapsedLabel,
  isLoading,
  buildState,
  summary,
  codeState,
  code,
  errorNotice,
}: FigmaSnapshotStatusRegionProps): ReactNode {
  return (
    <div
      id={statusId}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="figma-snapshot-status"
    >
      {isBuilding && (
        <p className="figma-snapshot-progress">
          Building snapshot — fetching screens from Figma…{" "}
          {buildElapsedLabel !== null ? `${buildElapsedLabel} elapsed.` : ""} Large boards can take
          several minutes.
        </p>
      )}
      {isLoading && <p className="figma-snapshot-progress">Loading stored snapshot…</p>}
      {/* WCAG 4.1.3: completion is announced here (visually hidden — the visible
          result renders below, outside this live region). */}
      {buildState === "done" && summary !== null && (
        <p className="sr-only">Snapshot complete — {summary.reductionHint}.</p>
      )}
      {codeState === "done" && code !== null && (
        <p className="sr-only">
          Code generated — {String(code.fileCount)} file{code.fileCount !== 1 ? "s" : ""} ready for
          review.
        </p>
      )}
      {/* Fix #7: status note when a cancel brings us back to idle. */}
      {buildState === "idle" && (
        <p className="sr-only" aria-live="polite">
          {/* intentionally empty when idle — screen reader sees nothing */}
        </p>
      )}
      {/* uiux-fix F045 C375 / Fix #5: no role="alert" inside this polite atomic live region —
          the assertive egress card was moved above as a sibling. Non-assertive errors render
          here as plain text; the live region itself announces them. */}
      {buildState === "error" && errorNotice !== null && errorNotice.assertive !== true && (
        <p className="figma-snapshot-error">{errorNotice.detail}</p>
      )}
    </div>
  );
}

interface FigmaSnapshotCancelRowProps {
  readonly isBuilding: boolean;
  readonly handleCancel: () => void;
}

// Fix #7: Cancel button during build.
function FigmaSnapshotCancelRow({
  isBuilding,
  handleCancel,
}: FigmaSnapshotCancelRowProps): ReactNode {
  if (!isBuilding) return null;
  return (
    <div className="figma-snapshot-cancel-row">
      <button type="button" className="figma-snapshot-cancel-btn" onClick={handleCancel}>
        Cancel
      </button>
      <p className="figma-snapshot-cancel-note" role="status" aria-live="polite">
        Cancelling stops this window from waiting — the server-side build continues on demand.
      </p>
    </div>
  );
}

interface FigmaSnapshotDetachedBuildNoticeProps {
  readonly detachedBuild: DetachedBuild | null;
  readonly busy: boolean;
  readonly handleReconnect: () => void;
}

function FigmaSnapshotDetachedBuildNotice({
  detachedBuild,
  busy,
  handleReconnect,
}: FigmaSnapshotDetachedBuildNoticeProps): ReactNode {
  if (detachedBuild === null || busy) return null;
  return (
    <div className="figma-snapshot-stored-notice">
      <p className="figma-snapshot-stored-text">
        This window is no longer waiting. The server may still be building the snapshot in the
        background. You can close this window safely.
      </p>
      <button type="button" className="figma-snapshot-load-btn" onClick={handleReconnect}>
        Reconnect build
      </button>
    </div>
  );
}

interface FigmaSnapshotFirstRunGuidanceProps {
  readonly buildState: BuildState;
  readonly summary: FigmaSnapshotSummary | null;
  readonly detachedBuild: DetachedBuild | null;
  readonly showLoadStored: boolean;
}

// First-run guidance (nothing captured or stored yet).
function FigmaSnapshotFirstRunGuidance({
  buildState,
  summary,
  detachedBuild,
  showLoadStored,
}: FigmaSnapshotFirstRunGuidanceProps): ReactNode {
  if (buildState !== "idle" || summary !== null || detachedBuild !== null || showLoadStored) {
    return null;
  }
  return (
    <div className="figma-snapshot-empty">
      <p className="figma-snapshot-empty-title">Capture screens from a Figma board</p>
      <ol className="figma-snapshot-empty-steps">
        <li>In Figma, select the frame or section you want to capture.</li>
        <li>Copy its link (Copy link to selection) — it contains the node-id.</li>
        <li>Paste it above, acknowledge the read-only scope, then take the snapshot.</li>
      </ol>
      <p className="figma-snapshot-empty-note">
        The snapshot stores the captured screens and their structure as immutable evidence — connect
        this window to Quality Intelligence to ground generated tests in the design. Requires a
        Figma access token configured on the server.
      </p>
    </div>
  );
}

interface FigmaSnapshotLoadStoredNoticeProps {
  readonly showLoadStored: boolean;
  readonly isLoading: boolean;
  readonly handleLoadStored: () => void;
}

// Fix #1: showLoadStored now includes buildState==="error" so the Load button stays mounted
// after a load failure — it is the retry affordance.
function FigmaSnapshotLoadStoredNotice({
  showLoadStored,
  isLoading,
  handleLoadStored,
}: FigmaSnapshotLoadStoredNoticeProps): ReactNode {
  if (!showLoadStored) return null;
  return (
    <div className="figma-snapshot-stored-notice">
      <p className="figma-snapshot-stored-text">A stored snapshot is available.</p>
      <button
        type="button"
        className="figma-snapshot-load-btn"
        onClick={handleLoadStored}
        aria-disabled={isLoading ? "true" : undefined}
        aria-busy={isLoading}
      >
        {isLoading ? "Loading…" : "Load snapshot"}
      </button>
    </div>
  );
}

type FigmaSnapshotDashboardItemActionsProps = Omit<
  FigmaSnapshotDashboardListProps,
  "snapshots" | "loading" | "error" | "emptyTitle" | "emptyDetail" | "showScope"
>;

interface FigmaSnapshotDashboardPanelProps {
  readonly dashboardId: string;
  readonly refreshDashboard: () => void;
  readonly dashboardTab: SnapshotDashboardTab;
  readonly setDashboardTab: Setter<SnapshotDashboardTab>;
  readonly currentScope: FigmaSnapshotScope | null;
  readonly snapshotManagementError: string | null;
  readonly boardSnapshots: readonly FigmaSnapshotListEntry[];
  readonly boardSnapshotsLoading: boolean;
  readonly boardSnapshotsError: string | null;
  readonly recentSnapshots: readonly FigmaSnapshotListEntry[];
  readonly recentSnapshotsLoading: boolean;
  readonly recentSnapshotsError: string | null;
  readonly dashboardItemProps: FigmaSnapshotDashboardItemActionsProps;
}

function FigmaSnapshotDashboardPanel({
  dashboardId,
  refreshDashboard,
  dashboardTab,
  setDashboardTab,
  currentScope,
  snapshotManagementError,
  boardSnapshots,
  boardSnapshotsLoading,
  boardSnapshotsError,
  recentSnapshots,
  recentSnapshotsLoading,
  recentSnapshotsError,
  dashboardItemProps,
}: FigmaSnapshotDashboardPanelProps): ReactNode {
  return (
    <section className="figma-snapshot-dashboard" aria-label="Snapshot dashboard">
      <div className="figma-snapshot-dashboard-header">
        <div>
          <p className="figma-snapshot-dashboard-eyebrow">Snapshot dashboard</p>
          <h2 className="figma-snapshot-dashboard-title">Stored snapshots</h2>
        </div>
        <button
          type="button"
          className="figma-snapshot-dashboard-refresh"
          onClick={refreshDashboard}
        >
          Refresh
        </button>
      </div>
      <div className="figma-snapshot-dashboard-tabs" role="tablist" aria-label="Snapshot views">
        <button
          type="button"
          className="figma-snapshot-dashboard-tab"
          role="tab"
          aria-selected={dashboardTab === "board"}
          aria-controls={`${dashboardId}-board-panel`}
          id={`${dashboardId}-board-tab`}
          onClick={() => {
            if (currentScope !== null) setDashboardTab("board");
          }}
          disabled={currentScope === null}
        >
          This board
        </button>
        <button
          type="button"
          className="figma-snapshot-dashboard-tab"
          role="tab"
          aria-selected={dashboardTab === "recent"}
          aria-controls={`${dashboardId}-recent-panel`}
          id={`${dashboardId}-recent-tab`}
          onClick={() => {
            setDashboardTab("recent");
          }}
        >
          Recent
        </button>
      </div>
      {snapshotManagementError !== null ? (
        <p
          className="figma-snapshot-dashboard-status figma-snapshot-dashboard-status-error"
          role="alert"
        >
          {snapshotManagementError}
        </p>
      ) : null}
      {dashboardTab === "board" ? (
        <div
          id={`${dashboardId}-board-panel`}
          className="figma-snapshot-dashboard-panel"
          role="tabpanel"
          aria-labelledby={`${dashboardId}-board-tab`}
        >
          {currentScope === null ? (
            <FigmaSnapshotDashboardList
              snapshots={[]}
              loading={false}
              error={null}
              emptyTitle="No board selected yet"
              emptyDetail="Paste a valid Figma board link or load a stored snapshot to see this board's history."
              showScope={false}
              {...dashboardItemProps}
            />
          ) : (
            <FigmaSnapshotDashboardList
              snapshots={boardSnapshots}
              loading={boardSnapshotsLoading}
              error={boardSnapshotsError}
              emptyTitle="No snapshots stored for this board"
              emptyDetail="Take the first snapshot for this board to make it available here."
              showScope={false}
              {...dashboardItemProps}
            />
          )}
        </div>
      ) : (
        <div
          id={`${dashboardId}-recent-panel`}
          className="figma-snapshot-dashboard-panel"
          role="tabpanel"
          aria-labelledby={`${dashboardId}-recent-tab`}
        >
          <FigmaSnapshotDashboardList
            snapshots={recentSnapshots}
            loading={recentSnapshotsLoading}
            error={recentSnapshotsError}
            emptyTitle="No snapshots stored yet"
            emptyDetail="Stored Figma snapshots will appear here once the first board capture completes."
            showScope={true}
            {...dashboardItemProps}
          />
        </div>
      )}
    </section>
  );
}

interface FigmaSnapshotReductionInfoProps {
  readonly summary: FigmaSnapshotSummary;
  readonly summaryManagement: FigmaSnapshotManagementSummary;
  readonly isScreenScopedSource: boolean;
  readonly selectedScreenName: string | undefined;
  readonly selectedScreenIds: readonly string[];
}

function FigmaSnapshotReductionInfo({
  summary,
  summaryManagement,
  isScreenScopedSource,
  selectedScreenName,
  selectedScreenIds,
}: FigmaSnapshotReductionInfoProps): ReactNode {
  return (
    <div className="figma-snapshot-reduction">
      <div className="figma-snapshot-result-head">
        <div>
          <h2 className="figma-snapshot-result-title" title={snapshotDisplayName(summary)}>
            {snapshotDisplayName(summary)}
          </h2>
          <p className="figma-snapshot-result-run">{summary.runId}</p>
        </div>
        <span className="figma-snapshot-result-hash" title={summary.integrityHash}>
          {shortIntegrityHash(summary.integrityHash)}
        </span>
      </div>
      <p className="figma-snapshot-reduction-hint">{summary.reductionHint}</p>
      {/* uiux-fix F045 C250: snapshot age — the information the re-snapshot
          decision hinges on. Same date presenter as the rest of the app. */}
      <p className="figma-snapshot-captured-at">Captured {formatDate(summary.fetchedAt)}</p>
      <dl className="figma-snapshot-result-metadata">
        <div>
          <dt>File</dt>
          <dd>{summary.fileKey}</dd>
        </div>
        <div>
          <dt>Node</dt>
          <dd>{summary.nodeId}</dd>
        </div>
        <div>
          <dt>Version</dt>
          <dd>{snapshotVersionLabel(summary.version)}</dd>
        </div>
        {summaryManagement.updatedAt !== undefined ? (
          <div>
            <dt>Name updated</dt>
            <dd>{formatDate(summaryManagement.updatedAt)}</dd>
          </div>
        ) : null}
      </dl>
      {isScreenScopedSource && (
        <p className="figma-snapshot-scope-note">
          QI source scope: {selectedScreenName ?? selectedScreenIds.join(", ")}
        </p>
      )}
      {summary.skippedCount > 0 && (
        <p className="figma-snapshot-skipped-notice">
          {String(summary.skippedCount)} screen{summary.skippedCount !== 1 ? "s" : ""} could not be
          rendered and were skipped.
        </p>
      )}
    </div>
  );
}

interface FigmaSnapshotCodegenPanelProps {
  readonly codeState: "idle" | "generating" | "done" | "error";
  readonly codeError: string | null;
  readonly code: FigmaCodegenResponse | null;
  readonly handleGenerateCode: () => void;
  readonly handleCancelCodegen: () => void;
}

// Design-to-code (#755): generate reviewable HTML/CSS + design tokens from the stored snapshot.
// Deterministic + model-free server-side; the result is a proposal for review.
function FigmaSnapshotCodegenPanel({
  codeState,
  codeError,
  code,
  handleGenerateCode,
  handleCancelCodegen,
}: FigmaSnapshotCodegenPanelProps): ReactNode {
  return (
    <div className="figma-snapshot-codegen">
      <div className="figma-snapshot-codegen-actions">
        <button
          type="button"
          className="figma-snapshot-codegen-btn"
          onClick={handleGenerateCode}
          aria-disabled={codeState === "generating" ? "true" : undefined}
          aria-busy={codeState === "generating"}
        >
          {codeState === "generating" ? "Generating code…" : "Generate code"}
        </button>
        {codeState === "generating" && (
          <button
            type="button"
            className="figma-snapshot-codegen-cancel-btn"
            onClick={handleCancelCodegen}
          >
            Cancel
          </button>
        )}
      </div>
      {codeState === "error" && codeError !== null && (
        <p className="figma-snapshot-error" role="alert">
          {codeError}
        </p>
      )}
      {codeState === "done" && code !== null && (
        <div className="figma-snapshot-code-result">
          <p className="figma-snapshot-code-summary">
            {String(code.fileCount)} reviewable file{code.fileCount !== 1 ? "s" : ""} (
            {String(code.screenCount)} screen{code.screenCount !== 1 ? "s" : ""}, {code.adapterName}
            ) — proposal only, never auto-applied.
          </p>
          {code.files.map((file) => (
            <details key={file.path} className="figma-snapshot-code-file">
              <summary className="figma-snapshot-code-file-path">{file.path}</summary>
              <pre className="figma-snapshot-code-file-contents">
                <code>{file.contents}</code>
              </pre>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

interface FigmaSnapshotRevokeControlsProps {
  readonly revokeConfirming: boolean;
  readonly revokeConfirmRef: MutableRefObject<HTMLButtonElement | null>;
  readonly revokeTriggerRef: MutableRefObject<HTMLButtonElement | null>;
  readonly handleRevokeConfirmed: () => void;
  readonly handleRevokeCancel: () => void;
  readonly setRevokeConfirming: Setter<boolean>;
  readonly setRevokeStatus: Setter<string | null>;
  readonly setRevokeError: Setter<string | null>;
  readonly revokeStatus: string | null;
  readonly revokeError: string | null;
}

// Fix #3: two-step inline confirm for PAT revoke. Revoke removes the stored encrypted PAT from
// the server vault (#758).
function FigmaSnapshotRevokeControls({
  revokeConfirming,
  revokeConfirmRef,
  revokeTriggerRef,
  handleRevokeConfirmed,
  handleRevokeCancel,
  setRevokeConfirming,
  setRevokeStatus,
  setRevokeError,
  revokeStatus,
  revokeError,
}: FigmaSnapshotRevokeControlsProps): ReactNode {
  return (
    <div className="figma-snapshot-revoke-row">
      {revokeConfirming ? (
        <span className="figma-snapshot-revoke-confirm">
          <span className="figma-snapshot-revoke-confirm-label">
            Really revoke the stored token?
          </span>
          <button
            ref={revokeConfirmRef}
            type="button"
            className="figma-snapshot-revoke-confirm-btn"
            onClick={handleRevokeConfirmed}
          >
            Yes, revoke
          </button>
          <button
            type="button"
            className="figma-snapshot-revoke-cancel-btn"
            onClick={handleRevokeCancel}
          >
            Cancel
          </button>
        </span>
      ) : (
        <button
          ref={revokeTriggerRef}
          type="button"
          className="figma-snapshot-revoke-btn"
          onClick={() => {
            setRevokeConfirming(true);
            setRevokeStatus(null);
            setRevokeError(null);
          }}
        >
          Revoke stored token
        </button>
      )}
      {/* aria-live status region for revoke outcome */}
      <p
        className="figma-snapshot-revoke-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {revokeStatus ?? revokeError ?? ""}
      </p>
    </div>
  );
}

type FigmaSnapshotScopesPanelProps = FigmaSnapshotRevokeControlsProps;

// PAT scopes info + Fix #3: revoke action — operator-facing.
function FigmaSnapshotScopesPanel(props: FigmaSnapshotScopesPanelProps): ReactNode {
  return (
    <details className="figma-snapshot-scopes">
      <summary className="figma-snapshot-scopes-summary">Required Figma PAT scopes</summary>
      <ul className="figma-snapshot-scopes-list">
        <li>
          <code>file_content:read</code> — read design file structure, node metadata, and rendered
          images
        </li>
      </ul>
      <p className="figma-snapshot-scopes-note">
        The token is read server-side from the vault, Keiko config, or{" "}
        <code>FIGMA_ACCESS_TOKEN</code> environment variable. This window never holds or transmits
        the token.
      </p>
      <FigmaSnapshotRevokeControls {...props} />
    </details>
  );
}

interface FigmaSnapshotGalleryProps {
  readonly displayedScreens: readonly FigmaDisplayedScreenEntry[];
  readonly visibleScreenCount: number;
  readonly setVisibleScreenCount: Setter<number>;
  readonly isScreenScopedSource: boolean;
  readonly totalScreenSummaryCount: number;
  readonly summary: FigmaSnapshotSummary;
  readonly openScreenSource:
    | ((input: {
        readonly snapshotRunId: string;
        readonly screenId: string;
        readonly name: string;
      }) => void)
    | undefined;
  readonly selectedScreenIdSet: ReadonlySet<string>;
}

// Screen gallery.
function FigmaSnapshotGallery({
  displayedScreens,
  visibleScreenCount,
  setVisibleScreenCount,
  isScreenScopedSource,
  totalScreenSummaryCount,
  summary,
  openScreenSource,
  selectedScreenIdSet,
}: FigmaSnapshotGalleryProps): ReactNode {
  if (displayedScreens.length === 0) {
    return (
      <div className="lk-empty">
        <p className="lk-empty-body">
          {isScreenScopedSource
            ? "The selected screen is not present in this stored snapshot."
            : "No screens were captured from this board section."}
        </p>
      </div>
    );
  }
  return (
    <>
      <section
        className="figma-snapshot-gallery"
        aria-label={
          isScreenScopedSource
            ? `${String(displayedScreens.length)} selected screen${displayedScreens.length !== 1 ? "s" : ""}`
            : `${String(totalScreenSummaryCount)} captured and structural screen${totalScreenSummaryCount !== 1 ? "s" : ""}`
        }
      >
        {displayedScreens.slice(0, visibleScreenCount).map((entry, displayIndex) => {
          const onAddSource =
            openScreenSource === undefined
              ? undefined
              : () =>
                  openScreenSource({
                    snapshotRunId: summary.runId,
                    screenId: entry.screen.screenId,
                    name: entry.screen.name,
                  });
          const dragPayload: FigmaViewDragPayload = {
            snapshotRunId: summary.runId,
            screenId: entry.screen.screenId,
            name: entry.screen.name,
          };
          return entry.kind === "rendered" ? (
            <ScreenCard
              key={entry.screen.screenId}
              index={displayIndex}
              screenId={entry.screen.screenId}
              name={entry.screen.name}
              irSummary={entry.screen.irSummary}
              imageSrc={figmaSnapshotScreenImageUrl(summary.runId, entry.imageIndex)}
              imageByteLength={entry.screen.imageByteLength}
              onAddSource={onAddSource}
              isSourceSelected={selectedScreenIdSet.has(entry.screen.screenId)}
              dragPayload={dragPayload}
            />
          ) : (
            <ScreenCard
              key={entry.screen.screenId}
              index={displayIndex}
              screenId={entry.screen.screenId}
              name={entry.screen.name}
              irSummary={entry.screen.irSummary}
              structuralReason={entry.screen.reason}
              onAddSource={onAddSource}
              isSourceSelected={selectedScreenIdSet.has(entry.screen.screenId)}
              dragPayload={dragPayload}
            />
          );
        })}
      </section>
      {visibleScreenCount < displayedScreens.length ? (
        <button
          type="button"
          className="figma-snapshot-gallery-more"
          onClick={() =>
            setVisibleScreenCount((count) =>
              Math.min(count + INITIAL_GALLERY_LIMIT, displayedScreens.length),
            )
          }
        >
          Show more screens
        </button>
      ) : null}
    </>
  );
}

interface FigmaSnapshotResultSectionProps {
  readonly summary: FigmaSnapshotSummary | null;
  readonly summaryManagement: FigmaSnapshotManagementSummary;
  readonly isScreenScopedSource: boolean;
  readonly selectedScreenName: string | undefined;
  readonly selectedScreenIds: readonly string[];
  readonly busy: boolean;
  readonly isBuilding: boolean;
  readonly handleResnapshot: () => void;
  readonly codeState: "idle" | "generating" | "done" | "error";
  readonly codeError: string | null;
  readonly code: FigmaCodegenResponse | null;
  readonly handleGenerateCode: () => void;
  readonly handleCancelCodegen: () => void;
  readonly displayedScreens: readonly FigmaDisplayedScreenEntry[];
  readonly visibleScreenCount: number;
  readonly setVisibleScreenCount: Setter<number>;
  readonly totalScreenSummaryCount: number;
  readonly openScreenSource:
    | ((input: {
        readonly snapshotRunId: string;
        readonly screenId: string;
        readonly name: string;
      }) => void)
    | undefined;
  readonly selectedScreenIdSet: ReadonlySet<string>;
  readonly revokeConfirming: boolean;
  readonly revokeConfirmRef: MutableRefObject<HTMLButtonElement | null>;
  readonly revokeTriggerRef: MutableRefObject<HTMLButtonElement | null>;
  readonly handleRevokeConfirmed: () => void;
  readonly handleRevokeCancel: () => void;
  readonly setRevokeConfirming: Setter<boolean>;
  readonly setRevokeStatus: Setter<string | null>;
  readonly setRevokeError: Setter<string | null>;
  readonly revokeStatus: string | null;
  readonly revokeError: string | null;
}

// Fix #2: render the result section whenever summary !== null (not only when buildState==="done")
// so a failed re-snapshot does not orphan the previous result. Building/error overlay status is
// shown inside the result section itself.
function FigmaSnapshotResultSection(props: FigmaSnapshotResultSectionProps): ReactNode {
  const { summary } = props;
  if (summary === null) return null;
  const {
    summaryManagement,
    isScreenScopedSource,
    selectedScreenName,
    selectedScreenIds,
    busy,
    isBuilding,
    handleResnapshot,
    codeState,
    codeError,
    code,
    handleGenerateCode,
    handleCancelCodegen,
    displayedScreens,
    visibleScreenCount,
    setVisibleScreenCount,
    totalScreenSummaryCount,
    openScreenSource,
    selectedScreenIdSet,
    ...revokeProps
  } = props;
  return (
    <div className="figma-snapshot-result">
      {/* Reduction info */}
      <FigmaSnapshotReductionInfo
        summary={summary}
        summaryManagement={summaryManagement}
        isScreenScopedSource={isScreenScopedSource}
        selectedScreenName={selectedScreenName}
        selectedScreenIds={selectedScreenIds}
      />

      {/* Fix #2: Re-snapshot uses aria-disabled + guard so it never unmounts mid-action. */}
      <button
        type="button"
        className="figma-snapshot-resnapshot-btn"
        onClick={handleResnapshot}
        aria-disabled={busy ? "true" : undefined}
        aria-busy={isBuilding}
        aria-label="Re-snapshot this board"
      >
        {isBuilding ? "Building…" : "Re-snapshot"}
      </button>

      <FigmaSnapshotCodegenPanel
        codeState={codeState}
        codeError={codeError}
        code={code}
        handleGenerateCode={handleGenerateCode}
        handleCancelCodegen={handleCancelCodegen}
      />

      <FigmaSnapshotScopesPanel {...revokeProps} />

      {/* Screen gallery */}
      <FigmaSnapshotGallery
        displayedScreens={displayedScreens}
        visibleScreenCount={visibleScreenCount}
        setVisibleScreenCount={setVisibleScreenCount}
        isScreenScopedSource={isScreenScopedSource}
        totalScreenSummaryCount={totalScreenSummaryCount}
        summary={summary}
        openScreenSource={openScreenSource}
        selectedScreenIdSet={selectedScreenIdSet}
      />
    </div>
  );
}

export function FigmaSnapshotWindow({
  sourceWindowId,
  snapshotRunId,
  selectedScreenIds = EMPTY_SELECTED_SCREEN_IDS,
  selectedScreenName,
  openScreenSource,
  openTokenSettings,
  updateCfg,
  triggerImpl = triggerFigmaSnapshot,
  loadImpl = loadFigmaSnapshotSummary,
  listImpl = listFigmaSnapshots,
  updateMetadataImpl = updateFigmaSnapshotMetadata,
  deleteImpl = deleteFigmaSnapshot,
  loadScreenJsonImpl = loadFigmaSnapshotScreenJson,
  codegenImpl = generateFigmaCode,
  revokeImpl = revokeFigmaToken,
}: FigmaSnapshotWindowProps): ReactNode {
  const inputId = useId();
  const statusId = useId();
  const validationId = useId();
  const dashboardId = useId();

  const [boardLink, setBoardLink] = useState("");
  const [buildState, setBuildState] = useState<BuildState>("idle");
  const [summary, setSummary] = useState<FigmaSnapshotSummary | null>(null);
  const [errorNotice, setErrorNotice] = useState<SnapshotErrorNotice | null>(null);
  const [detachedBuild, setDetachedBuild] = useState<DetachedBuild | null>(null);
  const [buildStartedAt, setBuildStartedAt] = useState<number | null>(null);
  const [buildElapsedMs, setBuildElapsedMs] = useState(0);
  const [dashboardTab, setDashboardTab] = useState<SnapshotDashboardTab>("recent");
  const [boardSnapshots, setBoardSnapshots] = useState<readonly FigmaSnapshotListEntry[]>([]);
  const [recentSnapshots, setRecentSnapshots] = useState<readonly FigmaSnapshotListEntry[]>([]);
  const [boardSnapshotsLoading, setBoardSnapshotsLoading] = useState(false);
  const [recentSnapshotsLoading, setRecentSnapshotsLoading] = useState(false);
  const [boardSnapshotsError, setBoardSnapshotsError] = useState<string | null>(null);
  const [recentSnapshotsError, setRecentSnapshotsError] = useState<string | null>(null);
  const [renamingSnapshotRunId, setRenamingSnapshotRunId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [detailsSnapshotRunId, setDetailsSnapshotRunId] = useState<string | null>(null);
  const [deleteConfirmRunId, setDeleteConfirmRunId] = useState<string | null>(null);
  const [snapshotManagementBusyRunId, setSnapshotManagementBusyRunId] = useState<string | null>(
    null,
  );
  const [snapshotManagementError, setSnapshotManagementError] = useState<string | null>(null);
  // Explicit read-only-scope acknowledgement (#760) — recorded server-side before the first build.
  const [consentChecked, setConsentChecked] = useState(false);
  // uiux-fix F038 C210: when consent blocks a snapshot (inline pre-check OR the server's 428
  // FIGMA_CONSENT_REQUIRED), the error must point AT the checkbox — mark it invalid and move
  // focus to it instead of leaving the user to connect message and control themselves.
  const [consentInvalid, setConsentInvalid] = useState(false);
  const consentRef = useRef<HTMLInputElement | null>(null);

  // Fix #7: AbortController for the active build/load fetch.
  const abortRef = useRef<AbortController | null>(null);
  const codeAbortRef = useRef<AbortController | null>(null);
  const screenJsonAbortRef = useRef<AbortController | null>(null);
  const dashboardAbortRef = useRef<AbortController | null>(null);
  const snapshotManagementAbortRef = useRef<AbortController | null>(null);
  const activeBuildRef = useRef<DetachedBuild | null>(null);
  const jsonPointerDragRef = useRef<DragPointerSession | null>(null);
  const suppressNextMouseDropRef = useRef(false);
  const jsonMouseDragCleanupRef = useRef<(() => void) | null>(null);

  const flagConsentRequired = useCallback((): void => {
    setConsentInvalid(true);
  }, []);

  // Design-to-code (#755) state — a reviewable artifact generated from the stored snapshot.
  const [codeState, setCodeState] = useState<"idle" | "generating" | "done" | "error">("idle");
  const [code, setCode] = useState<FigmaCodegenResponse | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [screenJsonState, setScreenJsonState] = useState<"idle" | "loading" | "done" | "error">(
    "idle",
  );
  const [screenJson, setScreenJson] = useState<FigmaSnapshotScreenJsonResponse | null>(null);
  const [screenJsonError, setScreenJsonError] = useState<string | null>(null);
  const [screenJsonCopyStatus, setScreenJsonCopyStatus] = useState<string | null>(null);

  // Fix #3: PAT revoke state — two-step inline confirm.
  const [revokeConfirming, setRevokeConfirming] = useState(false);
  const [revokeStatus, setRevokeStatus] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const revokeConfirmRef = useRef<HTMLButtonElement | null>(null);
  const revokeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [visibleScreenCount, setVisibleScreenCount] = useState(INITIAL_GALLERY_LIMIT);
  const selectedScreenIdKey = selectedScreenIds.join("\u0000");

  const linkValid = isValidFigmaLink(boardLink);
  const linkError = figmaLinkValidationMessage(boardLink);
  const currentScope = useMemo(
    () =>
      summary !== null
        ? { fileKey: summary.fileKey, nodeId: summary.nodeId }
        : parseFigmaScope(boardLink),
    [boardLink, summary],
  );
  const currentScopeFileKey = currentScope?.fileKey;
  const currentScopeNodeId = currentScope?.nodeId;
  const isBuilding = buildState === "building";
  const isLoading = buildState === "loading";
  const busy = isBuilding || isLoading;
  const buildElapsedLabel =
    isBuilding && buildStartedAt !== null ? formatElapsed(buildElapsedMs) : null;
  const selectedScreenIdSet = useMemo(() => new Set(selectedScreenIds), [selectedScreenIds]);
  const isScreenScopedSource = selectedScreenIds.length > 0;
  const isViewSourceMode =
    isScreenScopedSource && snapshotRunId !== undefined && snapshotRunId.length > 0;
  const displayedScreens = useMemo(() => {
    if (summary === null) return [];
    const renderedIds = new Set(summary.screens.map((screen) => screen.screenId));
    const rendered = summary.screens.map((screen, imageIndex) => ({
      kind: "rendered" as const,
      screen,
      imageIndex,
    }));
    const structural = (summary.structuralScreens ?? [])
      .filter((screen) => !renderedIds.has(screen.screenId))
      .map((screen) => ({ kind: "structural" as const, screen }));
    const all = [...rendered, ...structural];
    if (!isScreenScopedSource) return all;
    return all.filter((entry) => selectedScreenIdSet.has(entry.screen.screenId));
  }, [isScreenScopedSource, selectedScreenIdSet, summary]);
  const inspectableScreenId = selectedScreenIds.length === 1 ? selectedScreenIds[0] : undefined;
  const screenJsonText = useMemo(
    () => (screenJson === null ? "" : JSON.stringify(screenJson, null, 2)),
    [screenJson],
  );
  const screenJsonBytes = useMemo(() => jsonTextByteLength(screenJsonText), [screenJsonText]);
  const totalScreenSummaryCount =
    (summary?.screens.length ?? 0) + (summary?.structuralScreens?.length ?? 0);
  const summaryManagement: FigmaSnapshotManagementSummary =
    summary === null ? {} : snapshotManagement(summary);

  // uiux-fix F038 C210: move focus onto the consent checkbox once a consent-blocked error has
  // rendered. An effect (not an inline .focus() in the handler) because in the server-428 path
  // the checkbox is still disabled={isBuilding} when the error is caught — focusing must wait
  // for the re-render that re-enables it.
  useEffect(() => {
    if (consentInvalid && buildState === "error") consentRef.current?.focus();
  }, [consentInvalid, buildState]);

  // Fix #3: focus the confirm button when the revoke confirm step opens.
  useEffect(() => {
    if (revokeConfirming) revokeConfirmRef.current?.focus();
  }, [revokeConfirming]);

  useEffect(() => {
    if (!isBuilding || buildStartedAt === null) return;
    setBuildElapsedMs(Date.now() - buildStartedAt);
    const timer = window.setInterval(() => {
      setBuildElapsedMs(Date.now() - buildStartedAt);
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [isBuilding, buildStartedAt]);

  // Fix #7: abort in-flight fetch on unmount.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      codeAbortRef.current?.abort();
      screenJsonAbortRef.current?.abort();
      dashboardAbortRef.current?.abort();
      snapshotManagementAbortRef.current?.abort();
      jsonMouseDragCleanupRef.current?.();
      jsonMouseDragCleanupRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (currentScope === null && dashboardTab === "board") setDashboardTab("recent");
  }, [currentScope, dashboardTab]);

  const refreshDashboard = useCallback((): void => {
    dashboardAbortRef.current?.abort();
    const controller = new AbortController();
    dashboardAbortRef.current = controller;
    refreshRecentFigmaSnapshots({
      listImpl,
      controller,
      dashboardAbortRef,
      setRecentSnapshots,
      setRecentSnapshotsLoading,
      setRecentSnapshotsError,
    });
    refreshBoardFigmaSnapshots({
      listImpl,
      controller,
      dashboardAbortRef,
      currentScopeFileKey,
      currentScopeNodeId,
      setBoardSnapshots,
      setBoardSnapshotsLoading,
      setBoardSnapshotsError,
    });
  }, [currentScopeFileKey, currentScopeNodeId, listImpl]);

  useEffect(() => {
    refreshDashboard();
  }, [refreshDashboard, summary?.runId]);

  const loadSnapshotByRunId = useCallback(
    (runId: string): void => {
      loadStoredFigmaSnapshot({
        runId,
        busy,
        loadImpl,
        currentSnapshotRunId: snapshotRunId,
        updateCfg,
        abortRef,
        setBuildState,
        setErrorNotice,
        setDetachedBuild,
        setCodeState,
        setCode,
        setCodeError,
        setScreenJsonState,
        setScreenJson,
        setScreenJsonError,
        setScreenJsonCopyStatus,
        setSummary,
        setBoardLink,
      });
    },
    [busy, loadImpl, snapshotRunId, updateCfg],
  );

  useEffect(() => {
    if (!isViewSourceMode) return;
    if (snapshotRunId === undefined || snapshotRunId.length === 0) return;
    if (summary !== null || buildState !== "idle") return;
    loadSnapshotByRunId(snapshotRunId);
  }, [buildState, isViewSourceMode, loadSnapshotByRunId, snapshotRunId, summary]);

  const runBuild = useCallback(
    async (link: string, isResnapshot: boolean): Promise<void> => {
      await runFigmaSnapshotBuild({
        link,
        isResnapshot,
        triggerImpl,
        consentChecked,
        updateCfg,
        flagConsentRequired,
        abortRef,
        codeAbortRef,
        screenJsonAbortRef,
        activeBuildRef,
        setBuildState,
        setErrorNotice,
        setDetachedBuild,
        setBuildStartedAt,
        setBuildElapsedMs,
        setCodeState,
        setCode,
        setScreenJsonState,
        setScreenJson,
        setScreenJsonError,
        setScreenJsonCopyStatus,
        setSummary,
        setBoardLink,
      });
    },
    [triggerImpl, updateCfg, consentChecked, flagConsentRequired],
  );

  const handleSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>): void => {
      e.preventDefault();
      submitFigmaBoardLink({
        linkValid,
        busy,
        consentChecked,
        boardLink,
        runBuild,
        flagConsentRequired,
        setErrorNotice,
        setBuildState,
      });
    },
    [boardLink, busy, consentChecked, linkValid, runBuild, flagConsentRequired],
  );

  const handleResnapshot = useCallback((): void => {
    // Fix #2: aria-disabled guard — the button stays mounted so focus is never dropped.
    if (busy) return;
    if (summary === null) return;
    void runBuild(boardLinkFromSnapshot(summary), true);
  }, [busy, runBuild, summary]);

  // Fix #7: Cancel the in-flight build and return to idle with a status note.
  const handleCancel = useCallback((): void => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBuildStartedAt(null);
    setBuildElapsedMs(0);
    if (activeBuildRef.current !== null) setDetachedBuild(activeBuildRef.current);
    activeBuildRef.current = null;
    setBuildState("idle");
    setErrorNotice(null);
  }, []);

  const handleReconnect = useCallback((): void => {
    if (busy || detachedBuild === null) return;
    void runBuild(detachedBuild.link, detachedBuild.isResnapshot);
  }, [busy, detachedBuild, runBuild]);

  const handleGenerateCode = useCallback((): void => {
    generateFigmaCodeForSnapshot({
      runId: summary?.runId ?? snapshotRunId,
      codeState,
      codegenImpl,
      codeAbortRef,
      setCodeState,
      setCode,
      setCodeError,
    });
  }, [codegenImpl, codeState, snapshotRunId, summary]);

  const handleInspectJson = useCallback((): void => {
    loadFigmaScreenJsonForInspection({
      runId: summary?.runId ?? snapshotRunId,
      screenId: inspectableScreenId,
      screenJsonState,
      loadScreenJsonImpl,
      screenJsonAbortRef,
      setScreenJsonState,
      setScreenJson,
      setScreenJsonError,
      setScreenJsonCopyStatus,
    });
  }, [inspectableScreenId, loadScreenJsonImpl, screenJsonState, snapshotRunId, summary?.runId]);

  const handleCopyJson = useCallback((): void => {
    copyFigmaScreenJson({ screenJsonText, setScreenJsonCopyStatus });
  }, [screenJsonText]);

  const jsonDragPayload = useMemo<FigmaJsonDragPayload | null>(
    () =>
      computeFigmaJsonDragPayload({
        screenJsonRunId: screenJson?.runId,
        screenJsonScreenId: screenJson?.screen.screenId,
        screenJsonScreenName: screenJson?.screen.name,
        summaryRunId: summary?.runId,
        snapshotRunId,
        inspectableScreenId,
        selectedScreenName,
        sourceWindowId,
      }),
    [
      inspectableScreenId,
      screenJson?.runId,
      screenJson?.screen.name,
      screenJson?.screen.screenId,
      selectedScreenName,
      snapshotRunId,
      sourceWindowId,
      summary?.runId,
    ],
  );

  const handleJsonDragStart = useCallback(
    (event: DragEvent<HTMLElement>): void => {
      if (jsonDragPayload === null) return;
      event.dataTransfer.effectAllowed = "copyMove";
      event.dataTransfer.setData(FIGMA_JSON_DRAG_TYPE, serializeFigmaJsonDrag(jsonDragPayload));
      event.dataTransfer.setData("text/plain", `${jsonDragPayload.name}.json`);
    },
    [jsonDragPayload],
  );

  const handleJsonDragEnd = useCallback(
    (event: DragEvent<HTMLElement>): void => {
      if (jsonDragPayload === null) return;
      if (isWorkspaceDropTarget(event.clientX, event.clientY)) {
        dispatchFigmaJsonDrop(jsonDragPayload, event);
      }
    },
    [jsonDragPayload],
  );

  const handleJsonDragSurfaceKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>): void => {
      if (jsonDragPayload === null) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      dispatchFigmaJsonDrop(jsonDragPayload, {
        clientX: rect.right + 24,
        clientY: rect.top + rect.height / 2,
      });
    },
    [jsonDragPayload],
  );

  const handleJsonPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>): void => {
      if (jsonDragPayload === null || event.button !== 0) return;
      beginDragPointerSession(event, jsonPointerDragRef, suppressNextMouseDropRef);
    },
    [jsonDragPayload],
  );

  const handleJsonPointerMove = useCallback((event: PointerEvent<HTMLElement>): void => {
    trackDragPointerMove(event, jsonPointerDragRef);
  }, []);

  const handleJsonPointerUp = useCallback(
    (event: PointerEvent<HTMLElement>): void => {
      endDragPointerSession({
        event,
        sessionRef: jsonPointerDragRef,
        suppressNextMouseDropRef,
        payload: jsonDragPayload ?? undefined,
        dispatchDrop: dispatchFigmaJsonDrop,
      });
    },
    [jsonDragPayload],
  );

  const handleJsonPointerCancel = useCallback((event: PointerEvent<HTMLElement>): void => {
    cancelDragPointerSession(event, jsonPointerDragRef);
  }, []);

  const handleJsonMouseDown = useCallback(
    (event: MouseEvent<HTMLElement>): void => {
      if (jsonDragPayload === null || event.button !== 0) return;
      jsonMouseDragCleanupRef.current?.();
      startMouseDragTracking({
        payload: jsonDragPayload,
        startX: event.clientX,
        startY: event.clientY,
        suppressNextMouseDropRef,
        mouseDragCleanupRef: jsonMouseDragCleanupRef,
        dispatchDrop: dispatchFigmaJsonDrop,
      });
    },
    [jsonDragPayload],
  );

  const handleCancelCodegen = useCallback((): void => {
    codeAbortRef.current?.abort();
    codeAbortRef.current = null;
    setCodeState("idle");
    setCodeError(null);
  }, []);

  // Load a previously stored snapshot (e.g. after window re-open) when runId is in cfg but no
  // in-memory summary is present.
  const handleLoadStored = useCallback((): void => {
    if (snapshotRunId === undefined || snapshotRunId.length === 0 || busy) return;
    loadSnapshotByRunId(snapshotRunId);
  }, [busy, loadSnapshotByRunId, snapshotRunId]);

  useEffect(() => {
    setVisibleScreenCount(INITIAL_GALLERY_LIMIT);
  }, [selectedScreenIdKey, summary?.runId]);

  useEffect(() => {
    screenJsonAbortRef.current?.abort();
    screenJsonAbortRef.current = null;
    setScreenJsonState("idle");
    setScreenJson(null);
    setScreenJsonError(null);
    setScreenJsonCopyStatus(null);
  }, [selectedScreenIdKey, snapshotRunId]);

  const handleRevokeConfirmed = useCallback((): void => {
    setRevokeConfirming(false);
    setRevokeError(null);
    setRevokeStatus(null);
    revokeImpl()
      .then((result: FigmaRevokeTokenResult) => {
        setRevokeStatus(result.message);
        requestAnimationFrame(() => revokeTriggerRef.current?.focus());
      })
      .catch((err: unknown) => {
        setRevokeError(formatError(err));
        requestAnimationFrame(() => revokeTriggerRef.current?.focus());
      });
  }, [revokeImpl]);

  const handleRevokeCancel = useCallback((): void => {
    setRevokeConfirming(false);
    requestAnimationFrame(() => revokeTriggerRef.current?.focus());
  }, []);

  const handleStartRename = useCallback((snapshot: FigmaSnapshotListEntry): void => {
    setRenamingSnapshotRunId(snapshot.runId);
    setRenameValue(snapshot.displayName ?? "");
    setDetailsSnapshotRunId(null);
    setDeleteConfirmRunId(null);
    setSnapshotManagementError(null);
  }, []);

  const handleCancelRename = useCallback((): void => {
    setRenamingSnapshotRunId(null);
    setRenameValue("");
  }, []);

  const handleRenameSnapshot = useCallback(
    (runId: string): void => {
      if (snapshotManagementBusyRunId !== null) return;
      snapshotManagementAbortRef.current?.abort();
      const controller = new AbortController();
      snapshotManagementAbortRef.current = controller;
      renameFigmaSnapshot({
        runId,
        controller,
        renameValue,
        summaryRunId: summary?.runId,
        updateMetadataImpl,
        snapshotManagementAbortRef,
        setSummary,
        setBoardSnapshots,
        setRecentSnapshots,
        setRenamingSnapshotRunId,
        setRenameValue,
        setSnapshotManagementError,
        setSnapshotManagementBusyRunId,
      });
    },
    [renameValue, snapshotManagementBusyRunId, summary?.runId, updateMetadataImpl],
  );

  const handleToggleDetails = useCallback((runId: string): void => {
    setDetailsSnapshotRunId((current) => (current === runId ? null : runId));
    setRenamingSnapshotRunId(null);
    setDeleteConfirmRunId(null);
    setSnapshotManagementError(null);
  }, []);

  const handleRequestDelete = useCallback((runId: string): void => {
    setDeleteConfirmRunId(runId);
    setRenamingSnapshotRunId(null);
    setDetailsSnapshotRunId(null);
    setSnapshotManagementError(null);
  }, []);

  const handleDeleteSnapshot = useCallback(
    (runId: string): void => {
      if (snapshotManagementBusyRunId !== null) return;
      snapshotManagementAbortRef.current?.abort();
      const controller = new AbortController();
      snapshotManagementAbortRef.current = controller;
      deleteFigmaSnapshotByRunId({
        runId,
        controller,
        summaryRunId: summary?.runId,
        currentSnapshotRunId: snapshotRunId,
        deleteImpl,
        updateCfg,
        snapshotManagementAbortRef,
        setSummary,
        setBuildState,
        setCodeState,
        setCode,
        setScreenJsonState,
        setScreenJson,
        setBoardSnapshots,
        setRecentSnapshots,
        setDeleteConfirmRunId,
        setRenamingSnapshotRunId,
        setDetailsSnapshotRunId,
        setSnapshotManagementError,
        setSnapshotManagementBusyRunId,
      });
    },
    [deleteImpl, snapshotManagementBusyRunId, snapshotRunId, summary?.runId, updateCfg],
  );

  // Fix #1: keep the Load button mounted when buildState==="error" && summary===null so
  // it acts as a retry affordance. The original condition excluded "error" state.
  const showLoadStored = computeShowLoadStored(snapshotRunId, summary, buildState);

  const dashboardItemProps: FigmaSnapshotDashboardItemActionsProps = {
    currentRunId: summary?.runId,
    busy,
    isLoading,
    loadingRunId: snapshotRunId,
    snapshotManagementBusyRunId,
    detailsSnapshotRunId,
    renamingSnapshotRunId,
    deleteConfirmRunId,
    renameValue,
    onLoad: loadSnapshotByRunId,
    onStartRename: handleStartRename,
    onToggleDetails: handleToggleDetails,
    onRequestDelete: handleRequestDelete,
    onRenameValueChange: setRenameValue,
    onRenameSubmit: handleRenameSnapshot,
    onCancelRename: handleCancelRename,
    onConfirmDelete: handleDeleteSnapshot,
    onCancelDelete: () => {
      setDeleteConfirmRunId(null);
    },
  };

  if (isViewSourceMode) {
    return (
      <FigmaViewSourceModeSection
        selectedScreenName={selectedScreenName}
        selectedScreenIds={selectedScreenIds}
        inspectableScreenId={inspectableScreenId}
        summary={summary}
        snapshotRunId={snapshotRunId}
        screenJsonState={screenJsonState}
        statusId={statusId}
        isLoading={isLoading}
        buildState={buildState}
        errorNotice={errorNotice}
        displayedScreens={displayedScreens}
        sourceWindowId={sourceWindowId}
        screenJsonError={screenJsonError}
        screenJson={screenJson}
        jsonDragPayload={jsonDragPayload}
        handleLoadStored={handleLoadStored}
        handleInspectJson={handleInspectJson}
        handleJsonDragStart={handleJsonDragStart}
        handleJsonDragEnd={handleJsonDragEnd}
        handleJsonDragSurfaceKeyDown={handleJsonDragSurfaceKeyDown}
        handleJsonPointerDown={handleJsonPointerDown}
        handleJsonPointerMove={handleJsonPointerMove}
        handleJsonPointerUp={handleJsonPointerUp}
        handleJsonPointerCancel={handleJsonPointerCancel}
        handleJsonMouseDown={handleJsonMouseDown}
        handleCopyJson={handleCopyJson}
        screenJsonBytes={screenJsonBytes}
        screenJsonCopyStatus={screenJsonCopyStatus}
        screenJsonText={screenJsonText}
      />
    );
  }

  return (
    <section className="figma-snapshot-window" aria-label="Figma Snapshot">
      {/* ── Board link input ────────────────────────────────────────────── */}
      <FigmaSnapshotBoardForm
        inputId={inputId}
        validationId={validationId}
        statusId={statusId}
        boardLink={boardLink}
        setBoardLink={setBoardLink}
        errorNotice={errorNotice}
        setErrorNotice={setErrorNotice}
        buildState={buildState}
        setBuildState={setBuildState}
        detachedBuild={detachedBuild}
        setDetachedBuild={setDetachedBuild}
        consentInvalid={consentInvalid}
        setConsentInvalid={setConsentInvalid}
        linkError={linkError}
        busy={busy}
        linkValid={linkValid}
        isBuilding={isBuilding}
        consentChecked={consentChecked}
        setConsentChecked={setConsentChecked}
        consentRef={consentRef}
        handleSubmit={handleSubmit}
      />

      <FigmaSnapshotAssertiveErrorCard
        buildState={buildState}
        errorNotice={errorNotice}
        statusId={statusId}
        openTokenSettings={openTokenSettings}
      />

      {/* ── Status / progress ─────────────────────────────────────────────── */}
      <FigmaSnapshotStatusRegion
        statusId={statusId}
        isBuilding={isBuilding}
        buildElapsedLabel={buildElapsedLabel}
        isLoading={isLoading}
        buildState={buildState}
        summary={summary}
        codeState={codeState}
        code={code}
        errorNotice={errorNotice}
      />

      <FigmaSnapshotCancelRow isBuilding={isBuilding} handleCancel={handleCancel} />

      <FigmaSnapshotDetachedBuildNotice
        detachedBuild={detachedBuild}
        busy={busy}
        handleReconnect={handleReconnect}
      />

      {/* ── First-run guidance (nothing captured or stored yet) ───────────── */}
      <FigmaSnapshotFirstRunGuidance
        buildState={buildState}
        summary={summary}
        detachedBuild={detachedBuild}
        showLoadStored={showLoadStored}
      />

      {/* ── Load stored snapshot ──────────────────────────────────────────── */}
      <FigmaSnapshotLoadStoredNotice
        showLoadStored={showLoadStored}
        isLoading={isLoading}
        handleLoadStored={handleLoadStored}
      />

      <FigmaSnapshotDashboardPanel
        dashboardId={dashboardId}
        refreshDashboard={refreshDashboard}
        dashboardTab={dashboardTab}
        setDashboardTab={setDashboardTab}
        currentScope={currentScope}
        snapshotManagementError={snapshotManagementError}
        boardSnapshots={boardSnapshots}
        boardSnapshotsLoading={boardSnapshotsLoading}
        boardSnapshotsError={boardSnapshotsError}
        recentSnapshots={recentSnapshots}
        recentSnapshotsLoading={recentSnapshotsLoading}
        recentSnapshotsError={recentSnapshotsError}
        dashboardItemProps={dashboardItemProps}
      />

      {/* ── Snapshot summary ──────────────────────────────────────────────── */}
      <FigmaSnapshotResultSection
        summary={summary}
        summaryManagement={summaryManagement}
        isScreenScopedSource={isScreenScopedSource}
        selectedScreenName={selectedScreenName}
        selectedScreenIds={selectedScreenIds}
        busy={busy}
        isBuilding={isBuilding}
        handleResnapshot={handleResnapshot}
        codeState={codeState}
        codeError={codeError}
        code={code}
        handleGenerateCode={handleGenerateCode}
        handleCancelCodegen={handleCancelCodegen}
        displayedScreens={displayedScreens}
        visibleScreenCount={visibleScreenCount}
        setVisibleScreenCount={setVisibleScreenCount}
        totalScreenSummaryCount={totalScreenSummaryCount}
        openScreenSource={openScreenSource}
        selectedScreenIdSet={selectedScreenIdSet}
        revokeConfirming={revokeConfirming}
        revokeConfirmRef={revokeConfirmRef}
        revokeTriggerRef={revokeTriggerRef}
        handleRevokeConfirmed={handleRevokeConfirmed}
        handleRevokeCancel={handleRevokeCancel}
        setRevokeConfirming={setRevokeConfirming}
        setRevokeStatus={setRevokeStatus}
        setRevokeError={setRevokeError}
        revokeStatus={revokeStatus}
        revokeError={revokeError}
      />
    </section>
  );
}
