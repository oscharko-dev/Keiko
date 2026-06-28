"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { PDFDocumentProxy as PdfJsDocumentProxy } from "pdfjs-dist";
import { ApiError, fetchPdfCitationPreviewDocument } from "@/lib/api";
import { Icons } from "../../Icons";
import type { WorkspaceApi } from "../../hooks/useWorkspace.types";
import type { AppWindow } from "../../windows/types";
import {
  activatePdfCitationPreviewBackToChat,
  activatePdfCitationPreviewContext,
  getPdfCitationPreviewBackToChatAvailability,
  getPdfCitationPreviewSession,
  subscribePdfCitationPreviewRegistry,
  type PdfCitationPreviewSafeWindowCfg,
  type PdfCitationPreviewZoomMode,
} from "./pdf-citation-preview-session";

const MAX_SCALE = 2;
const MIN_SCALE = 0.5;
const PAGE_FRAME_PX = 32;
const RENDER_RADIUS = 1;
const SLOW_LOAD_MS = 900;
const ZOOM_STEP = 0.1;

interface PageSize {
  readonly height: number;
  readonly width: number;
}

interface PreviewFailure {
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

function anchorQualityDescription(value: PdfCitationPreviewSafeWindowCfg["anchorQuality"]): string {
  switch (value) {
    case "approximate":
      return "Keiko opened the verified source page near the cited passage. Exact PDF highlights are not part of this viewer.";
    case "unavailable":
      return "Keiko verified this PDF source, but no trustworthy page anchor is available for this citation. The viewer stays on its current page.";
    default:
      return "Keiko opened the verified source page for this citation. No passage-level highlight is available in this viewer.";
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

function previewFailure(error: unknown): PreviewFailure {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "PREVIEW_SESSION_NOT_FOUND":
      case "PREVIEW_SESSION_CLOSED":
      case "PREVIEW_SESSION_EXPIRED":
        return {
          title: "Preview unavailable",
          message:
            "This verified preview session is no longer available. Reopen the citation to create a new preview.",
          retryable: false,
        };
      case "PREVIEW_SOURCE_NOT_READY":
        return {
          title: "Preview not ready",
          message:
            "Keiko is still verifying the PDF source for passive preview. Retry in a moment.",
          retryable: true,
        };
      case "PREVIEW_SOURCE_UNREADABLE":
        return {
          title: "Preview temporarily unavailable",
          message:
            "Keiko could not read the verified PDF safely. Retry to request the preview again.",
          retryable: true,
        };
      case "PREVIEW_SOURCE_CHANGED":
        return {
          title: "Preview changed",
          message: "The verified PDF bytes no longer match the citation that opened this preview.",
          retryable: false,
        };
      case "PREVIEW_SOURCE_MISSING":
        return {
          title: "Preview source unavailable",
          message: "The verified PDF source is no longer available for passive preview.",
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

  return {
    title: "Preview failed",
    message: "Keiko could not load the verified PDF preview. Retry to request the document again.",
    retryable: true,
  };
}

function restoredShellFailure(failureOverride: PreviewFailure | null): PreviewFailure {
  if (failureOverride !== null) {
    return {
      title: failureOverride.title,
      message: `${failureOverride.message} Reopen the citation from the answer to re-verify before Keiko renders PDF bytes.`,
      retryable: false,
    };
  }
  return {
    title: "Preview requires re-verification",
    message:
      "This viewer was restored without an active verified preview session. Reopen the citation from the answer to re-verify the source before Keiko renders PDF bytes.",
    retryable: false,
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
  readonly onError: (error: unknown) => void;
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
        onError(error);
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
  const sessionEntry = useSyncExternalStore(
    subscribePdfCitationPreviewRegistry,
    () => getPdfCitationPreviewSession(windowId),
    () => getPdfCitationPreviewSession(windowId),
  );
  const backToChatReason = useSyncExternalStore(
    subscribePdfCitationPreviewRegistry,
    () => getPdfCitationPreviewBackToChatAvailability(windowId).reason ?? "",
    () => getPdfCitationPreviewBackToChatAvailability(windowId).reason ?? "",
  );
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [defaultPageSize, setDefaultPageSize] = useState<PageSize | null>(null);
  const [doc, setDoc] = useState<PdfDocumentProxy | null>(null);
  const [failure, setFailure] = useState<PreviewFailure | null>(null);
  const [measuredSizes, setMeasuredSizes] = useState<Record<number, PageSize>>({});
  const [numPages, setNumPages] = useState(0);
  const [pageInput, setPageInput] = useState("1");
  const [retryToken, setRetryToken] = useState(0);
  const [showSlowLoad, setShowSlowLoad] = useState(false);
  const currentPageRef = useRef(1);
  const didInitialScrollRef = useRef(false);
  const backToChatDescriptionId = useId();
  const pageRefs = useRef(new Map<number, HTMLElement>());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const citationContext = sessionEntry?.context;
  const backToChat =
    backToChatReason.length === 0
      ? { enabled: true as const }
      : { enabled: false as const, reason: backToChatReason };
  const activeCitation =
    citationContext?.citations.find(
      (citation) => citation.citation.stableId === citationContext.activeStableId,
    ) ?? citationContext?.citations[0];

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
        "PDF Preview",
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
  const restoredSafeShell = sessionEntry === undefined;
  const scalarIntentControlsEnabled = doc !== null || restoredSafeShell;
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
    if (sessionHandle === undefined) {
      setFailure(restoredShellFailure(failureOverride));
      setDefaultPageSize(null);
      setDoc(null);
      setNumPages(0);
      return;
    }

    let disposed = false;
    let loadingTask: PdfDocumentLoadingTask | null = null;
    const controller = new AbortController();

    setFailure(null);
    setShowSlowLoad(false);
    setMeasuredSizes({});
    setDefaultPageSize(null);
    setDoc(null);
    setNumPages(0);
    didInitialScrollRef.current = false;

    const slowTimer = window.setTimeout(() => setShowSlowLoad(true), SLOW_LOAD_MS);

    void fetchPdfCitationPreviewDocument(sessionHandle, controller.signal)
      .then(async (bytes) => {
        if (disposed) return null;
        const pdfjs = await loadPdfJs();
        if (disposed) return null;
        loadingTask = pdfjs.getDocument({ data: bytes }) as PdfDocumentLoadingTask;
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
        if (disposed || (error instanceof DOMException && error.name === "AbortError")) return;
        setFailure(previewFailure(error));
        setShowSlowLoad(false);
      })
      .finally(() => {
        window.clearTimeout(slowTimer);
      });

    return () => {
      disposed = true;
      controller.abort();
      void loadingTask?.destroy();
      window.clearTimeout(slowTimer);
    };
  }, [failureOverride, retryToken, sessionEntry]);

  useEffect(() => {
    return () => {
      void doc?.destroy?.();
    };
  }, [doc]);

  useEffect(() => {
    if (doc === null || numPages === 0 || didInitialScrollRef.current) return;
    didInitialScrollRef.current = true;
    requestAnimationFrame(() => {
      pageRefs.current.get(currentPage)?.scrollIntoView({ block: "start" });
    });
  }, [currentPage, doc, numPages]);

  useEffect(() => {
    if (doc === null || numPages === 0) return;
    requestAnimationFrame(() => {
      pageRefs.current.get(currentPageRef.current)?.scrollIntoView({ block: "start" });
    });
  }, [doc, effectiveScale, numPages, rotation]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null || numPages === 0) return;

    let frame = 0;
    const syncPage = (): void => {
      frame = 0;
      const rootRect = scroller.getBoundingClientRect();
      let bestPage = currentPage;
      let bestDistance = Number.POSITIVE_INFINITY;

      for (const [page, element] of pageRefs.current) {
        const rect = element.getBoundingClientRect();
        const distance = Math.abs(rect.top - rootRect.top - rootRect.height * 0.2);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestPage = page;
        }
      }

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
  }, [currentPage, numPages, updateCfg]);

  const pageNumbers = useMemo(
    () => Array.from({ length: numPages }, (_, index) => index + 1),
    [numPages],
  );

  const goToPage = (page: number): void => {
    const next = clampPage(page, numPages);
    updateCfg({ currentPage: next });
    pageRefs.current.get(next)?.scrollIntoView({ block: "start" });
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
        pageRefs.current
          .get(nextCitation.display.pageNumber ?? currentPageRef.current)
          ?.scrollIntoView({
            block: "start",
          });
      });
    }
  };

  return (
    <div className="pdfv-shell">
      <div className="pdfv-header">
        <div className="pdfv-heading">
          <p className="pdfv-eyebrow">Verified preview</p>
          <h2 className="pdfv-title">{display.documentLabel}</h2>
          <p className="pdfv-meta">
            {display.sourceLabel ?? "Local Knowledge PDF"}
            {display.pageLabel === undefined
              ? display.pageNumber === undefined
                ? ""
                : ` · Page ${String(display.pageNumber)}`
              : ` · ${display.pageLabel}`}
          </p>
        </div>
        <span className="pdfv-chip">{anchorQualityLabel(display.anchorQuality)}</span>
      </div>

      {activeCitation !== undefined ? (
        <section className="pdfv-context" aria-label="Citation context">
          <div className="pdfv-context-head">
            <div className="pdfv-context-copy">
              <p className="pdfv-context-eyebrow">Answer-local citation context</p>
              <h3 className="pdfv-context-title">
                {citationContextLabel({
                  label: activeCitation.citation.label,
                  marker: activeCitation.citation.marker,
                  source: activeCitation.citation.source,
                })}
              </h3>
              <p className="pdfv-context-message">
                {anchorQualityDescription(activeCitation.display.anchorQuality)}
              </p>
            </div>
            <div className="pdfv-context-actions">
              <button
                type="button"
                className="tm-action pdfv-back-to-chat"
                aria-describedby={
                  backToChat.reason === undefined ? undefined : backToChatDescriptionId
                }
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
          {citationContext !== undefined && citationContext.citations.length > 1 ? (
            <div className="pdfv-context-rail">
              <span className="grounded-citations-label">Same answer citations</span>
              <ul
                className="grounded-citations pdfv-context-list"
                aria-label="Same answer citations"
              >
                {citationContext.citations.map((citation) => {
                  const active = citation.citation.stableId === citationContext.activeStableId;
                  return (
                    <li key={citation.citation.stableId} className="grounded-citations-item">
                      <button
                        type="button"
                        className="grounded-citation grounded-citation-action pdfv-context-citation"
                        aria-pressed={active}
                        data-active={active ? "true" : "false"}
                        onClick={() => {
                          if (active) return;
                          activateContextCitation(citation.citation.stableId);
                        }}
                      >
                        <span className="grounded-citation-range">
                          {citationContextLabel({
                            label: citation.citation.label,
                            marker: citation.citation.marker,
                            source: citation.citation.source,
                          })}
                        </span>
                        <span className="grounded-citation-action-label">
                          {active ? "Active" : citationContextPageLabel(citation.display)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      <div className="pdfv-toolbar" role="group" aria-label="PDF preview controls">
        <div className="pdfv-group">
          <button
            type="button"
            className="pdfv-btn tm-action"
            disabled={doc === null || currentPage <= 1}
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
              disabled={doc === null}
              onChange={(event) => setPageInput(event.target.value)}
              onBlur={() => {
                const parsed = Number.parseInt(pageInput, 10);
                if (Number.isInteger(parsed)) {
                  goToPage(parsed);
                  return;
                }
                setPageInput(String(currentPage));
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                const parsed = Number.parseInt(pageInput, 10);
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
            disabled={doc === null || currentPage >= numPages}
            onClick={() => goToPage(currentPage + 1)}
          >
            <span>Next</span>
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
            <span>Zoom out</span>
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
            <span>Zoom in</span>
          </button>
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
        </div>
      </div>

      {failure !== null ? (
        <div className="lk-empty pdfv-status" role="alert">
          <div className="lk-empty-icon">
            <Icons.info size={20} />
          </div>
          <p className="lk-empty-title">{failure.title}</p>
          <p className="lk-empty-body">{failure.message}</p>
          {failure.retryable ? (
            <button
              type="button"
              className="tm-action pdfv-retry"
              onClick={() => setRetryToken((value) => value + 1)}
            >
              Retry preview
            </button>
          ) : null}
        </div>
      ) : doc === null ? (
        <div className="lk-loading pdfv-status" role="status" aria-live="polite">
          {showSlowLoad ? "Rendering verified PDF preview..." : "Opening verified PDF preview..."}
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="pdfv-scroll"
          role="region"
          aria-label={`${display.documentLabel} PDF preview`}
        >
          {pageNumbers.map((pageNumber) => {
            const pageSize = rotatedSize(
              measuredSizes[pageNumber] ?? defaultPageSize ?? { width: 612, height: 792 },
              rotation,
            );
            const minHeight = Math.max(220, Math.round(pageSize.height * effectiveScale));
            const shouldRender = Math.abs(pageNumber - currentPage) <= RENDER_RADIUS;

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
                  <div className="pdfv-page-meta mono">Page {String(pageNumber)}</div>
                  {shouldRender ? (
                    <PdfCanvasPage
                      active
                      onError={(error) => setFailure(previewFailure(error))}
                      onMeasured={(page, size) => {
                        setMeasuredSizes((previous) =>
                          previous[page]?.width === size.width &&
                          previous[page]?.height === size.height
                            ? previous
                            : { ...previous, [page]: size },
                        );
                      }}
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
        </div>
      )}
    </div>
  );
}
