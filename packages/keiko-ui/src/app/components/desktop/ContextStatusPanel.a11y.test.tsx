// ADR-0057 D2 — a11y smoke test for the ContextStatusPanel. jest-axe runs the WCAG 2.2 AA rule
// set against BOTH the default collapsed state and the expanded (<details open>) state, because
// the disclosure content is only present in the accessibility tree when the panel is open.

import { render } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";
import { ContextStatusPanel } from "./ContextStatusPanel";
import type { ContextLaneId, GroundedAnswerContextSummary } from "@/lib/types";

const ALL_LANES: readonly ContextLaneId[] = [
  "system-contract",
  "user-task",
  "active-plan",
  "repo-evidence",
  "tool-observations",
  "working-memory",
  "history-summary",
  "verification-evidence",
];

function fullSummary(): GroundedAnswerContextSummary {
  const counts = {} as Record<ContextLaneId, number>;
  for (const lane of ALL_LANES) {
    counts[lane] = 4;
  }
  return {
    totalEstimatedTokens: 34_000,
    budgetPressure: "high",
    laneCounts: counts,
    compactionActive: true,
  };
}

describe("ContextStatusPanel a11y", () => {
  it("jest-axe: collapsed (default) state has no violations", async () => {
    const { container } = render(<ContextStatusPanel contextSummary={fullSummary()} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("jest-axe: expanded state has no violations", async () => {
    const { container } = render(<ContextStatusPanel contextSummary={fullSummary()} />);
    const details = container.querySelector("details.ctx-status");
    details?.setAttribute("open", "");
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
