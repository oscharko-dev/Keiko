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
import { useTranslate, type I18nTranslate } from "@/lib/i18n";
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

function anchorQualityLabel(
  value: PdfCitationPreviewSafeWindowCfg["anchorQuality"],
  t: I18nTranslate,
): string {
  switch (value) {
    case "approximate":
      return t("pdfCitationPreviewWindow.anchorQuality.approximate");
    case "unavailable":
      return t("pdfCitationPreviewWindow.anchorQuality.unavailable");
    default:
      return t("pdfCitationPreviewWindow.anchorQuality.pageOnly");
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
  t: I18nTranslate,
): string {
  if (display.pageLabel !== undefined) return display.pageLabel;
  if (display.pageNumber !== undefined) {
    return t("pdfCitationPreviewWindow.page", { pageNumber: display.pageNumber });
  }
  return display.anchorQuality === "unavailable"
    ? t("pdfCitationPreviewWindow.noVerifiedPage")
    : t("pdfCitationPreviewWindow.verifiedPdf");
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

function isRenderingCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === "RenderingCancelledException";
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
  const t = useTranslate();
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
      aria-label={t("pdfCitationPreviewWindow.page", { pageNumber })}
    />
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
  const backToChat =
    backToChatReason.length === 0
      ? { enabled: true as const }
      : { enabled: false as const, reason: backToChatReason };
  const activeCitation =
    sessionEntry === undefined
      ? undefined
      : (citationContextCitations.find(
          (citation) => citation.citation.stableId === citationContext?.activeStableId,
        ) ?? citationContextCitations[0]);
  const reopenAttemptKey = useMemo((): string | undefined => {
    const origin = citationContext?.origin;
    if (origin === undefined || citationContext === undefined) return undefined;
    return `${origin.chatId}:${origin.assistantMessageId}:${origin.marker}:${citationContext.activeStableId}`;
  }, [citationContext]);

  const display = useMemo((): Pick<
    PdfCitationPreviewSafeWindowCfg,
    "anchorQuality" | "documentLabel" | "pageLabel" | "pageNumber" | "sourceLabel"
  > => {
    const sourceLabel = readOptionalString(cfg.sourceLabel) ?? sessionEntry?.display.sourceLabel;
    const pageNumber =
      typeof cfg.pageNumber === "number" ? cfg.pageNumber : sessionEntry?.display.pageNumber;
    const pageLabel = readOptionalString(cfg.pageLabel) ?? sessionEntry?.display.pageLabel;
    return {
      documentLabel:
        readOptionalString(cfg.documentLabel) ??
        sessionEntry?.display.documentLabel ??
        t("pdfCitationPreviewWindow.documentLabelFallback"),
      anchorQuality:
        activeCitation?.display.anchorQuality ?? sessionEntry?.display.anchorQuality ?? "page-only",
      ...(sourceLabel === undefined ? {} : { sourceLabel }),
      ...(pageNumber === undefined ? {} : { pageNumber }),
      ...(pageLabel === undefined ? {} : { pageLabel }),
    };
  }, [
    activeCitation?.display.anchorQuality,
    cfg.documentLabel,
    cfg.pageLabel,
    cfg.pageNumber,
    cfg.sourceLabel,
    sessionEntry,
    t,
  ]);

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

    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const sessionHandle = sessionEntry?.session.handle;
    const sessionByteLength = sessionEntry?.session.byteLength;
    if (sessionHandle === undefined) {
      setFailure(restoredShellFailure(failureOverride, reopenAttemptKey !== undefined, t));
      setDefaultPageSize(null);
      setDoc(null);
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
    setDoc(null);
    setNumPages(0);
    didInitialScrollRef.current = false;

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
        setDoc(pdf);
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

    return () => {
      disposed = true;
      controller.abort();
      void loadingTask?.destroy();
      window.clearTimeout(slowTimer);
      window.clearTimeout(deadlineTimer);
    };
    // GEN-PERF-WIDGET-001 — reopenPreview is intentionally read through a ref (above) rather
    // than listed here, so view-only cfg writes that churn its identity no longer re-run this
    // document-load effect. The document reloads only on a genuine session/retry change.
  }, [failureOverride, reopenAttemptKey, retryToken, sessionEntry, t]);

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
      ? t("pdfCitationPreviewWindow.action.reopenPreview")
      : failure?.action === "retry"
        ? t("pdfCitationPreviewWindow.action.retryPreview")
        : "";
  const handlePageRenderError = useCallback(
    (page: number, error: unknown): void => {
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
    updateCfg({ currentPage: next });
    requestAnimationFrame(() => scrollToPageNumber(next));
  };

  const activateContextCitation = (stableId: string): void => {
    const nextCitation = activatePdfCitationPreviewContext(windowId, stableId);
    if (nextCitation === undefined) {
      return;
    }
    updateCfg({
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
          ? currentPageRef.current
          : nextCitation.display.pageNumber,
      documentLabel: nextCitation.display.documentLabel,
    });
    if (nextCitation.display.pageNumber !== undefined) {
      requestAnimationFrame(() => {
        scrollToPageNumber(nextCitation.display.pageNumber ?? currentPageRef.current);
      });
    }
  };

  return (
    <div className={`pdfv-shell ${styles.lazyWidgetScope}`}>
      <div className="pdfv-header">
        <div className="pdfv-heading">
          <p className="pdfv-eyebrow">{t("pdfCitationPreviewWindow.eyebrow")}</p>
          <h2 className="pdfv-title">{display.documentLabel}</h2>
          <p className="pdfv-meta">
            {display.sourceLabel ?? t("pdfCitationPreviewWindow.sourceLabelFallback")}
            {display.pageLabel === undefined
              ? display.pageNumber === undefined
                ? ""
                : ` · ${t("pdfCitationPreviewWindow.page", { pageNumber: display.pageNumber })}`
              : ` · ${display.pageLabel}`}
          </p>
        </div>
        <span className="pdfv-chip">{anchorQualityLabel(display.anchorQuality, t)}</span>
      </div>

      {activeCitation !== undefined ? (
        <section
          className="pdfv-context"
          aria-label={t("pdfCitationPreviewWindow.citationContext.ariaLabel")}
        >
          <div className="pdfv-context-head">
            <div className="pdfv-context-copy">
              <p className="pdfv-context-eyebrow">
                {t("pdfCitationPreviewWindow.citationContext.eyebrow")}
              </p>
              <h3 className="pdfv-context-title">
                <span className="pdfv-context-marker">{activeCitation.citation.marker}</span>
                <span className="pdfv-context-document">
                  {activeCitation.display.documentLabel}
                </span>
                <span className="pdfv-context-page">
                  {citationContextPageLabel(activeCitation.display, t)}
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
                aria-describedby={
                  backToChat.reason === undefined ? undefined : backToChatDescriptionId
                }
                aria-disabled={backToChat.enabled ? undefined : "true"}
                data-tip={backToChat.reason ?? t("pdfCitationPreviewWindow.backToChat.defaultTip")}
                onClick={() => {
                  if (!backToChat.enabled) return;
                  activatePdfCitationPreviewBackToChat(windowId, { focusWindow, restoreWindow });
                }}
              >
                <Icons.back size={14} />
                <span>{t("pdfCitationPreviewWindow.backToChat.label")}</span>
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
                <span>{t("pdfCitationPreviewWindow.sameAnswerCitations")}</span>
                <span className="pdfv-context-count">{citationContextCitations.length}</span>
                <Icons.chevron size={13} />
              </summary>
              <ul
                className="grounded-citations pdfv-context-list"
                aria-label={t("pdfCitationPreviewWindow.sameAnswerCitations")}
              >
                {citationContextCitations.map((citation) => {
                  const active = citation.citation.stableId === citationContext.activeStableId;
                  const fullLabel = citationContextLabel({
                    label: citation.citation.label,
                    marker: citation.citation.marker,
                    source: citation.citation.source,
                  });
                  return (
                    <li key={citation.citation.stableId} className="grounded-citations-item">
                      <button
                        type="button"
                        className="grounded-citation grounded-citation-action pdfv-context-citation"
                        aria-label={`${fullLabel} ${citationContextPageLabel(citation.display, t)}`}
                        aria-pressed={active}
                        data-active={active ? "true" : "false"}
                        data-tip={fullLabel}
                        onClick={() => {
                          if (active) return;
                          activateContextCitation(citation.citation.stableId);
                        }}
                      >
                        <span className="grounded-citation-range">{citation.citation.marker}</span>
                        <span className="grounded-citation-action-label">
                          {active
                            ? t("pdfCitationPreviewWindow.citationActive")
                            : citationContextPageLabel(citation.display, t)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </details>
          ) : null}
        </section>
      ) : null}

      {showToolbar ? (
        <fieldset className="pdfv-toolbar">
          <legend className="sr-only">{t("pdfCitationPreviewWindow.toolbar.ariaLabel")}</legend>
          <div className="pdfv-group">
            <button
              type="button"
              className="pdfv-btn tm-action"
              disabled={currentPage <= 1}
              onClick={() => goToPage(currentPage - 1)}
            >
              <Icons.back size={14} />
              <span>{t("pdfCitationPreviewWindow.toolbar.previous")}</span>
            </button>
            <label className="pdfv-page-field">
              <span className="sr-only">{t("pdfCitationPreviewWindow.toolbar.currentPage")}</span>
              <input
                className="pdfv-page-input"
                inputMode="numeric"
                pattern="[0-9]*"
                value={pageInput}
                onChange={(event) => setPageInput(event.target.value)}
                onBlur={(event) => {
                  const parsed = Number.parseInt(event.currentTarget.value, 10);
                  if (Number.isInteger(parsed)) {
                    goToPage(parsed);
                    return;
                  }
                  setPageInput(String(currentPage));
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  const parsed = Number.parseInt(event.currentTarget.value, 10);
                  if (Number.isInteger(parsed)) {
                    goToPage(parsed);
                    return;
                  }
                  setPageInput(String(currentPage));
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
              <span>{t("pdfCitationPreviewWindow.toolbar.next")}</span>
              <Icons.fwd size={14} />
            </button>
          </div>

          <div className="pdfv-group">
            <button
              type="button"
              className="pdfv-btn tm-action"
              disabled={
                !scalarIntentControlsEnabled || (zoomMode === "manual" && zoomValue <= MIN_SCALE)
              }
              onClick={() =>
                updateCfg({
                  zoomMode: "manual",
                  zoomValue: clampScale(effectiveScale - ZOOM_STEP),
                })
              }
            >
              <Icons.zoomOut size={14} />
              <span>{t("pdfCitationPreviewWindow.toolbar.zoomOut")}</span>
            </button>
            <button
              type="button"
              className="pdfv-btn tm-action"
              disabled={
                !scalarIntentControlsEnabled || (zoomMode === "manual" && zoomValue >= MAX_SCALE)
              }
              onClick={() =>
                updateCfg({
                  zoomMode: "manual",
                  zoomValue: clampScale(effectiveScale + ZOOM_STEP),
                })
              }
            >
              <Icons.zoomIn size={14} />
              <span>{t("pdfCitationPreviewWindow.toolbar.zoomIn")}</span>
            </button>
            <button
              type="button"
              className="pdfv-btn tm-action"
              disabled={!scalarIntentControlsEnabled}
              data-selected={zoomMode === "fit-width" ? "true" : "false"}
              onClick={() => updateCfg({ zoomMode: "fit-width" })}
            >
              <span>{t("pdfCitationPreviewWindow.toolbar.fitWidth")}</span>
            </button>
            <button
              type="button"
              className="pdfv-btn tm-action"
              disabled={!scalarIntentControlsEnabled}
              data-selected={zoomMode === "fit-page" ? "true" : "false"}
              onClick={() => updateCfg({ zoomMode: "fit-page" })}
            >
              <span>{t("pdfCitationPreviewWindow.toolbar.fitPage")}</span>
            </button>
            <button
              type="button"
              className="pdfv-btn tm-action"
              disabled={!scalarIntentControlsEnabled}
              onClick={() => updateCfg({ rotation: normalizeRotation(rotation - 90) })}
            >
              <span>{t("pdfCitationPreviewWindow.toolbar.rotateLeft")}</span>
            </button>
            <button
              type="button"
              className="pdfv-btn tm-action"
              disabled={!scalarIntentControlsEnabled}
              onClick={() => updateCfg({ rotation: normalizeRotation(rotation + 90) })}
            >
              <span>{t("pdfCitationPreviewWindow.toolbar.rotateRight")}</span>
            </button>
            <span className="pdfv-zoom mono">{String(Math.round(effectiveScale * 100))}%</span>
          </div>
        </fieldset>
      ) : null}

      {failure !== null ? (
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
                  void reopenPreview(failure);
                  return;
                }
                setRetryToken((value) => value + 1);
              }}
            >
              {reopening ? t("pdfCitationPreviewWindow.action.openingPreview") : failureActionLabel}
            </button>
          ) : null}
        </div>
      ) : doc === null ? (
        <div className="lk-loading pdfv-status" role="status" aria-live="polite">
          {showSlowLoad
            ? t("pdfCitationPreviewWindow.loading.rendering")
            : t("pdfCitationPreviewWindow.loading.opening")}
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
          {pageWindow.pages.map((pageNumber) => {
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
          })}
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
