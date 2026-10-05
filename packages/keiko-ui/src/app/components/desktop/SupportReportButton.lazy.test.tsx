import { SUPPORT_REPORT_REQUEST_TIMEOUT_MS } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  let release = (): void => undefined;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { imports: 0, ready, release, create: vi.fn() };
});
const local = vi.hoisted(() => {
  let release = (): void => undefined;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { imports: 0, ready, release };
});
vi.mock("@/lib/support-report-local", async () => {
  local.imports += 1;
  await local.ready;
  return {
    originalSupportReportFailure: vi.fn(() => undefined),
    prepareLocalSupportReport: vi.fn(),
    prepareCachedSupportReport: vi.fn(),
  };
});
vi.mock("@/lib/support-report-api", async () => {
  api.imports += 1;
  await api.ready;
  return {
    createSupportReport: api.create,
    createSupportReportDownload: vi.fn(() => ({ href: "blob:keiko-report", dispose: vi.fn() })),
    SupportReportEvidenceUnavailable: class extends Error {},
    SupportReportResponseInvalid: class extends Error {},
  };
});
afterEach(() => vi.restoreAllMocks());

type ReportComponent = typeof import("./SupportReportButton");

async function cancelApiChunk(component: ReportComponent): Promise<void> {
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  const view = render(<component.SupportReportButton correlationId="late-api-chunk" />);
  await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
  expect(api.imports).toBe(1);
  expect(local.imports).toBe(0);
  expect(api.create).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Creating report…" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(timeout).toHaveBeenCalledExactlyOnceWith(SUPPORT_REPORT_REQUEST_TIMEOUT_MS);
  await act(async () => deadline.abort(new DOMException("Deadline expired", "TimeoutError")));
  expect(await screen.findByRole("status")).toHaveTextContent("Report unavailable. Try again.");
  timeout.mockReturnValue(new AbortController().signal);
  await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
  view.unmount();
  await act(async () => api.release());
  expect(api.create).not.toHaveBeenCalled();
  expect(local.imports).toBe(0);
  component.resetSupportReportOutcomesForTests();
}

async function cancelLocalChunk(component: ReportComponent): Promise<void> {
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  const view = render(<component.SupportReportButton correlationId="late-local-chunk" />);
  await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
  await waitFor(() => expect(local.imports).toBe(1));
  expect(api.create).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Creating report…" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await act(async () => deadline.abort(new DOMException("Deadline expired", "TimeoutError")));
  expect(await screen.findByRole("status")).toHaveTextContent("Report unavailable. Try again.");
  view.unmount();
  await act(async () => local.release());
  expect(api.create).not.toHaveBeenCalled();
  component.resetSupportReportOutcomesForTests();
}

it("renders without either report chunk, bounds both waits and ignores cancelled late imports", async () => {
  const automaticClick = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => undefined);
  let loaded = false;
  const pending = import("./SupportReportButton").then((value) => {
    loaded = true;
    return value;
  });
  await waitFor(() => expect(loaded).toBe(true));
  const component = await pending;
  expect(api.imports).toBe(0);
  expect(local.imports).toBe(0);
  await cancelApiChunk(component);
  await cancelLocalChunk(component);
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
  const report = { fileName: "report.json", reportJson: "{}" };
  api.create.mockResolvedValueOnce(report);
  render(<component.SupportReportButton correlationId="loaded-report-chunks" />);
  await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
  expect(await screen.findByRole("link", { name: "Download report" })).toHaveAttribute(
    "download",
    report.fileName,
  );
  expect(api.create).toHaveBeenCalledExactlyOnceWith(
    "loaded-report-chunks",
    expect.any(AbortSignal),
  );
  expect(automaticClick).not.toHaveBeenCalled();
  component.resetSupportReportOutcomesForTests();
});

it("handles a late local-module rejection after cancellation without replay or unhandled failure", async () => {
  vi.resetModules();
  api.create.mockClear();
  let rejectModule: ((error: Error) => void) | undefined;
  vi.doMock(
    "@/lib/support-report-local",
    () =>
      new Promise((_resolve, reject) => {
        rejectModule = reject;
      }),
  );
  const component = await import("./SupportReportButton");
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  const view = render(<component.SupportReportButton correlationId="local-chunk-reject" />);
  await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
  await waitFor(() => expect(rejectModule).toBeDefined());
  await act(async () => deadline.abort(new DOMException("Deadline expired", "TimeoutError")));
  expect(await screen.findByRole("status")).toHaveTextContent("Report unavailable. Try again.");
  view.unmount();
  await act(async () => rejectModule?.(new Error("Late local module unavailable")));
  expect(api.create).not.toHaveBeenCalled();
  component.resetSupportReportOutcomesForTests();
  vi.doUnmock("@/lib/support-report-local");
});

it("bounds the local fallback chunk after the API chunk fails", async () => {
  vi.resetModules();
  api.create.mockClear();
  vi.doMock("@/lib/support-report-api", () => {
    throw new TypeError("Unavailable report API chunk");
  });
  let releaseLocal: (() => void) | undefined;
  const prepare = vi.fn();
  vi.doMock("@/lib/support-report-local", async () => {
    await new Promise<void>((resolve) => {
      releaseLocal = resolve;
    });
    return { prepareLocalSupportReport: prepare, prepareCachedSupportReport: prepare };
  });
  const component = await import("./SupportReportButton");
  const localDeadline = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValueOnce(new AbortController().signal)
    .mockReturnValueOnce(localDeadline.signal);
  const view = render(<component.SupportReportButton correlationId="fallback-local-chunk" />);
  await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
  await waitFor(() => expect(releaseLocal).toBeDefined());
  expect(timeout).toHaveBeenNthCalledWith(2, 5_000);
  await act(async () => localDeadline.abort(new DOMException("Deadline expired", "TimeoutError")));
  expect(await screen.findByRole("status")).toHaveTextContent("Report unavailable. Try again.");
  view.unmount();
  await act(async () => releaseLocal?.());
  expect(prepare).not.toHaveBeenCalled();
  expect(api.create).not.toHaveBeenCalled();
  component.resetSupportReportOutcomesForTests();
  vi.doUnmock("@/lib/support-report-api");
  vi.doUnmock("@/lib/support-report-local");
});
