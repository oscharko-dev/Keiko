import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { ApiError } from "@/lib/api";
import { MAX_SUPPORT_REPORT_BYTES } from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  createSupportReport,
  createSupportReportDownload,
  SupportReportEvidenceUnavailable,
} from "@/lib/support-report-api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { SupportReportButton, resetSupportReportOutcomesForTests } from "./SupportReportButton";

vi.mock("@/lib/support-report-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/support-report-api")>()),
  createSupportReport: vi.fn(),
  createSupportReportDownload: vi.fn(() => ({ href: "blob:keiko-report", dispose: vi.fn() })),
}));
vi.mock("@/lib/client-diagnostics", () => ({
  reportClientDiagnostic: vi.fn(),
  retainedClientDiagnosticFailure: vi.fn(() => undefined),
}));
const create = vi.mocked(createSupportReport);
let automaticClick: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  automaticClick = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => undefined);
});
const report = { fileName: "report.json", reportJson: "{}" };
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  resetSupportReportOutcomesForTests();
  vi.useRealTimers();
  window.localStorage.removeItem("keiko.locale");
});

describe("SupportReportButton", () => {
  it.each(["en", "de"])(
    "prepares a %s report for direct download without claiming a file was saved",
    async (locale) => {
      window.localStorage.setItem("keiko.locale", locale);
      create.mockResolvedValue(report);
      vi.mocked(createSupportReportDownload).mockReturnValueOnce({
        href: "/api/diagnostics/report/download/prepared",
        dispose: vi.fn(),
      });
      render(
        <I18nProvider>
          <SupportReportButton correlationId="direct-download" />
        </I18nProvider>,
      );
      await userEvent.click(
        await screen.findByRole("button", {
          name: locale === "de" ? "Fehlerbericht erstellen" : "Create error report",
        }),
      );
      expect(await screen.findByRole("status")).toHaveTextContent(
        locale === "de" ? "Bericht bereit." : "Report ready.",
      );
      const link = screen.getByRole("link", {
        name: locale === "de" ? "Bericht herunterladen" : "Download report",
      });
      expect(link).toHaveAttribute("href", "/api/diagnostics/report/download/prepared");
      expect(link).toHaveAttribute("download", report.fileName);
      expect(automaticClick).not.toHaveBeenCalled();
      expect(reportClientDiagnostic).not.toHaveBeenCalled();
      await userEvent.click(link);
      expect(reportClientDiagnostic).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
        correlationId: "direct-download",
        supportReportDelivery: "manual",
      });
      expect(automaticClick).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledOnce();
    },
  );

  it.each(["en", "de"])(
    "offers a %s report with plain download and support instructions",
    async (locale) => {
      window.localStorage.setItem("keiko.locale", locale);
      create.mockResolvedValue({ ...report, evidenceScope: "client-only" });
      render(
        <I18nProvider>
          <SupportReportButton correlationId="unpaired-client-error" />
        </I18nProvider>,
      );
      const button = await screen.findByRole("button", {
        name: locale === "de" ? "Fehlerbericht erstellen" : "Create error report",
      });
      await userEvent.click(button);
      expect(
        await screen.findByText(
          locale === "de"
            ? "Bericht bereit. Lade ihn herunter und sende ihn an den Support."
            : "Report ready. Download it and send it to support.",
        ),
      ).toBeVisible();
      expect(
        screen.getByRole("link", {
          name: locale === "de" ? "Bericht herunterladen" : "Download report",
        }),
      ).toBeVisible();
      expect(screen.queryByText(/server evidence|Server-Belege|Verfügbarkeitsstatus/u)).toBeNull();
      expect(screen.queryByText(/complete report|vollständiger Bericht/iu)).toBeNull();
      expect(screen.queryByText(/Launcher/u)).toBeNull();
    },
  );

  it("keeps the prepared authenticated download during failed regeneration", async () => {
    const disposeServer = vi.fn();
    vi.mocked(createSupportReportDownload).mockReturnValueOnce({
      href: "/api/prepared-original",
      dispose: disposeServer,
    });
    create.mockResolvedValueOnce(report);
    render(<SupportReportButton correlationId="prepared-original" />);
    await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
    await userEvent.click(screen.getByRole("link", { name: "Download report" }));
    expect(reportClientDiagnostic).toHaveBeenLastCalledWith(expect.any(String), {
      correlationId: "prepared-original",
      supportReportDelivery: "manual",
    });
    create.mockRejectedValueOnce(new ApiError("SUPPORT_REPORT_UNAVAILABLE", "private", 503));
    await userEvent.click(screen.getByRole("button", { name: "Regenerate report" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Check that Keiko is running locally",
    );
    expect(screen.getByRole("link", { name: "Download report" })).toHaveAttribute(
      "href",
      "/api/prepared-original",
    );
    expect(disposeServer).not.toHaveBeenCalled();
    expect(create).toHaveBeenLastCalledWith("prepared-original", expect.any(AbortSignal));
    expect(automaticClick).not.toHaveBeenCalled();
  });

  it("shares regeneration while retaining prior bytes and releases them only on replacement", async () => {
    const disposeServer = vi.fn();
    vi.mocked(createSupportReportDownload).mockReturnValueOnce({
      href: "/api/prior",
      dispose: disposeServer,
    });
    create.mockResolvedValueOnce(report);
    render(
      <>
        <SupportReportButton correlationId="regenerate-shared" />
        <SupportReportButton correlationId="regenerate-shared" />
      </>,
    );
    await userEvent.click(screen.getAllByRole("button", { name: "Create error report" })[0]!);
    let finish: (value: typeof report) => void = () => undefined;
    create.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await userEvent.click(screen.getAllByRole("button", { name: "Regenerate report" })[0]!);
    for (const button of screen.getAllByRole("button", { name: "Creating report…" }))
      expect(button).toBeDisabled();
    expect(create).toHaveBeenCalledTimes(2);
    expect(screen.getAllByRole("link", { name: "Download report" })[0]).toHaveAttribute(
      "href",
      "/api/prior",
    );
    expect(disposeServer).not.toHaveBeenCalled();
    const replacement = { fileName: "replacement.json", reportJson: "replacement" };
    await act(async () => finish(replacement));
    expect(disposeServer).toHaveBeenCalledOnce();
    expect(screen.getAllByRole("link", { name: "Download report" })[0]).toHaveAttribute(
      "download",
      replacement.fileName,
    );
    expect(automaticClick).not.toHaveBeenCalled();
  });

  it("cancels regeneration on unmount while preserving the prior prepared report", async () => {
    create.mockResolvedValueOnce(report);
    const view = render(<SupportReportButton correlationId="cancel-regeneration" />);
    await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
    let finish: (value: typeof report) => void = () => undefined;
    create.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Regenerate report" }));
    const signal = create.mock.calls.at(-1)?.[1];
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => finish({ fileName: "late.json", reportJson: "late" }));
    render(<SupportReportButton correlationId="cancel-regeneration" />);
    expect(screen.getByRole("link", { name: "Download report" })).toHaveAttribute(
      "download",
      report.fileName,
    );
    expect(screen.getByRole("button", { name: "Regenerate report" })).toBeEnabled();
    expect(automaticClick).not.toHaveBeenCalled();
  });

  it("preserves prepared bytes when regeneration reaches its deadline", async () => {
    create.mockResolvedValueOnce(report);
    render(<SupportReportButton correlationId="regeneration-deadline" />);
    await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    create.mockReturnValueOnce(new Promise(() => undefined));
    await userEvent.click(screen.getByRole("button", { name: "Regenerate report" }));
    await act(async () => deadline.abort(new DOMException("Deadline expired", "TimeoutError")));
    expect(await screen.findByRole("status")).toHaveTextContent("Report unavailable. Try again.");
    expect(screen.getByRole("link", { name: "Download report" })).toHaveAttribute(
      "download",
      report.fileName,
    );
    expect(screen.getByRole("button", { name: "Regenerate report" })).toBeEnabled();
    expect(automaticClick).not.toHaveBeenCalled();
  });

  it("disposes the retained download target when the cache is reset", async () => {
    const disposeServer = vi.fn();
    vi.mocked(createSupportReportDownload).mockReturnValueOnce({
      href: "/api/reset-report",
      dispose: disposeServer,
    });
    create.mockResolvedValueOnce(report);
    render(<SupportReportButton correlationId="reset-prepared" />);
    await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
    await act(async () => resetSupportReportOutcomesForTests());
    expect(disposeServer).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Create error report" })).toBeEnabled();
  });

  it("releases a stalled export at the complete action deadline and allows retry", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    create.mockReturnValueOnce(new Promise(() => undefined));
    render(<SupportReportButton correlationId="stalled-export" />);
    await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
    expect(AbortSignal.timeout).toHaveBeenCalledExactlyOnceWith(35_000);
    await act(async () => deadline.abort(new DOMException("Deadline expired", "TimeoutError")));
    expect(await screen.findByRole("status")).toHaveTextContent("Report unavailable. Try again.");
    expect(screen.getByRole("button", { name: "Create error report" })).toBeEnabled();
    expect(automaticClick).not.toHaveBeenCalled();
    expect(reportClientDiagnostic).not.toHaveBeenCalled();
    create.mockResolvedValueOnce(report);
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
    await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Download report" })).toBeVisible(),
    );
  });

  it("keeps missing diagnostic delivery retryable without creating a reporting incident", async () => {
    create.mockRejectedValueOnce(new SupportReportEvidenceUnavailable());
    render(<SupportReportButton correlationId="offline-original-error" />);
    await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Report unavailable. Try again.");
    expect(screen.getByRole("button", { name: "Create error report" })).toBeEnabled();
    expect(reportClientDiagnostic).not.toHaveBeenCalled();
    expect(automaticClick).not.toHaveBeenCalled();
  });

  it.each([
    [403, "DENIED", "Report unavailable in this browser. Try creating it again."],
    [503, "SUPPORT_REPORT_UNAVAILABLE", "Check that Keiko is running locally, then retry."],
    [429, "RATE_LIMITED", "Please wait a minute, then retry this report."],
  ])(
    "offers recovery for report refusal %s and preserves the selected error",
    async (status, code, hint) => {
      const error = new ApiError(code, "private response body", status);
      error.correlationId = "report-request-refused";
      create.mockRejectedValueOnce(error);
      const view = render(<SupportReportButton correlationId="original-failure" />);
      await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
      expect(await screen.findByRole("status")).toHaveTextContent(hint);
      expect(view.container).not.toHaveTextContent("private response body");
      expect(automaticClick).not.toHaveBeenCalled();
      if (status === 503) expect(reportClientDiagnostic).not.toHaveBeenCalled();
      else
        expect(reportClientDiagnostic).toHaveBeenCalledWith(expect.any(String), {
          correlationId: "report-request-refused",
          errorKind: status === 403 ? "authority-denied" : "rate-limited",
        });
      create.mockResolvedValueOnce(report);
      await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
      expect(create).toHaveBeenLastCalledWith("original-failure", expect.any(AbortSignal));
      await waitFor(() =>
        expect(screen.getByRole("link", { name: "Download report" })).toBeVisible(),
      );
    },
  );

  it("removes an expired authenticated link and offers immediate regeneration", async () => {
    vi.useFakeTimers();
    vi.mocked(createSupportReportDownload).mockReturnValueOnce({
      href: "/api/diagnostics/report/download/test",
      expiresAtMs: Date.now() + 60_000,
      dispose: vi.fn(),
    });
    create.mockResolvedValue(report);
    render(<SupportReportButton correlationId="expired-download" />);
    await act(async () => {
      screen.getByRole("button", { name: "Create error report" }).click();
    });
    expect(screen.getByRole("link", { name: "Download report" })).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(screen.getByRole("button", { name: "Regenerate report" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Download link expired. Regenerate this report.",
    );
    expect(screen.queryByRole("link", { name: "Download report" })).toBeNull();
    await act(async () => {
      screen.getByRole("button", { name: "Regenerate report" }).click();
    });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("lets regeneration finish after its previous authenticated download reference expires", async () => {
    vi.useFakeTimers();
    const dispose = vi.fn();
    vi.mocked(createSupportReportDownload).mockReturnValueOnce({
      href: "/api/expiring-prior",
      expiresAtMs: Date.now() + 1000,
      dispose,
    });
    create.mockResolvedValueOnce(report);
    render(<SupportReportButton correlationId="expiry-during-regeneration" />);
    await act(async () => {
      screen.getByRole("button", { name: "Create error report" }).click();
    });
    let finish: (value: typeof report) => void = () => undefined;
    create.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await act(async () => {
      screen.getByRole("button", { name: "Regenerate report" }).click();
    });
    const signal = create.mock.calls.at(-1)?.[1];
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(dispose).toHaveBeenCalledOnce();
    expect(signal?.aborted).toBe(false);
    expect(screen.queryByRole("link", { name: "Download report" })).toBeNull();
    expect(screen.getByRole("button", { name: "Creating report…" })).toBeDisabled();
    const replacement = { fileName: "fresh.json", reportJson: "fresh" };
    await act(async () => finish(replacement));
    expect(screen.getByRole("link", { name: "Download report" })).toHaveAttribute(
      "download",
      replacement.fileName,
    );
    expect(screen.getByRole("button", { name: "Regenerate report" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("Report ready.");
  });

  it("prepares exactly the clicked failure for its direct download link", async () => {
    create.mockResolvedValue(report);
    render(<SupportReportButton correlationId="failure-1" />);
    await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Download report" })).toBeVisible(),
    );
    expect(create).toHaveBeenCalledExactlyOnceWith("failure-1", expect.any(AbortSignal));
    expect(screen.getByRole("status")).toHaveTextContent("Report ready.");
    expect(reportClientDiagnostic).not.toHaveBeenCalled();
    expect(automaticClick).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("link", { name: "Download report" }));
    expect(reportClientDiagnostic).toHaveBeenLastCalledWith(expect.any(String), {
      correlationId: "failure-1",
      supportReportDelivery: "manual",
    });
    expect(create).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Create error report" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download report" })).toHaveAttribute(
      "download",
      report.fileName,
    );
  });

  it("keeps the generated report downloadable across remounts without another request", async () => {
    vi.useFakeTimers();
    create.mockResolvedValue(report);
    const view = render(<SupportReportButton correlationId="completed-error" />);
    await act(async () => {
      screen.getByRole("button", { name: "Create error report" }).click();
    });
    expect(screen.getByRole("status")).toHaveTextContent("Report ready.");
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(screen.getByRole("link", { name: "Download report" })).toHaveAttribute(
      "href",
      "blob:keiko-report",
    );
    view.unmount();
    const sameError = render(<SupportReportButton correlationId="completed-error" />);
    expect(sameError.container).toHaveTextContent("Download report");
    expect(create).toHaveBeenCalledOnce();
    expect(automaticClick).not.toHaveBeenCalled();
  });

  it("evicts cached report bytes and releases the object URL while leaving that error retryable", async () => {
    const dispose = vi.fn();
    vi.mocked(createSupportReportDownload).mockReturnValueOnce({ href: "blob:first", dispose });
    const large = {
      fileName: "large.json",
      reportJson: "x".repeat(MAX_SUPPORT_REPORT_BYTES / 2 + 1),
    };
    create.mockResolvedValueOnce(large).mockResolvedValueOnce(large);
    const first = render(<SupportReportButton correlationId="large-first" />);
    await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
    expect(screen.getByRole("link", { name: "Download report" })).toHaveAttribute(
      "href",
      "blob:first",
    );
    first.unmount();
    const second = render(<SupportReportButton correlationId="large-second" />);
    await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
    expect(dispose).toHaveBeenCalledOnce();
    second.unmount();
    render(<SupportReportButton correlationId="large-first" />);
    expect(screen.getByRole("button", { name: "Create error report" })).toBeEnabled();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("aborts an unmounted report and rejects late completion without a download", async () => {
    let resolve: (value: typeof report) => void = () => undefined;
    create.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const view = render(<SupportReportButton correlationId="cancelled-error" />);
    await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
    const signal = create.mock.calls[0]?.[1];
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => resolve(report));
    expect(automaticClick).not.toHaveBeenCalled();
    render(<SupportReportButton correlationId="cancelled-error" />);
    expect(screen.getByRole("button", { name: "Create error report" })).toBeEnabled();
  });

  it("blocks duplicate clicks while creating and allows retry after failure", async () => {
    let rejectReport: (reason: Error) => void = () => {
      throw new TypeError("pending report not initialized");
    };
    create.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectReport = reject;
      }),
    );
    render(<SupportReportButton />);
    await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
    expect(screen.getByRole("button", { name: "Creating report…" })).toBeDisabled();
    await act(async () => rejectReport(new Error("offline")));
    expect(screen.getByRole("status")).toHaveTextContent("Report unavailable. Try again.");
    create.mockResolvedValueOnce(report);
    await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Download report" })).toBeVisible(),
    );
  });

  it("uses short German text and clears feedback for a new failure", async () => {
    window.localStorage.setItem("keiko.locale", "de");
    create.mockResolvedValue(report);
    const { rerender } = render(
      <I18nProvider>
        <SupportReportButton correlationId="one" />
      </I18nProvider>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Fehlerbericht erstellen" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Bericht bereit.");
    rerender(
      <I18nProvider>
        <SupportReportButton correlationId="two" />
      </I18nProvider>,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Fehlerbericht erstellen" }));
    expect(create).toHaveBeenLastCalledWith("two", expect.any(AbortSignal));
    expect(automaticClick).not.toHaveBeenCalled();
  });

  it("cancels the old correlation and ignores its late report after a pending switch", async () => {
    let finishOld: (value: typeof report) => void = () => undefined;
    let finishNew: (value: typeof report) => void = () => undefined;
    const oldReport = { fileName: "old.json", reportJson: "old" };
    const newReport = { fileName: "new.json", reportJson: "new" };
    create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishNew = resolve;
        }),
    );
    const view = render(<SupportReportButton correlationId="pending-old" />);
    await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
    const oldSignal = create.mock.calls[0]?.[1];
    view.rerender(<SupportReportButton correlationId="pending-new" />);
    expect(oldSignal?.aborted).toBe(true);
    expect(screen.getByRole("button", { name: "Create error report" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
    expect(create).toHaveBeenLastCalledWith("pending-new", expect.any(AbortSignal));
    await act(async () => finishOld(oldReport));
    expect(automaticClick).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Creating report…" })).toBeDisabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await act(async () => finishNew(newReport));
    expect(automaticClick).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Download report" })).toHaveAttribute(
      "download",
      newReport.fileName,
    );
    view.rerender(<SupportReportButton correlationId="pending-old" />);
    expect(screen.getByRole("button", { name: "Create error report" })).toBeEnabled();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("shares one pending download between duplicate contextual actions", async () => {
    let resolve: (value: typeof report) => void = () => undefined;
    create.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    render(
      <>
        <SupportReportButton correlationId="duplicate-error" />
        <SupportReportButton correlationId="duplicate-error" />
      </>,
    );
    await userEvent.click(screen.getAllByRole("button", { name: "Create error report" })[0]!);
    for (const button of screen.getAllByRole("button", { name: "Creating report…" }))
      expect(button).toBeDisabled();
    await act(async () => resolve(report));
    expect(create).toHaveBeenCalledOnce();
    expect(automaticClick).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Create error report" })).not.toBeInTheDocument();
  });
});
