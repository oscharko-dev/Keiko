// a11y smoke tests for the composed QI run card. jest-axe runs the WCAG 2.2 AA rule set across
// coverage states (Epic #734 / Issue #739), #748 quality badges + weak-test rationale flags, and
// inline-edit composition.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QiRunCard } from "./QiRunCard";
import type {
  QualityIntelligenceUiAtomCoverage,
  QualityIntelligenceUiCandidate,
  QualityIntelligenceUiRunDetail,
} from "@oscharko-dev/keiko-contracts";

function makeDetail(
  runId: string,
  coverageByAtom: readonly QualityIntelligenceUiAtomCoverage[],
  coveragePercentage: number,
  candidates: readonly QualityIntelligenceUiCandidate[] = [],
  qualityScore: number | null = null,
): QualityIntelligenceUiRunDetail {
  return {
    id: runId,
    status: "succeeded",
    requestedAt: "2026-06-01T10:00:00.000Z",
    completedAt: "2026-06-01T10:01:00.000Z",
    totals: { candidates: candidates.length, findings: coverageByAtom.length, exports: 0 },
    findingRefs: [],
    candidateIds: candidates.map((c) => c.id),
    candidates,
    evidenceRefs: [],
    reviewState: "open",
    manifestSchemaVersion: 1,
    coveragePercentage,
    coverageByAtom,
    qualityScore,
    drift: {
      status: "unavailable",
      sourceFingerprintCount: 0,
      atomFingerprintCount: 0,
      reCheckSupported: false,
      regenerateStaleSupported: false,
    },
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

describe("QiRunCard — a11y (WCAG 2.2 AA)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

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

  // Issue #748: the quality badge and weak-test rationale note live on the composed run card, so
  // scan that composed surface rather than only isolated helpers.
  it("has no violations with a quality score and weak-test rationale visible", async () => {
    const candidate: QualityIntelligenceUiCandidate = {
      id: "tc-a11y-weak",
      derivedFromAtomIds: ["atom-weak"],
      title: "Validate checkout shipping total",
      preconditions: ["Cart has one shippable item"],
      steps: ["Open checkout", "Wait for the order total"],
      expectedResults: ["The total includes shipping"],
      priority: "P1",
      riskClass: "functional",
      tags: ["checkout"],
      status: "proposed",
      reviewState: "open",
      weakTestFlag: {
        severity: "high",
        rationale:
          "AC fidelity: Misses the stated acceptance criteria.; Determinism: Relies on timing-sensitive behavior.",
      },
    };
    const { container } = render(
      <QiRunCard
        runId="qi-run-a11y-quality"
        fetchDetailImpl={fetchOk(makeDetail("qi-run-a11y-quality", [], 0, [candidate], 42))}
      />,
    );

    expect(await screen.findByTestId("qi-quality-badge")).toHaveTextContent("42 out of 100");
    expect(
      screen.getByRole("note", {
        name: /Weak test flagged by the quality judge: AC fidelity: Misses the stated acceptance criteria/i,
      }),
    ).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  // Issue #727 (Epic #712): the inline edit form must emit no axe violations on the FULL composed
  // run card — together with the reviewer-label governance input, the run heading, and the sr-only
  // live regions — not only as the isolated form scanned in CandidatesPane.a11y.test.tsx.
  it("has no violations with the inline edit form open on the full composed run card", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem("keiko.qi.reviewerLabel", "Alice");
    const candidate: QualityIntelligenceUiCandidate = {
      id: "tc-a11y-edit",
      derivedFromAtomIds: [],
      title: "Checkout total updates",
      preconditions: ["Cart has one item"],
      steps: ["Open the cart", "Apply a coupon"],
      expectedResults: ["Total reflects the discount"],
      priority: "P1",
      riskClass: "functional",
      tags: ["smoke"],
      status: "proposed",
      reviewState: "open",
    };
    const { container } = render(
      <QiRunCard
        runId="qi-run-a11y-edit"
        fetchDetailImpl={fetchOk(makeDetail("qi-run-a11y-edit", [], 0, [candidate]))}
      />,
    );
    await user.click(await screen.findByRole("button", { name: /^edit$/i }));
    expect(screen.getByRole("form", { name: /edit checkout total updates/i })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});
