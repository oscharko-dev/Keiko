"use client";

import {
  useOptionalWidgetTranslate as useTranslate,
  type OptionalWidgetTranslate as I18nTranslate,
} from "@/lib/optional-widget-i18n";

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
  type ReactNode,
} from "react";
import type { PDFDocumentProxy as PdfJsDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import styles from "./PdfCitationPreviewWindow.module.css";
import {
  ApiError,
  fetchPdfCitationPreviewDocument,
  openPdfCitationPreviewSession,
  pdfCitationPreviewDocumentUrl,
} from "@/lib/api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { bffRequestErrorKind } from "@/lib/http";
import { newClientCorrelationId } from "@/lib/bff-correlation";

import { Icons } from "../../Icons";
import {
  PdfCitationHighlight,
  type CitationHighlightSettled,
  type HighlightedPage,
} from "./PdfCitationHighlight";
import type { AppWindow } from "../../windows/types";
import {
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

// PascalCase aliases so the JSX tag itself signals "component", not member access (S6770).
const InfoIcon = Icons.info;
const BackIcon = Icons.back;
const FwdIcon = Icons.fwd;
const ZoomOutIcon = Icons.zoomOut;
const ZoomInIcon = Icons.zoomIn;

const MAX_SCALE = 2;
const MIN_SCALE = 0.5;
const PAGE_FRAME_PX = 32;
const PAGE_OUTER_CHROME_PX = 64;
const PAGE_SCROLL_GAP_PX = 18;
const PAGE_WINDOW_RADIUS = 3;
const RENDER_RADIUS = 1;
const SLOW_LOAD_MS = 900;
// Room above a framed citation when it is scrolled into view.
const CITATION_FRAME_MARGIN_PX = 48;
const ZOOM_STEP = 0.1;
const PDF_LOAD_DEADLINE_MS = 30_000;
const PDF_FULL_BUFFER_MAX_BYTES = 4 * 1024 * 1024;
const PDF_RANGE_CHUNK_SIZE = 1024 * 1024;
// Input that only a person produces: a programmatic scrollTo fires none of these.
const USER_SCROLL_EVENTS = ["wheel", "touchmove", "pointerdown", "keydown"] as const;

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

type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type PdfDocumentProxy = PdfJsDocumentProxy & {
  readonly destroy?: () => Promise<void> | void;
};

let pdfJsModulePromise: Promise<PdfJsModule> | null = null;

function loadPdfJs(): Promise<PdfJsModule> {
  // PDF.js's modern build requires runtime APIs newer than Keiko's declared browser floor
  // (Promise.try, URL.parse, Map#getOrInsertComputed and the Uint8Array base64 helpers among
  // others). The legacy distribution bundles its own core-js implementations in BOTH realms, so
  // keep the main module and worker on the matching legacy entries. A real-browser smoke removes
  // those host APIs before parsing a tiny PDF and proves that this is executable compatibility,
  // not merely a source-path assertion.
  pdfJsModulePromise ??= import("pdfjs-dist/legacy/build/pdf.mjs").then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/legacy/build/pdf.worker.mjs",
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

function failureFromOpenReason(reason: PdfCitationPreviewReasonCode): PreviewFailure {
  const copy = pdfCitationPreviewFailureCopy(reason);
  return {
    title: copy.title,
    message: copy.message,
    retryable: copy.retryable,
    ...(copy.retryable ? { action: "retry" as const } : {}),
  };
}

function sessionLostFailure(t: I18nTranslate): PreviewFailure {
  return {
    title: t("pdfCitationPreviewWindow.failure.sessionEnded.title"),
    message: t("pdfCitationPreviewWindow.failure.sessionEnded.message"),
    retryable: false,
    action: "reopen",
  };
}

function rangeFailure(t: I18nTranslate): PreviewFailure {
  return {
    title: t("pdfCitationPreviewWindow.failure.rangeFailed.title"),
    message: t("pdfCitationPreviewWindow.failure.rangeFailed.message"),
    retryable: false,
    action: "reopen",
  };
}

function timeoutFailure(t: I18nTranslate): PreviewFailure {
  return {
    title: t("pdfCitationPreviewWindow.failure.timedOut.title"),
    message: t("pdfCitationPreviewWindow.failure.timedOut.message"),
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

function previewFailureFromStatus(status: number, t: I18nTranslate): PreviewFailure | undefined {
  switch (status) {
    case 404:
      return sessionLostFailure(t);
    case 410:
      return sessionLostFailure(t);
    case 409:
      return {
        title: t("pdfCitationPreviewWindow.failure.changed.title"),
        message: t("pdfCitationPreviewWindow.failure.changedStatus.message"),
        retryable: false,
      };
    case 413:
      return {
        title: t("pdfCitationPreviewWindow.failure.tooLarge.title"),
        message: t("pdfCitationPreviewWindow.failure.tooLarge.message"),
        retryable: false,
      };
    case 416:
      return rangeFailure(t);
    case 503:
      return {
        title: t("pdfCitationPreviewWindow.failure.temporarilyUnavailable.title"),
        message: t("pdfCitationPreviewWindow.failure.temporarilyUnavailable.message"),
        retryable: true,
        action: "retry",
      };
    default:
      return undefined;
  }
}

function previewFailure(error: unknown, t: I18nTranslate): PreviewFailure {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "PREVIEW_SESSION_NOT_FOUND":
      case "PREVIEW_SESSION_CLOSED":
      case "PREVIEW_SESSION_EXPIRED":
        return sessionLostFailure(t);
      case "PREVIEW_SOURCE_NOT_READY":
        return {
          title: t("pdfCitationPreviewWindow.failure.notReady.title"),
          message: t("pdfCitationPreviewWindow.failure.notReady.message"),
          retryable: true,
          action: "retry",
        };
      case "PREVIEW_SOURCE_UNREADABLE":
      case "PREVIEW_SOURCE_DEHYDRATED":
        return {
          title: t("pdfCitationPreviewWindow.failure.temporarilyUnavailable.title"),
          message: t("pdfCitationPreviewWindow.failure.temporarilyUnavailable.message"),
          retryable: true,
          action: "retry",
        };
      case "PREVIEW_SOURCE_CHANGED":
        return {
          title: t("pdfCitationPreviewWindow.failure.changed.title"),
          message: t("pdfCitationPreviewWindow.failure.sourceChanged.message"),
          retryable: false,
        };
      case "PREVIEW_RANGE_NOT_SATISFIABLE":
        return rangeFailure(t);
      case "PREVIEW_SOURCE_REBIND_REQUIRED":
      case "PREVIEW_SOURCE_MISSING":
        return {
          title: t("pdfCitationPreviewWindow.failure.sourceUnavailable.title"),
          message: t("pdfCitationPreviewWindow.failure.sourceUnavailable.message"),
          retryable: false,
        };
      case "PREVIEW_SOURCE_NOT_PDF":
        return {
          title: t("pdfCitationPreviewWindow.failure.blocked.title"),
          message: t("pdfCitationPreviewWindow.failure.blocked.message"),
          retryable: false,
        };
      case "PREVIEW_SOURCE_TOO_LARGE":
        return {
          title: t("pdfCitationPreviewWindow.failure.tooLarge.title"),
          message: t("pdfCitationPreviewWindow.failure.tooLarge.message"),
          retryable: false,
        };
      default:
        break;
    }
  }

  const statusFailure = previewFailureFromStatus(responseExceptionStatus(error) ?? 0, t);
  if (statusFailure !== undefined) return statusFailure;

  return {
    title: t("pdfCitationPreviewWindow.failure.generic.title"),
    message: t("pdfCitationPreviewWindow.failure.generic.message"),
    retryable: true,
    action: "retry",
  };
}

function restoredShellFailure(
  failureOverride: PreviewFailure | null,
  canReopen: boolean,
  t: I18nTranslate,
): PreviewFailure {
  if (failureOverride !== null) {
    return failureOverride;
  }
  return {
    ...(canReopen ? { action: "reopen" as const } : {}),
    title: t("pdfCitationPreviewWindow.failure.reVerificationRequired.title"),
    message: t("pdfCitationPreviewWindow.failure.reVerificationRequired.message"),
    retryable: canReopen,
  };
}

/** The cited page's passage and the receiver of its highlight outcome. */
interface CitedPage {
  readonly passage: string | undefined;
  readonly onSettled: CitationHighlightSettled;
}

/** A loaded document and the load that produced it. */
interface LoadedDocument {
  readonly load: object;
  readonly pdf: PdfDocumentProxy;
}

function documentOfLoad(loaded: LoadedDocument | null, load: object): PdfDocumentProxy | null {
  return loaded?.load === load ? loaded.pdf : null;
}

function isRenderingCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === "RenderingCancelledException";
}

function PdfCanvasPage({
  active,
  citation,
  onError,
  onMeasured,
  pageNumber,
  pdf,
  rotation,
  scale,
}: {
  readonly active: boolean;
  /** Present on the cited page: the passage to frame there and where the outcome goes. */
  readonly citation: CitedPage | undefined;
  readonly onError: (page: number, error: unknown) => void;
  readonly onMeasured: (page: number, size: PageSize) => void;
  readonly pageNumber: number;
  readonly pdf: PdfDocumentProxy;
  readonly rotation: number;
  readonly scale: number;
}): ReactNode {
  const t = useTranslate();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [rendered, setRendered] = useState<HighlightedPage | null>(null);

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
        if (!disposed) setRendered({ page, viewport });
      })
      .catch((error) => {
        if (disposed || isRenderingCancelled(error)) return;
        onError(pageNumber, error);
      });

    return (): void => {
      disposed = true;
      cancelRender?.();
    };
  }, [active, onError, onMeasured, pageNumber, pdf, rotation, scale]);

  return (
    <div className={styles.cmpPageLayer}>
      <canvas
        ref={canvasRef}
        className="pdfv-page-canvas"
        aria-label={t("pdfCitationPreviewWindow.page", { pageNumber })}
      />
      {citation !== undefined && rendered !== null ? (
        <PdfCitationHighlight
          rendered={rendered}
          passage={citation.passage}
          onSettled={citation.onSettled}
        />
      ) : null}
    </div>
  );
}

