import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { prepareLocalSupportReport } from "@/lib/support-report-local";
import { SupportReportButton, resetSupportReportOutcomesForTests } from "./SupportReportButton";

vi.mock("@/lib/support-report-api", () => {
  const error = new Error("Loading unavailable report chunk failed");
  error.name = "ChunkLoadError";
  throw error;
});
vi.mock("@/lib/support-report-local", () => ({
  prepareLocalSupportReport: vi.fn(),
  prepareCachedSupportReport: vi.fn(),
}));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));
afterEach(() => {
  resetSupportReportOutcomesForTests();
  vi.resetAllMocks();
});

it("offers the existing local report when the first API chunk cannot load", async () => {
  vi.mocked(prepareLocalSupportReport).mockResolvedValueOnce({
    report: { fileName: "local.json", reportJson: "{}", evidenceScope: "client-only" },
    download: { href: "blob:local-gzip", fileName: "local.json.gz", dispose: vi.fn() },
  });
  render(<SupportReportButton correlationId="original-chunk-failure" />);
  await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
  expect(await screen.findByRole("link", { name: "Download report" })).toHaveAttribute(
    "href",
    "blob:local-gzip",
  );
  expect(prepareLocalSupportReport).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal), {
    correlationId: "original-chunk-failure",
    failure: undefined,
  });
  expect(screen.queryByText(/chunk|unavailable report/iu)).toBeNull();
});
