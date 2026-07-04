// Issue #187 — a11y smoke test for the GroundedAnswer component, including the new
// ContextPackSummary region. jest-axe runs the WCAG 2.2 AA rule set; this surface MUST emit
// zero violations because it is one of the two primary UI affordances on a grounded answer.

import { render } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { GroundedAnswer } from "./GroundedAnswer";
import type { CitationPreviewController } from "./hooks/usePdfCitationPreview";
import type {
  GroundedAnswer as GroundedAnswerType,
  GroundedAnswerContextPackSummary,
  LocalKnowledgeEvidenceCitation,
} from "@/lib/types";

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

function contextPack(): GroundedAnswerContextPackSummary {
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
    citationCount: 2,
    omittedCount: 1,
    omittedCounts: { ...OMITTED_COUNTS_ZERO, binary: 1 },
    uncertaintyCount: 1,
    elapsedMs: 1_812,
  };
}

function answer(): GroundedAnswerType {
  return {
    groundingKind: "connected-context",
    userMessageId: "msg-u",
    assistantMessageId: "msg-a",
    content: "Inspected 2 file(s) for: how does MyClass work?",
    citations: [
      {
        scopePath: "src/foo.ts",
        lineRange: { startLine: 1, endLine: 4 },
        score: 0.9,
        stableId: "atom-a",
      },
      {
        scopePath: "docs/report.docx",
        lineRange: { startLine: 1, endLine: 3 },
        score: 0.4,
        stableId: "atom-b",
        documentFormat: "docx",
      },
    ],
    uncertainty: [{ kind: "no-evidence", claim: "excerpt unavailable" }],
    omittedCount: 1,
    elapsedMs: 1_812,
    contextPack: contextPack(),
  };
}

// GEN-UI-TEST-GAP-005 (test-plan #5) — local-knowledge and hybrid answers, plus the interactive
// KnowledgeCitationChip recovery/blocked affordances, are distinct render paths from the
// connected-context answer above and were previously unguarded by axe.
function knowledgeCitation(
  overrides: Partial<LocalKnowledgeEvidenceCitation> = {},
): LocalKnowledgeEvidenceCitation {
  return {
    stableId: "lk-1",
    marker: "[1]",
    label: "manual.pdf · p.12",
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

function localKnowledgeAnswer(
  citations: readonly LocalKnowledgeEvidenceCitation[] = [knowledgeCitation()],
): GroundedAnswerType {
  return {
    groundingKind: "local-knowledge",
    userMessageId: "lk-u",
    assistantMessageId: "lk-a",
    content: "Answer grounded in the connected capsule [1].",
    citations,
    uncertainty: [{ kind: "no-evidence", claim: "excerpt unavailable" }],
    omittedCount: 1,
    elapsedMs: 12,
    noEvidence: false,
    contextPack: {
      kind: "local-knowledge",
      scopeKind: "capsule",
      scopeId: "lk-scope-1",
      scopeLabel: "Product Manual",
      capsuleCount: 1,
      sourceCount: 1,
      citationCount: citations.length,
      referenceBudget: 10,
      referencesUsed: citations.length,
    },
  };
}

function hybridAnswer(
  knowledgeCitations: readonly LocalKnowledgeEvidenceCitation[] = [knowledgeCitation()],
): GroundedAnswerType {
  return {
    groundingKind: "hybrid",
    userMessageId: "hy-u",
    assistantMessageId: "hy-a",
    content: "Merged folder and connector evidence.",
    citations: [
      {
        scopePath: "src/foo.ts",
        lineRange: { startLine: 1, endLine: 4 },
        score: 0.9,
        stableId: "atom-a",
      },
      {
        scopePath: "docs/report.docx",
        lineRange: { startLine: 1, endLine: 3 },
        score: 0.4,
        stableId: "atom-b",
        documentFormat: "docx",
      },
    ],
    knowledgeCitations,
    uncertainty: [],
    omittedCount: 0,
    elapsedMs: 33,
    contextPack: {
      kind: "hybrid",
      folderSourceCount: 2,
      connectorSourceCount: 1,
      folder: contextPack(),
      knowledge: {
        kind: "local-knowledge",
        scopeKind: "capsule",
        scopeId: "lk-scope-9",
        scopeLabel: "Quasar Manual",
        capsuleCount: 1,
        sourceCount: 1,
        citationCount: knowledgeCitations.length,
        referenceBudget: 10,
        referencesUsed: knowledgeCitations.length,
      },
    },
  };
}

// A CitationPreviewController stub that reports a fixed affordance state for the given citation, so
// the KnowledgeCitationChip renders as an interactive Recover / unavailable button (mirrors the
// controller stub in GroundedAnswer.test.tsx).
function citationPreviewController(
  state: "available" | "recoverable" | "blocked",
  citationValue: LocalKnowledgeEvidenceCitation,
): CitationPreviewController {
  return {
    forCitation: vi.fn((candidate) =>
      candidate.stableId === citationValue.stableId ? { citation: candidate, state } : undefined,
    ),
    forMarker: vi.fn(() => undefined),
    isOpening: vi.fn(() => false),
    openCitation: vi
      .fn<CitationPreviewController["openCitation"]>()
      .mockResolvedValue("pdf-window-1"),
  };
}

describe("GroundedAnswer a11y", () => {
  it("jest-axe: a fully populated grounded answer has no violations", async () => {
    const { container } = render(<GroundedAnswer answer={answer()} busy={false} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("jest-axe: a local-knowledge answer has no violations", async () => {
    const { container } = render(<GroundedAnswer answer={localKnowledgeAnswer()} busy={false} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("jest-axe: a hybrid answer has no violations", async () => {
    const { container } = render(<GroundedAnswer answer={hybridAnswer()} busy={false} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("jest-axe: a KnowledgeCitationChip in the recoverable state has no violations", async () => {
    const citation = knowledgeCitation();
    const { container } = render(
      <GroundedAnswer
        answer={localKnowledgeAnswer([citation])}
        busy={false}
        citationPreview={citationPreviewController("recoverable", citation)}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("jest-axe: a KnowledgeCitationChip in the blocked state has no violations", async () => {
    const citation = knowledgeCitation();
    const { container } = render(
      <GroundedAnswer
        answer={localKnowledgeAnswer([citation])}
        busy={false}
        citationPreview={citationPreviewController("blocked", citation)}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  // Issue #1296 — citation chips now consume the --ai-source-* component tokens (which
  // adapt per theme). The migration touches no JSX/ARIA, so axe re-verifies the structural
  // contract on the Light acceptance surface (jsdom axe does not compute colour contrast —
  // that is delegated to the browser evidence harness).
  it("jest-axe: stays violation-free under Light theme after the #1296 token migration", async () => {
    document.documentElement.setAttribute("data-theme", "light");
    try {
      const { container } = render(<GroundedAnswer answer={answer()} busy={false} />);
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    } finally {
      document.documentElement.removeAttribute("data-theme");
    }
  });
});
