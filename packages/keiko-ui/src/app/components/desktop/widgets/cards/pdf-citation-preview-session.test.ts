import { afterEach, describe, expect, it, vi } from "vitest";
import { closePdfCitationPreviewSession } from "@/lib/api";
import {
  clearPdfCitationPreviewWindowRegistryForTests,
  getPdfCitationPreviewSession,
  openPdfCitationPreviewWindow,
  syncPdfCitationPreviewWindowRegistry,
} from "./pdf-citation-preview-session";

vi.mock("@/lib/api", () => ({
  closePdfCitationPreviewSession: vi.fn().mockResolvedValue({ ok: true }),
}));

const PREVIEW = {
  outcome: "authorized" as const,
  display: {
    documentLabel: "Policy wording.pdf",
    sourceLabel: "Local capsule",
    pageNumber: 7,
    pageLabel: "Page 7",
    anchorQuality: "page-only" as const,
  },
  session: {
    handle: "preview-session-1",
    expiresAt: "2026-06-28T12:00:00.000Z",
    reused: false,
    byteLength: 4096,
    contentType: "application/pdf" as const,
  },
};

describe("pdf-citation-preview-session", () => {
  afterEach(() => {
    clearPdfCitationPreviewWindowRegistryForTests();
    vi.clearAllMocks();
  });

  it("opens a PDF preview window with safe cfg only and stores the opaque session in memory", () => {
    const add = vi.fn(() => "pdf-preview-1");

    const windowId = openPdfCitationPreviewWindow(add, PREVIEW);

    expect(windowId).toBe("pdf-preview-1");
    expect(add).toHaveBeenCalledWith("pdfCitationPreview", {
      documentLabel: "Policy wording.pdf",
      sourceLabel: "Local capsule",
      pageNumber: 7,
      pageLabel: "Page 7",
      anchorQuality: "page-only",
      currentPage: 7,
      zoomMode: "fit-width",
      zoomValue: 1,
      rotation: 0,
    });
    expect(getPdfCitationPreviewSession("pdf-preview-1")).toEqual({
      display: PREVIEW.display,
      session: PREVIEW.session,
    });
  });

  it("closes orphaned preview sessions when the window leaves the workspace", () => {
    const add = vi.fn(() => "pdf-preview-1");
    openPdfCitationPreviewWindow(add, PREVIEW);

    syncPdfCitationPreviewWindowRegistry([
      {
        id: "pdf-preview-1",
        type: "pdfCitationPreview",
        x: 0,
        y: 0,
        w: 400,
        h: 300,
        z: 1,
        cfg: {},
        max: false,
        zoom: 1,
      },
    ]);
    expect(closePdfCitationPreviewSession).not.toHaveBeenCalled();

    syncPdfCitationPreviewWindowRegistry([]);

    expect(closePdfCitationPreviewSession).toHaveBeenCalledWith("preview-session-1");
    expect(getPdfCitationPreviewSession("pdf-preview-1")).toBeUndefined();
  });
});
