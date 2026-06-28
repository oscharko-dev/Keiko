import { afterEach, describe, expect, it, vi } from "vitest";
import { closePdfCitationPreviewSession } from "@/lib/api";
import type { WorkspaceApi } from "../../hooks/useWorkspace.types";
import type { AppWindow } from "../../windows/types";
import {
  activatePdfCitationPreviewBackToChat,
  activatePdfCitationPreviewContext,
  clearPdfCitationPreviewWindowRegistryForTests,
  getPdfCitationPreviewBackToChatAvailability,
  getPdfCitationPreviewSession,
  openPdfCitationPreviewWindow,
  registerPdfCitationPreviewMessageTarget,
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

function chatWindow(id = "chat-window-1", chatId = "chat-1", minimized = false): AppWindow {
  return {
    id,
    type: "chat",
    x: 0,
    y: 0,
    w: 480,
    h: 420,
    z: 1,
    cfg: { chatId },
    max: false,
    minimized,
  };
}

function previewWindow(id = "pdf-preview-1"): AppWindow {
  return {
    id,
    type: "pdfCitationPreview",
    x: 0,
    y: 0,
    w: 640,
    h: 520,
    z: 2,
    cfg: {},
    max: false,
  };
}

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

  it("replaces the answer-local citation context when another verified answer reuses the same viewer", () => {
    const windows = {
      add: vi.fn<WorkspaceApi["add"]>(() => "pdf-preview-1"),
      focus: vi.fn<WorkspaceApi["focus"]>(),
      update: vi.fn<WorkspaceApi["update"]>(),
    };

    showPdfCitationPreviewResult(windows, PREVIEW, {
      context: {
        activeStableId: "stable-1",
        citations: [
          {
            citation: { stableId: "stable-1", marker: "[1]", label: "policy.pdf" },
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
      currentPage: 7,
    });

    const reusedWindowId = showPdfCitationPreviewResult(
      windows,
      {
        ...PREVIEW,
        display: {
          ...PREVIEW.display,
          pageNumber: 11,
          pageLabel: "Page 11",
        },
        session: {
          ...PREVIEW.session,
          reused: true,
        },
      },
      {
        context: {
          activeStableId: "stable-9",
          citations: [
            {
              citation: { stableId: "stable-9", marker: "[4]", label: "policy.pdf" },
              display: {
                ...PREVIEW.display,
                pageNumber: 11,
                pageLabel: "Page 11",
              },
            },
          ],
          origin: {
            assistantMessageId: "msg-b",
            chatId: "chat-1",
            chatWindowId: "chat-window-1",
            marker: "[4]",
            representation: "citation-chip",
          },
        },
        currentPage: 11,
      },
    );

    expect(reusedWindowId).toBe("pdf-preview-1");
    expect(getPdfCitationPreviewSession("pdf-preview-1")?.context).toEqual({
      activeStableId: "stable-9",
      citations: [
        {
          citation: { stableId: "stable-9", marker: "[4]", label: "policy.pdf" },
          display: {
            ...PREVIEW.display,
            pageNumber: 11,
            pageLabel: "Page 11",
          },
        },
      ],
      origin: {
        assistantMessageId: "msg-b",
        chatId: "chat-1",
        chatWindowId: "chat-window-1",
        marker: "[4]",
        representation: "citation-chip",
      },
    });
  });

  it("switches the active citation inside an existing answer-local viewer context without reauthorization", () => {
    const add = vi.fn(() => "pdf-preview-1");
    openPdfCitationPreviewWindow(add, PREVIEW, {
      context: {
        activeStableId: "stable-1",
        citations: [
          {
            citation: { stableId: "stable-1", marker: "[1]", label: "policy.pdf" },
            display: PREVIEW.display,
          },
          {
            citation: { stableId: "stable-2", marker: "[2]", label: "policy.pdf" },
            display: {
              ...PREVIEW.display,
              pageNumber: 9,
              pageLabel: "Page 9",
              anchorQuality: "approximate",
            },
          },
        ],
      },
    });

    const nextCitation = activatePdfCitationPreviewContext("pdf-preview-1", "stable-2");

    expect(nextCitation).toEqual({
      citation: { stableId: "stable-2", marker: "[2]", label: "policy.pdf" },
      display: {
        ...PREVIEW.display,
        pageNumber: 9,
        pageLabel: "Page 9",
        anchorQuality: "approximate",
      },
    });
    expect(getPdfCitationPreviewSession("pdf-preview-1")?.context?.activeStableId).toBe("stable-2");
    expect(getPdfCitationPreviewSession("pdf-preview-1")?.display).toEqual({
      ...PREVIEW.display,
      pageNumber: 9,
      pageLabel: "Page 9",
      anchorQuality: "approximate",
    });
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

  it("restores the source chat, falls back from a missing inline marker to the citation chip, and clears the transient highlight", async () => {
    vi.useFakeTimers();
    try {
      const add = vi.fn(() => "pdf-preview-1");
      openPdfCitationPreviewWindow(add, PREVIEW, {
        context: {
          activeStableId: "stable-1",
          citations: [
            {
              citation: { stableId: "stable-1", marker: "[1]", label: "policy.pdf" },
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
      syncPdfCitationPreviewWindowRegistry([chatWindow(), previewWindow()]);

      const message = document.createElement("article");
      message.tabIndex = -1;
      message.innerHTML = `
        <details class="grounded-evidence-disclosure">
          <summary>Evidence</summary>
          <button
            type="button"
            class="grounded-citation grounded-citation-action"
            aria-label="[1] policy.pdf · Open PDF"
          >
            <span class="grounded-citation-range">[1] policy.pdf</span>
          </button>
        </details>
      `;
      document.body.appendChild(message);
      const scrollIntoView = vi
        .spyOn(HTMLElement.prototype, "scrollIntoView")
        .mockImplementation(() => undefined);
      const focusMessage = vi.fn();
      const focusChip = vi.fn();
      message.focus = focusMessage;
      const chip = message.querySelector<HTMLButtonElement>(".grounded-citation-action");
      if (chip === null) throw new Error("expected chip");
      chip.focus = focusChip;

      const unregister = registerPdfCitationPreviewMessageTarget({
        assistantMessageId: "msg-a",
        chatId: "chat-1",
        chatWindowId: "chat-window-1",
        element: message,
      });
      const restoreWindow = vi.fn();
      const focusWindow = vi.fn();

      expect(
        activatePdfCitationPreviewBackToChat("pdf-preview-1", {
          focusWindow,
          restoreWindow,
        }),
      ).toBe(true);
      await Promise.resolve();

      expect(restoreWindow).toHaveBeenCalledWith("chat-window-1");
      expect(focusWindow).toHaveBeenCalledWith("chat-window-1");
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", inline: "nearest" });
      expect(focusChip).toHaveBeenCalledWith({ preventScroll: true });
      expect(message.querySelector("details")?.open).toBe(true);
      expect(chip).toHaveAttribute("data-back-to-chat-highlighted", "true");

      vi.advanceTimersByTime(1800);
      expect(chip).not.toHaveAttribute("data-back-to-chat-highlighted");

      unregister();
      message.remove();
      scrollIntoView.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports Back to chat as unavailable when the source chat window or answer is no longer available", () => {
    const add = vi.fn(() => "pdf-preview-1");
    openPdfCitationPreviewWindow(add, PREVIEW, {
      context: {
        activeStableId: "stable-1",
        citations: [
          {
            citation: { stableId: "stable-1", marker: "[1]", label: "policy.pdf" },
            display: PREVIEW.display,
          },
        ],
        origin: {
          assistantMessageId: "msg-a",
          chatId: "chat-1",
          chatWindowId: "chat-window-1",
          marker: "[1]",
          representation: "citation-chip",
        },
      },
    });

    expect(getPdfCitationPreviewBackToChatAvailability("pdf-preview-1")).toEqual({
      enabled: false,
      reason: "The originating chat is no longer available.",
    });

    syncPdfCitationPreviewWindowRegistry([chatWindow(), previewWindow()]);
    const message = document.createElement("article");
    const unregister = registerPdfCitationPreviewMessageTarget({
      assistantMessageId: "different-message",
      chatId: "chat-1",
      chatWindowId: "chat-window-1",
      element: message,
    });

    expect(getPdfCitationPreviewBackToChatAvailability("pdf-preview-1")).toEqual({
      enabled: false,
      reason: "The originating answer is no longer available.",
    });

    unregister();
  });

  it("keeps Back to chat available for a minimized source chat until it is restored and rendered", () => {
    const add = vi.fn(() => "pdf-preview-1");
    openPdfCitationPreviewWindow(add, PREVIEW, {
      context: {
        activeStableId: "stable-1",
        citations: [
          {
            citation: { stableId: "stable-1", marker: "[1]", label: "policy.pdf" },
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

    syncPdfCitationPreviewWindowRegistry([chatWindow("chat-window-1", "chat-1", true), previewWindow()]);

    expect(getPdfCitationPreviewBackToChatAvailability("pdf-preview-1")).toEqual({
      enabled: true,
    });
  });
});
