import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SupportReportButton, resetSupportReportOutcomesForTests } from "./SupportReportButton";

const loading = vi.hoisted(() => {
  let finishApi: () => void = () => undefined;
  const apiGate = new Promise<void>((resolve) => {
    finishApi = resolve;
  });
  return {
    apiGate,
    finishApi: (): void => finishApi(),
    apiStarted: vi.fn(),
    localStarted: vi.fn(),
    create: vi.fn().mockResolvedValue({ fileName: "report.json", reportJson: "{}" }),
  };
});

vi.mock("@/lib/support-report-api", async (original) => {
  loading.apiStarted();
  await loading.apiGate;
  return {
    ...(await original<typeof import("@/lib/support-report-api")>()),
    createSupportReport: loading.create,
    createSupportReportDownload: vi.fn(() => ({ href: "blob:parallel-report", dispose: vi.fn() })),
  };
});
vi.mock("@/lib/support-report-local", async (original) => {
  loading.localStarted();
  return await original<typeof import("@/lib/support-report-local")>();
});

afterEach(() => {
  loading.finishApi();
  resetSupportReportOutcomesForTests();
});

it("starts both report helpers on the first click while the API chunk is still loading", async () => {
  render(<SupportReportButton correlationId="parallel-report-load" />);
  expect(loading.apiStarted).not.toHaveBeenCalled();
  expect(loading.localStarted).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Create error report" }));
  await waitFor(() => expect(loading.apiStarted).toHaveBeenCalledOnce());
  await waitFor(() => expect(loading.localStarted).toHaveBeenCalledOnce());
  expect(loading.create).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Creating report…" })).toHaveAttribute(
    "aria-busy",
    "true",
  );
  loading.finishApi();
  expect(await screen.findByRole("link", { name: "Download report" })).toHaveAttribute(
    "href",
    "blob:parallel-report",
  );
  expect(loading.create).toHaveBeenCalledExactlyOnceWith(
    "parallel-report-load",
    expect.any(AbortSignal),
  );
});
