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

const OMITTED_COUNTS_ZERO = {
  "outside-scope": 0,
  binary: 0,
  generated: 0,
  ignored: 0,
  "size-exceeded": 0,
  "near-duplicate": 0,
  "low-relevance": 0,
  "redacted-only": 0,
  "budget-exhausted": 0,
  "tool-unavailable": 0,
} as const;

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
    omittedCounts: OMITTED_COUNTS_ZERO,
    uncertaintyCount: 0,
    elapsedMs: 1_812,
    ...overrides,
  };
}

function answer(overrides: Partial<GroundedAnswerType> = {}): GroundedAnswerType {
  const base: Extract<GroundedAnswerType, { readonly groundingKind: "connected-context" }> = {
    groundingKind: "connected-context",
    userMessageId: "msg-u",
    assistantMessageId: "msg-a",
    content: "Inspected 1 file(s) for: how does MyClass work?",
    citations: [citation()],
    uncertainty: [],
    omittedCount: 0,
    elapsedMs: 42,
    contextPack: contextPack(),
  };
  return { ...base, ...overrides } as GroundedAnswerType;
}

describe("GroundedAnswer", () => {
  it("renders nothing when answer is undefined and not busy", () => {
    const { container } = render(<GroundedAnswer answer={undefined} busy={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the busy placeholder when answer is undefined and busy", () => {
    render(<GroundedAnswer answer={undefined} busy={true} />);
    expect(screen.getByText(/Exploring repository context/)).toBeInTheDocument();
  });

  it("renders the assistant content", () => {
    render(<GroundedAnswer answer={answer()} busy={false} />);
    expect(screen.getByText(/Inspected 1 file/)).toBeInTheDocument();
  });

  it("warns about partial coverage when files were too large or a binary format", () => {
    const a = answer({
      contextPack: contextPack({
        omittedCounts: { ...OMITTED_COUNTS_ZERO, "size-exceeded": 3, binary: 2 },
      }),
    });
    render(<GroundedAnswer answer={a} busy={false} />);
    const notice = screen.getByText(/Partial coverage/);
    expect(notice).toBeInTheDocument();
    // 3 + 2 = 5 files not searched, with each reason quantified.
    expect(screen.getByText(/5 files were not searched/)).toBeInTheDocument();
    expect(screen.getByText(/3 larger than 2 MB/)).toBeInTheDocument();
    expect(screen.getByText(/2 binary or an unsupported format/)).toBeInTheDocument();
  });

  it("does not warn about coverage when omissions are only relevance or noise filtering", () => {
    const a = answer({
      contextPack: contextPack({
        omittedCounts: { ...OMITTED_COUNTS_ZERO, "low-relevance": 9, ignored: 4 },
      }),
    });
    render(<GroundedAnswer answer={a} busy={false} />);
    expect(screen.queryByText(/Partial coverage/)).not.toBeInTheDocument();
  });

  it("renders local knowledge citations and summary when the answer is knowledge-grounded", () => {
    const a: GroundedAnswerType = {
      groundingKind: "local-knowledge",
      userMessageId: "lk-u",
      assistantMessageId: "lk-a",
      content: "Alpha is described in the indexed capsule [1].",
      citations: [
        {
          stableId: "lk-1",
          marker: "[1]",
          label: "alpha.md · section 1",
          score: 0.91,
          source: "Alpha Capsule / Product Manual",
        },
      ],
      uncertainty: [],
      omittedCount: 0,
      elapsedMs: 27,
      noEvidence: false,
      contextPack: {
        kind: "local-knowledge",
        scopeKind: "capsule",
        scopeId: "lk-1234",
        scopeLabel: "Alpha Capsule",
        capsuleCount: 1,
        sourceCount: 1,
        citationCount: 1,
        referenceBudget: 10,
        referencesUsed: 1,
      },
    };
    render(<GroundedAnswer answer={a} busy={false} />);
    expect(screen.getByText("Knowledge scope: Alpha Capsule")).toBeInTheDocument();
    expect(
      screen.getByText(/\[1\] Alpha Capsule \/ Product Manual · alpha\.md · section 1/),
    ).toBeInTheDocument();
    expect(screen.getByText("1 / 10 references")).toBeInTheDocument();
  });

  it("renders folder citations, connector citations, and the hybrid source summary for a hybrid answer", () => {
    const a: GroundedAnswerType = {
      groundingKind: "hybrid",
      userMessageId: "hy-u",
      assistantMessageId: "hy-a",
      content: "Merged from the marketing folder and the product manual.",
      citations: [citation()],
      knowledgeCitations: [
        {
          stableId: "hk-1",
          marker: "[1]",
          label: "manual.pdf · p.287",
          score: 0.88,
          source: "Quasar Manual / Product Docs",
        },
      ],
      uncertainty: [],
      omittedCount: 0,
      elapsedMs: 55,
      contextPack: {
        kind: "hybrid",
        folderSourceCount: 2,
        connectorSourceCount: 1,
        folder: contextPack(),
        knowledge: {
          kind: "local-knowledge",
          scopeKind: "capsule",
          scopeId: "lk-9",
          scopeLabel: "Quasar Manual",
          capsuleCount: 1,
          sourceCount: 1,
          citationCount: 1,
          referenceBudget: 10,
          referencesUsed: 1,
        },
      },
    };
    render(<GroundedAnswer answer={a} busy={false} />);
    expect(screen.getByText(/Merged from the marketing folder/)).toBeInTheDocument();
    expect(screen.getByText(/src\/foo\.ts/)).toBeInTheDocument();
    expect(screen.getByText(/\[1\] Quasar Manual \/ Product Docs · manual\.pdf · p\.287/)).toBeInTheDocument();
    expect(screen.getByText("Hybrid: 2 folder sources + 1 connector source")).toBeInTheDocument();
    expect(screen.getByText("Knowledge scope: Quasar Manual")).toBeInTheDocument();
  });

  it("renders one static evidence reference per citation with the path:start-end label", () => {
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
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText("src/foo.ts:1-4")).toBeInTheDocument();
    expect(screen.getByText("src/bar.ts:10-12")).toBeInTheDocument();
    expect(screen.getByText("src/foo.ts:1-4").closest(".grounded-citation")).toHaveAttribute(
      "title",
      "Evidence citation in src/foo.ts at lines 1-4",
    );
  });

  it("renders the scopePath alone when the citation has no lineRange", () => {
    const a = answer({
      citations: [citation({ lineRange: undefined, scopePath: "src/qux.ts", stableId: "q" })],
    });
    render(<GroundedAnswer answer={a} busy={false} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText("src/qux.ts").closest(".grounded-citation")).toHaveAttribute(
      "title",
      "Evidence citation in src/qux.ts",
    );
  });

  it("renders the uncertainty marker count, deduped kinds, and claims", () => {
    const a = answer({
      uncertainty: [
        uncertainty({ kind: "no-evidence" }),
        uncertainty({ kind: "no-evidence", claim: "other" }),
        uncertainty({ kind: "budget-clipped", claim: "clipped at foo" }),
      ],
    });
    render(<GroundedAnswer answer={a} busy={false} />);
    expect(
      screen.getByText("Uncertainty (3 markers — no-evidence, budget-clipped)"),
    ).toBeInTheDocument();
    expect(screen.getByText("no-evidence: excerpt unavailable for src/baz.ts")).toBeInTheDocument();
    expect(screen.getByText("no-evidence: other")).toBeInTheDocument();
    expect(screen.getByText("budget-clipped: clipped at foo")).toBeInTheDocument();
  });

  it("does not render an uncertainty line when there are no markers", () => {
    render(<GroundedAnswer answer={answer()} busy={false} />);
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("renders the omitted count when > 0", () => {
    render(
      <GroundedAnswer
        answer={answer({
          omittedCount: 3,
          contextPack: contextPack({
            omittedCount: 3,
            omittedCounts: { ...OMITTED_COUNTS_ZERO, binary: 1, "low-relevance": 2 },
          }),
        })}
        busy={false}
      />,
    );
    expect(
      screen.getByText("Omitted: 3 evidence atoms (binary: 1, low relevance: 2)"),
    ).toBeInTheDocument();
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

  it("surfaces every context-pack usage and budget dimension as metric rows", () => {
    render(<GroundedAnswer answer={answer()} busy={false} />);
    const region = screen.getByRole("region", { name: "Context inspection summary" });
    expect(region.textContent).toContain("Searched");
    expect(region.textContent).toContain("3× / 16");
    expect(region.textContent).toContain("Read");
    expect(region.textContent).toContain("5 / 32 files");
    expect(region.textContent).toContain("Bytes");
    expect(region.textContent).toContain("12400 / 131072 B");
    expect(region.textContent).toContain("Input");
    expect(region.textContent).toContain("1500 / 32000 tokens");
    expect(region.textContent).toContain("Output");
    expect(region.textContent).toContain("400 / 4096 tokens");
    expect(region.textContent).toContain("Rerank");
    expect(region.textContent).toContain("0 / 0 calls");
    expect(region.textContent).toContain("Time");
    expect(region.textContent).toContain("1812 / 30000 ms");
    expect(region.textContent).toContain("Query");
    expect(region.textContent).toContain("natural-language");
  });

  it("links to the local connected-context audit evidence when a run id is present", () => {
    render(<GroundedAnswer answer={answer({ evidenceRunId: "grounded-run-1" })} busy={false} />);
    expect(
      screen.getByRole("link", { name: "View connected-context audit evidence" }),
    ).toHaveAttribute("href", "/api/evidence/grounded-run-1");
  });

  it("renders HTML payload in answer.content as escaped text, not live markup", () => {
    // Mutation guard: replacing `{answer.content}` with
    // `<div dangerouslySetInnerHTML={{__html: answer.content}}/>` must fail this test.
    const { container } = render(
      <GroundedAnswer answer={answer({ content: "<script>alert(1)</script>" })} busy={false} />,
    );
    expect(container.textContent).toContain("<script>alert(1)</script>");
    expect(container.querySelectorAll("script")).toHaveLength(0);
  });
});
