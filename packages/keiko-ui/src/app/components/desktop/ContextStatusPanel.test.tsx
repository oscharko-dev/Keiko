// ADR-0057 D2 / D4 — behavioural + path-free tests for the ContextStatusPanel. The panel is the
// browser-visible aggregate of the deterministic context-assembly pass; it must (a) render nothing
// for legacy / non-profiled answers, (b) stay collapsed by default, (c) show the aggregate rows
// (token total, pressure, populated lane counts, compaction), and (d) NEVER leak a path. The
// path-leak gate renders every lane populated and asserts the rendered text carries no "/" and no
// fixture path/scope string — the structural complement to the type-level path-free guarantee.

import { render } from "@testing-library/react";
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

// Returns a MUTABLE record so individual lanes can be overridden by callers before it widens to
// the readonly wire shape at the `summary()` boundary.
function laneCounts(value: number): Record<ContextLaneId, number> {
  const counts = {} as Record<ContextLaneId, number>;
  for (const lane of ALL_LANES) {
    counts[lane] = value;
  }
  return counts;
}

function summary(
  overrides: Partial<GroundedAnswerContextSummary> = {},
): GroundedAnswerContextSummary {
  return {
    totalEstimatedTokens: 34_000,
    budgetPressure: "moderate",
    laneCounts: laneCounts(0),
    compactionActive: false,
    ...overrides,
  };
}

describe("ContextStatusPanel", () => {
  it("renders null when contextSummary is undefined (legacy / non-profiled turn)", () => {
    const { container } = render(<ContextStatusPanel contextSummary={undefined} />);
    expect(container.querySelector(".ctx-status")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("renders a <details> that is collapsed by default (no open attribute)", () => {
    const { container } = render(<ContextStatusPanel contextSummary={summary()} />);
    const details = container.querySelector("details.ctx-status");
    expect(details).not.toBeNull();
    expect(details?.hasAttribute("open")).toBe(false);
  });

  it("renders the token total, pressure label, and compaction status as aggregate rows", () => {
    const { container } = render(
      <ContextStatusPanel
        contextSummary={summary({ totalEstimatedTokens: 34_000, compactionActive: true })}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Estimated");
    expect(text).toContain("34.0k tok");
    expect(text).toContain("Budget pressure");
    expect(text).toContain("Moderate");
    expect(text).toContain("Compaction");
    expect(text).toContain("Active");
  });

  it("shows Inactive when compaction did not fire", () => {
    const { container } = render(
      <ContextStatusPanel contextSummary={summary({ compactionActive: false })} />,
    );
    expect(container.textContent).toContain("Inactive");
  });

  it("renders only lanes with a count > 0, humanized, with the integer count", () => {
    const counts = laneCounts(0);
    counts["repo-evidence"] = 7;
    counts["system-contract"] = 1;
    const { container } = render(
      <ContextStatusPanel contextSummary={summary({ laneCounts: counts })} />,
    );
    const dts = Array.from(container.querySelectorAll(".grounded-context-pack-dt")).map(
      (dt) => dt.textContent,
    );
    expect(dts).toContain("repo evidence");
    expect(dts).toContain("system contract");
    // Zero-count lanes are omitted.
    expect(dts).not.toContain("working memory");
    const text = container.textContent ?? "";
    expect(text).toContain("7");
    expect(text).toContain("1");
  });

  it("PATH-LEAK GATE: with every lane populated, renders no '/' and no path/scope fixture string", () => {
    const { container } = render(
      <ContextStatusPanel
        contextSummary={summary({ laneCounts: laneCounts(3), budgetPressure: "exceeded" })}
      />,
    );
    const text = container.textContent ?? "";
    // Structural path-free gate (ADR-0057 D4): all values are counts/tokens/enum/boolean, so a
    // path could only appear via an implementation bug. A forward slash, a backslash, or any of
    // the canonical fixture path/scope strings must be absent.
    expect(text).not.toContain("/");
    expect(text).not.toContain("\\");
    expect(text).not.toContain("src/");
    expect(text).not.toContain("cs-");
    expect(text).not.toContain("scopeId");
    expect(text).not.toContain(".ts");
  });
});
