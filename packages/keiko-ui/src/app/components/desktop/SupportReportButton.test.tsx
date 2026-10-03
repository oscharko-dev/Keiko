import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { createSupportReport, downloadSupportReport } from "@/lib/support-report-api";
import { SupportReportButton } from "./SupportReportButton";

vi.mock("@/lib/support-report-api", () => ({
  createSupportReport: vi.fn(),
  downloadSupportReport: vi.fn(),
}));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));
const create = vi.mocked(createSupportReport);
const download = vi.mocked(downloadSupportReport);
const report = { fileName: "report.json", reportJson: "{}" };
afterEach(() => {
  vi.clearAllMocks();
  window.localStorage.removeItem("keiko.locale");
});

describe("SupportReportButton", () => {
  it("downloads exactly the clicked failure without a second confirmation", async () => {
    create.mockResolvedValue(report);
    render(<SupportReportButton correlationId="failure-1" />);
    await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
    await waitFor(() => expect(download).toHaveBeenCalledWith(report));
    expect(create).toHaveBeenCalledExactlyOnceWith("failure-1");
    expect(screen.getByRole("status")).toHaveTextContent("Downloaded.");
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
  });
});
