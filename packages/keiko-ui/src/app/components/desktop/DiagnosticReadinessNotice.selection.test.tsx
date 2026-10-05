import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { CORRELATION_HEADER } from "@/lib/bff-correlation";
import { I18nProvider } from "@/lib/i18n";
import * as reportApi from "@/lib/support-report-api";
import { canonicalSupportReportFixture } from "@/test-utils/support-report-fixture";
import { useBackendHealth } from "./hooks/useBackendHealth";
import { resetSupportReportOutcomesForTests } from "./SupportReportButton";
import { DiagnosticReadinessNotice } from "./DiagnosticReadinessNotice";

vi.mock("@/lib/coding-app-session-client", () => ({
  codingAppSessionPairingSettled: (): Promise<void> => Promise.resolve(),
  repairLocalCodingAppSessionWithEvidence: (): Promise<unknown> =>
    Promise.resolve({ repaired: true }),
}));

function ObservedNotice(): ReactElement {
  return <DiagnosticReadinessNotice health={useBackendHealth()} />;
}

afterEach(() => {
  resetSupportReportOutcomesForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("requests server readiness evidence without selecting the successful health GET", async () => {
  const report = await canonicalSupportReportFixture();
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (path) => {
    if (path === "/api/health")
      return new Response(
        JSON.stringify({
          status: "ok",
          version: "1.2.3",
          diagnostics: {
            readiness: "degraded",
            reasons: ["level-silent"],
            writer: "production-file",
            lostEvents: 2,
          },
        }),
        { headers: { [CORRELATION_HEADER]: "successful-health-observation" } },
      );
    expect(path).toBe("/api/diagnostics/report");
    return new Response(JSON.stringify(report));
  });
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(reportApi, "createSupportReportDownload").mockReturnValue({
    href: "blob:readiness-report",
    dispose: vi.fn(),
  });
  render(
    <I18nProvider>
      <ObservedNotice />
    </I18nProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Create error report" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(fetch.mock.calls[1]?.[1]?.body).toBe("{}");
  expect(await screen.findByRole("link", { name: "Download report" })).toHaveAttribute(
    "href",
    "blob:readiness-report",
  );
});
