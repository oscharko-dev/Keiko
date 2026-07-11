"use client";

import {
  type PdfCitationPreviewOpenResponse,
  type PdfCitationPreviewReasonCode,
} from "@oscharko-dev/keiko-contracts";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MutableRefObject,
  type ReactNode,
} from "react";
import type { PDFDocumentProxy as PdfJsDocumentProxy } from "pdfjs-dist";
import styles from "./PdfCitationPreviewWindow.module.css";
import {
  ApiError,
  fetchPdfCitationPreviewDocument,
  openPdfCitationPreviewSession,
  pdfCitationPreviewDocumentUrl,
} from "@/lib/api";
import { Icons } from "../../Icons";
import type { WorkspaceApi } from "../../hooks/useWorkspace.types";
import type { AppWindow } from "../../windows/types";
import {
  activatePdfCitationPreviewBackToChat,
  activatePdfCitationPreviewContext,
  getPdfCitationPreviewBackToChatAvailability,
  getPdfCitationPreviewSession,
  pdfCitationPreviewFailureCopy,
  replacePdfCitationPreviewWindowFailure,
  replacePdfCitationPreviewWindowSession,
  subscribePdfCitationPreviewRegistry,
  type PdfCitationPreviewAnswerContext,
  type PdfCitationPreviewContextCitation,
  type PdfCitationPreviewSafeWindowCfg,
  type PdfCitationPreviewZoomMode,
} from "./pdf-citation-preview-session";

const MAX_SCALE = 2;
const MIN_SCALE = 0.5;
const PAGE_FRAME_PX = 32;
const PAGE_OUTER_CHROME_PX = 64;
const PAGE_SCROLL_GAP_PX = 18;
const PAGE_WINDOW_RADIUS = 3;
const RENDER_RADIUS = 1;
const SLOW_LOAD_MS = 900;
const ZOOM_STEP = 0.1;
const PDF_LOAD_DEADLINE_MS = 30_000;
const PDF_FULL_BUFFER_MAX_BYTES = 4 * 1024 * 1024;
const PDF_RANGE_CHUNK_SIZE = 1024 * 1024;

interface PageSize {
  readonly height: number;
  readonly width: number;
}

type PreviewFailureAction = "reopen" | "retry";

interface PreviewFailure {
  readonly action?: PreviewFailureAction | undefined;
  readonly message: string;
  readonly retryable: boolean;
  readonly title: string;
}

interface PdfDocumentLoadingTask {
  readonly destroy: () => Promise<void> | void;
  readonly promise: Promise<PdfDocumentProxy>;
}

type PdfJsModule = typeof import("pdfjs-dist");
type PdfDocumentProxy = PdfJsDocumentProxy & {
  readonly destroy?: () => Promise<void> | void;
};

let pdfJsModulePromise: Promise<PdfJsModule> | null = null;

function loadPdfJs(): Promise<PdfJsModule> {
  pdfJsModulePromise ??= import("pdfjs-dist").then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.mjs",
      import.meta.url,
    ).toString();
    return pdfjs;
  });
  return pdfJsModulePromise;
}

function clampPage(page: number, totalPages: number): number {
  return Math.max(1, Math.min(totalPages, page));
}

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(scale * 10) / 10));
}

function normalizeRotation(value: number): number {
  return (((Math.round(value / 90) * 90) % 360) + 360) % 360;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readZoomMode(value: unknown): PdfCitationPreviewZoomMode {
  return value === "fit-page" || value === "manual" ? value : "fit-width";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPersistedContextCitation(value: unknown): PdfCitationPreviewContextCitation | null {
  if (!isRecord(value) || !isRecord(value.citation) || !isRecord(value.display)) return null;
  const stableId = readOptionalString(value.citation.stableId);
  const marker = readOptionalString(value.citation.marker);
  const label = readOptionalString(value.citation.label);
  const documentLabel = readOptionalString(value.display.documentLabel);
  const anchorQuality = value.display.anchorQuality;
  if (
    stableId === undefined ||
    marker === undefined ||
    label === undefined ||
    documentLabel === undefined ||
    (anchorQuality !== "approximate" &&
      anchorQuality !== "page-only" &&
      anchorQuality !== "unavailable")
  ) {
    return null;
  }
  const source = readOptionalString(value.citation.source);
  const sourceLabel = readOptionalString(value.display.sourceLabel);
  const pageLabel = readOptionalString(value.display.pageLabel);
  return {
    citation: {
      stableId,
      marker,
      label,
      ...(source === undefined ? {} : { source }),
    },
    display: {
      documentLabel,
      anchorQuality,
      ...(sourceLabel === undefined ? {} : { sourceLabel }),
      ...(typeof value.display.pageNumber === "number"
        ? { pageNumber: value.display.pageNumber }
        : {}),
      ...(pageLabel === undefined ? {} : { pageLabel }),
    },
  };
}

function readPersistedCitationContext(raw: unknown): PdfCitationPreviewAnswerContext | undefined {
  const encoded = readOptionalString(raw);
  if (encoded === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.citations)) return undefined;
  const activeStableId = readOptionalString(parsed.activeStableId);
  if (activeStableId === undefined) return undefined;
  const citations = parsed.citations
    .map((citation) => readPersistedContextCitation(citation))
    .filter((citation): citation is PdfCitationPreviewContextCitation => citation !== null);
  if (citations.length === 0) return undefined;
  const origin = isRecord(parsed.origin) ? parsed.origin : undefined;
  const originContext =
    origin === undefined
      ? undefined
      : {
          assistantMessageId: readOptionalString(origin.assistantMessageId),
          chatId: readOptionalString(origin.chatId),
          chatWindowId: readOptionalString(origin.chatWindowId),
          marker: readOptionalString(origin.marker),
          representation: origin.representation,
        };
  return {
    activeStableId,
    citations,
    ...(originContext?.assistantMessageId === undefined ||
    originContext.chatId === undefined ||
    originContext.marker === undefined ||
    (originContext.representation !== "inline-marker" &&
      originContext.representation !== "citation-chip")
      ? {}
      : {
          origin: {
            assistantMessageId: originContext.assistantMessageId,
            chatId: originContext.chatId,
            marker: originContext.marker,
            representation: originContext.representation,
            ...(originContext.chatWindowId === undefined
              ? {}
              : { chatWindowId: originContext.chatWindowId }),
          },
        }),
  };
}

function rotatedSize(size: PageSize, rotation: number): PageSize {
  return rotation % 180 === 0
    ? size
    : {
        width: size.height,
        height: size.width,
      };
}

function anchorQualityLabel(value: PdfCitationPreviewSafeWindowCfg["anchorQuality"]): string {
  switch (value) {
    case "approximate":
      return "Near cited passage";
    case "unavailable":
      return "Verified page unavailable";
    default:
      return "Verified page only";
  }
}

function citationContextLabel(args: {
  readonly label: string;
  readonly marker: string;
  readonly source?: string | undefined;
}): string {
  return args.source === undefined
    ? `${args.marker} ${args.label}`
    : `${args.marker} ${args.source} · ${args.label}`;
}

function citationContextPageLabel(
  display: Pick<PdfCitationPreviewSafeWindowCfg, "anchorQuality" | "pageLabel" | "pageNumber">,
): string {
  if (display.pageLabel !== undefined) return display.pageLabel;
  if (display.pageNumber !== undefined) return `Page ${String(display.pageNumber)}`;
  return display.anchorQuality === "unavailable" ? "No verified page" : "Verified PDF";
}

function uniqueContextCitations(
  citations: readonly PdfCitationPreviewContextCitation[] | undefined,
): readonly PdfCitationPreviewContextCitation[] {
  if (citations === undefined) return [];
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const stableId = citation.citation.stableId;
    if (seen.has(stableId)) return false;
    seen.add(stableId);
    return true;
  });
}

