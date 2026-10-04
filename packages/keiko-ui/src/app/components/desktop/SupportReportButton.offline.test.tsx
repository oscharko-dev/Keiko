import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import * as clientDiagnostics from "@/lib/client-diagnostics";
import { ApiError } from "@/lib/api";
import { ErrorNoticeFromError } from "./ErrorNotice";
import {
  createSupportReport,
  createSupportReportDownload,
  SupportReportResponseInvalid,
  SupportReportEvidenceUnavailable,
} from "@/lib/support-report-api";
import { prepareCachedSupportReport, prepareLocalSupportReport } from "@/lib/support-report-local";
import { SupportReportButton, resetSupportReportOutcomesForTests } from "./SupportReportButton";

vi.mock("@/lib/support-report-api", async (original) => ({
  ...(await original<typeof import("@/lib/support-report-api")>()),
  createSupportReport: vi.fn(),
  createSupportReportDownload: vi.fn(),
}));
vi.mock("@/lib/support-report-local", async (original) => ({
  ...(await original<typeof import("@/lib/support-report-local")>()),
  prepareLocalSupportReport: vi.fn(),
  prepareCachedSupportReport: vi.fn(),
}));
const local = {
  report: { fileName: "report.json", reportJson: "{}", evidenceScope: "client-only" as const },
  download: { href: "blob:offline-report", fileName: "report.json.gz", dispose: vi.fn() },
};
afterEach(() => {
  resetSupportReportOutcomesForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("reuses full canonical bytes locally after an attachment expires and the server goes offline", async () => {
  vi.useFakeTimers();
  const report = {
    fileName: "full.json",
    reportJson: '{"retained":"full canonical evidence"}',
    summary: {
      status: "degraded" as const,
      reasons: ["context-truncated" as const],
      recordCount: 2,
      reportDigest: "a".repeat(64),
      incidentId: "b".repeat(32),
      manifestUnreadableCount: 0,
      manifestReusedCount: 0,
      completeness: "complete" as const,
      loss: "none" as const,
    },
  };
  const diagnostic = vi.spyOn(clientDiagnostics, "reportClientDiagnostic");
  vi.mocked(createSupportReport).mockResolvedValueOnce(report);
  vi.mocked(createSupportReportDownload).mockReturnValueOnce({
    href: "/api/prepared-full",
    expiresAtMs: Date.now() + 60_000,
    dispose: vi.fn(),
  });
  render(<SupportReportButton correlationId="expired-full-offline" />);
  await act(async () => screen.getByRole("button", { name: "Create error report" }).click());
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(screen.queryByRole("link", { name: "Download report" })).toBeNull();
  vi.mocked(createSupportReport).mockRejectedValueOnce(new TypeError("offline"));
  vi.mocked(prepareCachedSupportReport).mockResolvedValueOnce({
    report,
    download: { href: "blob:retained-full", fileName: "full.json.gz", dispose: vi.fn() },
  });
  await act(async () => screen.getByRole("button", { name: "Regenerate report" }).click());
  expect(screen.getByRole("link", { name: "Download report" })).toHaveAttribute(
    "href",
    "blob:retained-full",
  );
  expect(prepareCachedSupportReport).toHaveBeenCalledExactlyOnceWith(
    report,
    expect.any(AbortSignal),
  );
  expect(prepareLocalSupportReport).not.toHaveBeenCalled();
  expect(diagnostic).toHaveBeenCalledWith("Keiko support report prepared locally.", {
    correlationId: "expired-full-offline",
    supportReportPreparation: {
      reportBytes: new TextEncoder().encode(report.reportJson).length,
      evidenceScope: "server",
      completeness: "complete",
      loss: "none",
    },
  });
  expect(screen.getAllByRole("status")).toHaveLength(1);
});

it.each([new TypeError("private network failure"), new ApiError("INTERNAL", "private", 502)])(
  "offers a truthful manually downloadable local report when the service is unavailable",
  async (failure) => {
    vi.mocked(createSupportReport).mockRejectedValueOnce(failure);
    vi.mocked(prepareLocalSupportReport).mockResolvedValueOnce(local);
    render(<SupportReportButton correlationId="original-offline-error" />);
    await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
    const link = await screen.findByRole("link", { name: "Download report" });
    expect(link).toHaveAttribute("href", local.download.href);
    expect(link).toHaveAttribute("download", local.download.fileName);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.queryByText(/private/u)).toBeNull();
    expect(prepareLocalSupportReport).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal), {
      correlationId: "original-offline-error",
      failure: undefined,
      availabilityReason: "service-unavailable",
    });
  },
);