// The cited page's highlight: reports its outcome once per document load, and a framed passage
// re-renders the window so the held page scrolls to the frame.
function useCitedPage(
  load: object,
  sessionEntry: ReturnType<typeof getPdfCitationPreviewSession>,
): CitedPage {
  const passage = sessionEntry?.display.passage;
  const reportedFor = useRef<object | null>(null);
  const [, setFramedCount] = useState(0);
  const onSettled = useCallback<CitationHighlightSettled>(
    (highlight) => {
      if (reportedFor.current === load) return;
      reportedFor.current = load;
      // i18n-exempt: body-free diagnostic message for the activity log, never rendered
      reportClientDiagnostic("PDF citation highlight settled", {
        correlationId: newClientCorrelationId(),
        citationHighlight: highlight,
      });
      if (highlight.outcome === "framed") setFramedCount((count) => count + 1);
    },
    [load],
  );
  return useMemo((): CitedPage => ({ passage, onSettled }), [onSettled, passage]);
}

// The label for the failure panel's single action button, matching the failure's action kind.
// A failure with no actionable recovery (e.g. "changed") renders no button, hence the empty string.
function failureActionLabel(failure: PreviewFailure | null, t: I18nTranslate): string {
  if (failure?.action === "reopen") return t("pdfCitationPreviewWindow.action.reopenPreview");
  if (failure?.action === "retry") return t("pdfCitationPreviewWindow.action.retryPreview");
  return "";
}

