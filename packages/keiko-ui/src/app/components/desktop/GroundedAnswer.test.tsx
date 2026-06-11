// Issue #185 — unit tests for the grounded Q&A presentation component. Extended in #187
// with ContextPackSummary coverage and an axe-based a11y smoke.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GroundedAnswer } from "./GroundedAnswer";
import type {
  GroundedAnswer as GroundedAnswerType,
  GroundedAnswerContextPackSummary,
  GroundedEvidenceCitation,
  GroundedUncertainty,
  LocalKnowledgeEvidenceCitation,
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

function knowledgeCitation(
  overrides: Partial<LocalKnowledgeEvidenceCitation> = {},
): LocalKnowledgeEvidenceCitation {
  return {
    stableId: "lk-1",
    marker: "[1]",
    label: "alpha.md",
    score: 0.91,
    lineage: {
      capsuleId: "cap-1" as LocalKnowledgeEvidenceCitation["lineage"]["capsuleId"],
      sourceId: "src-1" as LocalKnowledgeEvidenceCitation["lineage"]["sourceId"],
      documentId: "doc-1" as LocalKnowledgeEvidenceCitation["lineage"]["documentId"],
      chunkId: "chunk-1" as LocalKnowledgeEvidenceCitation["lineage"]["chunkId"],
    },
    ...overrides,
  };
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
    // uiux-fix F012 C163: source-neutral wording — the panel also serves
    // capsule/connector-only chats where no repository is involved.
    render(<GroundedAnswer answer={undefined} busy={true} />);
    expect(screen.getByText(/Searching connected sources/)).toBeInTheDocument();
  });

  it("does not duplicate the assistant content (the persisted chat bubble is canonical)", () => {
    // uiux-fix F009 C025: the panel previously re-rendered answer.content as raw
    // pre-wrap text directly below the markdown bubble — evidence only now.
    render(<GroundedAnswer answer={answer()} busy={false} />);
    expect(screen.queryByText(/Inspected 1 file/)).not.toBeInTheDocument();
    // The evidence surfaces stay rendered.
    expect(screen.getByText("src/foo.ts:10-25")).toBeInTheDocument();
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
        omittedCounts: {
          ...OMITTED_COUNTS_ZERO,
          "low-relevance": 9,
          ignored: 4,
          generated: 2,
          "budget-exhausted": 1,
        },
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
        knowledgeCitation({
          stableId: "lk-1",
          marker: "[1]",
          label: "alpha.md · section 1",
          score: 0.91,
          source: "Alpha Capsule / Product Manual",
        }),
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
        knowledgeCitation({
          stableId: "hk-1",
          marker: "[1]",
          label: "manual.pdf · p.287",
          score: 0.88,
          source: "Quasar Manual / Product Docs",
        }),
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
    // F009 C025: the merged answer text lives in the assistant bubble, not the panel.
    expect(screen.queryByText(/Merged from the marketing folder/)).not.toBeInTheDocument();
    expect(screen.getByText(/src\/foo\.ts/)).toBeInTheDocument();
    expect(
      screen.getByText(/\[1\] Quasar Manual \/ Product Docs · manual\.pdf · p\.287/),
    ).toBeInTheDocument();
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
    // uiux-fix F051 C306: the tooltip explains the trailing decimal (relevance score).
    const chip = screen.getByText("src/foo.ts:1-4").closest(".grounded-citation");
    expect(chip).toHaveAttribute(
      "title",
      "Evidence citation in src/foo.ts at lines 1-4 — relevance 0.87",
    );
    // The score carries a screen-reader-only label so it is not announced as a bare number.
    expect(chip?.querySelector(".grounded-citation-score .sr-only")?.textContent).toBe(
      "relevance ",
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
      "Evidence citation in src/qux.ts — relevance 0.87",
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
    // uiux-fix F012 C160: marker kinds are humanized ("no-evidence" -> "no evidence").
    expect(
      screen.getByText("Uncertainty (3 markers — no evidence, budget clipped)"),
    ).toBeInTheDocument();
    expect(screen.getByText("no evidence: excerpt unavailable for src/baz.ts")).toBeInTheDocument();
    expect(screen.getByText("no evidence: other")).toBeInTheDocument();
    expect(screen.getByText("budget clipped: clipped at foo")).toBeInTheDocument();
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
    // uiux-fix F012 C161: user-language wording instead of "evidence atoms" jargon.
    expect(
      screen.getByText("Not used: 3 excerpts (binary: 1, low relevance: 2)"),
    ).toBeInTheDocument();
  });

  it("does not render an omitted line when count is 0", () => {
    render(<GroundedAnswer answer={answer({ omittedCount: 0 })} busy={false} />);
    expect(screen.queryByText(/Not used:/)).toBeNull();
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
    // uiux-fix F012 C162: bytes/time use the shared lib/format presenters; the
    // searched row reads symmetrically; queryKind is humanized (C160).
    expect(region.textContent).toContain("Searched");
    expect(region.textContent).toContain("3 / 16 searches");
    expect(region.textContent).toContain("Read");
    expect(region.textContent).toContain("5 / 32 files");
    expect(region.textContent).toContain("Bytes");
    expect(region.textContent).toContain("12.1 KB / 128.0 KB");
    // uiux-fix F051 C318: token counts are thousands-separated for readability.
    expect(region.textContent).toContain("Input");
    expect(region.textContent).toContain("1,500 / 32,000 tokens");
    expect(region.textContent).toContain("Output");
    expect(region.textContent).toContain("400 / 4,096 tokens");
    expect(region.textContent).toContain("Rerank");
    expect(region.textContent).toContain("0 / 0 calls");
    expect(region.textContent).toContain("Time");
    expect(region.textContent).toContain("1.8 s / 30.0 s");
    expect(region.textContent).toContain("Query");
    expect(region.textContent).toContain("natural language");
    expect(region.textContent).not.toContain("natural-language");
  });

  it("links to the local connected-context audit evidence when a run id is present", () => {
    render(<GroundedAnswer answer={answer({ evidenceRunId: "grounded-run-1" })} busy={false} />);
    // WCAG 3.2.2 — the accessible name carries the new-tab hint via an sr-only span so screen
    // reader users are warned the link opens a new tab; asserting the full name keeps the hint
    // mutation-robust (removing the span fails the lookup).
    const link = screen.getByRole("link", {
      name: "View connected-context audit evidence (opens in new tab)",
    });
    expect(link).toHaveAttribute("href", "/api/evidence/grounded-run-1");
    // uiux-fix F012 C136/C164: the endpoint returns raw JSON — open in a new tab so the
    // workspace survives, and use the app link pattern instead of UA default styling.
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveClass("sm-link");
  });

  it("links every connected-context audit evidence run for multi-source answers", () => {
    render(
      <GroundedAnswer
        answer={answer({
          evidenceRunId: "grounded-run-1",
          evidenceRunIds: ["grounded-run-1", "grounded-run-2"],
        })}
        busy={false}
      />,
    );
    const first = screen.getByRole("link", {
      name: "View connected-context audit evidence 1 (opens in new tab)",
    });
    const second = screen.getByRole("link", {
      name: "View connected-context audit evidence 2 (opens in new tab)",
    });
    expect(first).toHaveAttribute("href", "/api/evidence/grounded-run-1");
    expect(second).toHaveAttribute("href", "/api/evidence/grounded-run-2");
    expect(
      screen.queryByRole("link", {
        name: "View connected-context audit evidence 3 (opens in new tab)",
      }),
    ).toBeNull();
  });

  // ─── uiux-fix F012 C091: citation cap + disclosure ───────────────────────────

  it("caps the evidence list at 8 top-scored chips and reveals the rest on demand", () => {
    const citations = Array.from({ length: 12 }, (_, i) =>
      citation({
        stableId: `atom-${String(i)}`,
        scopePath: `src/file-${String(i)}.ts`,
        score: (12 - i) / 12,
      }),
    );
    const { container } = render(<GroundedAnswer answer={answer({ citations })} busy={false} />);
    expect(container.querySelectorAll(".grounded-citations-item")).toHaveLength(8);
    const toggle = screen.getByRole("button", { name: "Show all 12 sources" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(container.querySelectorAll(".grounded-citations-item")).toHaveLength(12);
    const collapse = screen.getByRole("button", { name: "Show fewer sources" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(collapse);
    expect(container.querySelectorAll(".grounded-citations-item")).toHaveLength(8);
  });

  it("keeps the top-scored citations visible when collapsed (score-sorted cap)", () => {
    const citations = [
      citation({ stableId: "low", scopePath: "src/low.ts", score: 0.01 }),
      ...Array.from({ length: 8 }, (_, i) =>
        citation({
          stableId: `hi-${String(i)}`,
          scopePath: `src/hi-${String(i)}.ts`,
          score: 0.9 - i * 0.01,
        }),
      ),
    ];
    render(<GroundedAnswer answer={answer({ citations })} busy={false} />);
    // The weakest source is the one folded behind the disclosure, regardless of wire order.
    expect(screen.queryByText(/src\/low\.ts/)).not.toBeInTheDocument();
    expect(screen.getByText(/src\/hi-0\.ts/)).toBeInTheDocument();
  });

  it("renders no disclosure button when the citation list is within the cap", () => {
    const citations = Array.from({ length: 8 }, (_, i) =>
      citation({ stableId: `atom-${String(i)}`, scopePath: `src/f-${String(i)}.ts` }),
    );
    const { container } = render(<GroundedAnswer answer={answer({ citations })} busy={false} />);
    expect(container.querySelectorAll(".grounded-citations-item")).toHaveLength(8);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("caps knowledge citations with the same disclosure pattern", () => {
    const a: GroundedAnswerType = {
      groundingKind: "local-knowledge",
      userMessageId: "lk-u",
      assistantMessageId: "lk-a",
      content: "Answer [1].",
      citations: Array.from({ length: 10 }, (_, i) =>
        knowledgeCitation({
          stableId: `lk-${String(i)}`,
          marker: `[${String(i + 1)}]`,
          label: `doc-${String(i)}.md`,
          score: 1 - i * 0.05,
        }),
      ),
      uncertainty: [],
      omittedCount: 0,
      elapsedMs: 5,
      noEvidence: false,
      contextPack: {
        kind: "local-knowledge",
        scopeKind: "capsule",
        scopeId: "lk-1",
        scopeLabel: "Caps",
        capsuleCount: 1,
        sourceCount: 1,
        citationCount: 10,
        referenceBudget: 10,
        referencesUsed: 10,
      },
    };
    const { container } = render(<GroundedAnswer answer={a} busy={false} />);
    expect(container.querySelectorAll(".grounded-citations-item")).toHaveLength(8);
    fireEvent.click(screen.getByRole("button", { name: "Show all 10 sources" }));
    expect(container.querySelectorAll(".grounded-citations-item")).toHaveLength(10);
  });

  it("never renders answer.content into the panel — neither as text nor as markup", () => {
    // uiux-fix F009 C025: the panel no longer re-renders answer.content at all
    // (the persisted assistant bubble is the canonical rendering). Mutation guard:
    // re-introducing `{answer.content}` or a dangerouslySetInnerHTML body must
    // fail this test.
    const { container } = render(
      <GroundedAnswer answer={answer({ content: "<script>alert(1)</script>" })} busy={false} />,
    );
    expect(container.textContent).not.toContain("<script>alert(1)</script>");
    expect(container.querySelectorAll("script")).toHaveLength(0);
  });
});