it("preserves a prepared full report when regeneration loses the service", async () => {
  const report = { fileName: "full.json", reportJson: "{}" };
  vi.mocked(createSupportReport).mockResolvedValueOnce(report);
  vi.mocked(createSupportReportDownload).mockReturnValueOnce({
    href: "/api/prepared-full",
    dispose: vi.fn(),
  });
  render(<SupportReportButton correlationId="preserve-full-offline" />);
  await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
  await screen.findByRole("link", { name: "Download report" });
  vi.mocked(createSupportReport).mockRejectedValueOnce(new TypeError("offline"));
  await userEvent.click(screen.getByRole("button", { name: "Regenerate report" }));
  expect(screen.getByRole("link", { name: "Download report" })).toHaveAttribute(
    "href",
    "/api/prepared-full",
  );
  expect(prepareLocalSupportReport).not.toHaveBeenCalled();
});

it("disposes a late local artifact after the reporting control is unmounted", async () => {
  const diagnostic = vi.spyOn(clientDiagnostics, "reportClientDiagnostic");
  let deliver: (value: typeof local) => void = (): void => undefined;
  vi.mocked(createSupportReport).mockRejectedValueOnce(new TypeError("offline"));
  vi.mocked(prepareLocalSupportReport).mockReturnValueOnce(
    new Promise((resolve): void => {
      deliver = resolve;
    }),
  );
  const view = render(<SupportReportButton correlationId="late-offline-report" />);
  await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
  view.unmount();
  await act(async () => deliver(local));
  expect(local.download.dispose).toHaveBeenCalledOnce();
  expect(
    diagnostic.mock.calls.some(([, meta]) => meta?.supportReportPreparation !== undefined),
  ).toBe(false);
});

it("passes the original error correlation and safe class to the offline producer", async () => {
  const error = new ApiError("FORBIDDEN", "private /customer/file.html Bearer private-secret", 403);
  error.correlationId = "original-denied-request-123";
  vi.mocked(createSupportReport).mockRejectedValueOnce(new TypeError("offline"));
  vi.mocked(prepareLocalSupportReport).mockResolvedValueOnce(local);
  render(<ErrorNoticeFromError error={error} fallback="Cannot read the file" />);
  await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
  await screen.findByRole("link", { name: "Download report" });
  expect(prepareLocalSupportReport).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal), {
    correlationId: error.correlationId,
    availabilityReason: "service-unavailable",
    failure: {
      errorKind: "authority-denied",
      errorEvidence: { errorClass: "ApiError", frames: [], causeChain: [] },
      context: [],
    },
  });
  expect(screen.getAllByRole("status")).toHaveLength(1);
});

it("preserves the normal Chat string Support-ID and its known BAD_REQUEST classification", async () => {
  vi.mocked(createSupportReport).mockRejectedValueOnce(new TypeError("offline"));
  vi.mocked(prepareLocalSupportReport).mockResolvedValueOnce(local);
  render(
    <ErrorNoticeFromError
      error="Cannot read the selected folder. (BAD_REQUEST) [correlationId:original-chat-request-123]"
      fallback="Search failed"
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
  await screen.findByRole("link", { name: "Download report" });
  expect(prepareLocalSupportReport).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal), {
    correlationId: "original-chat-request-123",
    availabilityReason: "service-unavailable",
    failure: {
      errorKind: "invalid-request",
      errorEvidence: { errorClass: "string", frames: [], causeChain: [] },
      context: [],
    },
  });
});

