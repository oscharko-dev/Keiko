import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import * as api from "@/lib/api";
import * as reportApi from "@/lib/support-report-api";
import { I18nProvider } from "@/lib/i18n";
import { canonicalSupportReportFixture } from "@/test-utils/support-report-fixture";
import { HEALTH_POLL_INTERVAL_MS, useBackendHealth } from "./hooks/useBackendHealth";
import { resetSupportReportOutcomesForTests } from "./SupportReportButton";
import { DiagnosticReadinessNotice } from "./DiagnosticReadinessNotice";

function ObservedNotice(): ReactElement {
  return <DiagnosticReadinessNotice health={useBackendHealth()} />;
}

function degradedHealth(lostEvents: number): api.HealthSnapshot {
  return {
    status: "ok",
    version: "1.2.3",
    diagnostics: {
      readiness: "degraded",
      reasons: ["sink-unwritable"],
      writer: "production-file",
      lostEvents,
    },
  };
}

afterEach(() => {
  resetSupportReportOutcomesForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(["pending", "ready"] as const)(
  "preserves the %s report and original correlation while degraded health counters change",
  async (phase) => {
    const report = await canonicalSupportReportFixture();
    vi.useFakeTimers();
    const fetch = vi.spyOn(api, "fetchHealth").mockResolvedValueOnce(degradedHealth(1));
    fetch.mockResolvedValue(degradedHealth(2));
    let finish: ((value: typeof report) => void) | undefined;
    const create = vi.spyOn(reportApi, "createSupportReport").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const dispose = vi.fn();
    vi.spyOn(reportApi, "createSupportReportDownload").mockReturnValue({
      href: "blob:original-readiness-report",
      dispose,
    });
    render(
      <I18nProvider>
        <ObservedNotice />
      </I18nProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEALTH_POLL_INTERVAL_MS - 10_000);
    });
    fireEvent.click(screen.getByRole("button", { name: "Create error report" }));
    await act(async () => await Promise.resolve());
    expect(create).toHaveBeenCalledExactlyOnceWith(
      fetch.mock.calls[0]?.[0],
      expect.any(AbortSignal),
    );
    const signal = create.mock.calls[0]?.[1];
    if (phase === "ready") await act(async () => finish?.(report));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(signal?.aborted).toBe(false);
    if (phase === "pending") await act(async () => finish?.(report));
    expect(screen.getByRole("link", { name: "Download report" })).toHaveAttribute(
      "href",
      "blob:original-readiness-report",
    );
    expect(dispose).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
  },
);
