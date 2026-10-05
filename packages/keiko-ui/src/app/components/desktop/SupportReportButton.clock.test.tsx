import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { DesktopSupportReportResponse } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { SUPPORT_REPORT_DELIVERY_TTL_MS } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { canonicalSupportReportFixture } from "@/test-utils/support-report-fixture";
import { setClientDiagnosticWriter, resetClientDiagnosticWriter } from "@/lib/client-diagnostics";
import "@/lib/support-report-api";
import { SupportReportButton, resetSupportReportOutcomesForTests } from "./SupportReportButton";

vi.mock("@/lib/coding-app-session-client", () => ({
  codingAppSessionPairingSettled: (): Promise<boolean> => Promise.resolve(true),
  repairLocalCodingAppSessionWithEvidence: (): Promise<unknown> =>
    Promise.resolve({ repaired: true, correlationId: "clock-test-session" }),
}));

let fixture: DesktopSupportReportResponse;
beforeAll(async () => {
  fixture = await canonicalSupportReportFixture();
});

afterEach(() => {
  resetSupportReportOutcomesForTests();
  resetClientDiagnosticWriter();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const DOWNLOAD_PATH = "/api/diagnostics/report/download/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function skewedReportResponse(serverNow: number): Response {
  return new Response(
    JSON.stringify({
      ...fixture,
      downloadPath: DOWNLOAD_PATH,
      downloadExpiresAtMs: serverNow + SUPPORT_REPORT_DELIVERY_TTL_MS,
    }),
    { headers: { Date: new Date(serverNow).toUTCString() } },
  );
}

it("keeps the normal download action until its projected lifetime expires despite a slow server clock", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 9, 5, 12));
  let monotonic = 1_000;
  vi.spyOn(performance, "now").mockImplementation(() => monotonic);
  const serverNow = Date.now() - 3_600_000;
  const diagnostic = vi.fn();
  setClientDiagnosticWriter(diagnostic);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      await Promise.resolve();
      monotonic += SUPPORT_REPORT_DELIVERY_TTL_MS * 2;
      return skewedReportResponse(serverNow);
    }),
  );
  render(<SupportReportButton failure={{ errorKind: "unavailable", context: [] }} />);
  await act(async () => {
    screen.getByRole("button", { name: "Create error report" }).click();
  });
  const link = screen.getByRole("link", { name: "Download report" });
  expect(link).toHaveAttribute("href", DOWNLOAD_PATH);
  expect(link).toHaveAttribute("download", `${fixture.fileName}.gz`);
  expect(diagnostic).not.toHaveBeenCalled();
  link.addEventListener("click", (event) => event.preventDefault(), { once: true });
  act(() => link.click());
  expect(diagnostic).toHaveBeenCalledExactlyOnceWith("[keiko] support report download initiated", {
    correlationId: undefined,
    supportReportDelivery: {
      mode: "manual",
      source: "server",
      evidenceScope: "client-only",
      reportDigest: fixture.summary?.reportDigest,
    },
  });
  await act(async () => vi.advanceTimersByTimeAsync(SUPPORT_REPORT_DELIVERY_TTL_MS - 1_001));
  expect(screen.getByRole("link", { name: "Download report" })).toHaveAttribute(
    "href",
    DOWNLOAD_PATH,
  );
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(screen.queryByRole("link", { name: "Download report" })).toBeNull();
  expect(screen.getByRole("button", { name: "Regenerate report" })).toBeEnabled();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Download link expired. Regenerate this report.",
  );
});