it("records successful local preparation as routine evidence under the original support id", async () => {
  const diagnostic = vi.spyOn(clientDiagnostics, "reportClientDiagnostic");
  vi.mocked(createSupportReport).mockRejectedValueOnce(new TypeError("offline"));
  vi.mocked(prepareLocalSupportReport).mockResolvedValueOnce({
    ...local,
    report: {
      ...local.report,
      summary: {
        status: "insufficient",
        reasons: [],
        recordCount: 0,
        reportDigest: "a".repeat(64),
        incidentId: "b".repeat(32),
        manifestUnreadableCount: 0,
        manifestReusedCount: 0,
        completeness: "complete",
        loss: "none",
        availabilityReason: "service-unavailable",
      },
    },
  });
  render(<SupportReportButton correlationId="original-local-preparation-123" />);
  await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
  await screen.findByRole("link", { name: "Download report" });
  expect(diagnostic).toHaveBeenCalledWith("Keiko support report prepared locally.", {
    correlationId: "original-local-preparation-123",
    supportReportPreparation: {
      reportBytes: 2,
      evidenceScope: "client-only",
      completeness: "complete",
      loss: "none",
      availabilityReason: "service-unavailable",
    },
  });
  expect(diagnostic.mock.calls.some(([, meta]) => meta?.supportReportDelivery !== undefined)).toBe(
    false,
  );
});

it("does not duplicate server preparation with a browser fallback state", async () => {
  const diagnostic = vi.spyOn(clientDiagnostics, "reportClientDiagnostic");
  vi.mocked(createSupportReport).mockResolvedValueOnce({
    fileName: "server.json",
    reportJson: "{}",
  });
  vi.mocked(createSupportReportDownload).mockReturnValueOnce({
    href: "/api/server-prepared",
    dispose: vi.fn(),
  });
  render(<SupportReportButton correlationId="normal-server-report-123" />);
  await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
  await screen.findByRole("link", { name: "Download report" });
  expect(
    diagnostic.mock.calls.some(([, meta]) => meta?.supportReportPreparation !== undefined),
  ).toBe(false);
});

it("forwards original closed failure facts when the live endpoint returns a limited report", async () => {
  const failure = { errorKind: "timeout" as const, context: ["kind:sse-error"] };
  vi.mocked(createSupportReport).mockResolvedValueOnce(local.report);
  vi.mocked(createSupportReportDownload).mockReturnValueOnce(local.download);
  render(<SupportReportButton correlationId="live-unpaired-original" failure={failure} />);
  await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
  await screen.findByRole("link", { name: "Download report" });
  expect(createSupportReport).toHaveBeenCalledWith(
    "live-unpaired-original",
    expect.any(AbortSignal),
    failure,
  );
  expect(prepareLocalSupportReport).not.toHaveBeenCalled();
});

it("does not invent preparation loss or availability when a legacy artifact has no summary", async () => {
  const diagnostic = vi.spyOn(clientDiagnostics, "reportClientDiagnostic");
  vi.mocked(createSupportReport).mockRejectedValueOnce(new TypeError("offline"));
  vi.mocked(prepareLocalSupportReport).mockResolvedValueOnce(local);
  render(<SupportReportButton correlationId="legacy-report-no-summary" />);
  await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
  await screen.findByRole("link", { name: "Download report" });
  expect(
    diagnostic.mock.calls.some(([, meta]) => meta?.supportReportPreparation !== undefined),
  ).toBe(false);
});

