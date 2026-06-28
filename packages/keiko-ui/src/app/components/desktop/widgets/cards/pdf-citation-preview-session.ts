"use client";

import type {
  PdfCitationPreviewAnchorQuality,
  PdfCitationPreviewDisplay,
  PdfCitationPreviewOpenAuthorized,
} from "@oscharko-dev/keiko-contracts";
import { closePdfCitationPreviewSession } from "@/lib/api";
import type { WorkspaceApi } from "../../hooks/useWorkspace.types";
import type { AppWindow } from "../../windows/types";

export type PdfCitationPreviewZoomMode = "fit-width" | "fit-page" | "manual";

export interface PdfCitationPreviewSafeWindowCfg {
  readonly anchorQuality: PdfCitationPreviewAnchorQuality;
  readonly currentPage: number;
  readonly documentLabel: string;
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