function failureFromOpenReason(reason: PdfCitationPreviewReasonCode): PreviewFailure {
  const copy = pdfCitationPreviewFailureCopy(reason);
  return {
    title: copy.title,
    message: copy.message,
    retryable: copy.retryable,
    ...(copy.retryable ? { action: "retry" as const } : {}),
  };
}

function sessionLostFailure(): PreviewFailure {
  return {
    title: "Preview session ended",
    message:
      "This verified preview session is no longer active. Reopen the citation to create a fresh preview.",
    retryable: false,
    action: "reopen",
  };
}

function rangeFailure(): PreviewFailure {
  return {
    title: "Preview range failed",
    message:
      "The PDF byte range could not be loaded. Reopen the citation to create a fresh preview.",
    retryable: false,
    action: "reopen",
  };
}

function timeoutFailure(): PreviewFailure {
  return {
    title: "Preview timed out",
    message: "The verified PDF preview did not load in time. Retry to request the document again.",
    retryable: true,
    action: "retry",
  };
}

function responseExceptionStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const maybe = error as { readonly name?: unknown; readonly status?: unknown };
  if (maybe.name !== "ResponseException" || typeof maybe.status !== "number") return undefined;
  return Number.isInteger(maybe.status) ? maybe.status : undefined;
}

function previewFailureFromStatus(status: number): PreviewFailure | undefined {
  switch (status) {
    case 404:
      return sessionLostFailure();
    case 410:
      return sessionLostFailure();
    case 409:
      return {
        title: "Preview changed",
        message:
          "The verified PDF source is no longer in the expected preview state. Reopen the answer or re-index the document before previewing it again.",
        retryable: false,
      };
    case 413:
      return {
        title: "Preview too large",
        message: "The verified PDF exceeds the passive preview size limit for this viewer.",
        retryable: false,
      };
    case 416:
      return rangeFailure();
    case 503:
      return {
        title: "Preview temporarily unavailable",
        message:
          "Keiko could not read the verified PDF safely. Retry to request the preview again.",
        retryable: true,
        action: "retry",
      };
    default:
      return undefined;
  }
}

function previewFailure(error: unknown): PreviewFailure {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "PREVIEW_SESSION_NOT_FOUND":
      case "PREVIEW_SESSION_CLOSED":
      case "PREVIEW_SESSION_EXPIRED":
        return sessionLostFailure();
      case "PREVIEW_SOURCE_NOT_READY":
        return {
          title: "Preview not ready",
          message:
            "Keiko is still verifying the PDF source for passive preview. Retry in a moment.",
          retryable: true,
          action: "retry",
        };
      case "PREVIEW_SOURCE_UNREADABLE":
      case "PREVIEW_SOURCE_DEHYDRATED":
        return {
          title: "Preview temporarily unavailable",
          message:
            "Keiko could not read the verified PDF safely. Retry to request the preview again.",
          retryable: true,
          action: "retry",
        };
      case "PREVIEW_SOURCE_CHANGED":
        return {
          title: "Preview changed",
          message:
            "The verified PDF bytes no longer match the citation that opened this preview. Re-index the document, then ask again.",
          retryable: false,
        };
      case "PREVIEW_RANGE_NOT_SATISFIABLE":
        return rangeFailure();
      case "PREVIEW_SOURCE_REBIND_REQUIRED":
      case "PREVIEW_SOURCE_MISSING":
        return {
          title: "Preview source unavailable",
          message:
            "The verified PDF source is no longer available for passive preview. Locate the file or rebind the source root.",
          retryable: false,
        };
      case "PREVIEW_SOURCE_NOT_PDF":
        return {
          title: "Preview blocked",
          message:
            "The verified source is no longer a PDF and cannot be rendered in the PDF viewer.",
          retryable: false,
        };
      case "PREVIEW_SOURCE_TOO_LARGE":
        return {
          title: "Preview too large",
          message: "The verified PDF exceeds the passive preview size limit for this viewer.",
          retryable: false,
        };
      default:
        break;
    }
  }

  const statusFailure = previewFailureFromStatus(responseExceptionStatus(error) ?? 0);
  if (statusFailure !== undefined) return statusFailure;

  return {
    title: "Preview failed",
    message: "Keiko could not load the verified PDF preview. Retry to request the document again.",
    retryable: true,
    action: "retry",
  };
}

function restoredShellFailure(
  failureOverride: PreviewFailure | null,
  canReopen: boolean,
): PreviewFailure {
  if (failureOverride !== null) {
    return failureOverride;
  }
  return {
    ...(canReopen ? { action: "reopen" as const } : {}),
    title: "Preview requires re-verification",
    message:
      "This viewer was restored without an active verified preview session. Reopen the citation from the answer to re-verify the source before Keiko renders PDF bytes.",
    retryable: canReopen,
  };
}

function isRenderingCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === "RenderingCancelledException";
}

type PdfPreviewSessionSnapshot = ReturnType<typeof getPdfCitationPreviewSession>;

type PdfPreviewDisplayInfo = Pick<
  PdfCitationPreviewSafeWindowCfg,
  "anchorQuality" | "documentLabel" | "pageLabel" | "pageNumber" | "sourceLabel"
>;

// Deliberately NOT a discriminated union of `{ enabled: true }` / `{ enabled: false; reason:
// string }`: TypeScript rejects unqualified `.reason` access on that stricter union (every
// constituent must carry the property), which is exactly how callers read this value below.
// This wider, single-shape type keeps that same `enabled`/`reason` access pattern valid.
interface PdfPreviewBackToChatState {
  readonly enabled: boolean;
  readonly reason?: string;
}

// Mutable load-lifecycle state shared across the loading-task promise chain, the deadline timer,
// and the effect's cleanup function. Mirrors the closured `let disposed`/`deadlineElapsed`/
// `loadingTask` variables the inline effect used to hold directly; the extracted step functions
// below read and mutate it by reference so every step observes the same live state.
interface PdfLoadRuntime {
  deadlineElapsed: boolean;
  disposed: boolean;
  loadingTask: PdfDocumentLoadingTask | null;
}

function computeReopenAttemptKey(
  citationContext: PdfCitationPreviewAnswerContext | undefined,
): string | undefined {
  const origin = citationContext?.origin;
  if (origin === undefined || citationContext === undefined) return undefined;
  return `${origin.chatId}:${origin.assistantMessageId}:${origin.marker}:${citationContext.activeStableId}`;
}

function resolveActiveCitation(
  sessionEntry: PdfPreviewSessionSnapshot,
  citationContextCitations: readonly PdfCitationPreviewContextCitation[],
  activeStableId: string | undefined,
): PdfCitationPreviewContextCitation | undefined {
  if (sessionEntry === undefined) return undefined;
  return (
    citationContextCitations.find((citation) => citation.citation.stableId === activeStableId) ??
    citationContextCitations[0]
  );
}

function computeBackToChatState(backToChatReason: string): PdfPreviewBackToChatState {
  return backToChatReason.length === 0
    ? { enabled: true }
    : { enabled: false, reason: backToChatReason };
}