it("records failed local preparation without replacing the original global failure", async () => {
  clientDiagnostics.reportClientDiagnostic("Original body-free failure.", {
    kind: "window-error",
    globalFailure: true,
    correlationId: "original-recovery-failure",
    errorKind: "internal",
  });
  const original = clientDiagnostics.currentGlobalClientFailure();
  const diagnostic = vi.spyOn(clientDiagnostics, "reportClientDiagnostic");
  vi.mocked(createSupportReport).mockRejectedValueOnce(new TypeError("offline"));
  vi.mocked(prepareLocalSupportReport).mockRejectedValueOnce(new TypeError("private local detail"));
  render(<SupportReportButton correlationId="original-recovery-failure" />);
  await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
  await vi.waitFor(() => {
    expect(diagnostic).toHaveBeenCalledWith("Keiko local support report preparation failed.", {
      correlationId: "original-recovery-failure",
      supportReportPreparation: {
        outcome: "failed",
        errorKind: "unavailable",
        durationMs: expect.any(Number),
      },
    });
  });
  expect(clientDiagnostics.currentGlobalClientFailure()).toEqual(original);
  expect(screen.queryByRole("link", { name: "Download report" })).toBeNull();
  expect(screen.queryByText(/private local detail/u)).toBeNull();
});

it("diagnoses a local artifact TypeError instead of inventing a service outage", async () => {
  const diagnostic = vi.spyOn(clientDiagnostics, "reportClientDiagnostic");
  vi.mocked(createSupportReport).mockResolvedValueOnce(local.report);
  vi.mocked(createSupportReportDownload).mockImplementationOnce(() => {
    throw new TypeError("Artifact implementation failed");
  });
  vi.mocked(prepareLocalSupportReport).mockResolvedValueOnce(local);
  render(<SupportReportButton correlationId="original-artifact-cause" />);
  await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Report unavailable. Try again.");
  expect(prepareLocalSupportReport).not.toHaveBeenCalled();
  expect(screen.queryByRole("link", { name: "Download report" })).toBeNull();
  expect(diagnostic).toHaveBeenCalledWith(expect.any(String), {
    correlationId: undefined,
    parentCorrelationId: "original-artifact-cause",
    errorKind: "internal",
  });
});

it("diagnoses a malformed successful server response as an internal contract failure", async () => {
  const diagnostic = vi.spyOn(clientDiagnostics, "reportClientDiagnostic");
  const invalid = new SupportReportResponseInvalid("Invalid report response");
  invalid.correlationId = "malformed-report-request";
  vi.mocked(createSupportReport).mockRejectedValueOnce(invalid);
  render(<SupportReportButton correlationId="original-invalid-response" />);
  await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Report unavailable. Try again.");
  expect(prepareLocalSupportReport).not.toHaveBeenCalled();
  expect(diagnostic).toHaveBeenCalledWith(expect.any(String), {
    correlationId: "malformed-report-request",
    parentCorrelationId: "original-invalid-response",
    errorKind: "internal",
  });
});

it("passes diagnostic-delivery unavailability to local preparation without claiming a service outage", async () => {
  vi.mocked(createSupportReport).mockRejectedValueOnce(new SupportReportEvidenceUnavailable());
  vi.mocked(prepareLocalSupportReport).mockResolvedValueOnce(local);
  render(<SupportReportButton correlationId="original-delivery-unavailable" />);
  await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
  await screen.findByRole("link", { name: "Download report" });
  expect(prepareLocalSupportReport).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal), {
    correlationId: "original-delivery-unavailable",
    failure: undefined,
    availabilityReason: "diagnostic-delivery-unavailable",
  });
});

it("retains a refused server evidence selection in the local report availability reason", async () => {
  const error = new ApiError("SUPPORT_REPORT_SELECTION_UNAVAILABLE", "Report unavailable.", 503);
  error.correlationId = "selection-report-request";
  vi.mocked(createSupportReport).mockRejectedValueOnce(error);
  vi.mocked(prepareLocalSupportReport).mockResolvedValueOnce(local);
  render(<SupportReportButton correlationId="original-selection-unavailable" />);
  await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
  await screen.findByRole("link", { name: "Download report" });
  expect(prepareLocalSupportReport).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal), {
    correlationId: "original-selection-unavailable",
    failure: undefined,
    availabilityReason: "diagnostic-delivery-unavailable",
  });
});
