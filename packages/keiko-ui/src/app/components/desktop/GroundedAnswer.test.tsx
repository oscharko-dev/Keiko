// Issue #185 — unit tests for the grounded Q&A presentation component.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GroundedAnswer } from "./GroundedAnswer";
import type {
  GroundedAnswer as GroundedAnswerType,
  GroundedEvidenceCitation,
  GroundedUncertainty,
} from "@/lib/types";

function citation(overrides: Partial<GroundedEvidenceCitation> = {}): GroundedEvidenceCitation {
  return {
    scopePath: "src/foo.ts",
    lineRange: { startLine: 10, endLine: 25 },
    score: 0.87,
    stableId: "atom-1",
    ...overrides,
  };
}

function uncertainty(overrides: Partial<GroundedUncertainty> = {}): GroundedUncertainty {
  return { kind: "no-evidence", claim: "excerpt unavailable for src/baz.ts", ...overrides };
}

function answer(overrides: Partial<GroundedAnswerType> = {}): GroundedAnswerType {
  return {
    userMessageId: "msg-u",
    assistantMessageId: "msg-a",
    content: "Inspected 1 file(s) for: how does MyClass work?",
    citations: [citation()],
    uncertainty: [],
    omittedCount: 0,
    elapsedMs: 42,
    ...overrides,
  };
}

describe("GroundedAnswer", () => {
  it("renders nothing when answer is undefined and not busy", () => {
    const { container } = render(<GroundedAnswer answer={undefined} busy={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the busy placeholder when answer is undefined and busy", () => {
    render(<GroundedAnswer answer={undefined} busy={true} />);
    expect(screen.getByText(/Asking Keiko/)).toBeInTheDocument();
  });

  it("renders the assistant content", () => {
    render(<GroundedAnswer answer={answer()} busy={false} />);
    expect(screen.getByText(/Inspected 1 file/)).toBeInTheDocument();
  });

  it("renders one button per citation with the path:start-end label", () => {
    const a = answer({
      citations: [
        citation({
          stableId: "a",
          scopePath: "src/foo.ts",
          lineRange: { startLine: 1, endLine: 4 },
        }),
        citation({
          stableId: "b",
          scopePath: "src/bar.ts",
          lineRange: { startLine: 10, endLine: 12 },
          score: 0.55,
        }),
      ],
    });
    render(<GroundedAnswer answer={a} busy={false} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.textContent).toContain("src/foo.ts:1-4");
    expect(buttons[1]?.textContent).toContain("src/bar.ts:10-12");
    expect(buttons[0]?.getAttribute("aria-label")).toContain("src/foo.ts");
    expect(buttons[0]?.getAttribute("aria-label")).toContain("lines 1-4");
  });

  it("renders the scopePath alone when the citation has no lineRange", () => {
    const a = answer({
      citations: [citation({ lineRange: undefined, scopePath: "src/qux.ts", stableId: "q" })],
    });
    render(<GroundedAnswer answer={a} busy={false} />);
    const button = screen.getByRole("button");
    expect(button.textContent).toContain("src/qux.ts");
    expect(button.getAttribute("aria-label")).toBe("Evidence citation in src/qux.ts");
  });

  it("renders the uncertainty marker count + deduped kinds", () => {
    const a = answer({
      uncertainty: [
        uncertainty({ kind: "no-evidence" }),
        uncertainty({ kind: "no-evidence", claim: "other" }),
        uncertainty({ kind: "budget-clipped", claim: "clipped at foo" }),
      ],
    });
    render(<GroundedAnswer answer={a} busy={false} />);
    expect(screen.getByText("(3 markers — no-evidence, budget-clipped)")).toBeInTheDocument();
  });

  it("does not render an uncertainty line when there are no markers", () => {
    render(<GroundedAnswer answer={answer()} busy={false} />);
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("renders the omitted count when > 0", () => {
    render(<GroundedAnswer answer={answer({ omittedCount: 3 })} busy={false} />);
    expect(screen.getByText("Omitted: 3 evidence atoms")).toBeInTheDocument();
  });

  it("does not render an omitted line when count is 0", () => {
    render(<GroundedAnswer answer={answer({ omittedCount: 0 })} busy={false} />);
    expect(screen.queryByText(/Omitted:/)).toBeNull();
  });
});
