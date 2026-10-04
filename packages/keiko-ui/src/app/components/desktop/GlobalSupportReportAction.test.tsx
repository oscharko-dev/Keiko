import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { canonicalSupportReportFixture } from "@/test-utils/support-report-fixture";
import { createSupportReport, createSupportReportDownload } from "@/lib/support-report-api";
import {
  currentGlobalClientFailure,
  reportClientDiagnostic,
  resetClientDiagnosticWriter,
} from "@/lib/client-diagnostics";
import {
  GlobalSupportReportAction,
  resetSupportReportOutcomesForTests,
} from "./SupportReportButton";

vi.mock("@/lib/support-report-api", async (original) => ({
  ...(await original<typeof import("@/lib/support-report-api")>()),
  createSupportReport: vi.fn(),
  createSupportReportDownload: vi.fn(() => ({ href: "blob:keiko-report", dispose: vi.fn() })),
}));
afterEach(() => {
  act(() => {
    resetClientDiagnosticWriter();
    resetSupportReportOutcomesForTests();
  });
  vi.clearAllMocks();
  window.localStorage.removeItem("keiko.locale");
});

function renderFailureNotice(): void {
  render(
    <I18nProvider>
      <GlobalSupportReportAction onlyForFailure />
    </I18nProvider>,
  );
}

function publishFailure(correlationId: string): void {
  act(() =>
    reportClientDiagnostic("[keiko] uncaught window error: Error", {
      kind: "window-error",
      globalFailure: true,
      correlationId,
    }),
  );
}

describe("direct global error reporting", () => {
  it("shows no report archive or counter when there is no uncaught error", () => {
    renderFailureNotice();
    expect(screen.queryByRole("button", { name: "Create error report" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    act(() => reportClientDiagnostic("[keiko] contextual error", { kind: "window-error" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["en", "de"])(
    "offers a %s report directly beside an actual global error",
    async (locale) => {
      window.localStorage.setItem("keiko.locale", locale);
      renderFailureNotice();
      publishFailure("global-source-error");
      await screen.findByRole("button", {
        name: locale === "de" ? "Fehlerbericht erstellen" : "Create error report",
      });
      expect(screen.getByRole("alert")).toHaveTextContent(
        locale === "de" ? "Keiko hat einen Fehler festgestellt." : "Keiko encountered an error.",
      );
      vi.mocked(createSupportReport).mockResolvedValueOnce({
        fileName: "report.json",
        reportJson: "{}",
      });
      await userEvent.click(
        screen.getByRole("button", {
          name: locale === "de" ? "Fehlerbericht erstellen" : "Create error report",
        }),
      );
      expect(
        await screen.findByRole("link", {
          name: locale === "de" ? "Bericht herunterladen" : "Download report",
        }),
      ).toHaveAttribute("download", "report.json");
      expect(createSupportReport).toHaveBeenCalledExactlyOnceWith(
        "global-source-error",
        expect.any(AbortSignal),
        { errorKind: "unknown", context: ["kind:window-error"] },
      );
      await userEvent.click(
        screen.getByRole("button", { name: locale === "de" ? "Schließen" : "Close" }),
      );
      expect(currentGlobalClientFailure()).toBeNull();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );
});

it("dismisses a ready global report by disposing its target and aborting pending regeneration", async () => {
  const canonical = await canonicalSupportReportFixture();
  const dispose = vi.fn();
  vi.mocked(createSupportReport).mockResolvedValueOnce(canonical);
  vi.mocked(createSupportReportDownload).mockReturnValueOnce({
    href: "blob:dismissed-ready",
    dispose,
  });
  renderFailureNotice();
  publishFailure("dismissed-during-regeneration");
  await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
  expect(await screen.findByRole("link", { name: "Download report" })).toBeVisible();
  let finish: ((report: typeof canonical) => void) | undefined;
  vi.mocked(createSupportReport).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Regenerate report" }));
  const signal = vi.mocked(createSupportReport).mock.calls.at(-1)?.[1];
  expect(signal?.aborted).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(signal?.aborted).toBe(true);
  expect(dispose).toHaveBeenCalledOnce();
  expect(currentGlobalClientFailure()).toBeNull();
  await act(async () => {
    finish?.(canonical);
  });
  expect(createSupportReportDownload).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("link", { name: "Download report" })).toBeNull();
  publishFailure("dismissed-during-regeneration");
  expect(screen.getByRole("button", { name: "Create error report" })).toBeEnabled();
});
