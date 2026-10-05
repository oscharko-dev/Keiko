import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { prepareLocalSupportReport } from "@/lib/support-report-local";
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
vi.mock("@/lib/support-report-local", async (original) => {
  const producer = await original<typeof import("@/lib/support-report-local")>();
  return {
    ...producer,
    prepareLocalSupportReport: vi.fn(producer.prepareLocalSupportReport),
    prepareCachedSupportReport: vi.fn(producer.prepareCachedSupportReport),
  };
});
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
      <GlobalSupportReportAction />
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

it("offers global reports only for a current failure even without props", () => {
  render(<GlobalSupportReportAction />);
  expect(screen.queryByRole("button")).toBeNull();
});

it("keeps report controls and polite feedback outside the assertive failure text", () => {
  renderFailureNotice();
  publishFailure("separate-failure-controls");
  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent("Keiko encountered an error.");
  expect(alert.querySelector("button, a, output")).toBeNull();
  expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  expect(screen.getByRole("button", { name: "Create error report" })).not.toHaveClass("ft-seg");
});

it("restores the known prior focus after dismissing a global failure", async () => {
  render(
    <>
      <button>Workspace action</button>
      <GlobalSupportReportAction />
    </>,
  );
  const prior = screen.getByRole("button", { name: "Workspace action" });
  prior.focus();
  publishFailure("keyboard-dismiss");
  await userEvent.tab();
  expect(screen.getByRole("button", { name: "Create error report" })).toHaveFocus();
  await userEvent.tab();
  expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(prior).toHaveFocus();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps ready global actions accessible and distinctly labeled", async () => {
  const { container } = render(<GlobalSupportReportAction />);
  publishFailure("accessible-ready-global");
  vi.mocked(createSupportReport).mockResolvedValueOnce(await canonicalSupportReportFixture());
  const button = screen.getByRole("button", { name: "Create error report" });
  const actionClass = button.className;
  await userEvent.click(button);
  const download = await screen.findByRole("link", { name: "Download report" });
  expect(download).toHaveClass(actionClass);
  expect(screen.getByRole("group", { name: "Keiko encountered an error." })).toContainElement(
    download,
  );
  expect(screen.getByRole("alert")).not.toContainElement(download);
  expect(await axe(container)).toHaveNoViolations();
});

it("keeps the global notice retryable after an explicitly failed local fallback", async () => {
  vi.mocked(createSupportReport).mockRejectedValueOnce(new TypeError("Controlled offline"));
  vi.mocked(prepareLocalSupportReport).mockRejectedValueOnce(
    new TypeError("Controlled local failure"),
  );
  renderFailureNotice();
  publishFailure("controlled-global-failure");
  await userEvent.click(await screen.findByRole("button", { name: "Create error report" }));
  expect(await screen.findByText(/Check that Keiko is running locally/u)).toBeVisible();
  expect(prepareLocalSupportReport).toHaveBeenCalledOnce();
  expect(screen.queryByRole("link", { name: "Download report" })).toBeNull();
  expect(currentGlobalClientFailure()?.correlationId).toBe("controlled-global-failure");
});
