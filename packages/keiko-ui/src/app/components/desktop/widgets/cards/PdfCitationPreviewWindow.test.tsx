import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pdfCitationPreviewDocumentUrl } from "@/lib/api";
import { getDocument } from "pdfjs-dist";
import {
  getPdfCitationPreviewBackToChatAvailability,
  clearPdfCitationPreviewWindowRegistryForTests,
  openPdfCitationPreviewWindow,
  registerPdfCitationPreviewMessageTarget,
  syncPdfCitationPreviewWindowRegistry,
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
  pdfCitationPreviewDocumentUrl: vi.fn(
    (sessionHandle: string) =>
      `/api/local-knowledge/citation-preview/sessions/${encodeURIComponent(sessionHandle)}/document`,
  ),
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
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      {} as CanvasRenderingContext2D,
    );
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => undefined);
  });

  afterEach(() => {
    clearPdfCitationPreviewWindowRegistryForTests();
    vi.restoreAllMocks();
  });

  it("fails closed when no verified preview session is registered", async () => {
    render(
      <PdfCitationPreviewWindow
        cfg={{ documentLabel: "Policy wording.pdf" }}
        focusWindow={vi.fn()}
        restoreWindow={vi.fn()}
        updateCfg={vi.fn()}
        windowId="missing-preview-window"
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /restored without an active verified preview session/i,
    );
    expect(pdfCitationPreviewDocumentUrl).not.toHaveBeenCalled();
  });

  it("restores a safe shell without rendering bytes and allows only scalar intent controls", async () => {
    const updateCfg = vi.fn();
    render(
      <PdfCitationPreviewWindow
        cfg={{
          documentLabel: "Policy wording.pdf",
          currentPage: 7,
          pageNumber: 7,
          anchorQuality: "page-only",
          zoomMode: "manual",
          zoomValue: 1.2,
          rotation: 90,
        }}
        focusWindow={vi.fn()}
        restoreWindow={vi.fn()}
        updateCfg={updateCfg}
        windowId="restored-preview-window"
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(/requires re-verification/i);
    expect(pdfCitationPreviewDocumentUrl).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /previous/i })).toBeDisabled();
    expect(screen.getByLabelText(/current page/i)).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: /zoom in/i }));
    expect(updateCfg).toHaveBeenCalledWith({ zoomMode: "manual", zoomValue: 1.3 });

    await userEvent.click(screen.getByRole("button", { name: /fit page/i }));
    expect(updateCfg).toHaveBeenCalledWith({ zoomMode: "fit-page" });

    await userEvent.click(screen.getByRole("button", { name: /rotate right/i }));
    expect(updateCfg).toHaveBeenCalledWith({ rotation: 180 });
  });

  it("allows retry when a live verified session document fetch fails transiently", async () => {
    vi.mocked(getDocument).mockReturnValueOnce({
      promise: Promise.reject(new Error("source unreadable")),
      destroy: vi.fn(async () => {}),
    } as never);
    const add = vi.fn<Parameters<typeof openPdfCitationPreviewWindow>[0]>(() => "pdf-preview-1");
    const windowId = openPdfCitationPreviewWindow(add, PREVIEW);
    const firstCall = add.mock.calls[0];
    if (firstCall === undefined) throw new Error("expected preview window to open");
    const cfg = firstCall[1] as Record<string, unknown>;

    render(
      <PdfCitationPreviewWindow
        cfg={cfg}
        focusWindow={vi.fn()}
        restoreWindow={vi.fn()}
        updateCfg={vi.fn()}
        windowId={windowId ?? "missing"}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /could not load the verified PDF preview/i,
    );
    await userEvent.click(screen.getByRole("button", { name: /retry preview/i }));

    await waitFor(() => {
      expect(getDocument).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByText("Near cited passage")).toBeInTheDocument();
  });

  it("loads the verified PDF bytes, renders controls, supports page and zoom actions, and stays axe-clean", async () => {
    const add = vi.fn<Parameters<typeof openPdfCitationPreviewWindow>[0]>(() => "pdf-preview-1");
    const windowId = openPdfCitationPreviewWindow(add, PREVIEW, {
      context: {
        activeStableId: "stable-1",
        citations: [
          {
            citation: { stableId: "stable-1", marker: "[1]", label: "Policy wording.pdf" },
            display: PREVIEW.display,
          },
          {
            citation: { stableId: "stable-2", marker: "[2]", label: "Policy wording.pdf" },
            display: {
              ...PREVIEW.display,
              pageNumber: 3,
              pageLabel: "Page 3",
              anchorQuality: "page-only",
            },
          },
        ],
        origin: {
          assistantMessageId: "msg-a",
          chatId: "chat-1",
          chatWindowId: "chat-window-1",
          marker: "[1]",
          representation: "inline-marker",
        },
      },
    });
    syncPdfCitationPreviewWindowRegistry([
      {
        id: windowId ?? "pdf-preview-1",
        type: "pdfCitationPreview",
        x: 0,
        y: 0,
        w: 640,
        h: 520,
        z: 2,
        cfg: {},
        max: false,
      },
      {
        id: "chat-window-1",
        type: "chat",
        x: 0,
        y: 0,
        w: 420,
        h: 360,
        z: 1,
        cfg: { chatId: "chat-1" },
        max: false,
      },
    ]);
    const firstCall = add.mock.calls[0];
    if (firstCall === undefined) throw new Error("expected preview window to open");
    const cfg = firstCall[1] as Record<string, unknown>;
    const updateCfg = vi.fn();
    const focusWindow = vi.fn();
    const restoreWindow = vi.fn();
    const sourceMessage = document.createElement("article");
    const unregisterSourceMessage = registerPdfCitationPreviewMessageTarget({
      assistantMessageId: "msg-a",
      chatId: "chat-1",
      chatWindowId: "chat-window-1",
      element: sourceMessage,
    });

    const { container } = render(
      <PdfCitationPreviewWindow
        cfg={cfg}
        focusWindow={focusWindow}
        restoreWindow={restoreWindow}
        updateCfg={updateCfg}
        windowId={windowId ?? "missing"}
      />,
    );

    await waitFor(() => {
      expect(getDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          disableRange: false,
          disableStream: true,
          rangeChunkSize: 1024 * 1024,
          url: "/api/local-knowledge/citation-preview/sessions/preview-session-1/document",
        }),
      );
    });
    expect(await screen.findByText("Near cited passage")).toBeInTheDocument();
    expect(screen.getByText("Answer-local citation context")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Keiko opened the verified source page near the cited passage\. Exact PDF highlights are not part of this viewer\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /previous/i })).not.toHaveAttribute("disabled");
    expect(screen.getByDisplayValue("2")).toBeInTheDocument();
    expect(screen.getByText("/ 3")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /\[2\] Policy wording\.pdf/i }));
    expect(updateCfg).toHaveBeenCalledWith({
      currentPage: 3,
      documentLabel: "Policy wording.pdf",
      pageLabel: "Page 3",
      pageNumber: 3,
      sourceLabel: "Local capsule",
    });

    await userEvent.click(screen.getByRole("button", { name: /back to chat/i }));
    expect(restoreWindow).toHaveBeenCalledWith("chat-window-1");
    expect(focusWindow).toHaveBeenCalledWith("chat-window-1");
    unregisterSourceMessage();

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

  it("renders Back to chat as an explained disabled action when the source chat is unavailable", async () => {
    const add = vi.fn<Parameters<typeof openPdfCitationPreviewWindow>[0]>(() => "pdf-preview-1");
    const windowId = openPdfCitationPreviewWindow(add, PREVIEW, {
      context: {
        activeStableId: "stable-1",
        citations: [
          {
            citation: { stableId: "stable-1", marker: "[1]", label: "Policy wording.pdf" },
            display: PREVIEW.display,
          },
        ],
        origin: {
          assistantMessageId: "msg-a",
          chatId: "chat-1",
          chatWindowId: "missing-chat-window",
          marker: "[1]",
          representation: "citation-chip",
        },
      },
    });
    const firstCall = add.mock.calls[0];
    if (firstCall === undefined) throw new Error("expected preview window to open");
    const cfg = firstCall[1] as Record<string, unknown>;

    render(
      <PdfCitationPreviewWindow
        cfg={cfg}
        focusWindow={vi.fn()}
        restoreWindow={vi.fn()}
        updateCfg={vi.fn()}
        windowId={windowId ?? "missing"}
      />,
    );

    const button = await screen.findByRole("button", { name: /back to chat/i });
    expect(getPdfCitationPreviewBackToChatAvailability(windowId ?? "missing")).toEqual({
      enabled: false,
      reason: "The originating chat is no longer available.",
    });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("The originating chat is no longer available.")).toBeInTheDocument();
  });
});
