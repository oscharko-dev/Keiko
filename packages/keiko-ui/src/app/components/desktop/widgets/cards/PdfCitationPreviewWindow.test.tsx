import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPdfCitationPreviewDocument } from "@/lib/api";
import {
  clearPdfCitationPreviewWindowRegistryForTests,
  openPdfCitationPreviewWindow,
} from "./pdf-citation-preview-session";
import { PdfCitationPreviewWindow } from "./PdfCitationPreviewWindow";

const renderTask = {
  promise: Promise.resolve(),
  cancel: vi.fn(),
};

const page = {
  getViewport: vi.fn(({ scale }: { scale: number }) => ({
    width: 612 * scale,
    height: 792 * scale,
  })),
  render: vi.fn(() => renderTask),
};

const pdfDocument = {
  numPages: 3,
  getPage: vi.fn(async () => page),
  destroy: vi.fn(async () => {}),
};

const loadingTask = {
  promise: Promise.resolve(pdfDocument),
  destroy: vi.fn(async () => {}),
};

vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly status: number,
    ) {
      super(message);
      this.name = "ApiError";
    }
  },
  closePdfCitationPreviewSession: vi.fn().mockResolvedValue({ ok: true }),
  fetchPdfCitationPreviewDocument: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4])),
}));

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: vi.fn(() => loadingTask),
}));

const PREVIEW = {
  outcome: "authorized" as const,
  display: {
    documentLabel: "Policy wording.pdf",
    sourceLabel: "Local capsule",
    pageNumber: 2,
    pageLabel: "Page 2",
    anchorQuality: "approximate" as const,
  },
  session: {
    handle: "preview-session-1",
    expiresAt: "2026-06-28T12:00:00.000Z",
    reused: false,
    byteLength: 4096,
    contentType: "application/pdf" as const,
  },
};

describe("PdfCitationPreviewWindow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    page.getViewport.mockImplementation(({ scale }: { scale: number }) => ({
      width: 612 * scale,
      height: 792 * scale,
    }));
    page.render.mockReturnValue(renderTask);
    pdfDocument.getPage.mockResolvedValue(page);
    vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({} as CanvasRenderingContext2D);
    vi
      .spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    clearPdfCitationPreviewWindowRegistryForTests();
    vi.restoreAllMocks();
  });

  it("fails closed when no verified preview session is registered", async () => {
    render(
      <PdfCitationPreviewWindow
        cfg={{ documentLabel: "Policy wording.pdf" }}
        updateCfg={vi.fn()}
        windowId="missing-preview-window"
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /open this viewer from a verified citation preview session/i,
    );
    expect(fetchPdfCitationPreviewDocument).not.toHaveBeenCalled();
  });

  it("loads the verified PDF bytes, renders controls, supports page and zoom actions, and stays axe-clean", async () => {
    const add = vi.fn<Parameters<typeof openPdfCitationPreviewWindow>[0]>(() => "pdf-preview-1");
    const windowId = openPdfCitationPreviewWindow(add, PREVIEW);
    const firstCall = add.mock.calls[0];
    if (firstCall === undefined) throw new Error("expected preview window to open");
    const cfg = firstCall[1] as Record<string, unknown>;
    const updateCfg = vi.fn();

    const { container } = render(
      <PdfCitationPreviewWindow cfg={cfg} updateCfg={updateCfg} windowId={windowId ?? "missing"} />,
    );

    await waitFor(() => {
      expect(fetchPdfCitationPreviewDocument).toHaveBeenCalledWith(
        "preview-session-1",
        expect.any(AbortSignal),
      );
    });
    expect(await screen.findByText("Approximate anchor")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /previous/i })).not.toHaveAttribute("disabled");
    expect(screen.getByDisplayValue("2")).toBeInTheDocument();
    expect(screen.getByText("/ 3")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(updateCfg).toHaveBeenCalledWith({ currentPage: 3 });

    await userEvent.click(screen.getByRole("button", { name: /zoom in/i }));
    expect(updateCfg).toHaveBeenCalledWith({ zoomMode: "manual", zoomValue: 1.1 });

    await userEvent.click(screen.getByRole("button", { name: /fit page/i }));
    expect(updateCfg).toHaveBeenCalledWith({ zoomMode: "fit-page" });

    await userEvent.click(screen.getByRole("button", { name: /rotate right/i }));
    expect(updateCfg).toHaveBeenCalledWith({ rotation: 90 });

    const pageInput = screen.getByDisplayValue("2");
    await userEvent.clear(pageInput);
    await userEvent.type(pageInput, "1{enter}");
    expect(updateCfg).toHaveBeenCalledWith({ currentPage: 1 });

    expect(await axe(container)).toHaveNoViolations();
  });
});