// Takes each `cfg`/`activeCitation` field pre-narrowed to a single param (rather than the whole
// `cfg` object or the whole `activeCitation` record) so the calling useMemo's callback body only
// ever touches the exact member paths already listed in its dependency array — passing the whole
// objects through would make react-hooks/exhaustive-deps demand `cfg` and `activeCitation`
// themselves as deps, widening memoization far past the original per-key granularity.
function computePreviewDisplay(params: {
  readonly activeCitationAnchorQuality:
    PdfCitationPreviewContextCitation["display"]["anchorQuality"] | undefined;
  readonly cfgDocumentLabel: unknown;
  readonly cfgPageLabel: unknown;
  readonly cfgPageNumber: unknown;
  readonly cfgSourceLabel: unknown;
  readonly sessionEntry: PdfPreviewSessionSnapshot;
}): PdfPreviewDisplayInfo {
  const {
    activeCitationAnchorQuality,
    cfgDocumentLabel,
    cfgPageLabel,
    cfgPageNumber,
    cfgSourceLabel,
    sessionEntry,
  } = params;
  const sourceLabel = readOptionalString(cfgSourceLabel) ?? sessionEntry?.display.sourceLabel;
  const pageNumber =
    typeof cfgPageNumber === "number" ? cfgPageNumber : sessionEntry?.display.pageNumber;
  const pageLabel = readOptionalString(cfgPageLabel) ?? sessionEntry?.display.pageLabel;
  return {
    documentLabel:
      readOptionalString(cfgDocumentLabel) ?? sessionEntry?.display.documentLabel ?? "PDF Preview",
    anchorQuality:
      activeCitationAnchorQuality ?? sessionEntry?.display.anchorQuality ?? "page-only",
    ...(sourceLabel === undefined ? {} : { sourceLabel }),
    ...(pageNumber === undefined ? {} : { pageNumber }),
    ...(pageLabel === undefined ? {} : { pageLabel }),
  };
}

// Same reasoning as computePreviewDisplay above: narrowed per-field params keep the useMemo
// callback's touched paths identical to its dependency array.
function computeFailureOverride(params: {
  readonly cfgFailureMessage: unknown;
  readonly cfgFailureRetryable: unknown;
  readonly cfgFailureTitle: unknown;
}): PreviewFailure | null {
  const title = readOptionalString(params.cfgFailureTitle);
  const message = readOptionalString(params.cfgFailureMessage);
  if (title === undefined || message === undefined) return null;
  return {
    title,
    message,
    retryable: readOptionalBoolean(params.cfgFailureRetryable) ?? false,
  };
}

function computeEffectiveScale(
  currentPageSize: PageSize | null,
  rotation: number,
  containerWidth: number,
  containerHeight: number,
  zoomMode: PdfCitationPreviewZoomMode,
  zoomValue: number,
): number {
  if (currentPageSize === null) return zoomValue;
  const viewport = rotatedSize(currentPageSize, rotation);
  const fitWidth = clampScale(
    (Math.max(0, containerWidth - PAGE_FRAME_PX) || viewport.width) / viewport.width,
  );
  if (zoomMode === "fit-width") return fitWidth;
  if (zoomMode === "fit-page") {
    const fitHeight =
      (Math.max(0, containerHeight - PAGE_FRAME_PX) || viewport.height) / viewport.height;
    return clampScale(Math.min(fitWidth, fitHeight));
  }
  return zoomValue;
}

function buildContextCitationCfgPatch(
  nextCitation: PdfCitationPreviewContextCitation,
  fallbackCurrentPage: number,
): AppWindow["cfg"] {
  return {
    ...(nextCitation.display.pageLabel === undefined
      ? { pageLabel: undefined }
      : { pageLabel: nextCitation.display.pageLabel }),
    ...(nextCitation.display.pageNumber === undefined
      ? { pageNumber: undefined }
      : { pageNumber: nextCitation.display.pageNumber }),
    ...(nextCitation.display.sourceLabel === undefined
      ? { sourceLabel: undefined }
      : { sourceLabel: nextCitation.display.sourceLabel }),
    currentPage:
      nextCitation.display.pageNumber === undefined
        ? fallbackCurrentPage
        : nextCitation.display.pageNumber,
    documentLabel: nextCitation.display.documentLabel,
  };
}

function pdfPreviewPageMetaSuffix(
  pageLabel: string | undefined,
  pageNumber: number | undefined,
): string {
  if (pageLabel !== undefined) return ` · ${pageLabel}`;
  if (pageNumber !== undefined) return ` · Page ${String(pageNumber)}`;
  return "";
}

function commitPdfPreviewPageInput(
  rawValue: string,
  currentPage: number,
  goToPage: (page: number) => void,
  setPageInput: (value: string) => void,
): void {
  const parsed = Number.parseInt(rawValue, 10);
  if (Number.isInteger(parsed)) {
    goToPage(parsed);
    return;
  }
  setPageInput(String(currentPage));
}

function applyRestoredShellState(params: {
  readonly canReopen: boolean;
  readonly failureOverride: PreviewFailure | null;
  readonly setDefaultPageSize: (value: PageSize | null) => void;
  readonly setDoc: (value: PdfDocumentProxy | null) => void;
  readonly setFailure: (value: PreviewFailure | null) => void;
  readonly setNumPages: (value: number) => void;
  readonly setPageRenderFailures: (value: Record<number, PreviewFailure>) => void;
}): void {
  params.setFailure(restoredShellFailure(params.failureOverride, params.canReopen));
  params.setDefaultPageSize(null);
  params.setDoc(null);
  params.setNumPages(0);
  params.setPageRenderFailures({});
}

function resetPdfLoadState(params: {
  readonly setDefaultPageSize: (value: PageSize | null) => void;
  readonly setDoc: (value: PdfDocumentProxy | null) => void;
  readonly setFailure: (value: PreviewFailure | null) => void;
  readonly setMeasuredSizes: (value: Record<number, PageSize>) => void;
  readonly setNumPages: (value: number) => void;
  readonly setPageRenderFailures: (value: Record<number, PreviewFailure>) => void;
  readonly setShowSlowLoad: (value: boolean) => void;
}): void {
  params.setFailure(null);
  params.setShowSlowLoad(false);
  params.setMeasuredSizes({});
  params.setPageRenderFailures({});
  params.setDefaultPageSize(null);
  params.setDoc(null);
  params.setNumPages(0);
}

function handlePdfLoadDeadline(
  runtime: PdfLoadRuntime,
  controller: AbortController,
  setFailure: (value: PreviewFailure | null) => void,
  setShowSlowLoad: (value: boolean) => void,
): void {
  if (runtime.disposed) return;
  runtime.deadlineElapsed = true;
  controller.abort();
  void runtime.loadingTask?.destroy();
  setFailure(timeoutFailure());
  setShowSlowLoad(false);
}

async function resolvePdfLoadingTask(
  pdfjs: PdfJsModule,
  sessionHandle: string,
  sessionByteLength: number | undefined,
  controller: AbortController,
  runtime: PdfLoadRuntime,
): Promise<PdfDocumentProxy | null> {
  if (runtime.disposed) return null;
  if (typeof sessionByteLength === "number" && sessionByteLength > PDF_FULL_BUFFER_MAX_BYTES) {
    runtime.loadingTask = pdfjs.getDocument({
      disableRange: false,
      disableStream: false,
      httpHeaders: { Accept: "application/pdf" },
      rangeChunkSize: PDF_RANGE_CHUNK_SIZE,
      url: pdfCitationPreviewDocumentUrl(sessionHandle),
      withCredentials: false,
    }) as PdfDocumentLoadingTask;
  } else {
    const bytes = await fetchPdfCitationPreviewDocument(sessionHandle, controller.signal);
    if (runtime.disposed) return null;
    runtime.loadingTask = pdfjs.getDocument({
      data: bytes,
    }) as PdfDocumentLoadingTask;
  }
  return runtime.loadingTask.promise;
}

