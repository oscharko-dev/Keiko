import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityLogReadinessSnapshot } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { I18nProvider } from "@/lib/i18n";
import { HEALTH_POLL_INTERVAL_MS } from "../../hooks/useBackendHealth";
import { fetchHealth } from "@/lib/api";
import {
  currentGlobalClientFailure,
  reportClientDiagnostic,
  resetClientDiagnosticWriter,
  setClientDiagnosticWriter,
} from "@/lib/client-diagnostics";
import { createSupportReport } from "@/lib/support-report-api";
import { resetSupportReportOutcomesForTests } from "../../SupportReportButton";

vi.mock("@/lib/support-report-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/support-report-api")>()),
  createSupportReport: vi.fn(),
  createSupportReportDownload: vi.fn(() => ({ href: "blob:keiko-report", dispose: vi.fn() })),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchHealth: vi.fn(),
}));
const fetchHealthMock = vi.mocked(fetchHealth);
function renderDiagnostics(): ReturnType<typeof render> {
  fetchHealthMock.mockResolvedValue({
    status: "ok",
    version: "0.2.0-test",
    diagnostics: { readiness: "ready", reasons: [], writer: "production-file", lostEvents: 0 },
  });
  return render(
    <I18nProvider>
      <DiagnosticsPanel />
    </I18nProvider>,
  );
}
afterEach(() => {
  vi.clearAllMocks();
  resetClientDiagnosticWriter();
  resetSupportReportOutcomesForTests();
  vi.useRealTimers();
  window.localStorage.removeItem("keiko.locale");
});

describe("Diagnostics — canonical support reports", () => {
  it("uses the window title once and keeps report instructions brief", async () => {
    renderDiagnostics();
    await screen.findByText("Diagnostic recording ready");
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.getByText("Download a report to send to support.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create error report" })).toBeEnabled();
  });

  it("keeps reporting available and offers dismissal only for actual global uncaught failures", async () => {
    renderDiagnostics();
    await screen.findByText("Diagnostic recording ready");
    act(() =>
      reportClientDiagnostic("[keiko] contextual error", {
        kind: "window-error",
        errorKind: "internal",
      }),
    );
    expect(screen.getByRole("button", { name: "Create error report" })).toBeInTheDocument();
    act(() =>
      reportClientDiagnostic("[keiko] uncaught window error: Error", {
        kind: "window-error",
        globalFailure: true,
        correlationId: "global-error-one",
      }),
    );
    expect(screen.getByRole("button", { name: "Create error report" })).toBeInTheDocument();
    expect(Object.keys(currentGlobalClientFailure() ?? {})).toEqual(["ordinal", "correlationId"]);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("button", { name: "Create error report" })).toBeInTheDocument();
  });

  it("offers canonical reporting after reload without requiring an in-memory failure", async () => {
    vi.mocked(createSupportReport).mockResolvedValueOnce({
      fileName: "report.json",
      reportJson: "{}",
    });
    expect(currentGlobalClientFailure()).toBeNull();
    renderDiagnostics();
    await screen.findByText("Diagnostic recording ready");
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
    expect(createSupportReport).toHaveBeenCalledExactlyOnceWith(undefined, expect.any(AbortSignal));
    expect(await screen.findByRole("link", { name: "Download report" })).toHaveAttribute(
      "download",
      "report.json",
    );
    expect(currentGlobalClientFailure()).toBeNull();
  });

  it("groups retained diagnostics and the complete German reporting failure in the diagnosis window", async () => {
    window.localStorage.setItem("keiko.locale", "de");
    fetchHealthMock.mockResolvedValueOnce({
      status: "ok",
      version: "0.2.0-test",
      diagnostics: {
        readiness: "ready",
        reasons: [],
        writer: "production-file",
        lostEvents: 0,
        retainedDiagnosticCount: 32,
        diagnosticCapacity: 32,
      },
    });
    vi.mocked(createSupportReport).mockResolvedValueOnce({
      fileName: "report.json",
      reportJson: "{}",
    });
    const view = renderDiagnostics();
    await userEvent.click(await screen.findByRole("button", { name: "Fehlerbericht erstellen" }));
    vi.mocked(createSupportReport).mockRejectedValueOnce(new TypeError("private offline details"));
    await userEvent.click(screen.getByRole("button", { name: "Bericht erneut erstellen" }));
    const link = screen.getByRole("link", { name: "Bericht herunterladen" });
    const region = screen.getByRole("region", { name: "Diagnose" });
    expect(region).toContainElement(screen.getByText("32 gespeicherte Diagnoseeinträge"));
    expect(region).toContainElement(
      screen.getByRole("button", { name: "Bericht erneut erstellen" }),
    );
    expect(region).toContainElement(screen.getByRole("status"));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Bericht nicht verfügbar. Prüfen, ob Keiko lokal läuft, dann erneut versuchen.",
    );
    expect(screen.getByRole("region", { name: "Diagnose" })).toContainElement(link);
    expect(screen.queryByRole("contentinfo")).not.toBeInTheDocument();
    expect(view.container).not.toHaveTextContent("private offline details");
  });

  it("keeps the global report downloadable until the person dismisses it", async () => {
    vi.useFakeTimers();
    vi.mocked(createSupportReport).mockResolvedValue({ fileName: "report.json", reportJson: "{}" });
    renderDiagnostics();
    await act(async () => vi.advanceTimersByTimeAsync(0));
    act(() =>
      reportClientDiagnostic("[keiko] unhandled promise rejection: Error", {
        kind: "unhandled-rejection",
        globalFailure: true,
        correlationId: "global-error-two",
      }),
    );
    await act(async () => screen.getByRole("button", { name: "Create error report" }).click());
    expect(screen.getByRole("status")).toHaveTextContent("Report ready.");
    expect(screen.getByRole("link", { name: "Download report" })).toHaveAttribute(
      "download",
      "report.json",
    );
    expect(screen.getByRole("link", { name: "Download report" })).toHaveAttribute(
      "href",
      "blob:keiko-report",
    );
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(screen.getByRole("link", { name: "Download report" })).toBeInTheDocument();
    expect(currentGlobalClientFailure()).not.toBeNull();
    await act(async () => screen.getByRole("button", { name: "Close" }).click());
    expect(currentGlobalClientFailure()).toBeNull();
  });

  it("keeps reporting available when the health endpoint is offline", async () => {
    fetchHealthMock.mockRejectedValueOnce(new TypeError("private offline details"));
    const view = renderDiagnostics();
    await screen.findByText("Diagnostic status unavailable. You can still create a report.");
    expect(screen.getByRole("button", { name: "Create error report" })).toBeEnabled();
    expect(view.container).not.toHaveTextContent("private offline details");
  });

  it("explains stored diagnostic counts as records rather than confirmed open errors", async () => {
    renderDiagnostics();
    await screen.findByText("Diagnostic recording ready");
    expect(
      screen.getByText(/Saved records are diagnostic evidence, not confirmed errors/u),
    ).toBeInTheDocument();
    expect(screen.getByText("No diagnostic records saved.")).toBeInTheDocument();
  });
});

