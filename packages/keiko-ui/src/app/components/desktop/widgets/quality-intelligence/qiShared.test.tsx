// GEN-DUP-SEMANTIC-010: the run-status membership guard behind runStatusLabel / StatusBadge is now
// driven by the shared contracts constant QUALITY_INTELLIGENCE_RUN_STATUSES.includes, replacing an
// inline `s === "running" || …` chain. This matrix pins that the guard is byte-identical: every
// known status resolves to its human label + status-specific badge class, and any unknown status
// falls back to the raw value + the generic "qi-badge-default" class.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { QUALITY_INTELLIGENCE_RUN_STATUSES } from "@oscharko-dev/keiko-contracts";
import { StatusBadge, runStatusLabel } from "./qiShared";

const KNOWN: ReadonlyArray<readonly [string, string, string]> = [
  ["running", "Running", "qi-badge-running"],
  ["succeeded", "Succeeded", "qi-badge-succeeded"],
  ["failed", "Failed", "qi-badge-failed"],
  ["cancelled", "Cancelled", "qi-badge-cancelled"],
];

describe("qiShared run-status guard (GEN-DUP-SEMANTIC-010)", () => {
  it("tests exactly the statuses the shared contract enumerates", () => {
    expect([...QUALITY_INTELLIGENCE_RUN_STATUSES].sort()).toEqual(
      KNOWN.map(([status]) => status).sort(),
    );
  });

  for (const [status, label, cls] of KNOWN) {
    it(`labels known status "${status}" as "${label}"`, () => {
      expect(runStatusLabel(status)).toBe(label);
    });

    it(`renders the ${cls} badge for known status "${status}"`, () => {
      render(<StatusBadge status={status} />);
      const badge = screen.getByText(label);
      expect(badge).toHaveClass("qi-badge", cls);
    });
  }

  it("falls back to the raw value for an unknown status label", () => {
    expect(runStatusLabel("quantum-superposition")).toBe("quantum-superposition");
  });

  it("renders the generic default badge for an unknown status", () => {
    render(<StatusBadge status="quantum-superposition" />);
    const badge = screen.getByText("quantum-superposition");
    expect(badge).toHaveClass("qi-badge", "qi-badge-default");
  });
});
