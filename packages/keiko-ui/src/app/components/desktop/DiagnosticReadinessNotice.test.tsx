import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import type { BackendHealth } from "./hooks/useBackendHealth";
import { DiagnosticReadinessNotice } from "./DiagnosticReadinessNotice";

vi.mock("./SupportReportButton", () => ({
  SupportReportButton: (): ReactNode => <button type="button">Create error report</button>,
}));

function renderNotice(health: BackendHealth): ReturnType<typeof render> {
  return render(
    <I18nProvider>
      <DiagnosticReadinessNotice health={health} />
    </I18nProvider>,
  );
}

afterEach(() => {
  window.localStorage.removeItem("keiko.locale");
});

describe("DiagnosticReadinessNotice", () => {
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
      expect(screen.getByRole("status")).toHaveTextContent(
        "Error reports may currently be incomplete.",
      );
      expect(screen.getByRole("button", { name: "Create error report" })).toBeEnabled();
      expect(screen.queryByText(/32|sink-unwritable/u)).not.toBeInTheDocument();
    },
  );

  it("offers the same report action when the backend cannot be reached", () => {
    renderNotice({ state: "unavailable" });
    expect(screen.getByRole("button", { name: "Create error report" })).toBeEnabled();
  });
});
