// Issue #185 — unit tests for the grounded Q&A presentation component. Extended in #187
// with ContextPackSummary coverage and an axe-based a11y smoke.

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GroundedAnswer } from "./GroundedAnswer";
import type { CitationPreviewController } from "./hooks/usePdfCitationPreview";
import type {
  GroundedAnswer as GroundedAnswerType,
  GroundedAnswerContextPackSummary,
  GroundedEvidenceCitation,
  GroundedUncertainty,
  KnowledgePodRetrievalActivity,
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

function retrievalActivity(
  overrides: Partial<KnowledgePodRetrievalActivity> = {},
): KnowledgePodRetrievalActivity {
  return {
    schemaVersion: "1",
    summary: {
      searchedCount: 1,
      skippedCount: 0,
      degradedCount: 0,
      deniedCount: 0,
      unavailableCount: 0,
      notSelectedCount: 0,
      denseCandidateCount: 12,
      lexicalCandidateCount: 5,
      fusedCandidateCount: 8,
      referenceCount: 3,
      citationCount: 1,
    },
    privacy: {
      localFirst: true,
      rawContentExposed: false,
      rawQueryExposed: false,
      privatePathsExposed: false,
      directVectorScoreComparison: false,
    },
    pods: [
      {
        podId: "cap-1" as KnowledgePodRetrievalActivity["pods"][number]["podId"],
        podKind: "pod",
        displayName: "Alpha Capsule",
        state: "searched",
        modes: ["local-only", "hybrid", "lexical", "vector"],
        reasonCodes: ["searched"],
        sourceIds: ["src-1" as KnowledgePodRetrievalActivity["pods"][number]["sourceIds"][number]],
        counts: {
          sourceCount: 1,
          documentCount: 2,
          chunkCount: 6,
          vectorCount: 6,
          referenceCount: 3,
          citationCount: 1,
        },
      },
    ],
    ...overrides,
  };
}

function retrievalActivityPod(): KnowledgePodRetrievalActivity["pods"][number] {
  const pod = retrievalActivity().pods[0];
  if (pod === undefined) throw new Error("expected retrieval activity pod");
  return pod;
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
  "unsupported-format": 0,
  "no-text-layer": 0,
  "malformed-document": 0,
  "encrypted-document": 0,
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

function localKnowledgeAnswer(
  citations: readonly LocalKnowledgeEvidenceCitation[] = [knowledgeCitation()],
): Extract<GroundedAnswerType, { readonly groundingKind: "local-knowledge" }> {
  return {
    groundingKind: "local-knowledge",
    userMessageId: "lk-u",
    assistantMessageId: "lk-a",
    content: "Answer [1].",
    citations,
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
      citationCount: citations.length,
      referenceBudget: 10,
      referencesUsed: citations.length,
    },
  };
}

function citationPreviewController(
  state: "available" | "recoverable" | "blocked",
  citationValue: LocalKnowledgeEvidenceCitation,
): CitationPreviewController {
  return {
    forCitation: vi.fn((citationValueCandidate) =>
      citationValueCandidate.stableId === citationValue.stableId
        ? { citation: citationValueCandidate, state }
        : undefined,
    ),
    forMarker: vi.fn(() => undefined),
    isOpening: vi.fn(() => false),
    openCitation: vi
      .fn<CitationPreviewController["openCitation"]>()
      .mockResolvedValue("pdf-window-1"),
  };
}

function openEvidenceDisclosure(container: HTMLElement): HTMLDetailsElement {
  const disclosure = container.querySelector("details.grounded-evidence-disclosure");
  if (!(disclosure instanceof HTMLDetailsElement)) {
    throw new Error("expected grounded evidence disclosure");
  }
  const summary = disclosure.querySelector("summary");
  if (summary === null) {
    throw new Error("expected grounded evidence summary");
  }
  fireEvent.click(summary);
  return disclosure;
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
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveTextContent(/Searching connected sources/);
  });

  it("does not duplicate the assistant content (the persisted chat bubble is canonical)", () => {
    // uiux-fix F009 C025: the panel previously re-rendered answer.content as raw
    // pre-wrap text directly below the markdown bubble — evidence only now.
    render(<GroundedAnswer answer={answer()} busy={false} />);
    expect(screen.queryByText(/Inspected 1 file/)).not.toBeInTheDocument();
    // The evidence surfaces stay rendered.
    expect(screen.getByText("src/foo.ts:10-25")).toBeInTheDocument();
  });

  it("collapses the evidence audit by default and opens it on demand", () => {
    const { container } = render(<GroundedAnswer answer={answer()} busy={false} />);
    const disclosure = container.querySelector("details.grounded-evidence-disclosure");
    expect(disclosure).toBeInstanceOf(HTMLDetailsElement);
    expect((disclosure as HTMLDetailsElement).open).toBe(false);
    expect(container.querySelector(".grounded-evidence-summary-title")).toHaveTextContent(
      "Evidence",
    );
    expect(screen.getByText(/1 citation.*5 \/ 32 files read/)).toBeInTheDocument();

    const opened = openEvidenceDisclosure(container);
    expect(opened.open).toBe(true);
  });

  it("renders the path-free ranking rationale panel when a ranking summary is present (M2)", () => {
    const a = answer({
      contextPack: contextPack({
        rankingSummary: {
          bucketCounts: { "canonical-metadata": 2, source: 3 },
          ecosystems: [{ id: "maven", count: 2 }],
        },
      }),
    });
    render(<GroundedAnswer answer={a} busy={false} />);
    expect(screen.getByText("Why these files?")).toBeInTheDocument();
    // Bucket names are humanized; ecosystems are summarized — and NO file path is rendered.
    expect(screen.getByText("canonical metadata")).toBeInTheDocument();
    expect(screen.getByText(/Ecosystems: maven \(2\)/)).toBeInTheDocument();
  });

  it("omits the ranking rationale panel when no ranking summary is present (M2)", () => {
    render(<GroundedAnswer answer={answer()} busy={false} />);
    expect(screen.queryByText("Why these files?")).not.toBeInTheDocument();
  });

  it("warns about partial coverage when files were too large or a binary format", () => {
    const a = answer({
      contextPack: contextPack({
        omittedCounts: { ...OMITTED_COUNTS_ZERO, "size-exceeded": 3, binary: 2 },
      }),
    });
    render(<GroundedAnswer answer={a} busy={false} />);
    expect(screen.getAllByText(/Partial coverage/).length).toBeGreaterThan(0);
    // 3 + 2 = 5 files not searched, with each reason quantified.
    expect(screen.getByText(/5 files were not searched/)).toBeInTheDocument();
    expect(screen.getByText(/3 larger than 2 MB/)).toBeInTheDocument();
    expect(screen.getByText(/2 binary or an unsupported format/)).toBeInTheDocument();
    expect(
      screen.getByText(
        /Repository Search reads text, code, and small DOCX, XLSX, and text-layer PDF/,
      ),
    ).toBeInTheDocument();
  });

  it("surfaces skipped-document diagnostics in the coverage notice (Issue #1285)", () => {
    const a = answer({
      contextPack: contextPack({
        omittedCounts: {
          ...OMITTED_COUNTS_ZERO,
          "no-text-layer": 1,
          "encrypted-document": 1,
          "unsupported-format": 2,
          "malformed-document": 1,
        },
      }),
    });
    render(<GroundedAnswer answer={a} busy={false} />);
    expect(screen.getAllByText(/Partial coverage/).length).toBeGreaterThan(0);
    expect(screen.getByText(/5 files were not searched/)).toBeInTheDocument();
    expect(screen.getByText(/1 a scanned document with no text layer/)).toBeInTheDocument();
    expect(screen.getByText(/1 a password-protected document/)).toBeInTheDocument();
    expect(screen.getByText(/2 an unsupported document format/)).toBeInTheDocument();
    expect(screen.getByText(/1 a malformed document/)).toBeInTheDocument();
    expect(
      screen.getByText(
        /Repository Search reads text, code, and small DOCX, XLSX, and text-layer PDF/,
      ),
    ).toBeInTheDocument();
  });

  it("tags a document-evidence citation with its format badge (Issue #1285)", () => {
    const a = answer({
      citations: [
        citation({
          scopePath: "docs/report.docx",
          lineRange: { startLine: 1, endLine: 4 },
          documentFormat: "docx",
          stableId: "atom-doc",
        }),
      ],
    });
    render(<GroundedAnswer answer={a} busy={false} />);
    const badge = screen.getByText("DOCX");
    const range = screen.getByText("docs/report.docx:1-4");
    expect(badge).toBeInTheDocument();
    expect(badge).not.toHaveAttribute("aria-hidden");
    expect(screen.getByText(/document evidence extracted text/)).toHaveClass("sr-only");
    expect(range).toHaveClass("grounded-citation-range");
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
    const summary = screen.getByRole("region", { name: "Knowledge scope summary" });
    expect(within(summary).getByText("Knowledge Pod")).toBeInTheDocument();
    expect(within(summary).queryByText("capsule")).toBeNull();
    expect(
      screen.getByText(/\[1\] Alpha Capsule \/ Product Manual · alpha\.md · section 1/),
    ).toBeInTheDocument();
    expect(screen.getByText("1 / 10 references")).toBeInTheDocument();
  });

  it("renders redacted Knowledge Pod retrieval activity for a local-knowledge answer", () => {
    const a: GroundedAnswerType = {
      ...localKnowledgeAnswer(),
      retrievalActivity: retrievalActivity(),
    };
    render(<GroundedAnswer answer={a} busy={false} />);
    expect(
      screen.getByRole("region", { name: "Knowledge Pod retrieval activity" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Knowledge Pod activity")).toBeInTheDocument();
    expect(screen.getByText("12 vector · 5 lexical · 8 fused")).toBeInTheDocument();
    expect(screen.getByText("3 references · 1 citation")).toBeInTheDocument();
    expect(screen.getByText(/Alpha Capsule · 3 references · 1 citation/)).toBeInTheDocument();
    expect(screen.getByText(/Modes: local only, hybrid, lexical, vector/)).toBeInTheDocument();
    expect(screen.getByText(/Reasons: searched/)).toBeInTheDocument();
    expect(screen.queryByText(/\/Users\/|raw query|private path/i)).not.toBeInTheDocument();
  });

  it("omits Knowledge Pod retrieval activity when no activity or pod rows exist", () => {
    const { rerender } = render(<GroundedAnswer answer={localKnowledgeAnswer()} busy={false} />);
    expect(screen.queryByRole("region", { name: "Knowledge Pod retrieval activity" })).toBeNull();

    rerender(
      <GroundedAnswer
        answer={{
          ...localKnowledgeAnswer(),
          retrievalActivity: retrievalActivity({ pods: [] }),
        }}
        busy={false}
      />,
    );
    expect(screen.queryByRole("region", { name: "Knowledge Pod retrieval activity" })).toBeNull();
  });

  it("renders degraded, denied, unavailable, and not-selected activity states", () => {
    const pod = retrievalActivityPod();
    const activity = retrievalActivity({
      summary: {
        ...retrievalActivity().summary,
        searchedCount: 0,
        degradedCount: 1,
        deniedCount: 1,
        unavailableCount: 1,
        notSelectedCount: 1,
      },
      pods: [
        { ...pod, podId: "cap-degraded" as typeof pod.podId, state: "degraded" },
        {
          ...pod,
          podId: "cap-denied" as typeof pod.podId,
          state: "denied",
          modes: ["local-only", "sealed"],
          reasonCodes: ["policy-denied"],
        },
        { ...pod, podId: "cap-unavailable" as typeof pod.podId, state: "unavailable" },
        { ...pod, podId: "cap-filtered" as typeof pod.podId, state: "not-selected" },
      ],
    });
    render(
      <GroundedAnswer
        answer={{ ...localKnowledgeAnswer(), retrievalActivity: activity }}
        busy={false}
      />,
    );

    expect(screen.getAllByText("Degraded").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Denied").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Not selected").length).toBeGreaterThan(0);
    expect(
      screen.getByText(/Modes: local only, sealed · Reasons: policy denied/u),
    ).toBeInTheDocument();
  });

  it("keeps each per-pod activity state label announced in the activity list", () => {
    const pod = retrievalActivityPod();
    const activity = retrievalActivity({
      pods: [
        { ...pod, podId: "cap-searched" as typeof pod.podId, state: "searched" },
        { ...pod, podId: "cap-denied" as typeof pod.podId, state: "denied" },
        { ...pod, podId: "cap-degraded" as typeof pod.podId, state: "degraded" },
      ],
    });
    render(
      <GroundedAnswer
        answer={{ ...localKnowledgeAnswer(), retrievalActivity: activity }}
        busy={false}
      />,
    );

    // Scope to the per-pod list (the summary <dl> carries the same words as MetricRow labels)
    // and assert each state badge is announced: present in the accessibility tree and not inside
    // an aria-hidden subtree — so an icon-only/aria-hidden badge refactor would fail here rather
    // than silently drop the label from what a screen reader conveys.
    const details = screen.getByRole("list", { name: "Knowledge Pod activity details" });
    for (const label of ["Searched", "Denied", "Degraded"]) {
      const badge = within(details).getByText(label);
      expect(badge.closest("[aria-hidden='true']")).toBeNull();
    }
  });

  it("bounds long Knowledge Pod activity lists behind a disclosure control", () => {
    const pod = retrievalActivityPod();
    const activity = retrievalActivity({
      pods: Array.from({ length: 10 }, (_, index) => ({
        ...pod,
        podId: `cap-activity-${String(index)}` as typeof pod.podId,
        displayName: `Activity Pod ${String(index)}`,
      })),
    });
    render(
      <GroundedAnswer
        answer={{ ...localKnowledgeAnswer(), retrievalActivity: activity }}
        busy={false}
      />,
    );

    expect(screen.getByText(/Activity Pod 0/)).toBeInTheDocument();
    expect(screen.getByText(/Activity Pod 7/)).toBeInTheDocument();
    expect(screen.queryByText(/Activity Pod 8/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show all 10 Knowledge Pods" }));
    expect(screen.getByText(/Activity Pod 9/)).toBeInTheDocument();
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
      retrievalActivity: retrievalActivity(),
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
    expect(
      screen.getByText("Hybrid: 2 folder sources + 1 Knowledge Pod source"),
    ).toBeInTheDocument();
    expect(screen.getByText("Knowledge scope: Quasar Manual")).toBeInTheDocument();
    expect(screen.getByText("Knowledge Pod activity")).toBeInTheDocument();
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

  it("opens connected-context citations in the editor when repository navigation is available", () => {
    const openReference = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
    render(
      <GroundedAnswer
        answer={answer({
          citations: [
            citation({
              stableId: "a",
              scopePath: "src/foo.ts",
              lineRange: { startLine: 1, endLine: 4 },
            }),
          ],
        })}
        busy={false}
        repositoryRoots={[{ root: "/repo", label: "Keiko" }]}
        openRepositoryReference={openReference}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open src/foo.ts at lines 1-4 in editor" }));

    expect(openReference).toHaveBeenCalledWith({
      root: "/repo",
      path: "src/foo.ts",
      lineStart: 1,
      lineEnd: 4,
    });
  });

  it("opens root-level connected-context citations in the editor", () => {
    const openReference = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
    render(
      <GroundedAnswer
        answer={answer({
          citations: [
            citation({
              stableId: "package-lock",
              scopePath: "package-lock.json",
              lineRange: { startLine: 1, endLine: 48 },
            }),
          ],
        })}
        busy={false}
        repositoryRoots={[{ root: "/repo", label: "Keiko" }]}
        openRepositoryReference={openReference}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Open package-lock.json at lines 1-48 in editor",
      }),
    );

    expect(openReference).toHaveBeenCalledWith({
      root: "/repo",
      path: "package-lock.json",
      lineStart: 1,
      lineEnd: 48,
    });
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

  it("uses the context pack as the canonical omitted-count source", () => {
    render(
      <GroundedAnswer
        answer={answer({
          omittedCount: 99,
          contextPack: contextPack({
            omittedCount: 3,
            omittedCounts: { ...OMITTED_COUNTS_ZERO, binary: 1, "low-relevance": 2 },
          }),
        })}
        busy={false}
      />,
    );

    expect(screen.getByText(/1 citation.*5 \/ 32 files read.*3 not used/)).toBeInTheDocument();
    expect(
      screen.getByText("Not used: 3 excerpts (binary: 1, low relevance: 2)"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/99 not used|Not used: 99/)).not.toBeInTheDocument();
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
    openEvidenceDisclosure(container);
    const toggle = screen.getByRole("button", { name: "Show all 12 citations" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(container.querySelectorAll(".grounded-citations-item")).toHaveLength(12);
    const collapse = screen.getByRole("button", { name: "Show fewer citations" });
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
    // The weakest citation is the one folded behind the disclosure, regardless of wire order.
    expect(screen.queryByText(/src\/low\.ts/)).not.toBeInTheDocument();
    expect(screen.getByText(/src\/hi-0\.ts/)).toBeInTheDocument();
  });

  it("deduplicates folder citations by stable id before rendering", () => {
    const citations = [
      citation({ stableId: "dup", scopePath: "src/weak.ts", score: 0.1 }),
      citation({ stableId: "dup", scopePath: "src/strong.ts", score: 0.9 }),
      citation({ stableId: "unique", scopePath: "src/unique.ts", score: 0.5 }),
    ];

    const { container } = render(<GroundedAnswer answer={answer({ citations })} busy={false} />);

    expect(container.querySelectorAll(".grounded-citations-item")).toHaveLength(2);
    expect(screen.getByText(/src\/strong\.ts/)).toBeInTheDocument();
    expect(screen.getByText(/src\/unique\.ts/)).toBeInTheDocument();
    expect(screen.queryByText(/src\/weak\.ts/)).not.toBeInTheDocument();
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
    openEvidenceDisclosure(container);
    fireEvent.click(screen.getByRole("button", { name: "Show all 10 citations" }));
    expect(container.querySelectorAll(".grounded-citations-item")).toHaveLength(10);
  });

  it("deduplicates knowledge citations by stable id before rendering", () => {
    const a: GroundedAnswerType = {
      groundingKind: "local-knowledge",
      userMessageId: "lk-u",
      assistantMessageId: "lk-a",
      content: "Answer [1].",
      citations: [
        knowledgeCitation({
          stableId: "dup",
          marker: "[1]",
          label: "weak.md",
          score: 0.1,
        }),
        knowledgeCitation({
          stableId: "dup",
          marker: "[2]",
          label: "strong.md",
          score: 0.9,
        }),
        knowledgeCitation({
          stableId: "unique",
          marker: "[3]",
          label: "unique.md",
          score: 0.5,
        }),
      ],
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
        citationCount: 3,
        referenceBudget: 10,
        referencesUsed: 3,
      },
    };

    const { container } = render(<GroundedAnswer answer={a} busy={false} />);

    expect(container.querySelectorAll(".grounded-citations-item")).toHaveLength(2);
    expect(screen.getByText(/\[2\] strong\.md/)).toBeInTheDocument();
    expect(screen.getByText(/\[3\] unique\.md/)).toBeInTheDocument();
    expect(screen.queryByText(/\[1\] weak\.md/)).not.toBeInTheDocument();
  });

  it("opens an eligible PDF citation chip through the shared verified preview controller", () => {
    const pdfCitation = knowledgeCitation({ label: "policy.pdf" });
    const citationPreview = citationPreviewController("available", pdfCitation);
    const { container } = render(
      <GroundedAnswer
        answer={localKnowledgeAnswer([pdfCitation])}
        busy={false}
        citationPreview={citationPreview}
      />,
    );

    openEvidenceDisclosure(container);
    fireEvent.click(screen.getByRole("button", { name: "[1] policy.pdf · Open PDF" }));

    expect(citationPreview.openCitation).toHaveBeenCalledWith(pdfCitation, "citation-chip");
  });

  it("opens a recoverable PDF citation chip through active authorization", () => {
    const pdfCitation = knowledgeCitation({ label: "policy.pdf" });
    const citationPreview = citationPreviewController("recoverable", pdfCitation);
    const { container } = render(
      <GroundedAnswer
        answer={localKnowledgeAnswer([pdfCitation])}
        busy={false}
        citationPreview={citationPreview}
      />,
    );

    openEvidenceDisclosure(container);
    fireEvent.click(screen.getByRole("button", { name: "[1] policy.pdf · Recover PDF" }));

    expect(citationPreview.openCitation).toHaveBeenCalledWith(pdfCitation, "citation-chip");
  });

  it("renders blocked PDF citation chips as non-activatable safe affordances", () => {
    const pdfCitation = knowledgeCitation({ label: "policy.pdf" });
    const citationPreview = citationPreviewController("blocked", pdfCitation);
    const { container } = render(
      <GroundedAnswer
        answer={localKnowledgeAnswer([pdfCitation])}
        busy={false}
        citationPreview={citationPreview}
      />,
    );

    openEvidenceDisclosure(container);
    const chip = screen.getByRole("button", { name: "[1] policy.pdf · PDF unavailable" });
    expect(chip).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(chip);

    expect(citationPreview.openCitation).not.toHaveBeenCalled();
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

  it("RB-4 (GEN-AI-GROUNDING-007): surfaces a summary-level warning on empty evidence, not hidden in the disclosure", () => {
    const a = answer({
      uncertainty: [{ kind: "no-evidence", claim: "No repository evidence matched." }],
    });
    const { container } = render(<GroundedAnswer answer={a} busy={false} />);
    const warning = container.querySelector(".grounded-uncertainty[role='alert']");
    expect(warning).not.toBeNull();
    expect(warning?.textContent).toContain("Needs review");
    expect(warning?.textContent?.toLowerCase()).toContain("not grounded");
  });

  it("RB-4 (GEN-AI-GROUNDING-007): flags unsupported (fabricated) citations at the summary level", () => {
    const a = answer({
      uncertainty: [
        { kind: "unsupported-citation", claim: "The answer cited a source not retrieved." },
      ],
    });
    const { container } = render(<GroundedAnswer answer={a} busy={false} />);
    const warning = container.querySelector(".grounded-uncertainty[role='alert']");
    expect(warning?.textContent?.toLowerCase()).toContain("unsupported citation");
  });

  it("RB-4 (GEN-AI-GROUNDING-007): shows no warning banner for a fully grounded answer", () => {
    const { container } = render(<GroundedAnswer answer={answer()} busy={false} />);
    expect(container.querySelector(".grounded-uncertainty[role='alert']")).toBeNull();
  });

  it("RB-4 (GEN-AI-RETRIEVAL-001): surfaces silent reranker degradation to the user", () => {
    const base = localKnowledgeAnswer();
    const a = {
      ...base,
      contextPack: {
        ...base.contextPack,
        reranker: {
          status: "unavailable" as const,
          candidateCount: 3,
          documentCount: 3,
          keptCount: 3,
        },
      },
    } as GroundedAnswerType;
    const { container } = render(<GroundedAnswer answer={a} busy={false} />);
    const warning = container.querySelector(".grounded-uncertainty[role='alert']");
    expect(warning?.textContent?.toLowerCase()).toContain("reranker unavailable");
  });

  it("describes configured no-op reranking without exposing provider details", () => {
    const base = localKnowledgeAnswer();
    const a = {
      ...base,
      contextPack: {
        ...base.contextPack,
        reranker: {
          status: "disabled" as const,
          mode: "none" as const,
          failureKind: "not-configured" as const,
          candidateCount: 3,
          documentCount: 0,
          keptCount: 3,
        },
      },
    } as GroundedAnswerType;
    const { container } = render(<GroundedAnswer answer={a} busy={false} />);
    const warning = container.querySelector(".grounded-uncertainty[role='alert']");
    expect(warning?.textContent).toContain("no reranker configured");
    expect(warning?.textContent).toContain("fused retrieval order");
    expect(warning?.textContent).not.toContain("http");
  });
});
