import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  currentGlobalClientFailure,
  dismissGlobalClientFailure,
  reportClientDiagnostic,
  resetClientDiagnosticWriter,
  setClientDiagnosticWriter,
  takeClientDiagnosticLoss,
} from "@/lib/client-diagnostics";
import { createSupportReport, createSupportReportDownload } from "@/lib/support-report-api";
import { useWindowErrorLog } from "./hooks/useWindowErrorLog";
import { useUnhandledRejectionLog } from "./hooks/useUnhandledRejectionLog";
import {
  GlobalSupportReportAction,
  resetSupportReportOutcomesForTests,
} from "./SupportReportButton";

vi.mock("@/lib/support-report-api", async (original) => ({
  ...(await original<typeof import("@/lib/support-report-api")>()),
  createSupportReport: vi.fn(),
  createSupportReportDownload: vi.fn(() => ({ href: "blob:root-cause", dispose: vi.fn() })),
}));
vi.mock("@/lib/support-report-local", async (original) => ({
  ...(await original<typeof import("@/lib/support-report-local")>()),
  prepareLocalSupportReport: vi.fn().mockRejectedValue(new TypeError("fixture fallback rejected")),
  prepareCachedSupportReport: vi.fn().mockRejectedValue(new TypeError("fixture fallback rejected")),
}));
afterEach(() => {
  act(() => {
    resetClientDiagnosticWriter();
    resetSupportReportOutcomesForTests();
  });
  vi.clearAllMocks();
});

it("retains the first undismissed failure and its pending download through a cascade", async () => {
  let finish: ((value: { fileName: string; reportJson: string }) => void) | undefined;
  vi.mocked(createSupportReport).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render(<GlobalSupportReportAction />);
  act(() =>
    reportClientDiagnostic("[keiko] uncaught window error: TypeError", {
      kind: "window-error",
      globalFailure: true,
      correlationId: "original-cascade",
    }),
  );
  const original = currentGlobalClientFailure();
  await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
  await waitFor(() => expect(createSupportReport).toHaveBeenCalledOnce());
  const signal = vi.mocked(createSupportReport).mock.calls[0]?.[1];
  act(() =>
    reportClientDiagnostic("[keiko] uncaught window error: Error", {
      kind: "window-error",
      globalFailure: true,
      correlationId: "later-symptom",
    }),
  );
  expect(currentGlobalClientFailure()).toBe(original);
  expect(signal?.aborted).toBe(false);
  await act(async () => finish?.({ fileName: "report.json", reportJson: "{}" }));
  expect(screen.getByRole("link", { name: "Download report" })).toHaveAttribute(
    "href",
    "blob:root-cause",
  );
  expect(createSupportReport).toHaveBeenCalledOnce();
});

it.each(["window-error", "unhandled-rejection"] as const)(
  "still offers a new %s after the transport reporting cap and dismissal",
  (kind) => {
    const writer = vi.fn();
    setClientDiagnosticWriter(writer);
    renderHook(kind === "window-error" ? useWindowErrorLog : useUnhandledRejectionLog);
    const dispatch = (): void => {
      const event =
        kind === "window-error"
          ? new ErrorEvent("error", { error: new TypeError("private error") })
          : Object.assign(new Event("unhandledrejection"), {
              reason: new TypeError("private error"),
            });
      act(() => {
        window.dispatchEvent(event);
      });
    };
    for (let index = 0; index < 5; index += 1) dispatch();
    const first = currentGlobalClientFailure();
    expect(first).not.toBeNull();
    act(() => dismissGlobalClientFailure(first?.ordinal ?? -1));
    dispatch();
    expect(currentGlobalClientFailure()?.failure?.context).toEqual([`kind:${kind}`]);
    expect(currentGlobalClientFailure()?.ordinal).not.toBe(first?.ordinal);
    expect(writer).toHaveBeenCalledTimes(5);
    expect(takeClientDiagnosticLoss()).toEqual({
      [kind === "window-error" ? "errorsSuppressed" : "rejectionsSuppressed"]: 1,
    });
  },
);
