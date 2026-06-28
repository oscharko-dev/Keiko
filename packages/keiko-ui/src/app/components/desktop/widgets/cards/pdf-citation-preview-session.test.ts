import { afterEach, describe, expect, it, vi } from "vitest";
import { closePdfCitationPreviewSession } from "@/lib/api";
import type { WorkspaceApi } from "../../hooks/useWorkspace.types";
import {
  clearPdfCitationPreviewWindowRegistryForTests,
  getPdfCitationPreviewSession,
  openPdfCitationPreviewWindow,
  showPdfCitationPreviewResult,
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

  it("reuses and focuses the existing viewer for the same verified PDF session", () => {
    const windows = {
      add: vi.fn<WorkspaceApi["add"]>(() => "pdf-preview-1"),
      focus: vi.fn<WorkspaceApi["focus"]>(),
      update: vi.fn<WorkspaceApi["update"]>(),
    };

    const firstWindowId = showPdfCitationPreviewResult(windows, PREVIEW);
    const reusedWindowId = showPdfCitationPreviewResult(
      windows,
      {
        ...PREVIEW,
        display: {
          ...PREVIEW.display,
          pageNumber: 8,
          pageLabel: "Page 8",
        },
        session: {
          ...PREVIEW.session,
          reused: true,
        },
      },
      { currentPage: 8 },
    );

    expect(firstWindowId).toBe("pdf-preview-1");
    expect(reusedWindowId).toBe("pdf-preview-1");
    expect(windows.add).toHaveBeenCalledTimes(1);
    expect(windows.update).toHaveBeenCalledWith("pdf-preview-1", {
      cfg: expect.objectContaining({
        documentLabel: "Policy wording.pdf",
        currentPage: 8,
        pageNumber: 8,
      }),
    });
    expect(windows.focus).toHaveBeenCalledWith("pdf-preview-1");
  });

  it("opens a safe recovery shell when active authorization rejects recoverably", () => {
    const windows = {
      add: vi.fn<WorkspaceApi["add"]>(() => "pdf-preview-recovery"),
      focus: vi.fn<WorkspaceApi["focus"]>(),
      update: vi.fn<WorkspaceApi["update"]>(),
    };

    const windowId = showPdfCitationPreviewResult(windows, {
      outcome: "rejected",
      state: "recoverable",
      reason: "document-content-mismatch",
      display: PREVIEW.display,
    });

    expect(windowId).toBe("pdf-preview-recovery");
    expect(windows.add).toHaveBeenCalledWith(
      "pdfCitationPreview",
      expect.objectContaining({
        documentLabel: "Policy wording.pdf",
        failureTitle: "Preview changed",
        failureRetryable: true,
      }),
    );
    expect(windows.focus).not.toHaveBeenCalled();
  });
});
