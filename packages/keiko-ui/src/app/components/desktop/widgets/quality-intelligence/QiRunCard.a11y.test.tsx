// a11y smoke tests for the QI Coverage / Gap-Radar panel (Epic #734, Issue #739 — "coverage states
// accessible (text + ARIA, NOT colour alone)"). jest-axe runs the WCAG 2.2 AA rule set; the panel
// MUST emit zero violations whether the run is fully covered or has uncovered/weakly-covered gaps.

import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { QiRunCard } from "./QiRunCard";
import type {
  QualityIntelligenceUiAtomCoverage,
  QualityIntelligenceUiRunDetail,
} from "@oscharko-dev/keiko-contracts";

function makeDetail(
  runId: string,
  coverageByAtom: readonly QualityIntelligenceUiAtomCoverage[],
  coveragePercentage: number,
): QualityIntelligenceUiRunDetail {
  return {
    id: runId,
    status: "succeeded",
    requestedAt: "2026-06-01T10:00:00.000Z",
    completedAt: "2026-06-01T10:01:00.000Z",
    totals: { candidates: 0, findings: coverageByAtom.length, exports: 0 },
    findingRefs: [],
    candidateIds: [],
    candidates: [],
    evidenceRefs: [],
    reviewState: "open",
    manifestSchemaVersion: 1,
    coveragePercentage,
    coverageByAtom,
    qualityScore: null,
  };
}

const fetchOk = (
  detail: QualityIntelligenceUiRunDetail,
): typeof import("@/lib/quality-intelligence-api").fetchQiRunDetail =>
  vi
    .fn()
    .mockResolvedValue(
      detail,
    ) as unknown as typeof import("@/lib/quality-intelligence-api").fetchQiRunDetail;

describe("QiRunCard coverage panel — a11y (WCAG 2.2 AA)", () => {
  it("has no violations with mixed coverage states (covered / weakly-covered / uncovered)", async () => {
    const atoms: QualityIntelligenceUiAtomCoverage[] = [
      { atomId: "atom-1", status: "covered", confidence: 0.9 },
      { atomId: "atom-2", status: "weakly-covered", confidence: 0.5 },
      { atomId: "atom-3", status: "uncovered", confidence: 0 },
    ];
    const { container } = render(
      <QiRunCard
        runId="qi-run-a11y-1"
        fetchDetailImpl={fetchOk(makeDetail("qi-run-a11y-1", atoms, 33))}
      />,
    );
    await screen.findByTestId("qi-coverage-pct");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("conveys each gap status with a text label, not colour alone", async () => {
    const atoms: QualityIntelligenceUiAtomCoverage[] = [
      { atomId: "atom-weak", status: "weakly-covered", confidence: 0.5 },
      { atomId: "atom-gap", status: "uncovered", confidence: 0 },
    ];
    render(
      <QiRunCard
        runId="qi-run-a11y-2"
        fetchDetailImpl={fetchOk(makeDetail("qi-run-a11y-2", atoms, 0))}
      />,
    );
    // Both the visible label and an accessible name carry the status — colour is decorative only.
    expect(await screen.findByLabelText(/Atom atom-weak: Weakly covered/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Atom atom-gap: Uncovered/i)).toBeInTheDocument();
  });
});