async function finalizePdfLoadedDocument(
  pdf: PdfDocumentProxy | null,
  runtime: PdfLoadRuntime,
  setters: {
    readonly setDefaultPageSize: (value: PageSize | null) => void;
    readonly setDoc: (value: PdfDocumentProxy | null) => void;
    readonly setNumPages: (value: number) => void;
    readonly setShowSlowLoad: (value: boolean) => void;
  },
): Promise<void> {
  if (pdf === null) return;
  if (runtime.disposed) {
    await pdf.destroy?.();
    return;
  }
  const firstPage = await pdf.getPage(1);
  const viewport = firstPage.getViewport({ scale: 1 });
  setters.setDefaultPageSize({ width: viewport.width, height: viewport.height });
  setters.setDoc(pdf);
  setters.setNumPages(pdf.numPages);
  setters.setShowSlowLoad(false);
}

function handlePdfLoadFailure(
  error: unknown,
  runtime: PdfLoadRuntime,
  params: {
    readonly autoReopenAttemptedKeyRef: MutableRefObject<string | null>;
    readonly reopenAttemptKey: string | undefined;
    readonly reopenPreviewRef: MutableRefObject<
      (fallbackFailure?: PreviewFailure) => Promise<boolean>
    >;
    readonly setFailure: (value: PreviewFailure | null) => void;
    readonly setShowSlowLoad: (value: boolean) => void;
  },
): void {
  if (
    runtime.disposed ||
    runtime.deadlineElapsed ||
    (error instanceof DOMException && error.name === "AbortError")
  ) {
    return;
  }
  const failure = previewFailure(error);
  if (
    failure.action === "reopen" &&
    params.reopenAttemptKey !== undefined &&
    params.autoReopenAttemptedKeyRef.current !== params.reopenAttemptKey
  ) {
    params.autoReopenAttemptedKeyRef.current = params.reopenAttemptKey;
    void params.reopenPreviewRef.current(failure);
    return;
  }
  params.setFailure(failure);
  params.setShowSlowLoad(false);
}

function clearPdfLoadTimers(slowTimer: number, deadlineTimer: number): void {
  window.clearTimeout(slowTimer);
  window.clearTimeout(deadlineTimer);
}

function disposePdfLoad(
  runtime: PdfLoadRuntime,
  controller: AbortController,
  slowTimer: number,
  deadlineTimer: number,
): void {
  runtime.disposed = true;
  controller.abort();
  void runtime.loadingTask?.destroy();
  clearPdfLoadTimers(slowTimer, deadlineTimer);
}

// GEN-PERF-WIDGET-001 — orchestrates the document-load promise chain for the effect below. Kept
// as a single module-scope entry point (delegating each step to a small named function) so the
// effect body itself stays a thin "reset, then start the load" call.
function startPdfDocumentLoad(params: {
  readonly autoReopenAttemptedKeyRef: MutableRefObject<string | null>;
  readonly reopenAttemptKey: string | undefined;
  readonly reopenPreviewRef: MutableRefObject<
    (fallbackFailure?: PreviewFailure) => Promise<boolean>
  >;
  readonly sessionByteLength: number | undefined;
  readonly sessionHandle: string;
  readonly setDefaultPageSize: (value: PageSize | null) => void;
  readonly setDoc: (value: PdfDocumentProxy | null) => void;
  readonly setFailure: (value: PreviewFailure | null) => void;
  readonly setNumPages: (value: number) => void;
  readonly setShowSlowLoad: (value: boolean) => void;
}): () => void {
  const runtime: PdfLoadRuntime = { deadlineElapsed: false, disposed: false, loadingTask: null };
  const controller = new AbortController();

  const slowTimer = window.setTimeout(() => params.setShowSlowLoad(true), SLOW_LOAD_MS);
  const deadlineTimer = window.setTimeout(
    () => handlePdfLoadDeadline(runtime, controller, params.setFailure, params.setShowSlowLoad),
    PDF_LOAD_DEADLINE_MS,
  );

  void loadPdfJs()
    .then((pdfjs) =>
      resolvePdfLoadingTask(
        pdfjs,
        params.sessionHandle,
        params.sessionByteLength,
        controller,
        runtime,
      ),
    )
    .then((pdf) =>
      finalizePdfLoadedDocument(pdf, runtime, {
        setDefaultPageSize: params.setDefaultPageSize,
        setDoc: params.setDoc,
        setNumPages: params.setNumPages,
        setShowSlowLoad: params.setShowSlowLoad,
      }),
    )
    .catch((error: unknown) =>
      handlePdfLoadFailure(error, runtime, {
        autoReopenAttemptedKeyRef: params.autoReopenAttemptedKeyRef,
        reopenAttemptKey: params.reopenAttemptKey,
        reopenPreviewRef: params.reopenPreviewRef,
        setFailure: params.setFailure,
        setShowSlowLoad: params.setShowSlowLoad,
      }),
    )
    .finally(() => clearPdfLoadTimers(slowTimer, deadlineTimer));

  return () => disposePdfLoad(runtime, controller, slowTimer, deadlineTimer);
}

async function runReopenPreview(params: {
  readonly citationContext: PdfCitationPreviewAnswerContext | undefined;
  readonly currentPageRef: MutableRefObject<number>;
  readonly fallbackFailure: PreviewFailure | undefined;
  readonly setFailure: (value: PreviewFailure | null) => void;
  readonly setReopening: (value: boolean) => void;
  readonly setShowSlowLoad: (value: boolean) => void;
  readonly updateCfg: (patch: AppWindow["cfg"]) => void;
  readonly windowId: string;
}): Promise<boolean> {
  const {
    citationContext,
    currentPageRef,
    fallbackFailure,
    setFailure,
    setReopening,
    setShowSlowLoad,
    updateCfg,
    windowId,
  } = params;
  const origin = citationContext?.origin;
  if (origin === undefined || citationContext === undefined) {
    if (fallbackFailure !== undefined) {
      setFailure(fallbackFailure);
    }
    return false;
  }

  setReopening(true);
  setShowSlowLoad(false);
  try {
    const response: PdfCitationPreviewOpenResponse = await openPdfCitationPreviewSession({
      chatId: origin.chatId,
      assistantMessageId: origin.assistantMessageId,
      marker: origin.marker,
      stableId: citationContext.activeStableId,
      origin: origin.representation,
    });
    if (response.outcome === "authorized") {
      const nextCfg = replacePdfCitationPreviewWindowSession(windowId, response, {
        context: citationContext,
        currentPage: currentPageRef.current,
      });
      updateCfg(nextCfg);
      setFailure(null);
      return true;
    }
    const nextCfg = replacePdfCitationPreviewWindowFailure(windowId, response);
    updateCfg(nextCfg);
    setFailure(failureFromOpenReason(response.reason));
    return false;
  } catch (error) {
    const failure = previewFailure(error);
    setFailure(failure.action === "reopen" ? (fallbackFailure ?? failure) : failure);
    return false;
  } finally {
    setReopening(false);
  }
}

function PdfCanvasPage({
  active,
  onError,
  onMeasured,
  pageNumber,
  pdf,
  rotation,
  scale,
}: {
  readonly active: boolean;
  readonly onError: (page: number, error: unknown) => void;
  readonly onMeasured: (page: number, size: PageSize) => void;
  readonly pageNumber: number;
  readonly pdf: PdfDocumentProxy;
  readonly rotation: number;
  readonly scale: number;
}): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let cancelRender: (() => void) | undefined;

    void pdf
      .getPage(pageNumber)
      .then(async (page) => {
        if (disposed) return;
        const viewport = page.getViewport({ scale, rotation });
        const baseViewport = page.getViewport({ scale: 1 });
        onMeasured(pageNumber, {
          width: baseViewport.width,
          height: baseViewport.height,
        });

        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        if (canvas === null || context === null) return;

        const deviceScale = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.floor(viewport.width * deviceScale));
        canvas.height = Math.max(1, Math.floor(viewport.height * deviceScale));
        canvas.style.width = `${String(Math.floor(viewport.width))}px`;
        canvas.style.height = `${String(Math.floor(viewport.height))}px`;

        const renderTask = page.render({
          canvas: canvas,
          canvasContext: context,
          transform: deviceScale === 1 ? undefined : [deviceScale, 0, 0, deviceScale, 0, 0],
          viewport,
        });
        cancelRender = (): void => {
          renderTask.cancel();
        };
        await renderTask.promise;
      })
      .catch((error) => {
        if (disposed || isRenderingCancelled(error)) return;
        onError(pageNumber, error);
      });

    return () => {
      disposed = true;
      cancelRender?.();
    };
  }, [active, onError, onMeasured, pageNumber, pdf, rotation, scale]);

  return (
    <canvas
      ref={canvasRef}
      className="pdfv-page-canvas"
      aria-label={`Page ${String(pageNumber)}`}
    />
  );
}

