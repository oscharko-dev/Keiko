"use client";

import type {
  PdfCitationPreviewOpenResponse,
  PdfCitationPreviewAnchorQuality,
  PdfCitationPreviewDisplay,
  PdfCitationPreviewOpenAuthorized,
  PdfCitationPreviewReasonCode,
} from "@oscharko-dev/keiko-contracts";
import { closePdfCitationPreviewSession } from "@/lib/api";
import type { WorkspaceApi } from "../../hooks/useWorkspace.types";
import type { AppWindow, WindowCfgValue } from "../../windows/types";

export type PdfCitationPreviewZoomMode = "fit-width" | "fit-page" | "manual";

export interface PdfCitationPreviewSafeWindowCfg {
  readonly [key: string]: WindowCfgValue;
  readonly anchorQuality: PdfCitationPreviewAnchorQuality;
  readonly currentPage: number;
  readonly documentLabel: string;
  readonly failureMessage?: string;
  readonly failureRetryable?: boolean;
  readonly failureTitle?: string;
  readonly pageLabel?: string;
  readonly pageNumber?: number;
  readonly rotation: number;
  readonly sourceLabel?: string;
  readonly zoomMode: PdfCitationPreviewZoomMode;
  readonly zoomValue: number;
}

interface PdfCitationPreviewSessionEntry {
  readonly display: PdfCitationPreviewDisplay;
  readonly session: PdfCitationPreviewOpenAuthorized["session"];
}

const DEFAULT_ZOOM_MODE: PdfCitationPreviewZoomMode = "fit-width";
const DEFAULT_ZOOM_VALUE = 1;
const previewSessionsByWindowId = new Map<string, PdfCitationPreviewSessionEntry>();

function safePageNumber(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 1;
}

function baseSafeWindowCfg(
  display: PdfCitationPreviewDisplay,
  initialPage: number | undefined,
): PdfCitationPreviewSafeWindowCfg {
  return {
    documentLabel: display.documentLabel,
    ...(display.sourceLabel === undefined ? {} : { sourceLabel: display.sourceLabel }),
    ...(display.pageNumber === undefined ? {} : { pageNumber: display.pageNumber }),
    ...(display.pageLabel === undefined ? {} : { pageLabel: display.pageLabel }),
    anchorQuality: display.anchorQuality,
    currentPage: safePageNumber(initialPage ?? display.pageNumber),
    zoomMode: DEFAULT_ZOOM_MODE,
    zoomValue: DEFAULT_ZOOM_VALUE,
    rotation: 0,
  };
}

function activeFailureCopy(reason: PdfCitationPreviewReasonCode): {
  readonly message: string;
  readonly retryable: boolean;
  readonly title: string;
} {
  switch (reason) {
    case "preview-metadata-missing":
      return {
        title: "Preview recovery required",
        message:
          "Keiko can no longer verify this citation for immediate PDF preview. Reopen the answer after the preview metadata is refreshed.",
        retryable: true,
      };
    case "document-not-ready":
      return {
        title: "Preview not ready",
        message: "Keiko is still preparing the verified PDF source for preview. Retry in a moment.",
        retryable: true,
      };
    case "document-content-mismatch":
      return {
        title: "Preview changed",
        message: "The verified PDF bytes changed after this answer was generated. Retry to request a fresh preview.",
        retryable: true,
      };
    case "page-provenance-missing":
      return {
        title: "Preview recovery required",
        message: "Keiko can verify the PDF source, but the cited page anchor is no longer available for preview.",
        retryable: true,
      };
    case "preview-source-missing":
      return {
        title: "Preview source unavailable",
        message: "The verified PDF source is no longer available for preview.",
        retryable: true,
      };
    case "preview-source-unreadable":
      return {
        title: "Preview temporarily unavailable",
        message: "Keiko could not read the verified PDF safely. Retry to request the preview again.",
        retryable: true,
      };
    case "preview-source-oversized":
      return {
        title: "Preview too large",
        message: "The verified PDF exceeds the passive preview size limit for this viewer.",
        retryable: true,
      };
    case "stable-id-mismatch":
    case "citation-not-found":
      return {
        title: "Preview unavailable",
        message: "This citation no longer matches the structured grounded-answer metadata for this response.",
        retryable: false,
      };
    case "assistant-message-not-found":
    case "assistant-message-chat-mismatch":
    case "grounded-answer-missing":
    case "not-local-knowledge-citation":
      return {
        title: "Preview unavailable",
        message: "This answer no longer carries a verified Local Knowledge PDF preview for the selected citation.",
        retryable: false,
      };
    case "lineage-missing":
      return {
        title: "Preview unavailable",
        message: "Keiko can no longer trace this citation to a verified PDF source.",
        retryable: false,
      };
    case "lineage-mismatch":
      return {
        title: "Preview unavailable",
        message: "The citation lineage no longer matches the verified PDF source for this answer.",
        retryable: false,
      };
    case "document-not-pdf":
      return {
        title: "Preview unavailable",
        message: "The verified citation source is no longer a PDF.",
        retryable: false,
      };
    default:
      return {
        title: "Preview unavailable",
        message: "Keiko could not open the verified PDF preview for this citation.",
        retryable: false,
      };
  }
}

