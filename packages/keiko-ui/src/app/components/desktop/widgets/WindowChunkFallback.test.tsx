import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
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
    expect(reportClientDiagnostic).toHaveBeenLastCalledWith("desktop editor widget chunk: started");

    unmount();

    expect(reportClientDiagnostic).toHaveBeenLastCalledWith(
      expect.stringMatching(/^desktop editor widget chunk: settled after \d+ms$/),
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

    expect(reportClientDiagnostic).toHaveBeenLastCalledWith("desktop files widget chunk: started");
  });
});
