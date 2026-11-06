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

      const stalledStatus = screen
        .getAllByRole("status")
        .filter((status) => status.getAttribute("data-window-chunk") === "stalled");
      expect(stalledStatus).toHaveLength(1);
      expect(stalledStatus[0]).toHaveAttribute("data-window-chunk", "stalled");
      expect(stalledStatus[0]).toHaveTextContent("This window did not finish loading.");
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

// These controls qualify the owning recovery callback; stale invocation is bounded fault injection,
// not a claim that browser timers execute after the hook's normal cancellation cleanup.
describe("window chunk recovery callback boundaries", () => {
  it("uses the public factory default reload only after the human activates recovery", () => {
    const reload = vi.fn();
    const browser = window;
    vi.stubGlobal(
      "window",
      new Proxy(browser, {
        get(target, key): unknown {
          return key === "location" ? { reload } : Reflect.get(target, key);
        },
      }),
    );
    vi.useFakeTimers();
    try {
      const Fallback = createWindowChunkFallback("window chunk");
      const { unmount } = render(
        <I18nProvider>
          <Fallback />
        </I18nProvider>,
      );
      expect(reload).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(WINDOW_STAGE_STALL_MS));
      expect(reload).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Reload Keiko" }));
      expect(reload).toHaveBeenCalledTimes(1);
      unmount();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("does not recreate recovery DOM or reload if a captured stall callback arrives after unmount", () => {
    vi.useFakeTimers();
    const timer = vi.spyOn(globalThis, "setTimeout");
    try {
      const reload = vi.fn();
      const Fallback = createWindowChunkFallback("window chunk", reload);
      const { unmount } = render(
        <I18nProvider>
          <Fallback />
        </I18nProvider>,
      );
      const callback = timer.mock.calls.find((call) => call[1] === WINDOW_STAGE_STALL_MS)?.[0];
      if (typeof callback !== "function")
        throw new TypeError("Owning stall timer was not scheduled");
      unmount();
      expect(() => act(() => callback())).not.toThrow();
      expect(screen.queryByRole("button", { name: "Reload Keiko" })).toBeNull();
      expect(reload).not.toHaveBeenCalled();
    } finally {
      timer.mockRestore();
      vi.useRealTimers();
    }
  });
});