function failureSafeWindowCfg(
  response: Extract<PdfCitationPreviewOpenResponse, { readonly outcome: "rejected" }>,
  initialPage: number | undefined,
): PdfCitationPreviewSafeWindowCfg {
  const copy = activeFailureCopy(response.reason);
  const display =
    response.display ??
    ({
      anchorQuality: "page-only",
      documentLabel: "PDF Preview",
    } satisfies PdfCitationPreviewDisplay);
  return {
    ...baseSafeWindowCfg(display, initialPage),
    failureTitle: copy.title,
    failureMessage: copy.message,
    failureRetryable: copy.retryable,
  };
}

function windowIdForSessionHandle(sessionHandle: string): string | undefined {
  for (const [windowId, entry] of previewSessionsByWindowId) {
    if (entry.session.handle === sessionHandle) {
      return windowId;
    }
  }
  return undefined;
}

export function openPdfCitationPreviewWindow(
  openWindow: WorkspaceApi["add"],
  preview: PdfCitationPreviewOpenAuthorized,
  options?: { readonly currentPage?: number | undefined },
): string | null {
  const windowId = openWindow(
    "pdfCitationPreview",
    baseSafeWindowCfg(preview.display, options?.currentPage),
  );
  if (windowId !== null) {
    previewSessionsByWindowId.set(windowId, {
      display: preview.display,
      session: preview.session,
    });
  }
  return windowId;
}

export function getPdfCitationPreviewSession(
  windowId: string,
): PdfCitationPreviewSessionEntry | undefined {
  return previewSessionsByWindowId.get(windowId);
}

export function showPdfCitationPreviewResult(
  windows: Pick<WorkspaceApi, "add" | "focus" | "update">,
  preview: PdfCitationPreviewOpenResponse,
  options?: { readonly currentPage?: number | undefined },
): string | null {
  if (preview.outcome === "authorized") {
    const existingWindowId = windowIdForSessionHandle(preview.session.handle);
    if (existingWindowId !== undefined) {
      previewSessionsByWindowId.set(existingWindowId, {
        display: preview.display,
        session: preview.session,
      });
      windows.update(existingWindowId, {
        cfg: baseSafeWindowCfg(preview.display, options?.currentPage),
      });
      windows.focus(existingWindowId);
      return existingWindowId;
    }
    return openPdfCitationPreviewWindow(windows.add, preview, options);
  }
  return windows.add("pdfCitationPreview", failureSafeWindowCfg(preview, options?.currentPage));
}

export function syncPdfCitationPreviewWindowRegistry(wins: readonly AppWindow[] | null): void {
  const activeWindowIds = new Set(
    (wins ?? [])
      .filter((win) => win.type === "pdfCitationPreview")
      .map((win) => win.id),
  );
  for (const [windowId, entry] of previewSessionsByWindowId) {
    if (activeWindowIds.has(windowId)) continue;
    previewSessionsByWindowId.delete(windowId);
    void closePdfCitationPreviewSession(entry.session.handle).catch(() => {
      // Closing a missing/expired preview is best-effort only; the server TTL is the fail-safe.
    });
  }
}

export function clearPdfCitationPreviewWindowRegistryForTests(): void {
  previewSessionsByWindowId.clear();
}
