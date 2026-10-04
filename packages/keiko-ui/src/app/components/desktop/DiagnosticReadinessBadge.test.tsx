// #3532: the footer's Activity Log readiness indicator. Hidden while diagnostic evidence is
// complete; otherwise it names the state and every closed reason, in both shipped languages.

import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACTIVITY_LOG_READINESS_REASONS,
  type ActivityLogReadinessSnapshot,
} from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { I18nProvider } from "@/lib/i18n";
import { DiagnosticReadinessBadge } from "./DiagnosticReadinessBadge";

function snapshot(patch: Partial<ActivityLogReadinessSnapshot> = {}): ActivityLogReadinessSnapshot {
  return {
    readiness: "degraded",
    reasons: ["storage-pressure"],
    writer: "production-file",
    lostEvents: 0,
    ...patch,
  };
}

afterEach(() => {
  window.localStorage.removeItem("keiko.locale");
  document.documentElement.lang = "en";
  document.documentElement.removeAttribute("data-locale");
});

describe("DiagnosticReadinessBadge", () => {
  it("renders nothing without a snapshot or while diagnostic evidence is ready", () => {
    const { container, rerender } = render(<DiagnosticReadinessBadge snapshot={undefined} />);
    expect(container).toBeEmptyDOMElement();

    rerender(<DiagnosticReadinessBadge snapshot={snapshot({ readiness: "ready", reasons: [] })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows saved records without presenting retention capacity as a quota", () => {
    const { container } = render(
      <DiagnosticReadinessBadge
        snapshot={snapshot({
          readiness: "ready",
          reasons: [],
          retainedDiagnosticCount: 32,
          diagnosticCapacity: 32,
        })}
      />,
    );
    expect(screen.getByText("32 saved diagnostic records")).toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute("data-readiness", "ready");
    expect(container).not.toHaveTextContent("32/32");
    expect(screen.getByText(/Storage retains up to 32 recent records/u)).toBeInTheDocument();
    expect(
      screen.getByText(/Saved diagnostic records, not confirmed or open errors/u),
    ).toBeInTheDocument();
    expect(screen.getByText(/Error reports remain available/u)).toBeInTheDocument();
    expect(screen.queryByText("Diagnostics degraded")).toBeNull();
  });

  it("describes retained candidates honestly in German", async () => {
    window.localStorage.setItem("keiko.locale", "de");
    render(
      <I18nProvider>
        <DiagnosticReadinessBadge
          snapshot={snapshot({
            readiness: "ready",
            reasons: [],
            retainedDiagnosticCount: 32,
            diagnosticCapacity: 32,
          })}
        />
      </I18nProvider>,
    );
    expect(await screen.findByText("32 gespeicherte Diagnoseeinträge")).toBeInTheDocument();
    expect(screen.getByText(/keine bestätigten oder offenen Fehler/u)).toBeInTheDocument();
    expect(
      screen.getByText(/Fehlerberichte bleiben auch bei vollem Speicher verfügbar/u),
    ).toBeInTheDocument();
  });

  it("keeps writer degradation visible alongside the neutral candidate count", () => {
    render(
      <DiagnosticReadinessBadge
        snapshot={snapshot({ retainedDiagnosticCount: 3, diagnosticCapacity: 32 })}
      />,
    );
    expect(screen.getByText(/Diagnostics degraded/u)).toBeInTheDocument();
    expect(screen.getByText(/3 saved diagnostic records/u)).toBeInTheDocument();
  });

  it("names a degraded state and describes it with its reason", () => {
    const { container } = render(<DiagnosticReadinessBadge snapshot={snapshot()} />);
    const detail =
      "Keiko cannot record complete diagnostic evidence: log storage under pressure. Run keiko status for details.";

    expect(screen.getByText("Diagnostics degraded")).toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute("data-readiness", "degraded");
    expect(container.firstElementChild).toHaveAttribute("data-tip", detail);
    // The description reaches assistive technology as text, not only as a hover tooltip.
    expect(screen.getByText(detail)).toHaveClass("sr-only");
  });

  it("names an unavailable state and every reason it carries, in order", () => {
    const { container } = render(
      <DiagnosticReadinessBadge
        snapshot={snapshot({
          readiness: "unavailable",
          reasons: ["catalog-mismatch", "sink-unwritable"],
        })}
      />,
    );

    expect(screen.getByText("Diagnostics unavailable")).toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute("data-readiness", "unavailable");
    expect(screen.getByText(/: log catalog mismatch, log not writable\./u)).toBeInTheDocument();
  });

  it("gives every closed readiness reason its own message", () => {
    const details = ACTIVITY_LOG_READINESS_REASONS.map((reason) => {
      const { container, unmount } = render(
        <DiagnosticReadinessBadge snapshot={snapshot({ reasons: [reason] })} />,
      );
      const detail = container.firstElementChild?.getAttribute("data-tip");
      unmount();
      return detail;
    });

    expect(details.every((detail) => typeof detail === "string")).toBe(true);
    expect(new Set(details).size).toBe(ACTIVITY_LOG_READINESS_REASONS.length);
  });

  it("speaks German when the German locale is active", async () => {
    window.localStorage.setItem("keiko.locale", "de");
    render(
      <I18nProvider>
        <DiagnosticReadinessBadge snapshot={snapshot()} />
      </I18nProvider>,
    );

    expect(await screen.findByText("Diagnose eingeschränkt")).toBeInTheDocument();
    expect(screen.getByText(/: Protokollspeicher unter Druck\./u)).toBeInTheDocument();
  });

  it("exposes no axe violations inside the footer landmark", async () => {
    const { container } = render(
      <footer aria-label="Workspace status">
        <DiagnosticReadinessBadge snapshot={snapshot({ readiness: "unavailable" })} />
      </footer>,
    );

    expect(await axe(container)).toHaveNoViolations();
  });
});
