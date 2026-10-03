import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import {
  createSupportReport,
  downloadSupportReport,
  SupportReportEvidenceUnavailable,
} from "@/lib/support-report-api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { SupportReportButton, resetSupportReportOutcomesForTests } from "./SupportReportButton";

vi.mock("@/lib/support-report-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/support-report-api")>()),
  createSupportReport: vi.fn(),
  downloadSupportReport: vi.fn(),
}));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));
const create = vi.mocked(createSupportReport);
const download = vi.mocked(downloadSupportReport);
const report = { fileName: "report.json", reportJson: "{}" };
afterEach(() => {
  vi.clearAllMocks();
  resetSupportReportOutcomesForTests();
  vi.useRealTimers();
  window.localStorage.removeItem("keiko.locale");
});

describe("SupportReportButton", () => {
  it("keeps missing diagnostic delivery retryable without creating a reporting incident", async () => {
    create.mockRejectedValueOnce(new SupportReportEvidenceUnavailable());
    render(<SupportReportButton correlationId="offline-original-error" />);
    await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Report unavailable. Try again.");
    expect(screen.getByRole("button", { name: "Create error report" })).toBeEnabled();
    expect(reportClientDiagnostic).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it("downloads exactly the clicked failure without a second confirmation", async () => {
    create.mockResolvedValue(report);
    render(<SupportReportButton correlationId="failure-1" />);
    await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
    await waitFor(() => expect(download).toHaveBeenCalledWith(report));
    expect(create).toHaveBeenCalledExactlyOnceWith("failure-1", expect.any(AbortSignal));
    expect(screen.getByRole("status")).toHaveTextContent("Downloaded.");
    expect(screen.queryByRole("button", { name: "Create error report" })).not.toBeInTheDocument();
  });

  it("remembers fulfilled errors across remounts and expires the short confirmation", async () => {
    vi.useFakeTimers();
    create.mockResolvedValue(report);
    const view = render(<SupportReportButton correlationId="completed-error" />);
    await act(async () => {
      screen.getByRole("button", { name: "Create error report" }).click();
    });
    expect(screen.getByRole("status")).toHaveTextContent("Downloaded.");
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(view.container).toBeEmptyDOMElement();
    view.unmount();
    const sameError = render(<SupportReportButton correlationId="completed-error" />);
    expect(sameError.container).toBeEmptyDOMElement();
    expect(download).toHaveBeenCalledOnce();
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
    expect(download).not.toHaveBeenCalled();
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
    await waitFor(() => expect(download).toHaveBeenCalledOnce());
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
    expect(await screen.findByRole("status")).toHaveTextContent("Heruntergeladen.");
    rerender(
      <I18nProvider>
        <SupportReportButton correlationId="two" />
      </I18nProvider>,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Fehlerbericht erstellen" }));
    expect(create).toHaveBeenLastCalledWith("two", expect.any(AbortSignal));
    expect(download).toHaveBeenCalledTimes(2);
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
    expect(download).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Creating report…" })).toBeDisabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await act(async () => finishNew(newReport));
    expect(download).toHaveBeenCalledExactlyOnceWith(newReport);
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
    expect(download).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Create error report" })).not.toBeInTheDocument();
  });
});
