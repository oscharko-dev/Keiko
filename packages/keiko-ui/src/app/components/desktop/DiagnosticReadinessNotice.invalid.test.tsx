import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
});

it.each([
  [null, "null-shape"],
  [{ readiness: "private-new-value" }, "readiness-value"],
  [{ readiness: "ready", lostEvents: "private-bad-count" }, "snapshot-shape"],
])(
  "joins invalid diagnostics %j to the actual response and report classification",
  async (diagnostics, reason) => {
    const report = await canonicalSupportReportFixture();
    const create = vi.spyOn(reportApi, "createSupportReport").mockResolvedValue(report);
    vi.spyOn(reportApi, "createSupportReportDownload").mockReturnValue({
      href: "blob:invalid-health",
      dispose: vi.fn(),
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (path) =>
      path === "/api/health"
        ? new Response(JSON.stringify({ status: "ok", version: "1.2.3", diagnostics }), {
            headers: { [CORRELATION_HEADER]: "server-health-response" },
          })
        : new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetch);
    setClientDiagnosticWriter(fanOutClientDiagnostic);
    render(
      <I18nProvider>
        <ObservedNotice />
      </I18nProvider>,
    );
    const button = await screen.findByRole("button", { name: "Create error report" });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const body: unknown = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    expect(body).toMatchObject({
      correlationId: "server-health-response",
      errorKind: "validation-failed",
      healthDiagnosticsInvalidReason: reason,
      message: "[keiko] health diagnostics failed validation",
    });
    expect(body).not.toHaveProperty("errorEvidence");
    expect(JSON.stringify(body)).not.toMatch(/private-|TypeError/u);
    fireEvent.click(button);
    await screen.findByRole("link", { name: "Download report" });
    expect(create).toHaveBeenCalledExactlyOnceWith(
      "server-health-response",
      expect.any(AbortSignal),
      { errorKind: "validation-failed", context: [] },
    );
  },
);