export function PdfCitationPreviewWindow({
  cfg,
  updateCfg,
  windowId,
}: {
  readonly cfg: Record<string, unknown>;
  readonly updateCfg: (patch: AppWindow["cfg"]) => void;
  readonly windowId: string;
}): ReactNode {
  const t = useTranslate();
  const subscribeWindowRegistry = useCallback(
    (listener: () => void) => subscribePdfCitationPreviewRegistry(windowId, listener),
    [windowId],
  );
  const sessionEntry = useSyncExternalStore(
    subscribeWindowRegistry,
    () => getPdfCitationPreviewSession(windowId),
    () => getPdfCitationPreviewSession(windowId),
  );
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [defaultPageSize, setDefaultPageSize] = useState<PageSize | null>(null);
  const [loaded, setLoaded] = useState<LoadedDocument | null>(null);
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
  // The page the viewer holds in view until the person scrolls or navigates. Page heights are
  // estimated until each page is measured and the fit-width scale settles, so a single pixel jump
  // lands on the wrong page: a citation for page 53 opened on page 3 (#4173). Every layout change
  // scrolls back to this page, and scroll positions do not overwrite it while it is held.
  const anchorPageRef = useRef<number | null>(null);
  const failureDescriptionId = useId();
  const pageRefs = useRef(new Map<number, HTMLElement>());
  const scrollRef = useRef<HTMLElement | null>(null);
  const persistedCitationContext = useMemo(
    () => readPersistedCitationContext(cfg.previewContextJson),
    [cfg.previewContextJson],
  );
  const citationContext = sessionEntry?.context ?? persistedCitationContext;
  const reopenAttemptKey = useMemo((): string | undefined => {
    const origin = citationContext?.origin;
    if (origin === undefined || citationContext === undefined) return undefined;
    return `${origin.chatId}:${origin.assistantMessageId}:${origin.marker}:${citationContext.activeStableId}`;
  }, [citationContext]);

  const fallbackDocumentLabel = t("pdfCitationPreviewWindow.documentLabelFallback");
  const display = useMemo((): Pick<
    PdfCitationPreviewSafeWindowCfg,
    "documentLabel" | "pageNumber"
  > => {
    const pageNumber =
      typeof cfg.pageNumber === "number" ? cfg.pageNumber : sessionEntry?.display.pageNumber;
    return {
      documentLabel:
        readOptionalString(cfg.documentLabel) ??
        sessionEntry?.display.documentLabel ??
        fallbackDocumentLabel,
      ...(pageNumber === undefined ? {} : { pageNumber }),
    };
  }, [cfg.documentLabel, cfg.pageNumber, fallbackDocumentLabel, sessionEntry]);

  const zoomMode = readZoomMode(cfg.zoomMode);
  const zoomValue = clampScale(readNumber(cfg.zoomValue, 1));
  const rotation = normalizeRotation(readNumber(cfg.rotation, 0));
  const currentPage = clampPage(
    readNumber(cfg.currentPage, display.pageNumber ?? 1),
    numPages > 0 ? numPages : Number.MAX_SAFE_INTEGER,
  );
  const failureOverride = useMemo((): PreviewFailure | null => {
    const title = readOptionalString(cfg.failureTitle);
    const message = readOptionalString(cfg.failureMessage);
    if (title === undefined || message === undefined) return null;
    return {
      title,
      message,
      retryable: readOptionalBoolean(cfg.failureRetryable) ?? false,
    };
  }, [cfg.failureMessage, cfg.failureRetryable, cfg.failureTitle]);
  // Every change that reloads the document starts a new load. A document is shown only for the
  // load that produced it: a second citation click moves to another page and destroys the
  // outgoing document in the same commit, so no page of that document may start drawing then.
  const load = useMemo(
    (): object => ({ failureOverride, reopenAttemptKey, retryToken, sessionEntry, t }),
    [failureOverride, reopenAttemptKey, retryToken, sessionEntry, t],
  );
  const doc = documentOfLoad(loaded, load);
  const citedPage = useCitedPage(load, sessionEntry);
  const scalarIntentControlsEnabled = doc !== null;
  const currentPageSize = measuredSizes[currentPage] ?? defaultPageSize;
  const effectiveScale = useMemo((): number => {
    if (currentPageSize === null) return zoomValue;
    const viewport = rotatedSize(currentPageSize, rotation);
    const fitWidth = clampScale(
      (Math.max(0, containerSize.width - PAGE_FRAME_PX) || viewport.width) / viewport.width,
    );
    if (zoomMode === "fit-width") return fitWidth;
    if (zoomMode === "fit-page") {
      const fitHeight =
        (Math.max(0, containerSize.height - PAGE_FRAME_PX) || viewport.height) / viewport.height;
      return clampScale(Math.min(fitWidth, fitHeight));
    }
    return zoomValue;
  }, [containerSize.height, containerSize.width, currentPageSize, rotation, zoomMode, zoomValue]);

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
      const scroller = scrollRef.current;
      if (scroller === null) return;
      const element = pageRefs.current.get(pageNumber);
      // A framed citation is the place to show; otherwise the top of its page.
      const frame = element?.querySelector("[data-citation-box]");
      const target = frame ?? element;
      // Scroll only the page region: scrollIntoView would also move the workspace around it.
      const top =
        target === undefined
          ? estimatedPageOffset(pageNumber)
          : target.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top +
            scroller.scrollTop -
            (frame === null || frame === undefined ? 0 : CITATION_FRAME_MARGIN_PX);
      scroller.scrollTo({ top: Math.max(0, top) });
    },
    [estimatedPageOffset],
  );

  const reopenPreview = useCallback(
    async (fallbackFailure?: PreviewFailure): Promise<boolean> => {
      const context = citationContext;
      const origin = context?.origin;
      if (origin === undefined || context === undefined) {
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
          stableId: context.activeStableId,
          origin: origin.representation,
        });
        if (response.outcome === "authorized") {
          const nextCfg = replacePdfCitationPreviewWindowSession(windowId, response, {
            context,
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
        const failure = previewFailure(error, t);
        setFailure(failure.action === "reopen" ? (fallbackFailure ?? failure) : failure);
        return false;
      } finally {
        setReopening(false);
      }
    },
    [citationContext, t, updateCfg, windowId],
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

    return (): void => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const sessionHandle = sessionEntry?.session.handle;
    const sessionByteLength = sessionEntry?.session.byteLength;
    if (sessionHandle === undefined) {
      setFailure(null);
      setDefaultPageSize(null);
      setLoaded(null);
      setNumPages(0);
      setPageRenderFailures({});
      return;
    }

    let disposed = false;
    let deadlineElapsed = false;
    let loadingTask: PdfDocumentLoadingTask | null = null;
    const controller = new AbortController();

    setFailure(null);
    setShowSlowLoad(false);
    setMeasuredSizes({});
    setPageRenderFailures({});
    setDefaultPageSize(null);
    setLoaded(null);
    setNumPages(0);
    // A new citation's page is held from the start: the outgoing pages still scroll once.
    anchorPageRef.current = currentPageRef.current;

    const slowTimer = window.setTimeout(() => setShowSlowLoad(true), SLOW_LOAD_MS);
    const deadlineTimer = window.setTimeout(() => {
      if (disposed) return;
      deadlineElapsed = true;
      controller.abort();
      void loadingTask?.destroy();
      setFailure(timeoutFailure(t));
      setShowSlowLoad(false);
    }, PDF_LOAD_DEADLINE_MS);

    void loadPdfJs()
      .then(async (pdfjs) => {
        if (disposed) return null;
        if (
          typeof sessionByteLength === "number" &&
          sessionByteLength > PDF_FULL_BUFFER_MAX_BYTES
        ) {
          loadingTask = pdfjs.getDocument({
            disableRange: false,
            disableStream: false,
            httpHeaders: { Accept: "application/pdf" },
            rangeChunkSize: PDF_RANGE_CHUNK_SIZE,
            url: pdfCitationPreviewDocumentUrl(sessionHandle),
            withCredentials: false,
          }) as PdfDocumentLoadingTask;
        } else {
          const bytes = await fetchPdfCitationPreviewDocument(sessionHandle, controller.signal);
          if (disposed) return null;
          loadingTask = pdfjs.getDocument({
            data: bytes,
          }) as PdfDocumentLoadingTask;
        }
        return loadingTask.promise;
      })
      .then(async (pdf) => {
        if (pdf === null) return;
        if (disposed) {
          await pdf.destroy?.();
          return;
        }
        const firstPage = await pdf.getPage(1);
        const viewport = firstPage.getViewport({ scale: 1 });
        setDefaultPageSize({ width: viewport.width, height: viewport.height });
        setLoaded({ load, pdf });
        setNumPages(pdf.numPages);
        setShowSlowLoad(false);
      })
      .catch((error) => {
        if (
          disposed ||
          deadlineElapsed ||
          (error instanceof DOMException && error.name === "AbortError")
        ) {
          return;
        }
        const failure = previewFailure(error, t);
        if (
          failure.action === "reopen" &&
          reopenAttemptKey !== undefined &&
          autoReopenAttemptedKeyRef.current !== reopenAttemptKey
        ) {
          autoReopenAttemptedKeyRef.current = reopenAttemptKey;
          void reopenPreviewRef.current(failure);
          return;
        }
        setFailure(failure);
        setShowSlowLoad(false);
      })
      .finally(() => {
        window.clearTimeout(slowTimer);
        window.clearTimeout(deadlineTimer);
      });

    return (): void => {
      disposed = true;
      controller.abort();
      void loadingTask?.destroy();
      window.clearTimeout(slowTimer);
      window.clearTimeout(deadlineTimer);
    };
    // GEN-PERF-WIDGET-001 — reopenPreview is intentionally read through a ref (above) rather
    // than listed here, so view-only cfg writes that churn its identity no longer re-run this
    // document-load effect. The document reloads only on a genuine session/retry change.
  }, [failureOverride, load, reopenAttemptKey, retryToken, sessionEntry, t]);

  useEffect(() => {
    return (): void => {
      void loaded?.pdf.destroy?.();
    };
  }, [loaded]);

  // A loaded document opens on the cited page, and a zoom or rotation keeps the page in view.
  useEffect(() => {
    if (doc === null || numPages === 0) return;
    anchorPageRef.current = currentPageRef.current;
  }, [doc, effectiveScale, numPages, rotation]);

  // While a page is held, every layout change (a measured page, the settled fit-width scale, a
  // resized window) scrolls back to it.
  useEffect(() => {
    if (doc === null || numPages === 0) return;
    const frame = requestAnimationFrame(() => {
      const anchor = anchorPageRef.current;
      if (anchor !== null) scrollToPageNumber(anchor);
    });
    return (): void => {
      cancelAnimationFrame(frame);
    };
  });

  // The person's own scrolling releases the held page.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null || numPages === 0) return;
    const release = (): void => {
      anchorPageRef.current = null;
    };
    for (const type of USER_SCROLL_EVENTS) {
      scroller.addEventListener(type, release, { passive: true });
    }
    return (): void => {
      for (const type of USER_SCROLL_EVENTS) scroller.removeEventListener(type, release);
    };
  }, [doc, numPages]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null || numPages === 0) return;

    let frame = 0;
    const syncPage = (): void => {
      frame = 0;
      if (anchorPageRef.current !== null) return;
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
    return (): void => {
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
  // A restored window without a session derives its message at render, in the current language.
  const shownFailure =
    failure ??
    (sessionEntry === undefined
      ? restoredShellFailure(failureOverride, reopenAttemptKey !== undefined, t)
      : null);
  const showToolbar = doc !== null && shownFailure === null;
  const failureActionButtonLabel = failureActionLabel(shownFailure, t);
  const handlePageRenderError = useCallback(
    (page: number, error: unknown): void => {
      // i18n-exempt: body-free diagnostic message for the activity log, never rendered
      reportClientDiagnostic("PDF citation preview page render failed", {
        errorKind: bffRequestErrorKind(error),
        errorEvidence: clientErrorEvidence(error),
      });
      setPageRenderFailures((previous) => ({
        ...previous,
        [page]: previewFailure(error, t),
      }));
    },
    [t],
  );
  const handlePageMeasured = useCallback((page: number, size: PageSize): void => {
    setMeasuredSizes((previous) =>
      previous[page]?.width === size.width && previous[page]?.height === size.height
        ? previous
        : { ...previous, [page]: size },
    );
  }, []);

  const goToPage = (page: number): void => {
    const next = clampPage(page, numPages);
    anchorPageRef.current = next;
    updateCfg({ currentPage: next });
    requestAnimationFrame(() => scrollToPageNumber(next));
  };

  const renderPage = (pageNumber: number, pdf: PdfDocumentProxy): ReactNode => {
    const pageSize = rotatedSize(
      measuredSizes[pageNumber] ?? defaultPageSize ?? { width: 612, height: 792 },
      rotation,
    );
    const minHeight = Math.max(220, Math.round(pageSize.height * effectiveScale));
    const shouldRender = Math.abs(pageNumber - currentPage) <= RENDER_RADIUS;
    const pageFailure = pageRenderFailures[pageNumber];
    const pageFailureActionLabel =
      pageFailure?.action === "reopen"
        ? t("pdfCitationPreviewWindow.action.reopenPreview")
        : t("pdfCitationPreviewWindow.action.retryPage");
    const renderedPage = shouldRender ? (
      <PdfCanvasPage
        active
        citation={pageNumber === display.pageNumber ? citedPage : undefined}
        onError={handlePageRenderError}
        onMeasured={handlePageMeasured}
        pageNumber={pageNumber}
        pdf={pdf}
        rotation={rotation}
        scale={effectiveScale}
      />
    ) : (
      <div className="pdfv-page-skeleton" aria-hidden="true" />
    );
    return (
      <section
        key={pageNumber}
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
          <div className="pdfv-page-meta mono">
            {t("pdfCitationPreviewWindow.page", { pageNumber })}
          </div>
          {pageFailure !== undefined ? (
            <div className="lk-empty pdfv-page-error" role="alert">
              <div className="lk-empty-icon">
                <InfoIcon size={18} />
              </div>
              <p className="lk-empty-title">{pageFailure.title}</p>
              <p className="lk-empty-body">{pageFailure.message}</p>
              <button
                type="button"
                className="tm-action pdfv-retry"
                disabled={reopening}
                onClick={() => {
                  if (pageFailure.action === "reopen") {
                    void reopenPreview(pageFailure);
                    return;
                  }
                  setPageRenderFailures((previous) => {
                    const next = { ...previous };
                    delete next[pageNumber];
                    return next;
                  });
                }}
              >
                {reopening
                  ? t("pdfCitationPreviewWindow.action.openingPreview")
                  : pageFailureActionLabel}
              </button>
            </div>
          ) : (
            renderedPage
          )}
        </div>
      </section>
    );
  };

  const renderFailureState = (failureState: PreviewFailure): ReactNode => (
    <div className="lk-empty pdfv-status" role="alert" aria-describedby={failureDescriptionId}>
      <div className="lk-empty-icon">
        <InfoIcon size={20} />
      </div>
      <p className="lk-empty-title">{failureState.title}</p>
      <p id={failureDescriptionId} className="lk-empty-body">
        {failureState.message}
      </p>
      {failureState.action !== undefined ? (
        <button
          type="button"
          className="tm-action pdfv-retry"
          aria-describedby={failureDescriptionId}
          disabled={reopening}
          onClick={() => {
            if (failureState.action === "reopen") {
              void reopenPreview(failureState);
              return;
            }
            setRetryToken((value) => value + 1);
          }}
        >
          {reopening
            ? t("pdfCitationPreviewWindow.action.openingPreview")
            : failureActionButtonLabel}
        </button>
      ) : null}
    </div>
  );

  const renderLoadedDocument = (pdf: PdfDocumentProxy): ReactNode => (
    // Scrollable page region: <section> plus an accessible name carries the region role
    // natively, so no role attribute is needed (#2721).
    <section
      ref={scrollRef}
      className="pdfv-scroll"
      // tabIndex makes the overflow region keyboard-scrollable (WCAG 2.1.1);
      // jsx-a11y's default allowlist only covers role="tabpanel".
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      aria-label={t("pdfCitationPreviewWindow.scrollRegionLabel", {
        documentLabel: display.documentLabel,
      })}
    >
      {pageWindow.topSpacerHeight > 0 ? (
        <div
          className="pdfv-page-spacer"
          style={{ height: `${String(pageWindow.topSpacerHeight)}px` }}
          aria-hidden="true"
        />
      ) : null}
      {pageWindow.pages.map((pageNumber) => renderPage(pageNumber, pdf))}
      {pageWindow.bottomSpacerHeight > 0 ? (
        <div
          className="pdfv-page-spacer"
          style={{ height: `${String(pageWindow.bottomSpacerHeight)}px` }}
          aria-hidden="true"
        />
      ) : null}
    </section>
  );

  const renderDocumentState = (): ReactNode => {
    if (shownFailure !== null) return renderFailureState(shownFailure);
    if (doc !== null) return renderLoadedDocument(doc);
    return (
      <div className="lk-loading pdfv-status" role="status" aria-live="polite">
        {showSlowLoad
          ? t("pdfCitationPreviewWindow.loading.rendering")
          : t("pdfCitationPreviewWindow.loading.opening")}
      </div>
    );
  };

  const submitPageInput = (value: string): void => {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed)) {
      goToPage(parsed);
      return;
    }
    setPageInput(String(currentPage));
  };

  const renderPageControls = (): ReactNode => (
    <div className="pdfv-group">
      <button
        type="button"
        className={`pdfv-btn ${styles.cmpIconButton} tm-action`}
        aria-label={t("pdfCitationPreviewWindow.toolbar.previous")}
        data-tip={t("pdfCitationPreviewWindow.toolbar.previous")}
        disabled={currentPage <= 1}
        onClick={() => goToPage(currentPage - 1)}
      >
        <BackIcon size={14} />
      </button>
      <label className="pdfv-page-field">
        <span className="sr-only">{t("pdfCitationPreviewWindow.toolbar.currentPage")}</span>
        <input
          className="pdfv-page-input"
          inputMode="numeric"
          pattern="[0-9]*"
          value={pageInput}
          onChange={(event) => setPageInput(event.target.value)}
          onBlur={(event) => submitPageInput(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            submitPageInput(event.currentTarget.value);
          }}
        />
      </label>
      <span className="pdfv-page-count mono">/ {numPages > 0 ? String(numPages) : "--"}</span>
      <button
        type="button"
        className={`pdfv-btn ${styles.cmpIconButton} tm-action`}
        aria-label={t("pdfCitationPreviewWindow.toolbar.next")}
        data-tip={t("pdfCitationPreviewWindow.toolbar.next")}
        disabled={currentPage >= numPages}
        onClick={() => goToPage(currentPage + 1)}
      >
        <FwdIcon size={14} />
      </button>
    </div>
  );

  const renderZoomControls = (): ReactNode => (
    <div className="pdfv-group">
      <button
        type="button"
        className={`pdfv-btn ${styles.cmpIconButton} tm-action`}
        aria-label={t("pdfCitationPreviewWindow.toolbar.zoomOut")}
        data-tip={t("pdfCitationPreviewWindow.toolbar.zoomOut")}
        disabled={!scalarIntentControlsEnabled || effectiveScale <= MIN_SCALE}
        onClick={() =>
          updateCfg({ zoomMode: "manual", zoomValue: clampScale(effectiveScale - ZOOM_STEP) })
        }
      >
        <ZoomOutIcon size={14} />
      </button>
      <button
        type="button"
        className="pdfv-btn pdfv-zoom mono tm-action"
        data-tip={t("pdfCitationPreviewWindow.toolbar.fitWidth")}
        aria-label={t("pdfCitationPreviewWindow.toolbar.fitWidth")}
        aria-pressed={zoomMode === "fit-width"}
        disabled={!scalarIntentControlsEnabled}
        onClick={() => updateCfg({ zoomMode: "fit-width" })}
      >
        {String(Math.round(effectiveScale * 100))}%
      </button>
      <button
        type="button"
        className={`pdfv-btn ${styles.cmpIconButton} tm-action`}
        aria-label={t("pdfCitationPreviewWindow.toolbar.zoomIn")}
        data-tip={t("pdfCitationPreviewWindow.toolbar.zoomIn")}
        disabled={!scalarIntentControlsEnabled || effectiveScale >= MAX_SCALE}
        onClick={() =>
          updateCfg({ zoomMode: "manual", zoomValue: clampScale(effectiveScale + ZOOM_STEP) })
        }
      >
        <ZoomInIcon size={14} />
      </button>
    </div>
  );

  const renderPreview = (): ReactNode => (
    <div className={`pdfv-shell ${styles.lazyWidgetScope}`}>
      {showToolbar ? (
        <fieldset className="pdfv-toolbar">
          <legend className="sr-only">{t("pdfCitationPreviewWindow.toolbar.ariaLabel")}</legend>
          {renderPageControls()}
          {renderZoomControls()}
        </fieldset>
      ) : null}

      {renderDocumentState()}
    </div>
  );

  return renderPreview();
}