function PdfPreviewHeader({ display }: { readonly display: PdfPreviewDisplayInfo }): ReactNode {
  return (
    <div className="pdfv-header">
      <div className="pdfv-heading">
        <p className="pdfv-eyebrow">Verified preview</p>
        <h2 className="pdfv-title">{display.documentLabel}</h2>
        <p className="pdfv-meta">
          {display.sourceLabel ?? "Local Knowledge PDF"}
          {pdfPreviewPageMetaSuffix(display.pageLabel, display.pageNumber)}
        </p>
      </div>
      <span className="pdfv-chip">{anchorQualityLabel(display.anchorQuality)}</span>
    </div>
  );
}

function PdfPreviewCitationContextItem({
  activeStableId,
  citation,
  onActivate,
}: {
  readonly activeStableId: string;
  readonly citation: PdfCitationPreviewContextCitation;
  readonly onActivate: (stableId: string) => void;
}): ReactNode {
  const active = citation.citation.stableId === activeStableId;
  const fullLabel = citationContextLabel({
    label: citation.citation.label,
    marker: citation.citation.marker,
    source: citation.citation.source,
  });
  return (
    <li className="grounded-citations-item">
      <button
        type="button"
        className="grounded-citation grounded-citation-action pdfv-context-citation"
        aria-label={`${fullLabel} ${citationContextPageLabel(citation.display)}`}
        aria-pressed={active}
        data-active={active ? "true" : "false"}
        data-tip={fullLabel}
        onClick={() => {
          if (active) return;
          onActivate(citation.citation.stableId);
        }}
      >
        <span className="grounded-citation-range">{citation.citation.marker}</span>
        <span className="grounded-citation-action-label">
          {active ? "Active" : citationContextPageLabel(citation.display)}
        </span>
      </button>
    </li>
  );
}

