// Issue #187 — a11y smoke test for the GroundedAnswer component, including the new
// ContextPackSummary region. jest-axe runs the WCAG 2.2 AA rule set; this surface MUST emit
// zero violations because it is one of the two primary UI affordances on a grounded answer.

import { render } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";
import { GroundedAnswer } from "./GroundedAnswer";
import type {
  GroundedAnswer as GroundedAnswerType,
  GroundedAnswerContextPackSummary,
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
        scopePath: "src/bar.ts",
        lineRange: undefined,
        score: 0.4,
        stableId: "atom-b",
      },
    ],
    uncertainty: [{ kind: "no-evidence", claim: "excerpt unavailable" }],
    omittedCount: 1,
    elapsedMs: 1_812,
    contextPack: contextPack(),
  };
}

describe("GroundedAnswer a11y", () => {
  it("jest-axe: a fully populated grounded answer has no violations", async () => {
    const { container } = render(<GroundedAnswer answer={answer()} busy={false} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
