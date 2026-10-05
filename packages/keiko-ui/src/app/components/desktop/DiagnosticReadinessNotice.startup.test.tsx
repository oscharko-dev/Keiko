import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { CORRELATION_HEADER } from "@/lib/bff-correlation";
import { I18nProvider } from "@/lib/i18n";
import * as reportApi from "@/lib/support-report-api";
import { canonicalSupportReportFixture } from "@/test-utils/support-report-fixture";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "@/lib/client-diagnostics";
import {
  fanOutClientDiagnostic,
  resetClientDiagnosticPostStateForTests,
} from "@/lib/install-client-diagnostics";
import { useBackendHealth } from "./hooks/useBackendHealth";
import { resetSupportReportOutcomesForTests } from "./SupportReportButton";
import { DiagnosticReadinessNotice } from "./DiagnosticReadinessNotice";

function ObservedNotice(): ReactElement {
  return <DiagnosticReadinessNotice health={useBackendHealth()} />;
}

afterEach(() => {
  resetSupportReportOutcomesForTests();
  resetClientDiagnosticWriter();
  resetClientDiagnosticPostStateForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function healthOutage(): Response {
  return new Response(
    JSON.stringify({ error: { code: "UNAVAILABLE", message: "private-backend-location" } }),
    { status: 503, headers: { [CORRELATION_HEADER]: "startup-health-request" } },
  );
}

it("offers the failed initial health request's report without waiting for another poll", async () => {
  const report = await canonicalSupportReportFixture();
  vi.useFakeTimers();
  const create = vi.spyOn(reportApi, "createSupportReport").mockResolvedValue(report);
  vi.spyOn(reportApi, "createSupportReportDownload").mockReturnValue({
    href: "blob:startup-health-report",
    dispose: vi.fn(),
  });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async (path) =>
      path === "/api/health" ? healthOutage() : new Response(null, { status: 204 }),
    );
  vi.stubGlobal("fetch", fetch);
  setClientDiagnosticWriter(fanOutClientDiagnostic);
  render(
    <I18nProvider>
      <ObservedNotice />
    </I18nProvider>,
  );
  await act(async () => await vi.advanceTimersByTimeAsync(1));
  expect(fetch.mock.calls.filter(([path]) => path === "/api/health")).toHaveLength(1);
  const body: unknown = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
  expect(body).toMatchObject({ correlationId: "startup-health-request", errorKind: "unavailable" });
  expect(JSON.stringify(body)).not.toContain("private-backend-location");
  fireEvent.click(screen.getByRole("button", { name: "Create error report" }));
  await act(async () => await vi.advanceTimersByTimeAsync(1));
  expect(create).toHaveBeenCalledExactlyOnceWith(
    "startup-health-request",
    expect.any(AbortSignal),
    expect.objectContaining({ errorKind: "unavailable", context: [] }),
  );
  expect(screen.getByRole("link", { name: "Download report" })).toHaveAttribute(
    "href",
    "blob:startup-health-report",
  );
});
