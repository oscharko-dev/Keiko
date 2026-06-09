// a11y smoke tests for the QI inline-editing surface (Epic #712, Issue #727 — "accessible
// (keyboard + screen reader)"). jest-axe runs the WCAG 2.2 AA rule set; the candidate review/edit
// pane MUST emit zero violations in every state: review+edit enabled, governance-gated (controls
// aria-disabled with an associated reason), and with the inline edit form open.

import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { CandidatesPane } from "./CandidatesPane";
import type { QualityIntelligenceUiCandidate } from "@oscharko-dev/keiko-contracts";

function makeCandidate(
  overrides: Partial<QualityIntelligenceUiCandidate> = {},
): QualityIntelligenceUiCandidate {
  return {
    id: "tc-a11y-1",
    derivedFromAtomIds: [],
    title: "Test case under review",
    preconditions: ["User is logged in"],
    steps: ["Navigate to the page", "Click submit"],
    expectedResults: ["Form is submitted successfully"],
    priority: "P1",
    riskClass: "functional",
    tags: ["smoke"],
    status: "proposed",
    reviewState: "open",
    ...overrides,
  };
}

describe("CandidatesPane — a11y (WCAG 2.2 AA)", () => {
  it("has no violations with review + edit controls enabled", async () => {
    const { container } = render(
      <CandidatesPane candidates={[makeCandidate()]} onReview={vi.fn()} onEdit={vi.fn()} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no violations when actions are governance-disabled (aria-disabled + described reason)", async () => {
    const { container } = render(
      <CandidatesPane
        candidates={[makeCandidate()]}
        onReview={vi.fn()}
        onEdit={vi.fn()}
        actionsDisabled
        actionsDisabledReason="Set a reviewer label to review or edit candidates."
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no violations with the inline edit form open", async () => {
    const user = userEvent.setup();
    const { container, getByRole } = render(
      <CandidatesPane candidates={[makeCandidate()]} onEdit={vi.fn()} />,
    );
    await user.click(getByRole("button", { name: /^edit$/i }));
    expect(getByRole("textbox", { name: /^title$/i })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});
