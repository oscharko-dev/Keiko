// Issue #185 — unit tests for the grounded Q&A presentation component. Extended in #187
// with ContextPackSummary coverage and an axe-based a11y smoke.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GroundedAnswer } from "./GroundedAnswer";
import type {
  GroundedAnswer as GroundedAnswerType,
  GroundedAnswerContextPackSummary,
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

function contextPack(
  overrides: Partial<GroundedAnswerContextPackSummary> = {},
): GroundedAnswerContextPackSummary {
  return {
    schemaVersion: "1",
    scopeId: "cs-deadbeefcafef00d",
    scopeKind: "files",
    fileCount: 2,
    queryKind: "natural-language",
    usage: {
      searchCalls: 3,
      filesRead: 5,
      excerptBytes: 12_400,
      modelInputTokens: 1_500,
      modelOutputTokens: 400,
      elapsedMs: 1_800,
      rerankCalls: 0,
    },
    budget: {
      searchCallsMax: 16,
      filesReadMax: 32,
      excerptBytesMax: 131_072,
      modelInputTokensMax: 32_000,
      modelOutputTokensMax: 4_096,
      elapsedMsMax: 30_000,
      rerankCallsMax: 0,
    },
    citationCount: 1,
    omittedCount: 0,
    uncertaintyCount: 0,
    elapsedMs: 1_812,
    ...overrides,
  };
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
    contextPack: contextPack(),
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

  // ─── Issue #187: ContextPackSummary ─────────────────────────────────────────

  it("renders the context inspection summary region for a files-scope answer", () => {
    render(<GroundedAnswer answer={answer()} busy={false} />);
    const region = screen.getByRole("region", { name: "Context inspection summary" });
    expect(region).toBeInTheDocument();
    expect(region.textContent).toContain("Scope: 2 files in files");
  });

  it("workspace-root scope renders the literal 'workspace root' and omits the file count", () => {
    const a = answer({
      contextPack: contextPack({ scopeKind: "workspace-root", fileCount: -1 }),
    });
    render(<GroundedAnswer answer={a} busy={false} />);
    const region = screen.getByRole("region", { name: "Context inspection summary" });
    expect(region.textContent).toContain("Scope: workspace root");
    expect(region.textContent).not.toContain("-1");
  });

  it("directory scope shows a truncated scopeId suffix (last 8 hex chars)", () => {
    const a = answer({
      contextPack: contextPack({
        scopeKind: "directory",
        fileCount: 1,
        scopeId: "cs-1234567890abcdef",
      }),
    });
    render(<GroundedAnswer answer={a} busy={false} />);
    const region = screen.getByRole("region", { name: "Context inspection summary" });
    expect(region.textContent).toContain("directory (90abcdef)");
    expect(region.textContent).not.toContain("cs-1234567890abcdef");
  });

  it("renders '—' for budget caps equal to Infinity", () => {
    const a = answer({
      contextPack: contextPack({
        budget: {
          ...contextPack().budget,
          searchCallsMax: Number.POSITIVE_INFINITY,
          elapsedMsMax: Number.POSITIVE_INFINITY,
        },
      }),
    });
    render(<GroundedAnswer answer={a} busy={false} />);
    const region = screen.getByRole("region", { name: "Context inspection summary" });
    expect(region.textContent).not.toContain("Infinity");
    expect(region.textContent).toContain("—");
  });

  it("surfaces searchCalls, filesRead, excerptBytes, elapsedMs, and queryKind as metric rows", () => {
    render(<GroundedAnswer answer={answer()} busy={false} />);
    const region = screen.getByRole("region", { name: "Context inspection summary" });
    expect(region.textContent).toContain("Searched");
    expect(region.textContent).toContain("3× / 16");
    expect(region.textContent).toContain("Read");
    expect(region.textContent).toContain("5 / 32 files");
    expect(region.textContent).toContain("Bytes");
    expect(region.textContent).toContain("12400 / 131072 B");
    expect(region.textContent).toContain("Time");
    expect(region.textContent).toContain("1812 / 30000 ms");
    expect(region.textContent).toContain("Query");
    expect(region.textContent).toContain("natural-language");
  });
});