function PdfPreviewCitationContext({
  activeCitation,
  backToChat,
  backToChatDescriptionId,
  citationContext,
  citationContextCitations,
  focusWindow,
  onActivateCitation,
  restoreWindow,
  windowId,
}: {
  readonly activeCitation: PdfCitationPreviewContextCitation;
  readonly backToChat: PdfPreviewBackToChatState;
  readonly backToChatDescriptionId: string;
  readonly citationContext: PdfCitationPreviewAnswerContext | undefined;
  readonly citationContextCitations: readonly PdfCitationPreviewContextCitation[];
  readonly focusWindow: WorkspaceApi["focus"];
  readonly onActivateCitation: (stableId: string) => void;
  readonly restoreWindow: WorkspaceApi["restore"] | undefined;
  readonly windowId: string;
}): ReactNode {
  return (
    <section className="pdfv-context" aria-label="Citation context">
      <div className="pdfv-context-head">
        <div className="pdfv-context-copy">
          <p className="pdfv-context-eyebrow">Active citation</p>
          <h3 className="pdfv-context-title">
            <span className="pdfv-context-marker">{activeCitation.citation.marker}</span>
            <span className="pdfv-context-document">{activeCitation.display.documentLabel}</span>
            <span className="pdfv-context-page">
              {citationContextPageLabel(activeCitation.display)}
            </span>
          </h3>
          {activeCitation.display.sourceLabel === undefined ? null : (
            <p className="pdfv-context-message">{activeCitation.display.sourceLabel}</p>
          )}
        </div>
        <div className="pdfv-context-actions">
          <button
            type="button"
            className="tm-action pdfv-back-to-chat"
            aria-describedby={backToChat.reason === undefined ? undefined : backToChatDescriptionId}
            aria-disabled={backToChat.enabled ? undefined : "true"}
            data-tip={
              backToChat.reason ?? "Restore the originating chat and highlight this citation"
            }
            onClick={() => {
              if (!backToChat.enabled) return;
              activatePdfCitationPreviewBackToChat(windowId, { focusWindow, restoreWindow });
            }}
          >
            <Icons.back size={14} />
            <span>Back to chat</span>
          </button>
          {backToChat.reason === undefined ? null : (
            <span id={backToChatDescriptionId} className="pdfv-back-to-chat-hint">
              {backToChat.reason}
            </span>
          )}
        </div>
      </div>
      {citationContext !== undefined && citationContextCitations.length > 1 ? (
        <details className="pdfv-context-details">
          <summary className="pdfv-context-summary">
            <span>Same answer citations</span>
            <span className="pdfv-context-count">{citationContextCitations.length}</span>
            <Icons.chevron size={13} />
          </summary>
          <ul className="grounded-citations pdfv-context-list" aria-label="Same answer citations">
            {citationContextCitations.map((citation) => (
              <PdfPreviewCitationContextItem
                key={citation.citation.stableId}
                activeStableId={citationContext.activeStableId}
                citation={citation}
                onActivate={onActivateCitation}
              />
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function PdfPreviewPageNav({
  currentPage,
  goToPage,
  numPages,
  pageInput,
  setPageInput,
}: {
  readonly currentPage: number;
  readonly goToPage: (page: number) => void;
  readonly numPages: number;
  readonly pageInput: string;
  readonly setPageInput: (value: string) => void;
}): ReactNode {
  return (
    <div className="pdfv-group">
      <button
        type="button"
        className="pdfv-btn tm-action"
        disabled={currentPage <= 1}
        onClick={() => goToPage(currentPage - 1)}
      >
        <Icons.back size={14} />
        <span>Previous</span>
      </button>
      <label className="pdfv-page-field">
        <span className="sr-only">Current page</span>
        <input
          className="pdfv-page-input"
          inputMode="numeric"
          pattern="[0-9]*"
          value={pageInput}
          onChange={(event) => setPageInput(event.target.value)}
          onBlur={(event) =>
            commitPdfPreviewPageInput(
              event.currentTarget.value,
              currentPage,
              goToPage,
              setPageInput,
            )
          }
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            commitPdfPreviewPageInput(
              event.currentTarget.value,
              currentPage,
              goToPage,
              setPageInput,
            );
          }}
        />
      </label>
      <span className="pdfv-page-count mono">/ {numPages > 0 ? String(numPages) : "--"}</span>
      <button
        type="button"
        className="pdfv-btn tm-action"
        disabled={currentPage >= numPages}
        onClick={() => goToPage(currentPage + 1)}
      >
        <span>Next</span>
        <Icons.fwd size={14} />
      </button>
    </div>
  );
}

function PdfPreviewZoomButtons({
  effectiveScale,
  scalarIntentControlsEnabled,
  updateCfg,
  zoomMode,
  zoomValue,
}: {
  readonly effectiveScale: number;
  readonly scalarIntentControlsEnabled: boolean;
  readonly updateCfg: (patch: AppWindow["cfg"]) => void;
  readonly zoomMode: PdfCitationPreviewZoomMode;
  readonly zoomValue: number;
}): ReactNode {
  return (
    <>
      <button
        type="button"
        className="pdfv-btn tm-action"
        disabled={!scalarIntentControlsEnabled || (zoomMode === "manual" && zoomValue <= MIN_SCALE)}
        onClick={() =>
          updateCfg({ zoomMode: "manual", zoomValue: clampScale(effectiveScale - ZOOM_STEP) })
        }
      >
        <Icons.zoomOut size={14} />
        <span>Zoom out</span>
      </button>
      <button
        type="button"
        className="pdfv-btn tm-action"
        disabled={!scalarIntentControlsEnabled || (zoomMode === "manual" && zoomValue >= MAX_SCALE)}
        onClick={() =>
          updateCfg({ zoomMode: "manual", zoomValue: clampScale(effectiveScale + ZOOM_STEP) })
        }
      >
        <Icons.zoomIn size={14} />
        <span>Zoom in</span>
      </button>
    </>
  );
}

function PdfPreviewFitAndRotateButtons({
  effectiveScale,
  rotation,
  scalarIntentControlsEnabled,
  updateCfg,
  zoomMode,
}: {
  readonly effectiveScale: number;
  readonly rotation: number;
  readonly scalarIntentControlsEnabled: boolean;
  readonly updateCfg: (patch: AppWindow["cfg"]) => void;
  readonly zoomMode: PdfCitationPreviewZoomMode;
}): ReactNode {
  return (
    <>
      <button
        type="button"
        className="pdfv-btn tm-action"
        disabled={!scalarIntentControlsEnabled}
        data-selected={zoomMode === "fit-width" ? "true" : "false"}
        onClick={() => updateCfg({ zoomMode: "fit-width" })}
      >
        <span>Fit width</span>
      </button>
      <button
        type="button"
        className="pdfv-btn tm-action"
        disabled={!scalarIntentControlsEnabled}
        data-selected={zoomMode === "fit-page" ? "true" : "false"}
        onClick={() => updateCfg({ zoomMode: "fit-page" })}
      >
        <span>Fit page</span>
      </button>
      <button
        type="button"
        className="pdfv-btn tm-action"
        disabled={!scalarIntentControlsEnabled}
        onClick={() => updateCfg({ rotation: normalizeRotation(rotation - 90) })}
      >
        <span>Rotate left</span>
      </button>
      <button
        type="button"
        className="pdfv-btn tm-action"
        disabled={!scalarIntentControlsEnabled}
        onClick={() => updateCfg({ rotation: normalizeRotation(rotation + 90) })}
      >
        <span>Rotate right</span>
      </button>
      <span className="pdfv-zoom mono">{String(Math.round(effectiveScale * 100))}%</span>
    </>
  );
}

function PdfPreviewToolbar({
  currentPage,
  effectiveScale,
  goToPage,
  numPages,
  pageInput,
  rotation,
  scalarIntentControlsEnabled,
  setPageInput,
  updateCfg,
  zoomMode,
  zoomValue,
}: {
  readonly currentPage: number;
  readonly effectiveScale: number;
  readonly goToPage: (page: number) => void;
  readonly numPages: number;
  readonly pageInput: string;
  readonly rotation: number;
  readonly scalarIntentControlsEnabled: boolean;
  readonly setPageInput: (value: string) => void;
  readonly updateCfg: (patch: AppWindow["cfg"]) => void;
  readonly zoomMode: PdfCitationPreviewZoomMode;
  readonly zoomValue: number;
}): ReactNode {
  return (
    <div className="pdfv-toolbar" role="group" aria-label="PDF preview controls">
      <PdfPreviewPageNav
        currentPage={currentPage}
        goToPage={goToPage}
        numPages={numPages}
        pageInput={pageInput}
        setPageInput={setPageInput}
      />
      <div className="pdfv-group">
        <PdfPreviewZoomButtons
          effectiveScale={effectiveScale}
          scalarIntentControlsEnabled={scalarIntentControlsEnabled}
          updateCfg={updateCfg}
          zoomMode={zoomMode}
          zoomValue={zoomValue}
        />
        <PdfPreviewFitAndRotateButtons
          effectiveScale={effectiveScale}
          rotation={rotation}
          scalarIntentControlsEnabled={scalarIntentControlsEnabled}
          updateCfg={updateCfg}
          zoomMode={zoomMode}
        />
      </div>
    </div>
  );
}

function PdfPreviewFailurePanel({
  failure,
  failureActionLabel,
  failureDescriptionId,
  onReopen,
  onRetry,
  reopening,
}: {
  readonly failure: PreviewFailure;
  readonly failureActionLabel: string;
  readonly failureDescriptionId: string;
  readonly onReopen: (failure: PreviewFailure) => void;
  readonly onRetry: () => void;
  readonly reopening: boolean;
}): ReactNode {
  return (
    <div className="lk-empty pdfv-status" role="alert" aria-describedby={failureDescriptionId}>
      <div className="lk-empty-icon">
        <Icons.info size={20} />
      </div>
      <p className="lk-empty-title">{failure.title}</p>
      <p id={failureDescriptionId} className="lk-empty-body">
        {failure.message}
      </p>
      {failure.action !== undefined ? (
        <button
          type="button"
          className="tm-action pdfv-retry"
          aria-describedby={failureDescriptionId}
          disabled={reopening}
          onClick={() => {
            if (failure.action === "reopen") {
              onReopen(failure);
              return;
            }
            onRetry();
          }}
        >
          {reopening ? "Opening preview..." : failureActionLabel}
        </button>
      ) : null}
    </div>
  );
}

function PdfPreviewPageSection({
  currentPage,
  defaultPageSize,
  doc,
  effectiveScale,
  handlePageMeasured,
  handlePageRenderError,
  measuredSizes,
  onDismissPageFailure,
  onReopen,
  pageFailure,
  pageNumber,
  pageRefs,
  reopening,
  rotation,
}: {
  readonly currentPage: number;
  readonly defaultPageSize: PageSize | null;
  readonly doc: PdfDocumentProxy;
  readonly effectiveScale: number;
  readonly handlePageMeasured: (page: number, size: PageSize) => void;
  readonly handlePageRenderError: (page: number, error: unknown) => void;
  readonly measuredSizes: Record<number, PageSize>;
  readonly onDismissPageFailure: (pageNumber: number) => void;
  readonly onReopen: (failure: PreviewFailure) => void;
  readonly pageFailure: PreviewFailure | undefined;
  readonly pageNumber: number;
  readonly pageRefs: MutableRefObject<Map<number, HTMLElement>>;
  readonly reopening: boolean;
  readonly rotation: number;
}): ReactNode {
  const pageSize = rotatedSize(
    measuredSizes[pageNumber] ?? defaultPageSize ?? { width: 612, height: 792 },
    rotation,
  );
  const minHeight = Math.max(220, Math.round(pageSize.height * effectiveScale));
  const shouldRender = Math.abs(pageNumber - currentPage) <= RENDER_RADIUS;
  const pageFailureActionLabel = pageFailure?.action === "reopen" ? "Reopen preview" : "Retry page";

  return (
    <section
      ref={(element) => {
        if (element === null) {
          pageRefs.current.delete(pageNumber);
          return;
        }
        pageRefs.current.set(pageNumber, element);
      }}
      className="pdfv-page"
      style={{ minHeight: `${String(minHeight)}px` }}
    >
      <div className="pdfv-page-frame">
        <div className="pdfv-page-meta mono">Page {String(pageNumber)}</div>
        {pageFailure !== undefined ? (
          <div className="lk-empty pdfv-page-error" role="alert">
            <div className="lk-empty-icon">
              <Icons.info size={18} />
            </div>
            <p className="lk-empty-title">{pageFailure.title}</p>
            <p className="lk-empty-body">{pageFailure.message}</p>
            <button
              type="button"
              className="tm-action pdfv-retry"
              disabled={reopening}
              onClick={() => {
                if (pageFailure.action === "reopen") {
                  onReopen(pageFailure);
                  return;
                }
                onDismissPageFailure(pageNumber);
              }}
            >
              {reopening ? "Opening preview..." : pageFailureActionLabel}
            </button>
          </div>
        ) : shouldRender ? (
          <PdfCanvasPage
            active
            onError={handlePageRenderError}
            onMeasured={handlePageMeasured}
            pageNumber={pageNumber}
            pdf={doc}
            rotation={rotation}
            scale={effectiveScale}
          />
        ) : (
          <div className="pdfv-page-skeleton" aria-hidden="true" />
        )}
      </div>
    </section>
  );
}

export function PdfCitationPreviewWindow({
  cfg,
  focusWindow,
  restoreWindow,
  updateCfg,
  windowId,
}: {
  readonly cfg: Record<string, unknown>;
  readonly focusWindow: WorkspaceApi["focus"];
  readonly restoreWindow?: WorkspaceApi["restore"] | undefined;
  readonly updateCfg: (patch: AppWindow["cfg"]) => void;
  readonly windowId: string;
}): ReactNode {
  const subscribeWindowRegistry = useCallback(
    (listener: () => void) => subscribePdfCitationPreviewRegistry(windowId, listener),
    [windowId],
  );
  const sessionEntry = useSyncExternalStore(
    subscribeWindowRegistry,
    () => getPdfCitationPreviewSession(windowId),
    () => getPdfCitationPreviewSession(windowId),
  );
  const backToChatReason = useSyncExternalStore(
    subscribeWindowRegistry,
    () => getPdfCitationPreviewBackToChatAvailability(windowId).reason ?? "",
    () => getPdfCitationPreviewBackToChatAvailability(windowId).reason ?? "",
  );
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [defaultPageSize, setDefaultPageSize] = useState<PageSize | null>(null);
  const [doc, setDoc] = useState<PdfDocumentProxy | null>(null);
  const [failure, setFailure] = useState<PreviewFailure | null>(null);
  const [measuredSizes, setMeasuredSizes] = useState<Record<number, PageSize>>({});
  const [numPages, setNumPages] = useState(0);
  const [pageRenderFailures, setPageRenderFailures] = useState<Record<number, PreviewFailure>>({});
  const [pageInput, setPageInput] = useState("1");
  const [reopening, setReopening] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const [showSlowLoad, setShowSlowLoad] = useState(false);
  const autoReopenAttemptedKeyRef = useRef<string | null>(null);
  const currentPageRef = useRef(1);
  const didInitialScrollRef = useRef(false);
  const backToChatDescriptionId = useId();
  const failureDescriptionId = useId();
  const pageRefs = useRef(new Map<number, HTMLElement>());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const persistedCitationContext = useMemo(
    () => readPersistedCitationContext(cfg.previewContextJson),
    [cfg.previewContextJson],
  );
  const citationContext = sessionEntry?.context ?? persistedCitationContext;
  const citationContextCitations = useMemo(
    () => uniqueContextCitations(citationContext?.citations),
    [citationContext?.citations],
  );
  const backToChat = computeBackToChatState(backToChatReason);
  const activeCitation = resolveActiveCitation(
    sessionEntry,
    citationContextCitations,
    citationContext?.activeStableId,
  );
  const reopenAttemptKey = useMemo(
    () => computeReopenAttemptKey(citationContext),
    [citationContext],
  );

  const display = useMemo(
    () =>
      computePreviewDisplay({
        activeCitationAnchorQuality: activeCitation?.display.anchorQuality,
        cfgDocumentLabel: cfg.documentLabel,
        cfgPageLabel: cfg.pageLabel,
        cfgPageNumber: cfg.pageNumber,
        cfgSourceLabel: cfg.sourceLabel,
        sessionEntry,
      }),
    [
      activeCitation?.display.anchorQuality,
      cfg.documentLabel,
      cfg.pageLabel,
      cfg.pageNumber,
      cfg.sourceLabel,
      sessionEntry,
    ],
  );

  const zoomMode = readZoomMode(cfg.zoomMode);
  const zoomValue = clampScale(readNumber(cfg.zoomValue, 1));
  const rotation = normalizeRotation(readNumber(cfg.rotation, 0));
  const currentPage = clampPage(
    readNumber(cfg.currentPage, display.pageNumber ?? 1),
    numPages > 0 ? numPages : Number.MAX_SAFE_INTEGER,
  );
  const failureOverride = useMemo(
    () =>
      computeFailureOverride({
        cfgFailureMessage: cfg.failureMessage,
        cfgFailureRetryable: cfg.failureRetryable,
        cfgFailureTitle: cfg.failureTitle,
      }),
    [cfg.failureMessage, cfg.failureRetryable, cfg.failureTitle],
  );
  const scalarIntentControlsEnabled = doc !== null;
  const currentPageSize = measuredSizes[currentPage] ?? defaultPageSize;
  const effectiveScale = useMemo(
    () =>
      computeEffectiveScale(
        currentPageSize,
        rotation,
        containerSize.width,
        containerSize.height,
        zoomMode,
        zoomValue,
      ),
    [containerSize.height, containerSize.width, currentPageSize, rotation, zoomMode, zoomValue],
  );

  const estimatedPageOuterHeight = useCallback(
    (pageNumber: number): number => {
      const pageSize = rotatedSize(
        measuredSizes[pageNumber] ?? defaultPageSize ?? { width: 612, height: 792 },
        rotation,
      );
      return (
        Math.max(220, Math.round(pageSize.height * effectiveScale)) +
        PAGE_OUTER_CHROME_PX +
        PAGE_SCROLL_GAP_PX
      );
    },
    [defaultPageSize, effectiveScale, measuredSizes, rotation],
  );

  const estimatedPageOffset = useCallback(
    (pageNumber: number): number => {
      let offset = 0;
      for (let page = 1; page < pageNumber; page += 1) {
        offset += estimatedPageOuterHeight(page);
      }
      return offset;
    },
    [estimatedPageOuterHeight],
  );

  const pageAtScrollOffset = useCallback(
    (offset: number): number => {
      let cursor = 0;
      for (let page = 1; page <= numPages; page += 1) {
        cursor += estimatedPageOuterHeight(page);
        if (offset <= cursor) return page;
      }
      return numPages;
    },
    [estimatedPageOuterHeight, numPages],
  );

  const scrollToPageNumber = useCallback(
    (pageNumber: number): void => {
      const element = pageRefs.current.get(pageNumber);
      if (element !== undefined) {
        element.scrollIntoView({ block: "start" });
        return;
      }
      scrollRef.current?.scrollTo({ top: estimatedPageOffset(pageNumber) });
    },
    [estimatedPageOffset],
  );

  const reopenPreview = useCallback(
    (fallbackFailure?: PreviewFailure): Promise<boolean> =>
      runReopenPreview({
        citationContext,
        currentPageRef,
        fallbackFailure,
        setFailure,
        setReopening,
        setShowSlowLoad,
        updateCfg,
        windowId,
      }),
    [citationContext, updateCfg, windowId],
  );

  // GEN-PERF-WIDGET-001 — the document-load effect below must reload ONLY when the session
  // handle (or an explicit retry) changes, never merely because a view-only cfg write (scroll
  // page-crossing, zoom, rotate, fit) churned updateCfg -> reopenPreview identity. Hold the
  // latest reopenPreview in a ref so the effect can call it without listing it as a dependency.
  const reopenPreviewRef = useRef(reopenPreview);
  reopenPreviewRef.current = reopenPreview;

  useEffect(() => {
    currentPageRef.current = currentPage;
    setPageInput(String(currentPage));
  }, [currentPage]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element === null || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      setContainerSize({
        width: element.clientWidth,
        height: element.clientHeight,
      });
    });
    observer.observe(element);
    setContainerSize({
      width: element.clientWidth,
      height: element.clientHeight,
    });

    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const sessionHandle = sessionEntry?.session.handle;
    const sessionByteLength = sessionEntry?.session.byteLength;
    if (sessionHandle === undefined) {
      applyRestoredShellState({
        canReopen: reopenAttemptKey !== undefined,
        failureOverride,
        setDefaultPageSize,
        setDoc,
        setFailure,
        setNumPages,
        setPageRenderFailures,
      });
      return;
    }

    resetPdfLoadState({
      setDefaultPageSize,
      setDoc,
      setFailure,
      setMeasuredSizes,
      setNumPages,
      setPageRenderFailures,
      setShowSlowLoad,
    });
    didInitialScrollRef.current = false;

    return startPdfDocumentLoad({
      autoReopenAttemptedKeyRef,
      reopenAttemptKey,
      reopenPreviewRef,
      sessionByteLength,
      sessionHandle,
      setDefaultPageSize,
      setDoc,
      setFailure,
      setNumPages,
      setShowSlowLoad,
    });
    // GEN-PERF-WIDGET-001 — reopenPreview is intentionally read through a ref (above) rather
    // than listed here, so view-only cfg writes that churn its identity no longer re-run this
    // document-load effect. The document reloads only on a genuine session/retry change.
  }, [failureOverride, reopenAttemptKey, retryToken, sessionEntry]);

  useEffect(() => {
    return () => {
      void doc?.destroy?.();
    };
  }, [doc]);

  useEffect(() => {
    if (doc === null || numPages === 0 || didInitialScrollRef.current) return;
    didInitialScrollRef.current = true;
    requestAnimationFrame(() => {
      scrollToPageNumber(currentPage);
    });
  }, [currentPage, doc, numPages, scrollToPageNumber]);

  useEffect(() => {
    if (doc === null || numPages === 0) return;
    requestAnimationFrame(() => {
      scrollToPageNumber(currentPageRef.current);
    });
  }, [doc, effectiveScale, numPages, rotation, scrollToPageNumber]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null || numPages === 0) return;

    let frame = 0;
    const syncPage = (): void => {
      frame = 0;
      const bestPage = pageAtScrollOffset(scroller.scrollTop + scroller.clientHeight * 0.2);

      if (bestPage !== currentPage) {
        updateCfg({ currentPage: bestPage });
      }
    };

    const onScroll = (): void => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(syncPage);
    };

    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [currentPage, numPages, pageAtScrollOffset, updateCfg]);

  const pageWindow = useMemo(() => {
    const start = Math.max(1, currentPage - PAGE_WINDOW_RADIUS);
    const end = Math.min(numPages, currentPage + PAGE_WINDOW_RADIUS);
    const pages = Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index);
    return {
      pages,
      topSpacerHeight: estimatedPageOffset(start),
      bottomSpacerHeight:
        numPages === 0 ? 0 : estimatedPageOffset(numPages + 1) - estimatedPageOffset(end + 1),
    };
  }, [currentPage, estimatedPageOffset, numPages]);
  const showToolbar = doc !== null && failure === null;
  const failureActionLabel =
    failure?.action === "reopen"
      ? "Reopen preview"
      : failure?.action === "retry"
        ? "Retry preview"
        : "";
  const handlePageRenderError = useCallback((page: number, error: unknown): void => {
    setPageRenderFailures((previous) => ({
      ...previous,
      [page]: previewFailure(error),
    }));
  }, []);
  const handlePageMeasured = useCallback((page: number, size: PageSize): void => {
    setMeasuredSizes((previous) =>
      previous[page]?.width === size.width && previous[page]?.height === size.height
        ? previous
        : { ...previous, [page]: size },
    );
  }, []);

  const goToPage = (page: number): void => {
    const next = clampPage(page, numPages);
    updateCfg({ currentPage: next });
    requestAnimationFrame(() => scrollToPageNumber(next));
  };

  const activateContextCitation = (stableId: string): void => {
    const nextCitation = activatePdfCitationPreviewContext(windowId, stableId);
    if (nextCitation === undefined) {
      return;
    }
    updateCfg(buildContextCitationCfgPatch(nextCitation, currentPageRef.current));
    if (nextCitation.display.pageNumber !== undefined) {
      requestAnimationFrame(() => {
        scrollToPageNumber(nextCitation.display.pageNumber ?? currentPageRef.current);
      });
    }
  };

  return (
    <div className={`pdfv-shell ${styles.lazyWidgetScope}`}>
      <PdfPreviewHeader display={display} />

      {activeCitation !== undefined ? (
        <PdfPreviewCitationContext
          activeCitation={activeCitation}
          backToChat={backToChat}
          backToChatDescriptionId={backToChatDescriptionId}
          citationContext={citationContext}
          citationContextCitations={citationContextCitations}
          focusWindow={focusWindow}
          onActivateCitation={activateContextCitation}
          restoreWindow={restoreWindow}
          windowId={windowId}
        />
      ) : null}

      {showToolbar ? (
        <PdfPreviewToolbar
          currentPage={currentPage}
          effectiveScale={effectiveScale}
          goToPage={goToPage}
          numPages={numPages}
          pageInput={pageInput}
          rotation={rotation}
          scalarIntentControlsEnabled={scalarIntentControlsEnabled}
          setPageInput={setPageInput}
          updateCfg={updateCfg}
          zoomMode={zoomMode}
          zoomValue={zoomValue}
        />
      ) : null}

      {failure !== null ? (
        <PdfPreviewFailurePanel
          failure={failure}
          failureActionLabel={failureActionLabel}
          failureDescriptionId={failureDescriptionId}
          onReopen={(failureToReopen) => void reopenPreview(failureToReopen)}
          onRetry={() => setRetryToken((value) => value + 1)}
          reopening={reopening}
        />
      ) : doc === null ? (
        <div className="lk-loading pdfv-status" role="status" aria-live="polite">
          {showSlowLoad ? "Rendering verified PDF preview..." : "Opening verified PDF preview..."}
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="pdfv-scroll"
          // Scrollable page region: tabIndex makes the overflow region keyboard-scrollable
          // (WCAG 2.1.1); jsx-a11y's default allowlist only covers role="tabpanel".
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          role="region"
          aria-label={`${display.documentLabel} PDF preview`}
        >
          {pageWindow.topSpacerHeight > 0 ? (
            <div
              className="pdfv-page-spacer"
              style={{ height: `${String(pageWindow.topSpacerHeight)}px` }}
              aria-hidden="true"
            />
          ) : null}
          {pageWindow.pages.map((pageNumber) => (
            <PdfPreviewPageSection
              key={pageNumber}
              currentPage={currentPage}
              defaultPageSize={defaultPageSize}
              doc={doc}
              effectiveScale={effectiveScale}
              handlePageMeasured={handlePageMeasured}
              handlePageRenderError={handlePageRenderError}
              measuredSizes={measuredSizes}
              onDismissPageFailure={(page) => {
                setPageRenderFailures((previous) => {
                  const next = { ...previous };
                  delete next[page];
                  return next;
                });
              }}
              onReopen={(failureToReopen) => void reopenPreview(failureToReopen)}
              pageFailure={pageRenderFailures[pageNumber]}
              pageNumber={pageNumber}
              pageRefs={pageRefs}
              reopening={reopening}
              rotation={rotation}
            />
          ))}
          {pageWindow.bottomSpacerHeight > 0 ? (
            <div
              className="pdfv-page-spacer"
              style={{ height: `${String(pageWindow.bottomSpacerHeight)}px` }}
              aria-hidden="true"
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
