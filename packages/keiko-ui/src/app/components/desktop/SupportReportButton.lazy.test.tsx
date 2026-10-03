import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  let release = (): void => undefined;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { imports: 0, ready, release, create: vi.fn(), download: vi.fn() };
});
vi.mock("@/lib/support-report-api", async () => {
  api.imports += 1;
  await api.ready;
  return {
    createSupportReport: api.create,
    downloadSupportReport: api.download,
    SupportReportEvidenceUnavailable: class extends Error {},
  };
});
afterEach(() => vi.restoreAllMocks());

it("renders before the report chunk loads, bounds its wait, and ignores cancelled late imports", async () => {
  let loaded = false;
  const component = import("./SupportReportButton").then((value) => {
    loaded = true;
    return value;
  });
  await waitFor(() => expect(loaded).toBe(true));
  const { SupportReportButton, resetSupportReportOutcomesForTests } = await component;
  expect(api.imports).toBe(0);
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  const view = render(<SupportReportButton correlationId="late-report-chunk" />);
  await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
  expect(api.imports).toBe(1);
  expect(api.create).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Creating report…" })).toBeDisabled();
  expect(AbortSignal.timeout).toHaveBeenCalledExactlyOnceWith(35_000);
  await act(async () => deadline.abort(new DOMException("Deadline expired", "TimeoutError")));
  expect(await screen.findByRole("status")).toHaveTextContent("Report unavailable. Try again.");
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
  await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
  view.unmount();
  await act(async () => api.release());
  expect(api.create).not.toHaveBeenCalled();
  expect(api.download).not.toHaveBeenCalled();
  const report = { fileName: "report.json", reportJson: "{}" };
  api.create.mockResolvedValueOnce(report);
  render(<SupportReportButton correlationId="late-report-chunk" />);
  await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
  await waitFor(() => expect(api.download).toHaveBeenCalledExactlyOnceWith(report));
  resetSupportReportOutcomesForTests();
});
