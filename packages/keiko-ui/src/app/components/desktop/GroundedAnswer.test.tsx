// Issue #185 — unit tests for the grounded Q&A presentation component. Extended in #187
// with ContextPackSummary coverage and an axe-based a11y smoke.

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CITATION_FINDING_LIST_MAX,
  citationFindingTotalSuffix,
} from "@oscharko-dev/keiko-contracts/runtime/citation-markers";
import {
  buildGroundedAnswerContextPackSummary,
  groupConnectedContextOmissions,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { GroundedAnswer } from "./GroundedAnswer";
import {
  resetClientDiagnosticWriter,
  setClientDiagnosticWriter,
  type ClientDiagnosticWriter,
} from "@/lib/client-diagnostics";
import { connectedScopeFingerprint } from "./hooks/workspaceScopeIdentity";
import { repositoryReferenceRootsForScopes } from "./repositoryReferences";
import { I18N_STORAGE_KEY, I18nProvider, resetLoadedMessageCatalogs } from "@/lib/i18n";
import activityBadgeStyles from "./GroundedAnswer.module.css";
import type { CitationPreviewController } from "./hooks/usePdfCitationPreview";
import type {
  GroundedAnswer as GroundedAnswerType,
  GroundedAnswerContextPackSummary,
  GroundedEvidenceCitation,
  GroundedUncertainty,
  ChatConnectedScope,
  KnowledgePodRetrievalActivity,
  LocalKnowledgeEvidenceCitation,
} from "@/lib/types";
import * as api from "@/lib/api";
import { connectedInspectionManifest } from "./connectedEvidenceInspection.test-fixtures";

afterEach(resetClientDiagnosticWriter);

describe("honest connected evidence", () => {
  it("keeps a measured zero prompt-file count distinct from assembled reads", () => {
    render(
      <GroundedAnswer
        answer={answer({ contextPack: contextPack({ filesInPrompt: 0 }) })}
        busy={false}
      />,
    );
    expect(screen.getByText(/1 citation · 0 files in prompt/)).toBeInTheDocument();
  });
  it("names the inspected subfolder from the manifest instead of a scope hash", async () => {
    const fetch = vi
      .spyOn(api, "fetchEvidenceManifest")
      .mockResolvedValue({ manifest: connectedInspectionManifest() });
    const view = render(
      <GroundedAnswer
        answer={answer({
          evidenceRunId: "run-1",
          contextPack: contextPack({ scopeKind: "directory", fileCount: 1 }),
        })}
        busy={false}
        repositoryRoots={[{ root: "/repo", label: "repo" }]}
      />,
    );
    openEvidenceDisclosure(view.container);
    const details = screen.getByText("Inspect files").closest("details");
    if (details === null) throw new TypeError("Missing inspection disclosure");
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await waitFor(() => expect(screen.getAllByText("Scope: src/feature")).toHaveLength(2));
    expect(view.container).not.toHaveTextContent("cafef00d");
    fetch.mockRestore();
  });
  it("does not promise attachment after an unsuccessful citation repair", () => {
    render(
      <GroundedAnswer
        answer={answer({ citationBehaviour: "never", citations: [] })}
        busy={false}
      />,
    );
    expect(
      screen.getByText(/No evidence citations were attached to this answer/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("This model does not add citations itself; Keiko attaches evidence."),
    ).toBeNull();
  });
  it("shows prompt-reaching files and canonical omission groups rather than assembled reads", () => {
    const pack = contextPack({
      filesInPrompt: 1,
      omittedCounts: {
        ...OMITTED_COUNTS_ZERO,
        "low-relevance": 2,
        "budget-exhausted": 3,
        ignored: 4,
      },
    });
    const groups = groupConnectedContextOmissions(pack.omittedCounts);
    render(<GroundedAnswer answer={answer({ contextPack: pack })} busy={false} />);
    expect(
      screen.getByText(
        `1 citation · 1 files in prompt · ${String(groups.ranking)} omitted for relevance or budget · ${String(groups.eligibility)} ineligible`,
      ),
    ).toHaveAttribute("title", expect.stringContaining("low relevance: 2"));
  });
  it.each([
    [{ semanticProviderDisposition: "unavailable" as const }, "Retrieval used text matching only."],
    [
      {
        reranker: {
          status: "unavailable" as const,
          candidateCount: 9,
          documentCount: 3,
          keptCount: 0,
        },
      },
      "Relevance refinement was unavailable; the initial ranking was used.",
    ],
    [
      { scopeContextState: "overflow" as const },
      "The folder context exceeded the request capacity.",
    ],
    [{ selectionConfidence: "low" as const }, "No confident evidence match was found."],
  ])("shows a plain-language retrieval notice for %j", (diagnostics, message) => {
    render(
      <GroundedAnswer answer={answer({ contextPack: contextPack(diagnostics) })} busy={false} />,
    );
    expect(screen.getByText(message)).toHaveAttribute("title");
  });
  it("shows uncited text once, a reference in uncertainty, and separate memory context text", () => {
    render(
      <GroundedAnswer
        answer={answer({
          uncertainty: [
            uncertainty({ kind: "uncited-answer" }),
            uncertainty({ kind: "uncited-memory-context" }),
          ],
        })}
        busy={false}
      />,
    );
    expect(screen.getByText(/See the citation warning above/)).toBeInTheDocument();
    expect(
      screen.getAllByText(
        "This answer contains statements without an inline citation, so they cannot be traced to a source.",
      ),
    ).toHaveLength(1);
    expect(
      screen.getByText(/The answer used memory context without citing it/),
    ).toBeInTheDocument();
  });
  it.each(["never", "cites-after-repair"] as const)(
    "explains citation attachment for %s",
    (citationBehaviour) => {
      render(<GroundedAnswer answer={answer({ citationBehaviour })} busy={false} />);
      expect(
        screen.getByText("This model does not add citations itself; Keiko attaches evidence."),
      ).toBeInTheDocument();
    },
  );
});

function scopeFingerprint(scope: ChatConnectedScope): string {
  const fingerprint = connectedScopeFingerprint(scope);
  if (fingerprint === undefined) throw new TypeError("Missing fixture scope fingerprint");
  return fingerprint;
}

function cssClass(name: keyof typeof activityBadgeStyles): string {
  const value = activityBadgeStyles[name];
  if (value === undefined) throw new Error(`missing GroundedAnswer CSS module class ${name}`);
  return value;
}

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

function fullMatchLimitedCoverage(
  overrides: Partial<NonNullable<GroundedAnswerContextPackSummary["coverage"]>> = {},
): NonNullable<GroundedAnswerContextPackSummary["coverage"]> {
  return {
    incomplete: true,
    reasons: ["match-cap"],
    filesDiscovered: 112,
    filesAfterPolicy: 112,
    filesScanned: 112,
    filesSkipped: 0,
    truncated: true,
    ignoredByDiscovery: 0,
    deniedByDiscovery: 0,
    depthPrunedByDiscovery: 0,
    maxFilesPrunedByDiscovery: 0,
    matchesReturned: 50,
    elapsedMs: 1,
    limits: { maxFilesScanned: null, maxMatchesReturned: 50, elapsedMsMax: null },
    ...overrides,
  };
}

function producedEmptyScopeSummary(
  summary: GroundedAnswerContextPackSummary,
): GroundedAnswerContextPackSummary {
  return buildGroundedAnswerContextPackSummary(
    {
      schemaVersion: "1",
      stableId: "empty-search-pack",
      scope: {
        schemaVersion: "1",
        scopeId: "selected-workspace",
        workspaceRoot: "/repo",
        kind: "workspace-root",
        relativePaths: [],
        conversationId: "chat-1",
        connectedAtMs: 0,
        explicitConnection: true,
      },
      query: {
        kind: "exact-symbol",
        text: "ABSENT_SEARCH_MARKER",
        caseSensitive: true,
        maxResults: 50,
        emittedAtMs: 0,
      },
      budget: summary.budget,
      usage: summary.usage,
      files: [],
      omitted: [],
      uncertainty: [],
      emittedAtMs: 0,
      ledgerRef: undefined,
      diagnostics: { rankedCandidates: [], coverage: summary.coverage },
    },
    0,
    summary.elapsedMs,
  );
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
  it.each(["src/\u202egnp.ts", "src/ze\u200bro.ts", "src/control\u0007.ts", "src/tab\t.ts"])(
    "keeps hostile path display safe while opening the exact source %s",
    (path) => {
      const open = vi.fn(() => ({ ok: true as const, windowId: "editor-test" }));
      const { container } = render(
        <GroundedAnswer
          answer={answer({ citations: [citation({ scopePath: path })] })}
          busy={false}
          repositoryRoots={[{ root: "/repo", label: "repo" }]}
          openRepositoryReference={open}
        />,
      );
      const disclosure = container.querySelector(".grounded-evidence-summary");
      if (disclosure === null) throw new Error("Missing disclosure.");
      fireEvent.click(disclosure);
      const button = container.querySelector(".grounded-citation-open");
      if (!(button instanceof HTMLButtonElement)) throw new Error("Missing citation action.");
      expect(container.innerHTML).not.toMatch(/[\u0007\t\u200b\u202e]/u);
      fireEvent.click(button);
      expect(open).toHaveBeenCalledWith({ root: "/repo", path, lineStart: 10, lineEnd: 25 });
    },
  );

  it("does not resort unchanged citations on unrelated renders", () => {
    const scoreRead = vi.fn(() => 0.9);
    const citations = Array.from({ length: 64 }, (_, index) => ({
      ...citation({
        stableId: `stable-${String(index)}`,
        scopePath: `src/file-${String(index)}.ts`,
      }),
      get score(): number {
        return scoreRead();
      },
    }));
    const a = answer({ citations });
    const { rerender } = render(<GroundedAnswer answer={a} busy={false} />);
    const reads = scoreRead.mock.calls.length;
    expect(reads).toBeGreaterThan(0);
    rerender(<GroundedAnswer answer={a} busy={true} />);
    expect(scoreRead).toHaveBeenCalledTimes(reads);
  });

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
    expect(
      screen.getByText(
        /1 citation.*not recorded files in prompt.*0 omitted for relevance or budget.*0 ineligible/,
      ),
    ).toBeInTheDocument();

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
    // These recorded omissions provide a lower bound, not a corpus-wide exclusion census.
    expect(screen.getByText(/At least 5 files were not searched/)).toBeInTheDocument();
    expect(screen.getByText(/3 larger than 2 MB/)).toBeInTheDocument();
    expect(screen.getByText(/2 binary/)).toBeInTheDocument();
    expect(
      screen.getByText(
        /Repository Search reads text, code, and small DOCX, XLSX, and text-layer PDF/,
      ),
    ).toBeInTheDocument();
  });

  it("labels sampled exclusion counts without claiming a corpus total", () => {
    const a = answer({
      contextPack: contextPack({
        omittedCount: 100,
        omittedCounts: {
          ...OMITTED_COUNTS_ZERO,
          "size-exceeded": 1,
          binary: 49,
          "low-relevance": 50,
        },
        coverage: {
          incomplete: false,
          reasons: [],
          filesDiscovered: 7_519,
          filesAfterPolicy: 7_519,
          filesScanned: 6_993,
          filesSkipped: 603,
          truncated: false,
          ignoredByDiscovery: 45,
          deniedByDiscovery: 24,
          depthPrunedByDiscovery: 0,
          maxFilesPrunedByDiscovery: 0,
          matchesReturned: 50,
          elapsedMs: 1_000,
          limits: { maxFilesScanned: null, maxMatchesReturned: 50, elapsedMsMax: null },
        },
      }),
    });
    const { container } = render(<GroundedAnswer answer={a} busy={false} />);
    const notice = container.querySelector(".grounded-coverage-notice");
    expect(notice).toHaveTextContent("At least 50 files were not searched");
    expect(notice).toHaveTextContent("recorded exclusions: 1 larger than 2 MB, 49 binary");
    expect(notice).not.toHaveTextContent("526");
    expect(screen.getByText(/Not used: 100 files/)).toBeInTheDocument();
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
    expect(screen.getByText(/At least 5 files were not searched/)).toBeInTheDocument();
    expect(screen.getByText(/1 no text layer/)).toBeInTheDocument();
    expect(screen.getByText(/1 password-protected document/)).toBeInTheDocument();
    expect(screen.getByText(/2 unsupported format/)).toBeInTheDocument();
    expect(screen.getByText(/1 malformed document/)).toBeInTheDocument();
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

  it("renders skipped, degraded, denied, unavailable, and not-selected activity states", () => {
    const pod = retrievalActivityPod();
    const activity = retrievalActivity({
      summary: {
        ...retrievalActivity().summary,
        searchedCount: 0,
        skippedCount: 1,
        degradedCount: 1,
        deniedCount: 1,
        unavailableCount: 1,
        notSelectedCount: 1,
      },
      pods: [
        { ...pod, podId: "cap-skipped" as typeof pod.podId, state: "skipped" },
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
    const { container } = render(
      <GroundedAnswer
        answer={{ ...localKnowledgeAnswer(), retrievalActivity: activity }}
        busy={false}
      />,
    );

    expect(screen.getAllByText("Skipped").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Degraded").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Denied").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Not selected").length).toBeGreaterThan(0);
    expect(
      screen.getByText(/Modes: local only, sealed · Reasons: policy denied/u),
    ).toBeInTheDocument();

    // AUDIT-E1816-006: each activity badge carries a state-scoped data attribute so the
    // component-scoped CSS module can apply a per-state accent color, not just shared text.
    const badgeStates = [
      ...container.querySelectorAll(".grounded-evidence-summary-badge[data-activity-state]"),
    ].map((badge) => badge.getAttribute("data-activity-state"));
    expect(badgeStates).toEqual(
      expect.arrayContaining(["skipped", "degraded", "denied", "unavailable", "not-selected"]),
    );
  });

  it("keeps each per-pod activity state label announced in the activity list", () => {
    const pod = retrievalActivityPod();
    const activity = retrievalActivity({
      pods: [
        { ...pod, podId: "cap-searched" as typeof pod.podId, state: "searched" },
        { ...pod, podId: "cap-skipped" as typeof pod.podId, state: "skipped" },
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
    for (const label of ["Searched", "Skipped", "Denied", "Degraded"]) {
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
        displayName:
          index === 7
            ? "Activity Pod With Extremely Long Safe Display Name That Must Wrap In Narrow Panels"
            : `Activity Pod ${String(index)}`,
      })),
    });
    const { container } = render(
      <div style={{ width: "280px" }}>
        <GroundedAnswer
          answer={{ ...localKnowledgeAnswer(), retrievalActivity: activity }}
          busy={false}
        />
      </div>,
    );

    expect(screen.getByText(/Activity Pod 0/)).toBeInTheDocument();
    const details = screen.getByRole("list", { name: "Knowledge Pod activity details" });
    expect(details).toHaveClass(cssClass("activityList"));
    expect(
      screen.getByText(/Activity Pod With Extremely Long Safe Display Name/u),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Activity Pod 8/)).toBeNull();
    expect(container.querySelectorAll(`.${cssClass("activityListItem")}`)).toHaveLength(8);
    expect(container.querySelector(`.${cssClass("activityMeta")}`)).not.toBeNull();
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
    const chip = screen.getByText("src/foo.ts:1-4").closest(".grounded-citation");
    expect(chip).toHaveAttribute("title", "Evidence citation in src/foo.ts at lines 1-4");
    expect(chip?.querySelector(".grounded-citation-score")).toBeNull();
    expect(screen.queryByText("0.87")).toBeNull();
    expect(screen.queryByText("0.55")).toBeNull();
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

  it("uses all 96 evidence paths to disambiguate same basenames before and after disclosure", () => {
    const paths = Array.from(
      { length: 96 },
      (_, index) =>
        `packages/entry-${String(index + 1).padStart(3, "0")}/src/LateDefinitionProbe.ts`,
    );
    const citations = paths.map((path) =>
      citation({ scopePath: path, stableId: path, lineRange: { startLine: 301, endLine: 302 } }),
    );
    const openReference = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
    const { container } = render(
      <GroundedAnswer
        answer={answer({ citations })}
        busy={false}
        repositoryRoots={[{ root: "/repo", label: "Keiko" }]}
        openRepositoryReference={openReference}
      />,
    );
    const expected = paths.map((path) => `${path.split("/").slice(-3).join("/")}:301-302`);
    expect(
      [...container.querySelectorAll(".grounded-citation-open")].map(
        (button) => button.textContent,
      ),
    ).toEqual(expected.slice(0, 8));
    openEvidenceDisclosure(container);
    fireEvent.click(screen.getByRole("button", { name: "Show all 96 citations" }));
    expect(
      [...container.querySelectorAll(".grounded-citation-open")].map(
        (button) => button.textContent,
      ),
    ).toEqual(expected);
  });

  it("distinguishes identical citation paths from different attributed sources", () => {
    const citations = ["ManualA", "ManualB"].map((source) =>
      citation({ source, stableId: source }),
    );
    const openReference = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
    const { container } = render(
      <GroundedAnswer
        answer={answer({ citations })}
        busy={false}
        repositoryRoots={[{ root: "/repo", label: "Keiko" }]}
        openRepositoryReference={openReference}
      />,
    );
    expect(
      [...container.querySelectorAll(".grounded-citation-open")].map(
        (button) => button.textContent,
      ),
    ).toEqual(["ManualA · foo.ts:10-25", "ManualB · foo.ts:10-25"]);
    openEvidenceDisclosure(container);
    const first = screen.getByRole("button", {
      name: "Open ManualA · src/foo.ts at lines 10-25 in editor",
    });
    fireEvent.click(first);
    expect(openReference).toHaveBeenCalledWith({
      root: "/repo",
      path: "src/foo.ts",
      lineStart: 10,
      lineEnd: 25,
    });
  });

  it.each([false, true])(
    "preserves an exact citation path inside a same-named root (identity: %s)",
    (identified) => {
      const scope = {
        kind: "workspace-root" as const,
        root: "/repo/src",
        relativePaths: [],
        connectedAtMs: 1,
      };
      const fingerprint = scopeFingerprint(scope);
      const openReference = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
      const { container } = render(
        <GroundedAnswer
          answer={answer({
            citations: [
              citation({
                scopePath: "src/foo.ts",
                ...(identified ? { sourceScopeFingerprint: fingerprint } : {}),
              }),
            ],
          })}
          busy={false}
          repositoryRoots={[{ root: scope.root, label: "src", scopeFingerprints: [fingerprint] }]}
          openRepositoryReference={openReference}
        />,
      );
      openEvidenceDisclosure(container);
      fireEvent.click(screen.getByRole("button", { name: /Open src\/foo.ts/ }));
      expect(openReference).toHaveBeenCalledWith({
        root: "/repo/src",
        path: "src/foo.ts",
        lineStart: 10,
        lineEnd: 25,
      });
    },
  );

  it("requires an explicit source for legacy relative paths that resemble a root label", () => {
    const openReference = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
    const { container } = render(
      <GroundedAnswer
        answer={answer({ citations: [citation({ scopePath: "ManualB/src/foo.ts" })] })}
        busy={false}
        repositoryRoots={[
          { root: "/ManualA", label: "ManualA" },
          { root: "/ManualB", label: "ManualB" },
        ]}
        openRepositoryReference={openReference}
      />,
    );
    openEvidenceDisclosure(container);
    fireEvent.click(screen.getByRole("button", { name: /Open ManualB\/src\/foo.ts/ }));
    expect(openReference).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Select repository source: ManualB" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select repository source: ManualA" }));
    expect(openReference).toHaveBeenCalledWith({
      root: "/ManualA",
      path: "ManualB/src/foo.ts",
      lineStart: 10,
      lineEnd: 25,
    });
  });

  it("keeps source attribution for identical paths without an editor callback", () => {
    const citations = ["ManualA", "ManualB"].map((source) =>
      citation({ source, stableId: source }),
    );
    const { container } = render(<GroundedAnswer answer={answer({ citations })} busy={false} />);
    expect(
      [...container.querySelectorAll(".grounded-citation-range")].map((range) => range.textContent),
    ).toEqual(["ManualA · src/foo.ts:10-25", "ManualB · src/foo.ts:10-25"]);
  });

  it("opens the exact attributed source and includes its visible label in the accessible name", () => {
    const scopes = ["ManualA", "ManualB"].map((name) => ({
      kind: "directory" as const,
      root: `/${name}`,
      relativePaths: ["src"],
      connectedAtMs: 1,
    }));
    const citations = scopes.map((scope) =>
      citation({
        stableId: scope.root,
        source: scope.root.slice(1),
        sourceScopeFingerprint: scopeFingerprint(scope),
      }),
    );
    const roots = scopes.map((scope) => ({
      root: scope.root,
      label: scope.root.slice(1),
      scopeFingerprints: [scopeFingerprint(scope)],
    }));
    const openReference = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
    render(
      <GroundedAnswer
        answer={answer({ citations })}
        busy={false}
        repositoryRoots={roots}
        openRepositoryReference={openReference}
      />,
    );
    openEvidenceDisclosure(document.body);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open ManualB · src/foo.ts at lines 10-25 in editor",
      }),
    );
    expect(openReference).toHaveBeenCalledWith({
      root: "/ManualB",
      path: "src/foo.ts",
      lineStart: 10,
      lineEnd: 25,
    });
    expect(screen.queryByRole("button", { name: /Select repository source:/u })).toBeNull();
  });

  it.each(["replacement", "different subfolder", "ambiguous"] as const)(
    "requires a manual source choice for %s identity instead of guessing from labels",
    (kind) => {
      const original = {
        kind: "directory" as const,
        root: "/old/manual",
        relativePaths: ["src"],
        connectedAtMs: 1,
      };
      const current = {
        ...original,
        root: kind === "replacement" ? "/new/manual" : original.root,
        relativePaths: kind === "different subfolder" ? ["docs"] : original.relativePaths,
      };
      const fingerprint = scopeFingerprint(original);
      const root = {
        root: current.root,
        label: "manual",
        scopeFingerprints: [scopeFingerprint(current)],
      };
      const roots = kind === "ambiguous" ? [root, { ...root, root: "/alias/manual" }] : [root];
      const openReference = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
      render(
        <GroundedAnswer
          answer={answer({
            citations: [citation({ source: "manual", sourceScopeFingerprint: fingerprint })],
          })}
          busy={false}
          repositoryRoots={roots}
          openRepositoryReference={openReference}
        />,
      );
      openEvidenceDisclosure(document.body);
      fireEvent.click(
        screen.getByRole("button", { name: "Open src/foo.ts at lines 10-25 in editor" }),
      );
      expect(openReference).not.toHaveBeenCalled();
      const expectedNames = {
        ambiguous: [
          "Select repository source: manual · /alias/manual",
          "Select repository source: manual · /old/manual",
        ],
        replacement: ["Select repository source: manual · new/manual"],
        "different subfolder": ["Select repository source: manual · old/manual"],
      }[kind];
      const choices = screen.getAllByRole("button", { name: /^Select repository source:/u });
      expect(choices).toHaveLength(expectedNames.length);
      for (const name of expectedNames) expect(screen.getByRole("button", { name })).toBeVisible();
    },
  );

  it("uses identity rather than colliding basenames and strips hostile source display controls", () => {
    const scopes = ["first", "second"].map((name) => ({
      kind: "directory" as const,
      root: `/${name}/manual`,
      relativePaths: ["src"],
      connectedAtMs: 1,
    }));
    const citations = scopes.map((scope, index) =>
      citation({
        stableId: scope.root,
        source: index === 0 ? "manual~first" : "manual~second\u202e",
        sourceScopeFingerprint: scopeFingerprint(scope),
      }),
    );
    const roots = scopes.map((scope) => ({
      root: scope.root,
      label: "manual",
      scopeFingerprints: [scopeFingerprint(scope)],
    }));
    const openReference = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
    render(
      <GroundedAnswer
        answer={answer({ citations })}
        busy={false}
        repositoryRoots={roots}
        openRepositoryReference={openReference}
      />,
    );
    openEvidenceDisclosure(document.body);
    const button = screen.getByRole("button", {
      name: "Open manual~second · src/foo.ts at lines 10-25 in editor",
    });
    expect(button).toHaveTextContent("manual~second · foo.ts:10-25");
    expect(button.textContent).not.toContain("\u202e");
    fireEvent.click(button);
    expect(openReference).toHaveBeenCalledWith({
      root: "/second/manual",
      path: "src/foo.ts",
      lineStart: 10,
      lineEnd: 25,
    });
  });

  it("keeps distinct ranges from one file without displaying a numeric retrieval rank", () => {
    const citations = Array.from({ length: 6 }, (_, index) =>
      citation({
        stableId: `range-${String(index)}`,
        scopePath: "README.md",
        lineRange: { startLine: index * 10 + 1, endLine: index * 10 + 2 },
        score: 0.04,
      }),
    );
    const { container } = render(<GroundedAnswer answer={answer({ citations })} busy={false} />);
    expect(container.querySelectorAll(".grounded-citation")).toHaveLength(6);
    expect(screen.getByText("README.md:1-2")).toBeInTheDocument();
    expect(screen.getByText("README.md:51-52")).toBeInTheDocument();
    expect(screen.queryByText("0.04")).toBeNull();
    expect(container.querySelector(".grounded-citation-score")).toBeNull();
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
    // uiux-fix F012 C160: marker kinds are humanized ("no-evidence" -> "no evidence").
    expect(
      screen.getByText("Uncertainty (3 markers — no evidence, budget clipped)"),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(
        "no evidence: No matching evidence is available for this part of the answer.",
      ),
    ).toHaveLength(1);
    expect(screen.getByText("excerpt unavailable for src/baz.ts")).not.toBeVisible();
    expect(screen.getByText("other")).not.toBeVisible();
    expect(screen.getByText("clipped at foo")).not.toBeVisible();
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
    expect(screen.getByText("Not used: 3 files (binary: 1, low relevance: 2)")).toBeInTheDocument();
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

    expect(
      screen.getByText(
        /1 citation.*not recorded files in prompt.*2 omitted for relevance or budget.*1 ineligible/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Not used: 3 files (binary: 1, low relevance: 2)")).toBeInTheDocument();
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

  it("workspace-root scope renders the connected folder label without a file count", () => {
    const a = answer({
      contextPack: contextPack({ scopeKind: "workspace-root", fileCount: -1 }),
    });
    render(<GroundedAnswer answer={a} busy={false} />);
    const region = screen.getByRole("region", { name: "Context inspection summary" });
    expect(region.textContent).toContain("Scope: connected folder");
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
    expect(region.textContent).toContain("Search operations");
    expect(region.textContent).toContain("3 / 16 searches");
    expect(region.textContent).toContain("Assembled for this answer");
    expect(region.textContent).toContain("5 / 32 files");
    expect(region.textContent).toContain("Selected excerpt size");
    expect(region.textContent).toContain("12.1 KB / 128.0 KB");
    // uiux-fix F051 C318: token counts are thousands-separated for readability.
    expect(region.textContent).toContain("Model budget: input");
    expect(region.textContent).toContain("1,500 / 32,000 tokens");
    expect(region.textContent).toContain("Model budget: output");
    expect(region.textContent).toContain("400 / 4,096 tokens");
    expect(region.textContent).toContain("Rerank");
    expect(region.textContent).toContain("0 / 0 calls");
    expect(region.textContent).toContain("Response duration");
    expect(region.textContent).toContain("1.8 s");
    expect(region.textContent).toContain("Source search time limit30.0 s");
    expect(region.textContent).toContain("Search type");
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

  it("preserves distinct cited ranges for one evidence atom", () => {
    const citations = [
      citation({ stableId: "shared", lineRange: { startLine: 1, endLine: 4 }, score: 0.9 }),
      citation({ stableId: "shared", lineRange: { startLine: 10, endLine: 12 }, score: 0.8 }),
      citation({ stableId: "shared", lineRange: { startLine: 1, endLine: 4 }, score: 0.1 }),
    ];

    const { container } = render(<GroundedAnswer answer={answer({ citations })} busy={false} />);

    expect(container.querySelectorAll(".grounded-citations-item")).toHaveLength(2);
    expect(screen.getByText("src/foo.ts:1-4")).toBeInTheDocument();
    expect(screen.getByText("src/foo.ts:10-12")).toBeInTheDocument();
    expect(
      screen.getByText(
        /2 citations.*not recorded files in prompt.*0 omitted for relevance or budget.*0 ineligible/,
      ),
    ).toBeInTheDocument();
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

  it.each([false, true])(
    "strips unsafe Knowledge citation display characters without changing its target (action=%s)",
    (action) => {
      const citation = knowledgeCitation({
        source: "Hand\u0001book\u200b",
        label: "policy\u202e.pdf",
      });
      const preview = citationPreviewController("available", citation);
      const { container } = render(
        <GroundedAnswer
          answer={localKnowledgeAnswer([citation])}
          busy={false}
          {...(action ? { citationPreview: preview } : {})}
        />,
      );
      openEvidenceDisclosure(container);
      const label = "[1] Handbook · policy.pdf";
      const chip = action
        ? screen.getByRole("button", { name: `${label} · Open PDF` })
        : screen.getByText(label).closest(".grounded-citation");
      if (chip === null) throw new TypeError("Missing Knowledge citation chip");
      expect(chip).toHaveTextContent(label);
      expect(chip.getAttribute("title")).toMatch(/^Handbook · policy\.pdf/u);
      expect(chip.outerHTML).not.toMatch(/[\u0001\u200b\u202e]/u);
      if (action) {
        fireEvent.click(chip);
        expect(preview.openCitation).toHaveBeenCalledWith(citation, "citation-chip");
      }
    },
  );

  it("strips unsafe manual labels, titles and sections while opening the unchanged opaque target", () => {
    const openDocumentationTarget = vi.fn().mockReturnValue(true);
    const target = "keiko-html-manual-citation:original-safe-target";
    const citation = knowledgeCitation({
      source: "Device\u0001 Handbook",
      label: "original\u200b-label",
      htmlManual: {
        sourceKind: "html-manual-http",
        pageTitle: "device\u202e.html",
        safePageId: "safe-page",
        sectionPath: ["Trouble\u200bshooting", "Time\u0001outs"],
        parsedUnitId: "safe-unit",
        targetSummary: { originSummary: "https://manual.example.invalid", pathSummary: "/…" },
        open: { state: "available", target },
      },
    });
    const { container } = render(
      <GroundedAnswer
        answer={localKnowledgeAnswer([citation])}
        busy={false}
        openDocumentationTarget={openDocumentationTarget}
      />,
    );
    openEvidenceDisclosure(container);
    const chip = screen.getByRole("button", {
      name: "[1] Device Handbook · HTML manual · device.html · Troubleshooting · Timeouts · Open manual",
    });
    expect(chip.getAttribute("title")).toBe(
      "device.html · Troubleshooting · Timeouts — HTML manual evidence · Open manual",
    );
    expect(chip.outerHTML).not.toMatch(/[\u0001\u200b\u202e]/u);
    fireEvent.click(chip);
    expect(openDocumentationTarget).toHaveBeenCalledWith(target);
    expect(citation.htmlManual?.pageTitle).toBe("device\u202e.html");
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

  it("opens an eligible HTML manual citation in the existing documentation browser widget", () => {
    // Epic #1854 (#1879/#1881) regression: the citation chip must hand the opaque target to the
    // existing governed docs-browser widget (which alone calls navigateDocumentation and renders
    // the real reason/severity) instead of resolving/discarding the outcome itself.
    const openDocumentationTarget = vi.fn().mockReturnValue(true);
    const manualCitation = knowledgeCitation({
      source: "Device Handbook",
      htmlManual: {
        sourceKind: "html-manual-http",
        pageTitle: "device-handbook.html",
        safePageId: "doc-device",
        sectionPath: ["Troubleshooting", "Timeouts"],
        anchorId: "timeouts",
        parsedUnitId: "unit-device",
        targetSummary: {
          originSummary: "https://manual.internal",
          pathSummary: "/…",
        },
        open: {
          state: "available",
          target: "keiko-html-manual-citation:opaque",
        },
      },
    });
    const { container } = render(
      <GroundedAnswer
        answer={localKnowledgeAnswer([manualCitation])}
        busy={false}
        openDocumentationTarget={openDocumentationTarget}
      />,
    );

    openEvidenceDisclosure(container);
    const chip = screen.getByRole("button", {
      name: "[1] Device Handbook · HTML manual · device-handbook.html · Troubleshooting · Timeouts · Open manual",
    });
    expect(chip).not.toHaveClass("grounded-citation-action--blocked");
    fireEvent.click(chip);

    expect(openDocumentationTarget).toHaveBeenCalledWith("keiko-html-manual-citation:opaque");
    expect(screen.getByText("Opened")).toBeInTheDocument();
  });

  it("opens a page-level-only HTML manual citation (missing anchor) in the documentation browser widget", () => {
    const openDocumentationTarget = vi.fn().mockReturnValue(true);
    const manualCitation = knowledgeCitation({
      htmlManual: {
        sourceKind: "html-manual-local",
        pageTitle: "device-handbook.html",
        safePageId: "doc-device",
        open: {
          state: "page-level-only",
          target: "keiko-html-manual-citation:opaque-page",
          reason: "missing-anchor",
        },
      },
    });
    const { container } = render(
      <GroundedAnswer
        answer={localKnowledgeAnswer([manualCitation])}
        busy={false}
        openDocumentationTarget={openDocumentationTarget}
      />,
    );

    openEvidenceDisclosure(container);
    const chip = screen.getByRole("button", {
      name: "[1] HTML manual · device-handbook.html · Open page",
    });
    expect(chip).not.toHaveAttribute("aria-disabled");
    fireEvent.click(chip);

    expect(openDocumentationTarget).toHaveBeenCalledWith("keiko-html-manual-citation:opaque-page");
    expect(screen.getByText("Opened")).toBeInTheDocument();
  });

  it("shows a failed state when the documentation browser widget could not be opened", () => {
    const openDocumentationTarget = vi.fn().mockReturnValue(false);
    const manualCitation = knowledgeCitation({
      htmlManual: {
        sourceKind: "html-manual-local",
        pageTitle: "device-handbook.html",
        safePageId: "doc-device",
        open: {
          state: "available",
          target: "keiko-html-manual-citation:opaque",
        },
      },
    });
    const { container } = render(
      <GroundedAnswer
        answer={localKnowledgeAnswer([manualCitation])}
        busy={false}
        openDocumentationTarget={openDocumentationTarget}
      />,
    );

    openEvidenceDisclosure(container);
    fireEvent.click(
      screen.getByRole("button", { name: "[1] HTML manual · device-handbook.html · Open manual" }),
    );

    expect(openDocumentationTarget).toHaveBeenCalledWith("keiko-html-manual-citation:opaque");
    const chip = screen.getByRole("button", {
      name: "[1] HTML manual · device-handbook.html · Open failed",
    });
    expect(screen.getByText("Open failed")).toBeInTheDocument();
    expect(chip).toHaveClass("grounded-citation-action--blocked");
  });

  it("renders unavailable HTML manual citation targets without opening the documentation browser", () => {
    const openDocumentationTarget = vi.fn();
    const manualCitation = knowledgeCitation({
      htmlManual: {
        sourceKind: "html-manual-http",
        pageTitle: "device-handbook.html",
        safePageId: "doc-device",
        sectionPath: ["Troubleshooting"],
        open: {
          state: "unavailable",
          reason: "source-metadata-unavailable",
        },
      },
    });
    const { container } = render(
      <GroundedAnswer
        answer={localKnowledgeAnswer([manualCitation])}
        busy={false}
        openDocumentationTarget={openDocumentationTarget}
      />,
    );

    openEvidenceDisclosure(container);
    const chip = screen.getByRole("button", {
      name: "[1] HTML manual · device-handbook.html · Troubleshooting · Source unavailable",
    });
    expect(chip).toHaveAttribute("aria-disabled", "true");
    expect(chip).toHaveClass("grounded-citation-action--blocked");
    fireEvent.click(chip);

    expect(openDocumentationTarget).not.toHaveBeenCalled();
  });

  it("keeps long HTML manual citation labels shrinkable in constrained chip rows", () => {
    const longPageTitle =
      "device-handbook-with-a-very-long-manual-page-title-and-versioned-appendix-name.html";
    const manualCitation = knowledgeCitation({
      source: "Field Service Knowledge Pod With Long Display Name",
      htmlManual: {
        sourceKind: "html-manual-http",
        pageTitle: longPageTitle,
        safePageId: "doc-device-long",
        sectionPath: [
          "Troubleshooting",
          "Network Isolation",
          "Extremely Long Diagnostic Subsection Label",
        ],
        anchorId: "diagnostic-timeouts",
        parsedUnitId: "unit-device-long",
        targetSummary: {
          originSummary: "https://manual.internal",
          pathSummary: "/…",
        },
        open: {
          state: "available",
          target: "keiko-html-manual-citation:opaque-long",
        },
      },
    });
    const { container } = render(
      <div style={{ width: "280px" }}>
        <GroundedAnswer answer={localKnowledgeAnswer([manualCitation])} busy={false} />
      </div>,
    );

    openEvidenceDisclosure(container);
    const chip = screen.getByRole("button", {
      name: new RegExp(`${longPageTitle}.*Open manual`, "u"),
    });
    const item = chip.closest(".grounded-citations-item");
    const range = chip.querySelector(".grounded-citation-range");

    expect(item).toHaveClass(cssClass("citationListItem"));
    expect(chip).toHaveClass(cssClass("manualCitationAction"));
    expect(range).toHaveClass(cssClass("manualCitationRange"));
    expect(range).toHaveTextContent(longPageTitle);
    expect(chip).toHaveAttribute("title", expect.stringContaining(longPageTitle));
    expect(screen.getByText("Open manual")).toBeInTheDocument();
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

  it("renders hostile repository and Knowledge citation labels only as escaped text", () => {
    const hostile = '<img src=x onerror="globalThis.pwned=true"><script>alert(1)</script>';
    const { container } = render(
      <>
        <GroundedAnswer
          answer={answer({ citations: [citation({ scopePath: hostile })] })}
          busy={false}
        />
        <GroundedAnswer
          answer={localKnowledgeAnswer([
            knowledgeCitation({ label: hostile, source: `<svg onload="pwned()">${hostile}</svg>` }),
          ])}
          busy={false}
        />
      </>,
    );

    expect(container.textContent).toContain(hostile);
    expect(container.querySelector("img, script, svg, [onerror], [onload]")).toBeNull();
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

  it("labels a memory-only local answer as ungrounded without inventing source citations", () => {
    const memoryOnly = {
      ...localKnowledgeAnswer([]),
      content: "You prefer pnpm.",
      noEvidence: true,
      noEvidenceReason: "answer-only-memory",
    };
    const { container } = render(<GroundedAnswer answer={memoryOnly} busy={false} />);
    const warning = container.querySelector(".grounded-uncertainty[role='alert']");
    expect(warning?.textContent?.toLowerCase()).toContain("not grounded");
    expect(container.querySelectorAll(".grounded-citation")).toHaveLength(0);
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

  it("Knowledge M1.2 (#2563): flags unsupported claims (cited but not entailed) at the summary level", () => {
    const a = answer({
      uncertainty: [
        {
          kind: "unsupported-claim",
          claim: "The answer made a claim the cited source does not support: policy.md.",
        },
      ],
    });
    const { container } = render(<GroundedAnswer answer={a} busy={false} />);
    const warning = container.querySelector(".grounded-uncertainty[role='alert']");
    expect(warning?.textContent?.toLowerCase()).toContain("unsupported claim");
  });

  it("Knowledge M1.2 (#2563): surfaces the entailment-unavailable WARN caveat at the summary level", () => {
    const a = answer({
      uncertainty: [
        { kind: "entailment-unavailable", claim: "Citation support could not be verified." },
      ],
    });
    const { container } = render(<GroundedAnswer answer={a} busy={false} />);
    const warning = container.querySelector(".grounded-uncertainty[role='alert']");
    expect(warning?.textContent?.toLowerCase()).toContain("could not be verified");
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

  it("RB-4 (GEN-AI-RETRIEVAL-001): surfaces silent reranker degradation for an invalid-response status", () => {
    const base = localKnowledgeAnswer();
    const a = {
      ...base,
      contextPack: {
        ...base.contextPack,
        reranker: {
          status: "invalid-response" as const,
          failureKind: "invalid-response" as const,
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

  it("RB-4 (GEN-AI-RETRIEVAL-001): does not surface a Needs review banner for a not-configured reranker (default, safe install state)", () => {
    // Regression for Epic #1820 / #1922: a reranker that was simply never configured is the
    // default, fully-supported state, not a degradation — the summary banner must stay silent
    // even though the redacted diagnostics still carry failureKind "not-configured".
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
    expect(container.querySelector(".grounded-uncertainty[role='alert']")).toBeNull();
  });
});

// The customer's grounded chat (German UI, model gemma via LiteLLM) rendered "Needs review",
// "1 unsupported citation" and "Citation support could not be verified" in English, and counted
// marker OBJECTS instead of the dangling markers. Every line is localised by marker kind.
describe("GroundedAnswer — citation warnings by marker kind", () => {
  afterEach(() => {
    window.localStorage.removeItem(I18N_STORAGE_KEY);
    resetLoadedMessageCatalogs();
  });

  function renderInLocale(
    locale: "en" | "de",
    a: GroundedAnswerType,
    citationPreview?: CitationPreviewController,
  ): ReturnType<typeof render> {
    window.localStorage.setItem(I18N_STORAGE_KEY, locale);
    return render(
      <I18nProvider>
        <GroundedAnswer answer={a} busy={false} citationPreview={citationPreview} />
      </I18nProvider>,
    );
  }

  it.each(["en", "de"] as const)(
    "uses the %s locale for inspection counts and file singulars",
    async (locale) => {
      const pack = contextPack({
        budget: { ...contextPack().budget, filesReadMax: null },
        usage: { ...contextPack().usage, filesRead: 1, excerptBytes: 12400 },
        omittedCount: 1000,
        omittedCounts: { ...OMITTED_COUNTS_ZERO, binary: 1000 },
      });
      const a = answer({ contextPack: pack, omittedCount: 1000 });
      const { container } = renderInLocale(locale, a);
      if (locale === "de")
        await waitFor(() => expect(container).toHaveTextContent("Nicht als Quelle verwendet"));
      expect(container).toHaveTextContent(
        locale === "de" ? "1 Datei zusammengestellt" : "1 file assembled",
      );
      expect(container).toHaveTextContent(locale === "de" ? "1.000 Dateien" : "1,000 files");
      expect(container).toHaveTextContent(locale === "de" ? "12,1 KB" : "12.1 KB");
      expect(container).toHaveTextContent(locale === "de" ? "1,8 s" : "1.8 s");
    },
  );

  it.each(["en", "de"] as const)(
    "renders duration boundary carry and matching byte precision in %s",
    async (locale) => {
      const pack = contextPack({
        elapsedMs: 59_970,
        budget: { ...contextPack().budget, elapsedMsMax: 60_000 },
      });
      const { container } = renderInLocale(locale, answer({ contextPack: pack }));
      const durationLabel = locale === "de" ? "Antwortdauer" : "Response duration";
      await waitFor(() => expect(container).toHaveTextContent(durationLabel));
      expect(container).toHaveTextContent(`${durationLabel}1m 0s`);
      expect(container).not.toHaveTextContent(/60[.,]0 s/);
      expect(container).toHaveTextContent(
        locale === "de" ? "12,1 KB / 128,0 KB" : "12.1 KB / 128.0 KB",
      );
      expect(pack.elapsedMs).toBe(59_970);
    },
  );

  it.each(["en", "de"] as const)(
    "uses singular file nouns for one omitted file in %s",
    async (locale) => {
      const pack = contextPack({
        budget: { ...contextPack().budget, filesReadMax: null },
        usage: { ...contextPack().usage, filesRead: 1 },
        omittedCount: 1,
        omittedCounts: { ...OMITTED_COUNTS_ZERO, binary: 1 },
      });
      const { container } = renderInLocale(locale, answer({ contextPack: pack, omittedCount: 1 }));
      const text = locale === "de" ? "Nicht als Quelle verwendet: 1 Datei (" : "Not used: 1 file (";
      await waitFor(() => expect(container).toHaveTextContent(text));
      expect(container).not.toHaveTextContent(
        locale === "de" ? "1 Dateien zusammengestellt" : "1 files assembled",
      );
    },
  );

  it("shows each grouped marker count and deduplicates identical original details", () => {
    const markers = ["detail A", "detail A", "detail B", "detail B", "detail C"].map((claim) =>
      uncertainty({ claim, kind: "budget-clipped" }),
    );
    const { container } = renderInLocale("en", answer({ uncertainty: markers }));
    const list = container.querySelector(".grounded-uncertainty-list");
    expect(list).toHaveTextContent("5 markers");
    expect(list?.querySelectorAll("details p")).toHaveLength(3);
    expect(list?.querySelector("details")).toHaveClass(cssClass("cmpOriginalDetails"));
    expect(list?.querySelector("details p")).not.toHaveAttribute("style");
  });

  it("localizes hybrid scope, activity and PDF actions in German", async () => {
    const knowledge = localKnowledgeAnswer();
    if (knowledge.groundingKind !== "local-knowledge")
      throw new Error("Expected knowledge fixture.");
    const a: GroundedAnswerType = {
      ...answer(),
      groundingKind: "hybrid",
      citations: [citation()],
      knowledgeCitations: [knowledgeCitation()],
      retrievalActivity: retrievalActivity(),
      contextPack: {
        kind: "hybrid",
        folderSourceCount: 1,
        connectorSourceCount: 1,
        folder: contextPack(),
        knowledge: knowledge.contextPack,
      },
    };
    const { container } = renderInLocale(
      "de",
      a,
      citationPreviewController("available", knowledgeCitation()),
    );
    await waitFor(() =>
      expect(container).toHaveTextContent("Kombiniert: 1 Ordnerquelle + 1 Knowledge-Pod-Quelle"),
    );
    expect(container).toHaveTextContent("Wissensumfang:");
    expect(container).toHaveTextContent("Knowledge-Pod-Aktivität");
    expect(container).toHaveTextContent("PDF öffnen");
    expect(container).toHaveTextContent("Gründe: Durchsucht");
    expect(container).toHaveTextContent("Modi:");
    expect(container).toHaveTextContent("Gründe:");
    expect(container).not.toHaveTextContent(
      /Knowledge scope|Context budget|Modes:|Reasons:|Searched/u,
    );
  });

  it("localizes HTML manual and repository opening affordances in German", async () => {
    const manual = knowledgeCitation({
      htmlManual: {
        sourceKind: "html-manual-local",
        pageTitle: "handbook.html",
        safePageId: "manual-1",
        parsedUnitId: "unit-1",
        targetSummary: { originSummary: "local", pathSummary: "/…" },
        open: { state: "available", target: "keiko-html-manual-citation:opaque" },
      },
    });
    const { unmount } = renderInLocale("de", localKnowledgeAnswer([manual]));
    expect(
      await screen.findByRole("button", { name: /HTML-Handbuch.*Handbuch öffnen/u }),
    ).toBeInTheDocument();
    unmount();
    const open = vi.fn(() => ({ ok: true as const, windowId: "source-window" }));
    render(
      <I18nProvider>
        <GroundedAnswer
          answer={answer()}
          busy={false}
          repositoryRoots={[{ root: "/repo", label: "repo" }]}
          openRepositoryReference={open}
        />
      </I18nProvider>,
    );
    const button = await screen.findByRole("button", {
      name: "src/foo.ts in Zeilen 10-25 im Editor öffnen",
    });
    fireEvent.click(button);
    expect(open).toHaveBeenCalledWith({
      root: "/repo",
      path: "src/foo.ts",
      lineStart: 10,
      lineEnd: 25,
    });
    expect(await screen.findByRole("status")).toHaveTextContent("src/foo.ts im Editor geöffnet.");
  });

  it("groups repeated retrieval warnings while retaining every technical claim", () => {
    const markers = Array.from({ length: 9 }, (_, index) =>
      uncertainty({
        kind: "scope-incomplete",
        claim: index === 0 ? "" : `Scan detail ${String(index)} <script>unsafe()</script>`,
      }),
    );
    const { container } = renderInLocale("en", answer({ uncertainty: markers }));
    const list = container.querySelector(
      '.grounded-uncertainty[role="note"] .grounded-uncertainty-list',
    );
    expect(list?.children).toHaveLength(1);
    expect(list?.querySelectorAll("details p")).toHaveLength(9);
    expect(list?.querySelector("details p")?.textContent).toBe("");
    expect(list?.querySelectorAll("script")).toHaveLength(0);
    expect(list).toHaveTextContent("Scan detail 8 <script>unsafe()</script>");
    expect(container.querySelector(".grounded-uncertainty[role='note']")).toHaveTextContent(
      "Uncertainty (9 markers — scope incomplete)",
    );
  });

  it.each([
    "no-evidence",
    "stale-evidence",
    "scope-incomplete",
    "budget-clipped",
    "tool-unavailable",
    "low-confidence",
  ])("groups repeated %s retrieval details without dropping originals", (kind) => {
    const { container } = renderInLocale(
      "en",
      answer({
        uncertainty: [
          uncertainty({ kind, claim: "First" }),
          uncertainty({ kind, claim: "Second" }),
        ],
      }),
    );
    const list = container.querySelector(
      '.grounded-uncertainty[role="note"] .grounded-uncertainty-list',
    );
    expect(list?.children).toHaveLength(1);
    expect(list?.querySelectorAll("details p")).toHaveLength(2);
    expect(list).toHaveTextContent("First");
    expect(list).toHaveTextContent("Second");
  });

  it("groups only closed retrieval kinds while preserving citation and future-kind findings", () => {
    const markers = [
      uncertainty({ kind: "scope-incomplete", claim: "First scope detail" }),
      uncertainty({ kind: "unsupported-citation", claim: "Unsupported citations: [2]" }),
      uncertainty({ kind: "scope-incomplete", claim: "Second scope detail" }),
      uncertainty({ kind: "unsupported-citation", claim: "Unsupported citations: [7]" }),
      uncertainty({ kind: "future-retrieval-kind", claim: "First future claim" }),
      uncertainty({ kind: "future-retrieval-kind", claim: "Second future claim" }),
    ];
    const { container } = renderInLocale("en", answer({ uncertainty: markers }));
    const list = container.querySelector(
      '.grounded-uncertainty[role="note"] .grounded-uncertainty-list',
    );
    expect(list?.children).toHaveLength(5);
    expect(list).toHaveTextContent("[2]");
    expect(list).toHaveTextContent("[7]");
    expect(list).toHaveTextContent("First future claim");
    expect(list).toHaveTextContent("Second future claim");
    expect(list?.querySelectorAll("details p")).toHaveLength(2);
  });

  it("labels German exclusion details as recorded examples rather than a total", async () => {
    const { container } = renderInLocale(
      "de",
      answer({
        contextPack: contextPack({
          omittedCounts: { ...OMITTED_COUNTS_ZERO, "size-exceeded": 1, binary: 49 },
        }),
      }),
    );
    await waitFor(() =>
      expect(container.querySelector(".grounded-coverage-notice")).toHaveTextContent(
        "Mindestens 50 Dateien wurden nicht durchsucht (erfasste Ausschlüsse:",
      ),
    );
    expect(container.querySelector(".grounded-coverage-notice")).toHaveTextContent(
      "möglicherweise nicht jede ausgeschlossene Datei",
    );
  });

  function emptySearchAnswer(): GroundedAnswerType {
    return answer({
      content:
        "I could not find evidence in the connected scope to answer this question. " +
        "No answer is given because there is nothing to ground it in.",
      citations: [],
      uncertainty: [{ kind: "no-evidence", claim: "No evidence matched." }],
      contextPack: producedEmptyScopeSummary(
        contextPack({
          queryKind: "exact-symbol",
          citationCount: 0,
          usage: {
            ...contextPack().usage,
            filesRead: 0,
            excerptBytes: 0,
            modelInputTokens: 0,
            modelOutputTokens: 0,
          },
          coverage: {
            incomplete: false,
            reasons: [],
            filesDiscovered: 200_005,
            filesAfterPolicy: 200_002,
            filesScanned: 200_002,
            filesSkipped: 0,
            truncated: false,
            ignoredByDiscovery: 3,
            deniedByDiscovery: 0,
            depthPrunedByDiscovery: 0,
            maxFilesPrunedByDiscovery: 0,
            matchesReturned: 0,
            elapsedMs: 34_000,
            limits: { maxFilesScanned: null, maxMatchesReturned: 50, elapsedMsMax: null },
          },
        }),
      ),
    });
  }

  it("shows a complete empty search as a neutral German result with eligible coverage", async () => {
    const { container } = renderInLocale("de", emptySearchAnswer());
    const status = await screen.findByRole("status");
    await waitFor(() =>
      expect(status).toHaveTextContent("Keine passenden Belege für diese Suche gefunden."),
    );
    expect(status).toHaveTextContent("200.002 / 200.002 zulässige Dateien durchsucht");
    expect(status).not.toHaveTextContent("200,005");
    expect(container.querySelector(".grounded-uncertainty[role='alert']")).toBeNull();
    expect(container).not.toHaveTextContent("Bitte prüfen");
    expect(container).not.toHaveTextContent("diese Antwort ist nicht belegt");
  });

  it.each(["scope-incomplete", "budget-clipped", "tool-unavailable", "unsupported-claim"])(
    "keeps an empty search with %s as a review warning",
    (kind) => {
      const a = emptySearchAnswer();
      const { container } = renderInLocale("en", {
        ...a,
        uncertainty: [...a.uncertainty, { kind, claim: "Search could not complete." }],
      });
      expect(container.querySelector(".grounded-uncertainty[role='alert']")).not.toBeNull();
      expect(container).toHaveTextContent("Needs review");
    },
  );

  it.each([
    "incomplete",
    "truncated",
    "unscanned",
    "skipped",
    "matches",
    "omissions",
    "model-answer",
  ])("does not certify an empty search with %s", (caseName) => {
    const a = emptySearchAnswer();
    if (a.groundingKind !== "connected-context" || a.contextPack.coverage === undefined) {
      throw new TypeError("expected connected empty search fixture");
    }
    const coverage = { ...a.contextPack.coverage };
    const pack = a.contextPack;
    if (caseName === "incomplete") coverage.incomplete = true;
    if (caseName === "truncated") coverage.truncated = true;
    if (caseName === "unscanned") coverage.filesScanned -= 1;
    if (caseName === "skipped") coverage.filesSkipped = 1;
    if (caseName === "matches") coverage.matchesReturned = 1;
    const { container } = renderInLocale("en", {
      ...a,
      ...(caseName === "model-answer" ? { content: "This project does not support OAuth." } : {}),
      contextPack: {
        ...pack,
        coverage,
        ...(caseName === "omissions" ? { omittedCount: 1 } : {}),
      },
    });
    expect(container.querySelector(".grounded-uncertainty[role='alert']")).not.toBeNull();
  });

  it("retains review warnings when a canonical empty answer includes selected file reads", () => {
    const a = emptySearchAnswer();
    if (a.groundingKind !== "connected-context") throw new TypeError("expected connected fixture");
    const { container } = renderInLocale("en", {
      ...a,
      contextPack: {
        ...a.contextPack,
        usage: { ...a.contextPack.usage, filesRead: 1 },
      },
    });
    expect(container.querySelector(".grounded-uncertainty[role='alert']")).not.toBeNull();
  });

  it("retains review warnings when the empty answer reports model output usage", () => {
    const a = emptySearchAnswer();
    if (a.groundingKind !== "connected-context") throw new TypeError("expected connected fixture");
    const { container } = renderInLocale("en", {
      ...a,
      contextPack: {
        ...a.contextPack,
        usage: { ...a.contextPack.usage, modelOutputTokens: 1 },
      },
    });
    expect(container.querySelector(".grounded-uncertainty[role='alert']")).not.toBeNull();
  });

  it("separates German recursive traversal from selected reads and source time bounds", async () => {
    const pack = contextPack({
      scopeKind: "workspace-root",
      fileCount: -1,
      budget: { ...contextPack().budget, elapsedMsMax: null },
      coverage: {
        incomplete: false,
        reasons: [],
        filesDiscovered: 200_002,
        filesAfterPolicy: 200_002,
        filesScanned: 200_002,
        filesSkipped: 0,
        truncated: false,
        ignoredByDiscovery: 0,
        deniedByDiscovery: 0,
        depthPrunedByDiscovery: 0,
        maxFilesPrunedByDiscovery: 0,
        matchesReturned: 2,
        elapsedMs: 34_700,
        limits: { maxFilesScanned: null, maxMatchesReturned: 50, elapsedMsMax: null },
      },
      omittedCount: 3,
      omittedCounts: { ...OMITTED_COUNTS_ZERO, binary: 1, "low-relevance": 2 },
    });
    renderInLocale("de", answer({ contextPack: pack, citations: [citation({ score: 1 })] }));
    const region = await screen.findByRole("region", { name: "Prüfung verbundener Dateien" });
    expect(within(region).getByText("Rekursiv geprüft")).toBeInTheDocument();
    expect(region).toHaveTextContent("200.002 / 200.002 Dateien je Suchbereich");
    expect(region).toHaveTextContent(
      "Überlappende Suchbereiche können dieselbe Datei mehrfach zählen",
    );
    expect(within(region).getByText("Für die Antwort zusammengestellt")).toBeInTheDocument();
    expect(region).toHaveTextContent("5 / 32 Dateien");
    expect(region).toHaveTextContent("32 ist das Lesebudget für diese Antwort");
    expect(within(region).getByText("Suchzeitlimit")).toBeInTheDocument();
    expect(region).toHaveTextContent("Kein Suchzeitlimit");
    expect(region).toHaveTextContent("Modellaufrufe haben eigene Wartezeiten");
    expect(region).not.toHaveTextContent("Searched");
    expect(region).not.toHaveTextContent("∞");
    expect(screen.getByText(/Nicht als Quelle verwendet: 3 Dateien/)).toBeInTheDocument();
    expect(screen.queryByText("1.00")).toBeNull();
    expect(screen.getByTitle("Quellenangabe in src/foo.ts in Zeilen 10-25")).toBeInTheDocument();
  });

  it("counts the distinct dangling marker indices, not the marker objects", () => {
    const a = localKnowledgeAnswer();
    const { container } = render(
      <GroundedAnswer
        answer={{
          ...a,
          uncertainty: [
            {
              kind: "unsupported-citation",
              claim:
                "The answer cited evidence markers not present in the retrieved evidence: [7], [8], [9]. Treat the affected claims as unverified.",
            },
            {
              kind: "unsupported-citation",
              claim:
                "The answer cited an evidence marker not present in the retrieved evidence: [9]. Treat the affected claims as unverified.",
            },
          ],
        }}
        busy={false}
      />,
    );

    const warning = container.querySelector(".grounded-uncertainty[role='alert']");
    expect(warning?.textContent).toContain("3 unsupported citations");
    expect(warning?.textContent).not.toContain("2 unsupported citations");
  });

  // PR #3678 review: the server lists at most eight findings per marker; the count must be the
  // stated total, not the listed items, and one claims marker can stand for several claims.
  // PR #3678 review: the answer-level "support could not be verified" caveat must say which
  // source it is about, and a verified answer must not mark any source.
  it("marks a weakly supported citation unverified only while no judge verified the answer", () => {
    const weak = knowledgeCitation({ lexicalSupport: "weak" });
    const strong = knowledgeCitation({
      stableId: "lk-2",
      marker: "[2]",
      label: "beta.md",
      lineage: { ...weak.lineage, chunkId: "chunk-2" as typeof weak.lineage.chunkId },
    });
    const caveat = { kind: "entailment-unavailable", claim: "Support could not be verified." };
    const unverified = render(
      <GroundedAnswer
        answer={{ ...localKnowledgeAnswer([weak, strong]), uncertainty: [caveat] }}
        busy={false}
      />,
    );
    const chips = unverified.container.querySelectorAll(".grounded-citation");
    expect(chips).toHaveLength(2);
    expect(within(unverified.container).getAllByText("unverified")).toHaveLength(1);
    expect(
      [...chips].find((chip) => chip.textContent?.includes("alpha.md"))?.textContent,
    ).toContain("unverified");
    unverified.unmount();

    const verified = render(
      <GroundedAnswer answer={localKnowledgeAnswer([weak, strong])} busy={false} />,
    );
    expect(within(verified.container).queryByText("unverified")).toBeNull();
  });

  // PR #3678 review: the HTML-manual chip dropped the unverified support, and a chip whose
  // aria-label replaces its content must name it for a screen reader as well.
  it("names unverified support on the HTML-manual chip, visibly and in its accessible name", () => {
    const manualCitation = knowledgeCitation({
      source: "Device Handbook",
      lexicalSupport: "weak",
      htmlManual: {
        sourceKind: "html-manual-http",
        pageTitle: "device-handbook.html",
        safePageId: "doc-device",
        sectionPath: ["Troubleshooting", "Timeouts"],
        anchorId: "timeouts",
        parsedUnitId: "unit-device",
        targetSummary: { originSummary: "https://manual.internal", pathSummary: "/…" },
        open: { state: "available", target: "keiko-html-manual-citation:opaque" },
      },
    });
    const caveat = { kind: "entailment-unavailable", claim: "Support could not be verified." };
    const { container } = render(
      <GroundedAnswer
        answer={{ ...localKnowledgeAnswer([manualCitation]), uncertainty: [caveat] }}
        busy={false}
        openDocumentationTarget={vi.fn().mockReturnValue(true)}
      />,
    );

    openEvidenceDisclosure(container);
    const chip = screen.getByRole("button", {
      name: "[1] Device Handbook · HTML manual · device-handbook.html · Troubleshooting · Timeouts · unverified · Open manual",
    });
    expect(chip).toHaveTextContent("unverified");
  });

  it("counts the stated total of a marker that lists only part of its findings", () => {
    const listed = Array.from({ length: CITATION_FINDING_LIST_MAX }, (_, i) => i + 5);
    const a = localKnowledgeAnswer();
    const { container } = render(
      <GroundedAnswer
        answer={{
          ...a,
          uncertainty: [
            {
              kind: "unsupported-citation",
              claim:
                "The answer cited evidence markers not present in the retrieved evidence: " +
                `${listed.map((index) => `[${String(index)}]`).join(", ")}. Treat the affected ` +
                `claims as unverified.${citationFindingTotalSuffix(12)}`,
            },
            {
              kind: "unsupported-claim",
              claim:
                "The answer made claims that the cited sources do not appear to support: [1], [2]" +
                `. Treat those statements as unverified.${citationFindingTotalSuffix(3)}`,
            },
          ],
        }}
        busy={false}
      />,
    );

    const warning = container.querySelector(".grounded-uncertainty[role='alert']");
    expect(warning?.textContent).toContain("12 unsupported citations");
    expect(warning?.textContent).toContain("3 unsupported claims");
  });

  it("does not call an answer without any marker an unsupported citation", () => {
    const a = localKnowledgeAnswer();
    const { container } = render(
      <GroundedAnswer
        answer={{
          ...a,
          uncertainty: [
            {
              kind: "uncited-answer",
              claim: "The answer used retrieved evidence without a supported inline citation.",
            },
          ],
        }}
        busy={false}
      />,
    );

    const warning = container.querySelector(".grounded-uncertainty[role='alert']");
    expect(warning?.textContent).toContain("without an inline citation");
    expect(warning?.textContent?.toLowerCase()).not.toContain("unsupported citation");
    expect(warning?.textContent).not.toContain("not in the retrieved evidence");
  });

  it("renders the grounded warnings, evidence title and summary in German under the de locale", async () => {
    const a = {
      ...localKnowledgeAnswer(),
      uncertainty: [
        { kind: "unsupported-citation", claim: "The answer cited ... markers: [7], [8]." },
        { kind: "entailment-unavailable", claim: "Citation support could not be verified." },
      ],
    };
    const { container } = renderInLocale("de", a);

    await waitFor(() => {
      expect(container.querySelector(".grounded-uncertainty[role='alert']")?.textContent).toContain(
        "Bitte prüfen",
      );
    });
    const warning = container.querySelector(".grounded-uncertainty[role='alert']");
    expect(warning?.textContent).toContain("2 nicht belegte Quellenangaben");
    expect(warning?.textContent).toContain(
      "Die Quellenbelege konnten für einen Teil dieser Antwort nicht geprüft werden.",
    );
    expect(warning?.textContent).not.toContain("Needs review");
    expect(warning?.textContent).not.toContain("could not be verified");
    expect(screen.getByText("Knowledge-Evidenz")).toBeInTheDocument();
    expect(screen.getByText("1 Quellenangabe · 1 / 10 Referenzen")).toBeInTheDocument();
  });

  it.each(["de", "en"] as const)(
    "shows uncapped selected reads without a false denominator in %s",
    async (locale) => {
      const pack = contextPack();
      const { container } = renderInLocale(
        locale,
        answer({
          contextPack: { ...pack, budget: { ...pack.budget, filesReadMax: null } },
        }),
      );
      await screen.findAllByText(locale === "de" ? "Evidenz" : "Evidence");
      openEvidenceDisclosure(container);
      expect(container).not.toHaveTextContent("5 / 32");
      expect(container).not.toHaveTextContent("5 / —");
      expect(container).not.toHaveTextContent("5 / ∞");
      expect(container).toHaveTextContent(
        locale === "de" ? "5 Dateien zusammengestellt" : "5 files assembled",
      );
      expect(container).toHaveTextContent(
        locale === "de" ? "Kein festes Dateianzahllimit" : "No fixed file-count limit",
      );
    },
  );

  it("retains an explicitly finite32 read budget in the evidence summary and counters", async () => {
    const { container } = renderInLocale("de", answer({ contextPack: contextPack() }));
    await screen.findAllByText("Evidenz");
    openEvidenceDisclosure(container);
    expect(container).toHaveTextContent("5 / 32 Dateien");
    expect(container).toHaveTextContent("32 ist das Lesebudget");
    expect(container).not.toHaveTextContent("Kein festes Dateianzahllimit");
  });

  it("keeps a fully inspected match-limited search informational without a review alert", async () => {
    const { container } = renderInLocale(
      "en",
      answer({ contextPack: contextPack({ coverage: fullMatchLimitedCoverage() }) }),
    );
    await screen.findAllByText("Evidence");
    expect(container.querySelector(".grounded-uncertainty[role='alert']")).toBeNull();
    expect(container.querySelector(".grounded-evidence-summary-badge")).toBeNull();
    openEvidenceDisclosure(container);
    expect(container).toHaveTextContent("Additional matching results omitted");
    expect(container).toHaveTextContent("112 / 112");
  });

  it("retains other genuine review warnings with a fully inspected match-limited search", async () => {
    const { container } = renderInLocale(
      "en",
      answer({
        uncertainty: [uncertainty({ kind: "unsupported-citation" })],
        contextPack: contextPack({ coverage: fullMatchLimitedCoverage() }),
      }),
    );
    const warning = await screen.findByRole("alert");
    expect(warning).toHaveTextContent("citation");
    expect(warning).not.toHaveTextContent("Additional matching results omitted");
    expect(container.querySelector(".grounded-evidence-summary-badge")).toHaveTextContent(
      "Needs review",
    );
  });

  it("warns with the generic scope detail when incomplete coverage has no detailed reason", async () => {
    renderInLocale(
      "en",
      answer({
        contextPack: contextPack({
          coverage: fullMatchLimitedCoverage({ reasons: [] }),
        }),
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("selected evidence is incomplete");
  });

  it.each(["match-cap", "io-error"] as const)(
    "uses the hybrid folder coverage for the %s summary warning",
    async (reason) => {
      const a: GroundedAnswerType = {
        ...answer(),
        groundingKind: "hybrid",
        citations: [citation()],
        knowledgeCitations: [knowledgeCitation()],
        contextPack: {
          kind: "hybrid",
          folderSourceCount: 1,
          connectorSourceCount: 1,
          folder: contextPack({ coverage: fullMatchLimitedCoverage({ reasons: [reason] }) }),
          knowledge: localKnowledgeAnswer().contextPack,
        },
      };
      const { container } = renderInLocale("en", a);
      await screen.findAllByText("Evidence");
      const warning = container.querySelector(".grounded-uncertainty[role='alert']");
      if (reason === "match-cap") expect(warning).toBeNull();
      else expect(warning).toHaveTextContent("error occurred");
    },
  );

  it("does not infer a folder coverage warning for a local-knowledge-only answer", async () => {
    const { container } = renderInLocale("en", localKnowledgeAnswer());
    await screen.findAllByText("Knowledge evidence");
    expect(container.querySelector(".grounded-uncertainty[role='alert']")).toBeNull();
    expect(container.querySelector(".grounded-evidence-summary-badge")).toBeNull();
  });

  it.each(["io-error", "timeout"] as const)(
    "shows %s coverage gaps before evidence is expanded, even with no omissions",
    async (reason) => {
      const { container } = renderInLocale(
        "en",
        answer({
          uncertainty: [],
          omittedCount: 0,
          contextPack: contextPack({
            coverage: fullMatchLimitedCoverage({
              incomplete: true,
              reasons: [reason],
            }),
          }),
        }),
      );
      const warning = await screen.findByRole("alert");
      expect(warning).toBeVisible();
      expect(warning).toHaveTextContent(reason === "io-error" ? /error occurred/i : /incomplete/i);
      expect(
        container.querySelector(".grounded-evidence-summary .grounded-evidence-summary-badge"),
      ).toHaveTextContent("Partial coverage");
      expect(container.querySelector(".grounded-evidence-disclosure")).not.toHaveAttribute("open");
    },
  );

  it.each(["match-cap", "io-error"] as const)(
    "explains typed %s coverage truthfully in German",
    async (reason) => {
      const pack = contextPack();
      const claim = "Opaque original coverage diagnostic.";
      const { container } = renderInLocale(
        "de",
        answer({
          uncertainty: [{ kind: "scope-incomplete", claim }],
          contextPack: {
            ...pack,
            coverage: fullMatchLimitedCoverage({ reasons: [reason] }),
          },
        }),
      );
      await screen.findAllByText("Evidenz");
      openEvidenceDisclosure(container);
      expect(container).toHaveTextContent(
        reason === "match-cap"
          ? "Weitere passende Treffer wurden nicht in die Antwortbelege aufgenommen."
          : "Beim Durchsuchen oder Lesen verbundener Quellen trat ein Fehler auf.",
      );
      if (reason === "match-cap")
        expect(container).toHaveTextContent(
          "Alle zugelassenen Dateien je Suchbereich wurden durchsucht.",
        );
      expect(container).toHaveTextContent("Umfang unvollständig");
      expect(screen.getByText(claim)).not.toBeVisible();
      fireEvent.click(screen.getByText("Technische Originaldetails"));
      expect(screen.getByText(claim)).toBeVisible();
    },
  );

  it.each(["de", "en"] as const)(
    "keeps independent structural uncertainty distinct from search match coverage in %s",
    async (locale) => {
      const claim = "Structural source inspection could not read the requested line range.";
      const { container } = renderInLocale(
        locale,
        answer({
          uncertainty: [{ kind: "scope-incomplete", claim }],
          contextPack: { ...contextPack(), coverage: fullMatchLimitedCoverage() },
        }),
      );
      await screen.findAllByText(locale === "de" ? "Evidenz" : "Evidence");
      openEvidenceDisclosure(container);
      const uncertainty = container.querySelector(
        ".grounded-evidence-body .grounded-uncertainty-list",
      );
      const summary = container.querySelector(".grounded-context-pack");
      expect(uncertainty).toHaveTextContent(
        locale === "de"
          ? "Die ausgewählten Belege sind unvollständig."
          : "The selected evidence is incomplete.",
      );
      expect(uncertainty).not.toHaveTextContent(
        locale === "de"
          ? "Alle zugelassenen Dateien je Suchbereich wurden durchsucht."
          : "All eligible files in each search scope were searched.",
      );
      expect(summary).toHaveTextContent(
        locale === "de"
          ? "Weitere passende Treffer wurden nicht in die Antwortbelege aufgenommen."
          : "Additional matching results were not included in the answer evidence.",
      );
      expect(screen.getByText(claim)).not.toBeVisible();
      fireEvent.click(
        screen.getByText(
          locale === "de" ? "Technische Originaldetails" : "Technical original details",
        ),
      );
      expect(screen.getByText(claim)).toBeVisible();
    },
  );

  it.each([
    { filesScanned: 111 },
    { filesSkipped: 1 },
    { depthPrunedByDiscovery: 1 },
    { maxFilesPrunedByDiscovery: 1 },
    { reasons: ["match-cap", "io-error"] as const },
    { reasons: ["timeout"] as const },
  ])("does not claim complete traversal for incomplete coverage %j", async (coverage) => {
    const pack = contextPack();
    const { container } = renderInLocale(
      "en",
      answer({
        uncertainty: [{ kind: "scope-incomplete", claim: "Original incomplete evidence." }],
        contextPack: { ...pack, coverage: fullMatchLimitedCoverage(coverage) },
      }),
    );
    await screen.findAllByText("Evidence");
    openEvidenceDisclosure(container);
    expect(container).not.toHaveTextContent(
      "All eligible files in each search scope were searched.",
    );
    expect(container).toHaveTextContent("scope incomplete");
  });

  it("localizes incomplete search hints while retaining exact original diagnostics behind disclosure", async () => {
    const claims = [
      "repository search coverage was incomplete (reasons io-error)",
      "project metadata discovery was incomplete for the connected scope",
      "No evidence matched the requested question.",
    ];
    const { container } = renderInLocale("de", {
      ...localKnowledgeAnswer(),
      uncertainty: claims.map((claim, index) => ({
        kind: index === 2 ? "no-evidence" : "scope-incomplete",
        claim,
      })),
    });
    await screen.findByText("Knowledge-Evidenz");
    openEvidenceDisclosure(container);
    expect(
      screen.getAllByText(
        "Umfang unvollständig: Die ausgewählten Belege sind unvollständig. Ein Teil der Quellen oder passenden Textstellen konnte nicht aufgenommen werden. Die Antwort kann Details auslassen.",
      ),
    ).toHaveLength(1);
    expect(
      screen.getByText(
        "keine Evidenz: Für diesen Teil der Antwort liegen keine passenden Belege vor.",
      ),
    ).toBeVisible();
    const summaries = screen.getAllByText("Technische Originaldetails");
    expect(summaries).toHaveLength(2);
    for (const claim of claims) expect(screen.getByText(claim)).not.toBeVisible();
    const first = summaries[0];
    if (first === undefined) throw new TypeError("Missing original-details control.");
    fireEvent.click(first);
    expect(screen.getByText(claims[0] ?? "")).toBeVisible();
  });

  it("preserves original diagnostic text as escaped English disclosure content", async () => {
    const claim = "<script>privateExample()</script>\nsource: docs/manual.html";
    const { container } = renderInLocale("en", {
      ...localKnowledgeAnswer(),
      uncertainty: [{ kind: "scope-incomplete", claim }],
    });
    await screen.findByText("Knowledge evidence");
    openEvidenceDisclosure(container);
    const original = screen.getByText(
      (_, element) => element?.tagName === "P" && element.textContent === claim,
    );
    expect(original).not.toBeVisible();
    const summary = screen.getByText("Technical original details");
    summary.focus();
    expect(summary).toHaveFocus();
    fireEvent.click(summary);
    expect(original).toBeVisible();
    expect(container.querySelector("script")).toBeNull();
    expect(original.textContent).toBe(claim);
  });

  it.each([
    ["no-evidence", "keine Evidenz"],
    ["stale-evidence", "veraltete Evidenz"],
    ["scope-incomplete", "Umfang unvollständig"],
    ["budget-clipped", "Budget gekürzt"],
    ["tool-unavailable", "Werkzeug nicht verfügbar"],
    ["low-confidence", "geringe Sicherheit"],
  ])("localizes %s without parsing or discarding its exact original", async (kind, label) => {
    const claim = "Opaque exact original: special <>& text.";
    const { container } = renderInLocale("de", {
      ...localKnowledgeAnswer(),
      uncertainty: [{ kind, claim }],
    });
    await screen.findByText("Knowledge-Evidenz");
    openEvidenceDisclosure(container);
    const line = screen.getByText((text) => text.startsWith(`${label}: `));
    expect(line).toBeVisible();
    expect(line.textContent).not.toContain(claim);
    expect(screen.getByText(claim)).not.toBeVisible();
    fireEvent.click(screen.getByText("Technische Originaldetails"));
    expect(screen.getByText(claim)).toBeVisible();
  });

  it("preserves unknown uncertainty details without inventing a localized explanation", async () => {
    const claim = "Future diagnostic with context that must remain available.";
    const { container } = renderInLocale("de", {
      ...localKnowledgeAnswer(),
      uncertainty: [{ kind: "future-uncertainty", claim }],
    });
    await screen.findByText("Knowledge-Evidenz");
    openEvidenceDisclosure(container);
    expect(screen.getByText(`future uncertainty: ${claim}`)).toBeVisible();
    expect(screen.queryByText("Technische Originaldetails")).not.toBeInTheDocument();
  });

  it("localises the uncertainty disclosure lines by kind instead of the server's English claim", async () => {
    const a = {
      ...localKnowledgeAnswer(),
      uncertainty: [{ kind: "uncited-answer", claim: "English server claim text." }],
    };
    const { container } = renderInLocale("de", a);

    await waitFor(() => {
      expect(screen.getByText("Knowledge-Evidenz")).toBeInTheDocument();
    });
    openEvidenceDisclosure(container);
    expect(screen.getByText("Unsicherheit (1) — Antwort ohne Quellenangabe")).toBeInTheDocument();
    expect(
      screen.getByText("Antwort ohne Quellenangabe: Siehe den Zitierhinweis oben."),
    ).toBeInTheDocument();
    expect(container.textContent).not.toContain("English server claim text.");
  });
});

describe("attributed citation activation evidence", () => {
  it.each(["x", "A1".repeat(32)])(
    "requires explicit choice for malformed identity %s even if a root repeats it",
    (fingerprint) => {
      const openReference = vi.fn(() => ({ ok: true as const, windowId: "source" }));
      render(
        <GroundedAnswer
          answer={answer({ citations: [citation({ sourceScopeFingerprint: fingerprint })] })}
          busy={false}
          repositoryRoots={[{ root: "/repo", label: "Repo", scopeFingerprints: [fingerprint] }]}
          openRepositoryReference={openReference}
        />,
      );
      openEvidenceDisclosure(document.body);
      fireEvent.click(screen.getByRole("button", { name: /Open src\/foo.ts/ }));
      expect(openReference).not.toHaveBeenCalled();
      fireEvent.click(
        screen.getByRole("button", { name: "Select repository source: Repo · repo" }),
      );
      expect(openReference).toHaveBeenCalledExactlyOnceWith({
        root: "/repo",
        path: "src/foo.ts",
        lineStart: 10,
        lineEnd: 25,
      });
    },
  );

  it.each(["/repo", "/repo/manuals"])(
    "opens the attributed ancestor or descendant %s without preferring path depth",
    (selectedRoot) => {
      const scopes = ["/repo", "/repo/manuals"].map((root) => ({
        kind: "workspace-root" as const,
        root,
        relativePaths: [],
        connectedAtMs: 1,
      }));
      const roots = repositoryReferenceRootsForScopes(scopes, "");
      const selected = roots.find((root) => root.root === selectedRoot);
      expect(selected?.scopeFingerprints).toHaveLength(1);
      const openReference = vi.fn(() => ({ ok: true as const, windowId: "source" }));
      render(
        <GroundedAnswer
          answer={answer({
            citations: [citation({ sourceScopeFingerprint: selected?.scopeFingerprints?.[0] })],
          })}
          busy={false}
          repositoryRoots={roots}
          openRepositoryReference={openReference}
        />,
      );
      openEvidenceDisclosure(document.body);
      fireEvent.click(screen.getByRole("button", { name: /Open src\/foo.ts/ }));
      expect(openReference).toHaveBeenCalledExactlyOnceWith({
        root: selectedRoot,
        path: "src/foo.ts",
        lineStart: 10,
        lineEnd: 25,
      });
      expect(screen.queryByRole("button", { name: /Select repository source:/ })).toBeNull();
    },
  );

  it("requires manual choice for normalized-equal root aliases produced from connected scopes", () => {
    const scopes = ["/repo", "/repo/", "\\repo"].map((root) => ({
      kind: "workspace-root" as const,
      root,
      relativePaths: [],
      connectedAtMs: 1,
    }));
    const roots = repositoryReferenceRootsForScopes(scopes, "");
    expect(roots).toHaveLength(3);
    expect(new Set(roots.flatMap((root) => root.scopeFingerprints ?? [])).size).toBe(1);
    const openReference = vi.fn(() => ({ ok: true as const, windowId: "source" }));
    render(
      <GroundedAnswer
        answer={answer({
          citations: [citation({ sourceScopeFingerprint: roots[0]?.scopeFingerprints?.[0] })],
        })}
        busy={false}
        repositoryRoots={roots}
        openRepositoryReference={openReference}
      />,
    );
    openEvidenceDisclosure(document.body);
    fireEvent.click(screen.getByRole("button", { name: /Open src\/foo.ts/ }));
    expect(openReference).not.toHaveBeenCalled();
    const options = screen.getAllByRole("button", { name: /Select repository source:/ });
    expect(options).toHaveLength(3);
    fireEvent.click(
      screen.getByRole("button", { name: "Select repository source: repo · /repo/" }),
    );
    expect(openReference).toHaveBeenCalledExactlyOnceWith({
      root: "/repo/",
      path: "src/foo.ts",
      lineStart: 10,
      lineEnd: 25,
    });
  });

  it.each(["absent", "malformed", "matched", "unmatched", "ambiguous"] as const)(
    "records %s identity separately from the actual picker/open outcome",
    (reason) => {
      const writer = vi.fn<ClientDiagnosticWriter>();
      setClientDiagnosticWriter(writer);
      const fingerprint = "a1".repeat(32);
      const roots = [
        { root: "/private/first", label: "First", scopeFingerprints: [fingerprint] },
        {
          root: "/private/second",
          label: "Second",
          scopeFingerprints: reason === "ambiguous" ? [fingerprint] : [],
        },
      ];
      const identities = {
        absent: undefined,
        malformed: "private-invalid",
        matched: fingerprint,
        unmatched: "b2".repeat(32),
        ambiguous: fingerprint,
      };
      const openReference = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
      render(
        <GroundedAnswer
          answer={answer({ citations: [citation({ sourceScopeFingerprint: identities[reason] })] })}
          busy={false}
          repositoryRoots={roots}
          openRepositoryReference={openReference}
        />,
      );
      openEvidenceDisclosure(document.body);
      expect(writer).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: /Open src\/foo.ts/ }));
      const outcome = reason === "matched" ? "opened" : "picker-opened";
      const matchCount = { matched: 1, ambiguous: 2, absent: 0, malformed: 0, unmatched: 0 }[
        reason
      ];
      expect(writer).toHaveBeenLastCalledWith("[keiko] citation activation settled", {
        correlationId: expect.any(String),
        citationActivation: { reason, outcome, rootCount: 2, matchCount },
      });
      if (reason !== "matched")
        fireEvent.click(
          screen.getByRole("button", { name: "Select repository source: Second · private/second" }),
        );
      expect(writer).toHaveBeenLastCalledWith("[keiko] citation activation settled", {
        correlationId: expect.any(String),
        citationActivation: { reason, outcome: "opened", rootCount: 2, matchCount },
      });
      const correlations = writer.mock.calls.map((call) => call[1]?.correlationId);
      expect(new Set(correlations).size).toBe(1);
      expect(JSON.stringify(writer.mock.calls)).not.toContain("/private/");
      expect(JSON.stringify(writer.mock.calls)).not.toContain(fingerprint);
    },
  );

  it("records a refused editor open without labeling attribution as a failure", () => {
    const writer = vi.fn<ClientDiagnosticWriter>();
    setClientDiagnosticWriter(writer);
    render(
      <GroundedAnswer
        answer={answer({ citations: [citation()] })}
        busy={false}
        repositoryRoots={[{ root: "/private/first", label: "First" }]}
        openRepositoryReference={() => ({ ok: false, message: "Editor unavailable" })}
      />,
    );
    openEvidenceDisclosure(document.body);
    fireEvent.click(screen.getByRole("button", { name: /Open src\/foo.ts/ }));
    expect(writer).toHaveBeenCalledWith("[keiko] citation activation settled", {
      correlationId: expect.any(String),
      citationActivation: {
        reason: "absent",
        outcome: "open-refused",
        rootCount: 1,
        matchCount: 0,
      },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Editor unavailable");
  });
});

it("joins citation picker dismissal and selection to their actual activation", () => {
  const writer = vi.fn<ClientDiagnosticWriter>();
  setClientDiagnosticWriter(writer);
  const openReference = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
  render(
    <GroundedAnswer
      answer={answer({ citations: [citation()] })}
      busy={false}
      repositoryRoots={[
        { root: "/first", label: "First" },
        { root: "/second", label: "Second" },
      ]}
      openRepositoryReference={openReference}
    />,
  );
  openEvidenceDisclosure(document.body);
  const trigger = screen.getByRole("button", { name: /Open src\/foo.ts/ });
  fireEvent.click(trigger);
  const first = writer.mock.calls[0]?.[1]?.correlationId;
  fireEvent.keyDown(
    screen.getByRole("button", { name: "Select repository source: First · first" }),
    {
      key: "Escape",
    },
  );
  expect(writer.mock.calls[1]?.[1]).toMatchObject({
    correlationId: first,
    citationActivation: {
      reason: "absent",
      outcome: "picker-dismissed",
      rootCount: 2,
      matchCount: 0,
    },
  });
  expect(openReference).not.toHaveBeenCalled();
  fireEvent.click(trigger);
  const second = writer.mock.calls[2]?.[1]?.correlationId;
  expect(second).not.toBe(first);
  fireEvent.click(
    screen.getByRole("button", { name: "Select repository source: Second · second" }),
  );
  expect(writer.mock.calls[3]?.[1]).toMatchObject({
    correlationId: second,
    citationActivation: { outcome: "opened" },
  });
});

it("preserves the open citation picker, focus and activation across a parent rerender", () => {
  const writer = vi.fn<ClientDiagnosticWriter>();
  setClientDiagnosticWriter(writer);
  const openReference = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
  const props = {
    answer: answer({ citations: [citation()] }),
    busy: false,
    repositoryRoots: [
      { root: "/first", label: "first" },
      { root: "/second", label: "second" },
    ],
    openRepositoryReference: openReference,
  };
  const { rerender } = render(<GroundedAnswer {...props} />);
  openEvidenceDisclosure(document.body);
  const trigger = screen.getByRole("button", { name: /Open src\/foo.ts/ });
  fireEvent.click(trigger);
  const selected = screen.getByRole("button", { name: "Select repository source: second" });
  selected.focus();
  const correlationId = writer.mock.calls[0]?.[1]?.correlationId;
  expect(correlationId).toEqual(expect.any(String));
  expect(writer).toHaveBeenCalledOnce();
  rerender(<GroundedAnswer {...props} answer={{ ...props.answer, content: "More answer text" }} />);
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: "Select repository source: second" })).toBe(selected);
  expect(selected).toHaveFocus();
  expect(writer).toHaveBeenCalledOnce();
  fireEvent.click(selected);
  expect(openReference).toHaveBeenCalledExactlyOnceWith({
    root: "/second",
    path: "src/foo.ts",
    lineStart: 10,
    lineEnd: 25,
  });
  expect(trigger).toHaveFocus();
  expect(writer.mock.calls.map((call) => call[1]?.correlationId)).toEqual([
    correlationId,
    correlationId,
  ]);
  expect(writer.mock.calls.map((call) => call[1]?.citationActivation?.outcome)).toEqual([
    "picker-opened",
    "opened",
  ]);
});
