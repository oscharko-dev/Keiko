import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  fetchPdfCitationPreviewDocument,
  openPdfCitationPreviewSession,
} from "@/lib/api";
import { getDocument } from "pdfjs-dist";
import {
  clearPdfCitationPreviewWindowRegistryForTests,
  getPdfCitationPreviewBackToChatAvailability,
  getPdfCitationPreviewSession,
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
  fetchPdfCitationPreviewDocument: vi.fn(async () => new Uint8Array([37, 80, 68, 70])),
  openPdfCitationPreviewSession: vi.fn(),
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
    pdfDocument.numPages = 3;
    page.getViewport.mockImplementation(({ scale }: { scale: number }) => ({
      width: 612 * scale,
      height: 792 * scale,
    }));
    page.render.mockReturnValue(renderTask);
    pdfDocument.getPage.mockResolvedValue(page);
    vi.mocked(fetchPdfCitationPreviewDocument).mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
    vi.mocked(openPdfCitationPreviewSession).mockResolvedValue({
      ...PREVIEW,
      session: {
        ...PREVIEW.session,
        handle: "preview-session-2",
      },
    });
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
    expect(screen.queryByRole("button", { name: /reopen preview/i })).not.toBeInTheDocument();
    expect(fetchPdfCitationPreviewDocument).not.toHaveBeenCalled();
  });

  it("reopens a restored viewer from persisted citation context", async () => {
    vi.mocked(openPdfCitationPreviewSession).mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    const context = {
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
        chatWindowId: "chat-window-1",
        marker: "[1]",
        representation: "inline-marker" as const,
      },
    };
    const add = vi.fn<Parameters<typeof openPdfCitationPreviewWindow>[0]>(() => "pdf-preview-1");
    const windowId = openPdfCitationPreviewWindow(add, PREVIEW, { context });
    const firstCall = add.mock.calls[0];
    if (firstCall === undefined) throw new Error("expected preview window to open");
    clearPdfCitationPreviewWindowRegistryForTests();

    render(
      <PdfCitationPreviewWindow
        cfg={firstCall[1] as Record<string, unknown>}
        focusWindow={vi.fn()}
        restoreWindow={vi.fn()}
        updateCfg={vi.fn()}
        windowId={windowId ?? "missing"}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(/requires re-verification/i);
    fireEvent.click(screen.getByRole("button", { name: /reopen preview/i }));

    expect(openPdfCitationPreviewSession).toHaveBeenCalledWith({
      chatId: "chat-1",
      assistantMessageId: "msg-a",
      marker: "[1]",
      stableId: "stable-1",
      origin: "inline-marker",
    });
    expect(fetchPdfCitationPreviewDocument).not.toHaveBeenCalled();
  });

  it("restores a safe shell without rendering bytes and exposes no PDF controls", async () => {
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
    expect(fetchPdfCitationPreviewDocument).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: /pdf preview controls/i })).not.toBeInTheDocument();
    expect(updateCfg).not.toHaveBeenCalled();
  });

  it("allows retry when a live verified session document fetch fails transiently", async () => {
    vi.mocked(fetchPdfCitationPreviewDocument).mockRejectedValueOnce(
      new ApiError("PREVIEW_SOURCE_UNREADABLE", "temporary read failure", 503),
    );
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
      /could not read the verified PDF safely/i,
    );
    await userEvent.click(screen.getByRole("button", { name: /retry preview/i }));

    await waitFor(() => {
      expect(fetchPdfCitationPreviewDocument).toHaveBeenCalledTimes(2);
    });
    expect(getDocument).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Near cited passage")).toBeInTheDocument();
  });

  it.each([
    [404, /preview session ended/i, /reopen preview/i],
    [410, /preview session ended/i, /reopen preview/i],
    [409, /preview changed/i, null],
    [413, /preview too large/i, null],
    [416, /preview range failed/i, /reopen preview/i],
    [503, /preview temporarily unavailable/i, /retry preview/i],
  ] as const)(
    "maps pdf.js ResponseException status %i to a concrete failure",
    async (status, title, action) => {
      vi.mocked(getDocument).mockReturnValueOnce({
        promise: Promise.reject({ name: "ResponseException", status }),
        destroy: vi.fn(async () => {}),
      } as never);
      const add = vi.fn<Parameters<typeof openPdfCitationPreviewWindow>[0]>(() => "pdf-preview-1");
      const windowId = openPdfCitationPreviewWindow(add, PREVIEW);
      const firstCall = add.mock.calls[0];
      if (firstCall === undefined) throw new Error("expected preview window to open");

      render(
        <PdfCitationPreviewWindow
          cfg={firstCall[1] as Record<string, unknown>}
          focusWindow={vi.fn()}
          restoreWindow={vi.fn()}
          updateCfg={vi.fn()}
          windowId={windowId ?? "missing"}
        />,
      );

      expect(await screen.findByRole("alert")).toHaveTextContent(title);
      if (action === null) {
        expect(screen.queryByRole("button")).not.toBeInTheDocument();
      } else {
        expect(screen.getByRole("button", { name: action })).toBeInTheDocument();
      }
      expect(
        screen.queryByRole("group", { name: /pdf preview controls/i }),
      ).not.toBeInTheDocument();
    },
  );

  it("attempts one automatic re-open when document fetch reports a lost session", async () => {
    vi.mocked(fetchPdfCitationPreviewDocument)
      .mockRejectedValueOnce(new ApiError("PREVIEW_SESSION_NOT_FOUND", "missing", 404))
      .mockRejectedValueOnce(new ApiError("PREVIEW_SESSION_NOT_FOUND", "missing again", 404));
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
          chatWindowId: "chat-window-1",
          marker: "[1]",
          representation: "inline-marker",
        },
      },
    });
    const firstCall = add.mock.calls[0];
    if (firstCall === undefined) throw new Error("expected preview window to open");

    render(
      <PdfCitationPreviewWindow
        cfg={firstCall[1] as Record<string, unknown>}
        focusWindow={vi.fn()}
        restoreWindow={vi.fn()}
        updateCfg={vi.fn()}
        windowId={windowId ?? "missing"}
      />,
    );

    await waitFor(() => {
      expect(openPdfCitationPreviewSession).toHaveBeenCalledTimes(1);
    });
    expect(openPdfCitationPreviewSession).toHaveBeenCalledWith({
      chatId: "chat-1",
      assistantMessageId: "msg-a",
      marker: "[1]",
      stableId: "stable-1",
      origin: "inline-marker",
    });
    await waitFor(() => {
      expect(fetchPdfCitationPreviewDocument).toHaveBeenCalledTimes(2);
    });
    expect(openPdfCitationPreviewSession).toHaveBeenCalledTimes(1);
    expect(getPdfCitationPreviewSession(windowId ?? "missing")?.session.handle).toBe(
      "preview-session-2",
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(/preview session ended/i);
  });

  it("destroys a hanging pdf.js load and exposes a retryable timeout", async () => {
    vi.useFakeTimers();
    try {
      const pendingDestroy = vi.fn(async () => {});
      vi.mocked(getDocument).mockReturnValueOnce({
        promise: new Promise(() => undefined),
        destroy: pendingDestroy,
      } as never);
      const add = vi.fn<Parameters<typeof openPdfCitationPreviewWindow>[0]>(() => "pdf-preview-1");
      const windowId = openPdfCitationPreviewWindow(add, PREVIEW);
      const firstCall = add.mock.calls[0];
      if (firstCall === undefined) throw new Error("expected preview window to open");

      render(
        <PdfCitationPreviewWindow
          cfg={firstCall[1] as Record<string, unknown>}
          focusWindow={vi.fn()}
          restoreWindow={vi.fn()}
          updateCfg={vi.fn()}
          windowId={windowId ?? "missing"}
        />,
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });

      expect(getDocument).toHaveBeenCalledTimes(1);
      expect(pendingDestroy).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("alert")).toHaveTextContent(/preview timed out/i);
      expect(screen.getByRole("button", { name: /retry preview/i })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the range URL path for very large preview sessions", async () => {
    const largePreview = {
      ...PREVIEW,
      session: {
        ...PREVIEW.session,
        byteLength: 64 * 1024 * 1024,
      },
    };
    const add = vi.fn<Parameters<typeof openPdfCitationPreviewWindow>[0]>(() => "pdf-preview-1");
    const windowId = openPdfCitationPreviewWindow(add, largePreview);
    const firstCall = add.mock.calls[0];
    if (firstCall === undefined) throw new Error("expected preview window to open");

    render(
      <PdfCitationPreviewWindow
        cfg={firstCall[1] as Record<string, unknown>}
        focusWindow={vi.fn()}
        restoreWindow={vi.fn()}
        updateCfg={vi.fn()}
        windowId={windowId ?? "missing"}
      />,
    );

    await waitFor(() => {
      expect(fetchPdfCitationPreviewDocument).not.toHaveBeenCalled();
      expect(getDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          disableRange: false,
          disableStream: false,
          rangeChunkSize: 1024 * 1024,
          url: "/api/local-knowledge/citation-preview/sessions/preview-session-1/document",
        }),
      );
    });
    expect(await screen.findByText("Near cited passage")).toBeInTheDocument();
  });

  it("windows mounted page sections for large PDF previews", async () => {
    pdfDocument.numPages = 50;
    const largePreview = {
      ...PREVIEW,
      display: {
        ...PREVIEW.display,
        pageNumber: 25,
        pageLabel: "Page 25",
      },
    };
    const add = vi.fn<Parameters<typeof openPdfCitationPreviewWindow>[0]>(() => "pdf-preview-1");
    const windowId = openPdfCitationPreviewWindow(add, largePreview);
    const firstCall = add.mock.calls[0];
    if (firstCall === undefined) throw new Error("expected preview window to open");

    const { container } = render(
      <PdfCitationPreviewWindow
        cfg={firstCall[1] as Record<string, unknown>}
        focusWindow={vi.fn()}
        restoreWindow={vi.fn()}
        updateCfg={vi.fn()}
        windowId={windowId ?? "missing"}
      />,
    );

    expect(await screen.findByText("Page 25")).toBeInTheDocument();
    expect(container.querySelectorAll(".pdfv-page")).toHaveLength(7);
    expect(screen.queryByText("Page 1")).not.toBeInTheDocument();
    expect(screen.getByText("Page 22")).toBeInTheDocument();
    expect(screen.getByText("Page 28")).toBeInTheDocument();
  });

  it("uses the range URL path above the server no-range cap", async () => {
    const aboveNoRangeCapPreview = {
      ...PREVIEW,
      session: {
        ...PREVIEW.session,
        byteLength: 4 * 1024 * 1024 + 1,
      },
    };
    const add = vi.fn<Parameters<typeof openPdfCitationPreviewWindow>[0]>(() => "pdf-preview-1");
    const windowId = openPdfCitationPreviewWindow(add, aboveNoRangeCapPreview);
    const firstCall = add.mock.calls[0];
    if (firstCall === undefined) throw new Error("expected preview window to open");

    render(
      <PdfCitationPreviewWindow
        cfg={firstCall[1] as Record<string, unknown>}
        focusWindow={vi.fn()}
        restoreWindow={vi.fn()}
        updateCfg={vi.fn()}
        windowId={windowId ?? "missing"}
      />,
    );

    await waitFor(() => {
      expect(fetchPdfCitationPreviewDocument).not.toHaveBeenCalled();
      expect(getDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          disableRange: false,
          disableStream: false,
          url: "/api/local-knowledge/citation-preview/sessions/preview-session-1/document",
        }),
      );
    });
  });

  it("shows canvas render failures inline without discarding the loaded document", async () => {
    const add = vi.fn<Parameters<typeof openPdfCitationPreviewWindow>[0]>(() => "pdf-preview-1");
    const windowId = openPdfCitationPreviewWindow(add, PREVIEW);
    const firstCall = add.mock.calls[0];
    if (firstCall === undefined) throw new Error("expected preview window to open");
    const cfg = firstCall[1] as Record<string, unknown>;
    const updateCfg = vi.fn();

    const rendered = render(
      <PdfCitationPreviewWindow
        cfg={cfg}
        focusWindow={vi.fn()}
        restoreWindow={vi.fn()}
        updateCfg={updateCfg}
        windowId={windowId ?? "missing"}
      />,
    );

    expect(await screen.findByText("Near cited passage")).toBeInTheDocument();
    page.render.mockReturnValueOnce({
      promise: Promise.reject(new Error("canvas render failed")),
      cancel: vi.fn(),
    });
    rendered.rerender(
      <PdfCitationPreviewWindow
        cfg={{ ...cfg, rotation: 90 }}
        focusWindow={vi.fn()}
        restoreWindow={vi.fn()}
        updateCfg={updateCfg}
        windowId={windowId ?? "missing"}
      />,
    );

    expect(await screen.findByText("Preview failed")).toBeInTheDocument();
    expect(screen.getByRole("toolbar", { name: /pdf preview controls/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry page/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry preview/i })).not.toBeInTheDocument();
  });

  it("loads the verified PDF bytes, renders controls, supports page and zoom actions, and stays axe-clean", async () => {
    const originalConsoleError = console.error;
    const consoleError = vi.spyOn(console, "error").mockImplementation((...args) => {
      if (
        args.some((part) => String(part).includes("Encountered two children with the same key"))
      ) {
        return;
      }
      originalConsoleError(...args);
    });
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
      expect(fetchPdfCitationPreviewDocument).toHaveBeenCalledWith(
        "preview-session-1",
        expect.any(AbortSignal),
      );
      expect(getDocument).toHaveBeenCalledWith({
        data: new Uint8Array([37, 80, 68, 70]),
      });
    });
    expect(await screen.findByText("Near cited passage")).toBeInTheDocument();
    expect(screen.getByText("Active citation")).toBeInTheDocument();
    expect(screen.getByText("Same answer citations")).toBeInTheDocument();
    expect(container.querySelectorAll(".pdfv-context-citation")).toHaveLength(2);
    expect(screen.getByRole("button", { name: /previous/i })).not.toHaveAttribute("disabled");
    expect(screen.getByDisplayValue("2")).toBeInTheDocument();
    expect(screen.getByText("/ 3")).toBeInTheDocument();

    await userEvent.click(screen.getByText("Same answer citations"));
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
    await act(async () => {
      fireEvent.change(pageInput, { target: { value: "1" } });
      fireEvent.keyDown(pageInput, { key: "Enter", code: "Enter" });
    });
    expect(updateCfg).toHaveBeenCalledWith({ currentPage: 1 });

    expect(await axe(container)).toHaveNoViolations();
    expect(
      consoleError.mock.calls.some((call) =>
        call.some((part) => String(part).includes("Encountered two children with the same key")),
      ),
    ).toBe(false);
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

  // GEN-PERF-WIDGET-001 — a view-only cfg write (scroll page-crossing, zoom, rotate, fit) must
  // NOT reload/re-parse the document. Simulate such a write by rerendering with a fresh
  // updateCfg identity plus a changed currentPage cfg value and assert the document was fetched
  // and parsed exactly once (the load effect no longer depends on updateCfg/reopenPreview).
  it("does not re-fetch or re-parse the document on a view-only cfg write", async () => {
    const add = vi.fn<Parameters<typeof openPdfCitationPreviewWindow>[0]>(() => "pdf-preview-1");
    const windowId = openPdfCitationPreviewWindow(add, PREVIEW);
    const firstCall = add.mock.calls[0];
    if (firstCall === undefined) throw new Error("expected preview window to open");
    const cfg = firstCall[1] as Record<string, unknown>;

    const { rerender } = render(
      <PdfCitationPreviewWindow
        cfg={cfg}
        focusWindow={vi.fn()}
        restoreWindow={vi.fn()}
        updateCfg={vi.fn()}
        windowId={windowId ?? "missing"}
      />,
    );

    await waitFor(() => {
      expect(fetchPdfCitationPreviewDocument).toHaveBeenCalledTimes(1);
      expect(getDocument).toHaveBeenCalledTimes(1);
    });

    // Three successive view-only cfg writes, each with a NEW updateCfg identity (as WindowFrame
    // mints per cfg write) and a changed currentPage — exactly the churn that used to reload.
    for (const page of [2, 3, 2]) {
      rerender(
        <PdfCitationPreviewWindow
          cfg={{ ...cfg, currentPage: page, rotation: page * 90 }}
          focusWindow={vi.fn()}
          restoreWindow={vi.fn()}
          updateCfg={vi.fn()}
          windowId={windowId ?? "missing"}
        />,
      );
    }

    // Give any (incorrectly) re-triggered effect a chance to fire.
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchPdfCitationPreviewDocument).toHaveBeenCalledTimes(1);
    expect(getDocument).toHaveBeenCalledTimes(1);
  });

  // GEN-UI-KEYBOARD-002 — the scrollable page region must be keyboard-focusable so arrow/PageUp/
  // PageDown scroll it (WCAG 2.1.1). Assert the region carries tabIndex 0 once bytes render.
  it("exposes the scrollable page region as a keyboard-focusable region", async () => {
    const add = vi.fn<Parameters<typeof openPdfCitationPreviewWindow>[0]>(() => "pdf-preview-1");
    const windowId = openPdfCitationPreviewWindow(add, PREVIEW);
    const firstCall = add.mock.calls[0];
    if (firstCall === undefined) throw new Error("expected preview window to open");

    render(
      <PdfCitationPreviewWindow
        cfg={firstCall[1] as Record<string, unknown>}
        focusWindow={vi.fn()}
        restoreWindow={vi.fn()}
        updateCfg={vi.fn()}
        windowId={windowId ?? "missing"}
      />,
    );

    const region = await screen.findByRole("region", { name: /policy wording\.pdf pdf preview/i });
    expect(region).toHaveClass("pdfv-scroll");
    expect(region).toHaveAttribute("tabindex", "0");
  });

  // GEN-UI-FOCUS-001 + GEN-UI-VISUAL-001 — the .tm-action chrome and its focus ring must be
  // re-declared under THIS module's scope (the TerminalWidget copy cannot match the PDF window's
  // CSS-module hash). jsdom cannot compute the ring, so guard the source rule at the string level.
  it("re-declares the tm-action chrome and focus ring under the pdf module scope", () => {
    // Resolve the sibling CSS module relative to THIS test file, not process.cwd(): the coverage
    // gate (test:coverage:ui) runs from the repo root, so a cwd-relative path would ENOENT there.
    const css = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "PdfCitationPreviewWindow.module.css"),
      "utf8",
    );
    expect(css).toMatch(/:global\(\.tm-action\)\s*\{/);
    expect(css).toMatch(/:global\(\.tm-action\):focus-visible\s*\{[^}]*--focus-ring[^}]*\}/);
  });
});
