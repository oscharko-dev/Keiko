import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import type { BackendHealth } from "./hooks/useBackendHealth";
import { axe } from "jest-axe";
import * as reportApi from "@/lib/support-report-api";
import { canonicalSupportReportFixture } from "@/test-utils/support-report-fixture";
import { resetSupportReportOutcomesForTests } from "./SupportReportButton";
import { DiagnosticReadinessNotice } from "./DiagnosticReadinessNotice";

function renderNotice(health: BackendHealth): ReturnType<typeof render> {
  return render(
    <I18nProvider>
      <DiagnosticReadinessNotice health={health} />
    </I18nProvider>,
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetSupportReportOutcomesForTests();
  window.localStorage.removeItem("keiko.locale");
});

describe("DiagnosticReadinessNotice", () => {
  it.each(["pending", "ready"] as const)(
    "preserves a %s report through health recovery",
    async (phase) => {
      const report = await canonicalSupportReportFixture();
      let resolveReport: ((value: typeof report) => void) | undefined;
      const create = vi.spyOn(reportApi, "createSupportReport").mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveReport = resolve;
          }),
      );
      const dispose = vi.fn();
      vi.spyOn(reportApi, "createSupportReportDownload").mockReturnValue({
        href: "blob:readiness-report",
        dispose,
      });
      const view = renderNotice({ state: "unavailable" });
      fireEvent.click(screen.getByRole("button", { name: "Create error report" }));
      await vi.waitFor(() => {
        expect(create).toHaveBeenCalledOnce();
      });
      if (phase === "ready") {
        resolveReport?.(report);
        await screen.findByRole("link", { name: "Download report" });
      }
      view.rerender(
        <I18nProvider>
          <DiagnosticReadinessNotice
            health={{ state: "loaded", health: { status: "ok", version: "1.2.3" } }}
          />
        </I18nProvider>,
      );
      if (phase === "pending") resolveReport?.(report);
      expect(await screen.findByRole("link", { name: "Download report" })).toHaveAttribute(
        "href",
        "blob:readiness-report",
      );
      expect(
        screen.queryByText("Error reports may currently be incomplete."),
      ).not.toBeInTheDocument();
      expect(dispose).not.toHaveBeenCalled();
      view.rerender(
        <I18nProvider>
          <DiagnosticReadinessNotice health={{ state: "unavailable" }} />
        </I18nProvider>,
      );
      expect(screen.getByRole("link", { name: "Download report" })).toHaveAttribute(
        "href",
        "blob:readiness-report",
      );
      expect(create).toHaveBeenCalledOnce();
    },
  );

  it("keeps the recovered download reachable after regeneration fails", async () => {
    const report = await canonicalSupportReportFixture();
    const create = vi.spyOn(reportApi, "createSupportReport").mockResolvedValueOnce(report);
    const dispose = vi.fn();
    vi.spyOn(reportApi, "createSupportReportDownload").mockReturnValue({
      href: "blob:prior-ready",
      dispose,
    });
    const view = renderNotice({ state: "unavailable" });
    fireEvent.click(screen.getByRole("button", { name: "Create error report" }));
    await screen.findByRole("link", { name: "Download report" });
    view.rerender(
      <I18nProvider>
        <DiagnosticReadinessNotice
          health={{ state: "loaded", health: { status: "ok", version: "1.2.3" } }}
        />
      </I18nProvider>,
    );
    create.mockRejectedValueOnce(new reportApi.SupportReportResponseInvalid("Invalid response"));
    fireEvent.click(screen.getByRole("button", { name: "Regenerate report" }));
    await vi.waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("Report unavailable");
    });
    expect(screen.getByRole("link", { name: "Download report" })).toHaveAttribute(
      "href",
      "blob:prior-ready",
    );
    expect(dispose).not.toHaveBeenCalled();
  });

  it("expires the recovered target while retaining regeneration and separate live regions", async () => {
    const report = await canonicalSupportReportFixture();
    vi.useFakeTimers();
    vi.spyOn(reportApi, "createSupportReport").mockResolvedValue(report);
    const dispose = vi.fn();
    vi.spyOn(reportApi, "createSupportReportDownload").mockReturnValue({
      href: "/api/diagnostics/report/download/expiring",
      expiresAtMs: Date.now() + 60_000,
      dispose,
    });
    const view = renderNotice({ state: "unavailable" });
    fireEvent.click(screen.getByRole("button", { name: "Create error report" }));
    await vi.waitFor(() => {
      expect(screen.getByRole("link", { name: "Download report" })).toBeInTheDocument();
    });
    expect(view.container.querySelector("output output")).toBeNull();
    view.rerender(
      <I18nProvider>
        <DiagnosticReadinessNotice
          health={{ state: "loaded", health: { status: "ok", version: "1.2.3" } }}
        />
      </I18nProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.queryByRole("link", { name: "Download report" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Regenerate report" })).toBeEnabled();
    expect(dispose).toHaveBeenCalledOnce();
    vi.useRealTimers();
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it("keeps a ready or loading workspace quiet", () => {
    const view = renderNotice({ state: "loading" });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    view.rerender(
      <I18nProvider>
        <DiagnosticReadinessNotice
          health={{ state: "loaded", health: { status: "ok", version: "1.2.3" } }}
        />
      </I18nProvider>,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it.each(["degraded", "unavailable"] as const)(
    "makes %s readiness visible without an archive, capacity counter or internal reasons",
    (readiness) => {
      renderNotice({
        state: "loaded",
        health: {
          status: "ok",
          version: "1.2.3",
          diagnostics: {
            readiness,
            reasons: ["sink-unwritable"],
            writer: "production-file",
            lostEvents: 2,
            retainedDiagnosticCount: 32,
            diagnosticCapacity: 32,
          },
        },
      });
      const readinessStatus = screen
        .getAllByRole("status")
        .filter((status) => status.textContent === "Error reports may currently be incomplete.");
      expect(readinessStatus).toHaveLength(1);
      expect(readinessStatus[0]).toHaveTextContent("Error reports may currently be incomplete.");
      expect(screen.getByRole("button", { name: "Create error report" })).toBeEnabled();
      expect(screen.queryByText(/32|sink-unwritable/u)).not.toBeInTheDocument();
    },
  );

  it("offers the same report action when the backend cannot be reached", () => {
    renderNotice({ state: "unavailable" });
    expect(screen.getByRole("button", { name: "Create error report" })).toBeEnabled();
  });
});

it.each(["en", "de"])("announces invalid readiness accessibly in %s", async (locale) => {
  window.localStorage.setItem("keiko.locale", locale);
  const health = { status: "ok" as const, version: "1.2.3", diagnosticsInvalid: true as const };
  const view = renderNotice({ state: "loaded", health });
  expect(
    await screen.findByText(
      locale === "de"
        ? "Fehlerberichte können derzeit unvollständig sein."
        : "Error reports may currently be incomplete.",
    ),
  ).toBeVisible();
  expect(view.container.querySelector("output output")).toBeNull();
  expect(await axe(view.container)).toHaveNoViolations();
});