describe("Diagnostics — recording readiness", () => {
  const ready: ActivityLogReadinessSnapshot = {
    readiness: "ready",
    reasons: [],
    writer: "production-file",
    lostEvents: 0,
  };
  const degraded: ActivityLogReadinessSnapshot = {
    ...ready,
    readiness: "degraded",
    reasons: ["level-silent"],
  };

  // Settles the pending health read (and any interval tick) inside React's act scope.
  async function advance(ms: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows no indicator while diagnostic evidence is ready", async () => {
    fetchHealthMock.mockResolvedValueOnce({ status: "ok", version: "1.0.0", diagnostics: ready });
    renderDiagnostics();

    expect(await screen.findByText("Diagnostic recording ready")).toBeInTheDocument();
    expect(screen.queryByText(/^Diagnostics /u)).not.toBeInTheDocument();
  });

  it("names a degraded readiness and its reason", async () => {
    fetchHealthMock.mockResolvedValueOnce({
      status: "ok",
      version: "1.0.0",
      diagnostics: degraded,
    });
    renderDiagnostics();

    expect(await screen.findByText("Diagnostics degraded")).toBeInTheDocument();
    expect(screen.getByText(/: logging is set to silent\./u)).toBeInTheDocument();
    expect(screen.queryByText("Diagnostic recording ready")).not.toBeInTheDocument();
  });

  it("re-reads health on its interval and follows a readiness transition", async () => {
    vi.useFakeTimers();
    fetchHealthMock
      .mockResolvedValueOnce({ status: "ok", version: "1.0.0", diagnostics: ready })
      .mockResolvedValueOnce({ status: "ok", version: "1.0.0", diagnostics: degraded });
    renderDiagnostics();
    await advance(0);
    expect(screen.getByText("Diagnostic recording ready")).toBeInTheDocument();
    expect(screen.queryByText("Diagnostics degraded")).not.toBeInTheDocument();

    await advance(HEALTH_POLL_INTERVAL_MS);

    expect(fetchHealthMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Diagnostics degraded")).toBeInTheDocument();
  });

  it("drops the indicator it can no longer vouch for when a later read fails", async () => {
    vi.useFakeTimers();
    fetchHealthMock
      .mockResolvedValueOnce({ status: "ok", version: "1.0.0", diagnostics: degraded })
      .mockRejectedValueOnce(new Error("offline"));
    renderDiagnostics();
    await advance(0);
    expect(screen.getByText("Diagnostics degraded")).toBeInTheDocument();

    await advance(HEALTH_POLL_INTERVAL_MS);

    expect(
      screen.getByText("Diagnostic status unavailable. You can still create a report."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Diagnostics degraded")).not.toBeInTheDocument();
  });

  it("reports a failed health read once per failure streak, by class only", async () => {
    vi.useFakeTimers();
    const reports: string[] = [];
    setClientDiagnosticWriter((message) => reports.push(message));
    try {
      fetchHealthMock
        .mockRejectedValueOnce(new TypeError("offline at /Users/alice"))
        .mockRejectedValueOnce(new TypeError("offline at /Users/alice"))
        .mockResolvedValueOnce({ status: "ok", version: "1.0.0", diagnostics: ready })
        .mockRejectedValueOnce(new TypeError("offline at /Users/alice"));
      renderDiagnostics();
      await advance(0);
      await advance(HEALTH_POLL_INTERVAL_MS);
      expect(reports).toEqual(["[keiko] health read failed: TypeError"]);

      await advance(HEALTH_POLL_INTERVAL_MS);
      await advance(HEALTH_POLL_INTERVAL_MS);
      expect(reports).toEqual([
        "[keiko] health read failed: TypeError",
        "[keiko] health read failed: TypeError",
      ]);
    } finally {
      resetClientDiagnosticWriter();
    }
  });

  it("stops reading health once the footer unmounts", async () => {
    vi.useFakeTimers();
    const { unmount } = renderDiagnostics();
    await advance(0);
    unmount();

    await vi.advanceTimersByTimeAsync(HEALTH_POLL_INTERVAL_MS * 3);

    expect(fetchHealthMock).toHaveBeenCalledTimes(1);
  });
});
