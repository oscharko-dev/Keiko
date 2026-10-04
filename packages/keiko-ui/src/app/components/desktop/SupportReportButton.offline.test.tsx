import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { createSupportReport, createSupportReportDownload } from "@/lib/support-report-api";
import { prepareCachedSupportReport, prepareLocalSupportReport } from "@/lib/support-report-local";
import { SupportReportButton, resetSupportReportOutcomesForTests } from "./SupportReportButton";

vi.mock("@/lib/support-report-api", async (original) => ({
  ...(await original<typeof import("@/lib/support-report-api")>()),
  createSupportReport: vi.fn(),
  createSupportReportDownload: vi.fn(),
}));
vi.mock("@/lib/support-report-local", () => ({
  prepareLocalSupportReport: vi.fn(),
  prepareCachedSupportReport: vi.fn(),
}));
const local = {
  report: { fileName: "report.json", reportJson: "{}", evidenceScope: "client-only" as const },
  download: { href: "blob:offline-report", fileName: "report.json.gz", dispose: vi.fn() },
};
afterEach(() => {
  resetSupportReportOutcomesForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("reuses full canonical bytes locally after an attachment expires and the server goes offline", async () => {
  vi.useFakeTimers();
  const report = { fileName: "full.json", reportJson: '{"retained":"full canonical evidence"}' };
  vi.mocked(createSupportReport).mockResolvedValueOnce(report);
  vi.mocked(createSupportReportDownload).mockReturnValueOnce({
    href: "/api/prepared-full",
    expiresAtMs: Date.now() + 60_000,
    dispose: vi.fn(),
  });
  render(<SupportReportButton correlationId="expired-full-offline" />);
  await act(async () => screen.getByRole("button", { name: "Create error report" }).click());
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(screen.queryByRole("link", { name: "Download report" })).toBeNull();
  vi.mocked(createSupportReport).mockRejectedValueOnce(new TypeError("offline"));
  vi.mocked(prepareCachedSupportReport).mockResolvedValueOnce({
    report,
    download: { href: "blob:retained-full", fileName: "full.json.gz", dispose: vi.fn() },
  });
  await act(async () => screen.getByRole("button", { name: "Regenerate report" }).click());
  expect(screen.getByRole("link", { name: "Download report" })).toHaveAttribute(
    "href",
    "blob:retained-full",
  );
  expect(prepareCachedSupportReport).toHaveBeenCalledExactlyOnceWith(
    report,
    expect.any(AbortSignal),
  );
  expect(prepareLocalSupportReport).not.toHaveBeenCalled();
  expect(screen.queryByText(/Download it and send it to support/u)).toBeNull();
});

it.each([new TypeError("private network failure"), new ApiError("INTERNAL", "private", 502)])(
  "offers a truthful manually downloadable local report when the service is unavailable",
  async (failure) => {
    vi.mocked(createSupportReport).mockRejectedValueOnce(failure);
    vi.mocked(prepareLocalSupportReport).mockResolvedValueOnce(local);
    render(<SupportReportButton correlationId="original-offline-error" />);
    await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
    const link = await screen.findByRole("link", { name: "Download report" });
    expect(link).toHaveAttribute("href", local.download.href);
    expect(link).toHaveAttribute("download", local.download.fileName);
    expect(screen.getByText("Report ready. Download it and send it to support.")).toBeVisible();
    expect(screen.queryByText(/private/u)).toBeNull();
    expect(prepareLocalSupportReport).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
  },
);

it("preserves a prepared full report when regeneration loses the service", async () => {
  const report = { fileName: "full.json", reportJson: "{}" };
  vi.mocked(createSupportReport).mockResolvedValueOnce(report);
  vi.mocked(createSupportReportDownload).mockReturnValueOnce({
    href: "/api/prepared-full",
    dispose: vi.fn(),
  });
  render(<SupportReportButton correlationId="preserve-full-offline" />);
  await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
  await screen.findByRole("link", { name: "Download report" });
  vi.mocked(createSupportReport).mockRejectedValueOnce(new TypeError("offline"));
  await userEvent.click(screen.getByRole("button", { name: "Regenerate report" }));
  expect(screen.getByRole("link", { name: "Download report" })).toHaveAttribute(
    "href",
    "/api/prepared-full",
  );
  expect(prepareLocalSupportReport).not.toHaveBeenCalled();
});

it("disposes a late local artifact after the reporting control is unmounted", async () => {
  let deliver: (value: typeof local) => void = (): void => undefined;
  vi.mocked(createSupportReport).mockRejectedValueOnce(new TypeError("offline"));
  vi.mocked(prepareLocalSupportReport).mockReturnValueOnce(
    new Promise((resolve): void => {
      deliver = resolve;
    }),
  );
  const view = render(<SupportReportButton correlationId="late-offline-report" />);
  await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
  view.unmount();
  await act(async () => deliver(local));
  expect(local.download.dispose).toHaveBeenCalledOnce();
});
