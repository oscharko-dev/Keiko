import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { WINDOW_STAGE_STALL_MS } from "../../hooks/useWindowStageEvidence";
import EditorSurfaceLoading from "./EditorSurfaceLoading";

const diagnostic = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: diagnostic }));
vi.mock("../../SupportReportButton", () => ({
  SupportReportButton: () => <button type="button">Create error report</button>,
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("nested editor chunk recovery", () => {
  it("names loading, reports a bounded stall and exposes recovery without a blank editor", () => {
    vi.useFakeTimers();
    render(
      <I18nProvider>
        <EditorSurfaceLoading />
      </I18nProvider>,
    );
    expect(screen.getByRole("status")).toHaveAttribute("data-window-chunk", "loading");
    expect(screen.queryByRole("button", { name: "Reload Keiko" })).toBeNull();
    act(() => {
      vi.advanceTimersByTime(WINDOW_STAGE_STALL_MS);
    });
    expect(screen.getByRole("status")).toHaveAttribute("data-window-chunk", "stalled");
    expect(screen.getByRole("button", { name: "Reload Keiko" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Create error report" })).toBeVisible();
    expect(diagnostic).toHaveBeenLastCalledWith(
      expect.stringMatching(/^desktop editor widget chunk #\d+: stalled after 10000ms$/u),
      expect.objectContaining({ errorKind: "timeout", correlationId: expect.any(String) }),
    );
  });

  it("cancels the stall timer when the actual editor chunk arrives", () => {
    vi.useFakeTimers();
    const { unmount } = render(
      <I18nProvider>
        <EditorSurfaceLoading />
      </I18nProvider>,
    );
    unmount();
    act(() => {
      vi.advanceTimersByTime(WINDOW_STAGE_STALL_MS);
    });
    expect(diagnostic.mock.calls.some((call) => String(call[0]).includes("stalled"))).toBe(false);
  });
});
