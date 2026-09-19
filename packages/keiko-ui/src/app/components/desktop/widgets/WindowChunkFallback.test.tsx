import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { WINDOW_STAGE_STALL_MS } from "../hooks/useWindowStageEvidence";
import { createWindowChunkFallback } from "./WindowChunkFallback";

const reportClientDiagnostic = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client-diagnostics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-diagnostics")>()),
  reportClientDiagnostic,
}));

describe("createWindowChunkFallback", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders the named block-level placeholder and reports the chunk's own stage", () => {
    const EditorChunkFallback = createWindowChunkFallback("editor widget chunk");

    const { unmount } = render(
      <I18nProvider>
        <EditorChunkFallback />
      </I18nProvider>,
    );

    const placeholder = screen.getByRole("status");
    expect(placeholder).toHaveAttribute("data-window-chunk", "loading");
    expect(placeholder).toHaveStyle({ display: "block" });
    expect(reportClientDiagnostic).toHaveBeenLastCalledWith(
      expect.stringMatching(/^desktop editor widget chunk #\d+: started$/),
      expect.objectContaining({
        stageReport: expect.objectContaining({ stage: "editor widget chunk", phase: "started" }),
      }),
    );

    unmount();

    expect(reportClientDiagnostic).toHaveBeenLastCalledWith(
      expect.stringMatching(/^desktop editor widget chunk #\d+: settled after \d+ms$/),
      expect.objectContaining({
        stageReport: expect.objectContaining({ stage: "editor widget chunk", phase: "settled" }),
      }),
    );
  });

  // Two chunks, two stages: the factory must not share one label across its callers.
  it("keeps distinct stages distinct", () => {
    const FilesChunkFallback = createWindowChunkFallback("files widget chunk");

    render(
      <I18nProvider>
        <FilesChunkFallback />
      </I18nProvider>,
    );

    expect(reportClientDiagnostic).toHaveBeenLastCalledWith(
      expect.stringMatching(/^desktop files widget chunk #\d+: started$/),
      expect.objectContaining({
        stageReport: expect.objectContaining({ stage: "files widget chunk", phase: "started" }),
      }),
    );
  });

  // Dev CI run 35438847738: WebKit's network process crashed, the Chat History chunk's request was
  // lost without an error event, and the window waited on "Loading…" until the journey timed out.
  // A chunk that has not arrived in time says so, reports the stall under its stage's id, and offers
  // the reload that requests it fresh.
  it("turns a chunk that never arrives into a stalled state with a reload", () => {
    vi.useFakeTimers();
    try {
      const reload = vi.fn();
      const ChatHistoryChunkFallback = createWindowChunkFallback("window chunk", reload);
      render(
        <I18nProvider>
          <ChatHistoryChunkFallback />
        </I18nProvider>,
      );
      const started = reportClientDiagnostic.mock.calls.at(-1);
      expect(screen.queryByRole("button", { name: "Reload Keiko" })).toBeNull();

      act(() => {
        vi.advanceTimersByTime(WINDOW_STAGE_STALL_MS);
      });

      expect(screen.getByRole("status")).toHaveAttribute("data-window-chunk", "stalled");
      expect(screen.getByRole("status")).toHaveTextContent("This window did not finish loading.");
      expect(reportClientDiagnostic).toHaveBeenLastCalledWith(
        expect.stringMatching(/^desktop window chunk #\d+: stalled after 10000ms$/u),
        {
          correlationId: (started?.[1] as { correlationId?: string } | undefined)?.correlationId,
          errorKind: "timeout",
        },
      );
      fireEvent.click(screen.getByRole("button", { name: "Reload Keiko" }));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports no stall for a chunk that arrives in time", () => {
    vi.useFakeTimers();
    try {
      const Fallback = createWindowChunkFallback("window chunk", vi.fn());
      const { unmount } = render(
        <I18nProvider>
          <Fallback />
        </I18nProvider>,
      );

      act(() => {
        vi.advanceTimersByTime(WINDOW_STAGE_STALL_MS - 1);
      });
      unmount();
      act(() => {
        vi.advanceTimersByTime(WINDOW_STAGE_STALL_MS);
      });

      const stalls = reportClientDiagnostic.mock.calls.filter(([message]) =>
        String(message).includes("stalled"),
      );
      expect(stalls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
