import { describe, expect, it } from "vitest";
import type { ModelCapability } from "./gateway.js";
import type { ReviewSeedCase, ReviewSeedRunResult } from "./pull-request-review.js";
import {
  REVIEW_FINDING_FINGERPRINT_DOMAIN,
  evaluateReviewRoleEligibility,
  normalizeReviewDefectExcerpt,
  reviewFindingFingerprintPreimage,
  scoreReviewSeedRun,
} from "./pull-request-review-rules.js";

const NOW_MS = Date.parse("2026-10-30T12:00:00.000Z");
const BUDGET = { minContextWindowTokens: 65_536 };

function capability(overrides: Partial<ModelCapability> = {}): ModelCapability {
  return {
    id: "gemma-4-31b-it",
    kind: "chat",
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    toolCalling: true,
    toolCallingVerification: {
      status: "verified",
      checkedAt: "2026-10-30T11:00:00.000Z",
      probe: "gateway-tool-calling-v1",
      configurationFingerprint: "lab",
    },
    structuredOutput: true,
    streaming: true,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: true,
    costClass: "low",
    latencyClass: "standard",
    throughputHint: "lab",
    preferredUseCases: [],
    knownLimitations: [],
    ...overrides,
  };
}

describe("reviewFindingFingerprintPreimage", () => {
  const base = {
    file: "src/settle.ts",
    category: "correctness" as const,
    defectExcerpt: "if (verdict === undefined) {\n  return complete;\n}",
  };

  it("frames the domain, file, category and normalized excerpt", () => {
    const excerpt = "if (verdict === undefined) {\nreturn complete;\n}";
    expect(reviewFindingFingerprintPreimage(base)).toBe(
      [REVIEW_FINDING_FINGERPRINT_DOMAIN, "src/settle.ts", "correctness", excerpt]
        .map((part) => `${String(part.length)}:${part}`)
        .join(""),
    );
  });

  it("ignores indentation, line endings and blank lines of the excerpt", () => {
    const moved = {
      ...base,
      defectExcerpt:
        "\r\n    if (verdict === undefined) {\r\n\r\n      return complete;\r\n    }\n\n",
    };
    expect(reviewFindingFingerprintPreimage(moved)).toBe(reviewFindingFingerprintPreimage(base));
  });

  it("changes with the file, the category or the code itself", () => {
    const original = reviewFindingFingerprintPreimage(base);
    expect(reviewFindingFingerprintPreimage({ ...base, file: "src/settle2.ts" })).not.toBe(
      original,
    );
    expect(reviewFindingFingerprintPreimage({ ...base, category: "reliability" })).not.toBe(
      original,
    );
    expect(
      reviewFindingFingerprintPreimage({
        ...base,
        defectExcerpt: base.defectExcerpt.replace("===", "!=="),
      }),
    ).not.toBe(original);
  });

  it("cannot be forged by moving text across framed field boundaries", () => {
    const left = reviewFindingFingerprintPreimage({ ...base, file: "src/a", defectExcerpt: "bc" });
    const right = reviewFindingFingerprintPreimage({ ...base, file: "src/ab", defectExcerpt: "c" });
    expect(left).not.toBe(right);
  });

  it("normalizes composed and decomposed Unicode identically", () => {
    expect(normalizeReviewDefectExcerpt("const café = 1;")).toBe(
      normalizeReviewDefectExcerpt("const café = 1;"),
    );
    expect(normalizeReviewDefectExcerpt("")).toBe("");
  });
});

describe("evaluateReviewRoleEligibility", () => {
  const at = { nowMs: NOW_MS };

  it("admits a verified chat model whose window fits the review budget", () => {
    expect(evaluateReviewRoleEligibility(capability(), BUDGET, at)).toEqual({ status: "eligible" });
  });

  it("keeps a busy model eligible with a hint", () => {
    expect(evaluateReviewRoleEligibility(capability(), BUDGET, { ...at, busy: true })).toEqual({
      status: "eligible",
      hint: "busy",
    });
  });

  it("marks a model observed unready as temporarily unavailable", () => {
    expect(
      evaluateReviewRoleEligibility(capability({ conversationReady: false }), BUDGET, at),
    ).toEqual({ status: "temporarily-unavailable" });
  });

  it.each([
    ["not-configured", undefined],
    ["not-coding-safe", capability({ kind: "embedding" })],
    [
      "not-tool-capable",
      capability({
        toolCalling: false,
        toolCallingVerification: {
          status: "unsupported",
          checkedAt: "2026-10-30T11:00:00.000Z",
          probe: "gateway-tool-calling-v1",
          configurationFingerprint: "lab",
        },
      }),
    ],
    [
      "tool-verification-stale",
      capability({
        toolCallingVerification: {
          status: "verified",
          checkedAt: "2026-10-28T11:00:00.000Z",
          probe: "gateway-tool-calling-v1",
          configurationFingerprint: "lab",
        },
      }),
    ],
    ["window-unknown", capability({ contextWindowAssumed: true })],
    ["window-unknown", capability({ contextWindow: 0 })],
    ["window-too-small", capability({ contextWindow: 32_768 })],
    ["window-too-small", capability({ maxInputTokens: 60_000 })],
  ] as const)("returns ineligible/%s for the matching capability", (reason, model) => {
    expect(evaluateReviewRoleEligibility(model, BUDGET, at)).toEqual({
      status: "ineligible",
      reason,
    });
  });

  it("admits a window exactly at the budget and reports structural reasons before readiness", () => {
    const exact = capability({ contextWindow: BUDGET.minContextWindowTokens });
    expect(evaluateReviewRoleEligibility(exact, BUDGET, at).status).toBe("eligible");
    const small = capability({ contextWindow: 1_024, conversationReady: false });
    expect(evaluateReviewRoleEligibility(small, BUDGET, at)).toEqual({
      status: "ineligible",
      reason: "window-too-small",
    });
  });
});

describe("scoreReviewSeedRun", () => {
  const cases: readonly ReviewSeedCase[] = [
    {
      id: "off-by-one",
      seedClass: "correctness",
      required: true,
      cleanControl: false,
      expected: { file: "src/range.ts", startLine: 20, endLine: 22 },
    },
    {
      id: "path-escape",
      seedClass: "security",
      required: true,
      cleanControl: false,
      expected: { file: "src/path.ts", startLine: 5, endLine: 5 },
    },
    {
      id: "slow-loop",
      seedClass: "performance",
      required: false,
      cleanControl: false,
      expected: { file: "src/loop.ts", startLine: 9, endLine: 14 },
    },
    { id: "clean-refactor", seedClass: "maintainability", required: false, cleanControl: true },
  ];

  it("counts found, missed, stale and false-alarm cases", () => {
    const results: readonly ReviewSeedRunResult[] = [
      {
        caseId: "off-by-one",
        outcome: "settled",
        findings: [{ file: "src/range.ts", startLine: 22, endLine: 30 }],
      },
      {
        caseId: "path-escape",
        outcome: "settled",
        findings: [{ file: "src/other.ts", startLine: 5, endLine: 5 }],
      },
      {
        caseId: "slow-loop",
        outcome: "stale",
        findings: [{ file: "src/loop.ts", startLine: 9, endLine: 9 }],
      },
      {
        caseId: "clean-refactor",
        outcome: "settled",
        findings: [
          { file: "src/a.ts", startLine: 1, endLine: 1 },
          { file: "src/b.ts", startLine: 2, endLine: 2 },
        ],
      },
    ];
    expect(scoreReviewSeedRun(cases, results)).toEqual({
      defectCaseCount: 3,
      cleanControlCount: 1,
      found: 1,
      missed: 1,
      stale: 1,
      falseAlarms: 2,
      requiredCount: 2,
      requiredFound: 1,
      unmatchedResults: 0,
    });
  });

  it("treats a case without a result as missed and counts unknown or repeated results", () => {
    const results: readonly ReviewSeedRunResult[] = [
      {
        caseId: "path-escape",
        outcome: "settled",
        findings: [{ file: "src/path.ts", startLine: 1, endLine: 5 }],
      },
      { caseId: "path-escape", outcome: "settled", findings: [] },
      { caseId: "unknown", outcome: "settled", findings: [] },
    ];
    expect(scoreReviewSeedRun(cases, results)).toMatchObject({
      found: 1,
      missed: 2,
      requiredFound: 1,
      falseAlarms: 0,
      unmatchedResults: 2,
    });
  });

  it("does not count a finding just outside the expected range or a stale clean control", () => {
    const results: readonly ReviewSeedRunResult[] = [
      {
        caseId: "off-by-one",
        outcome: "settled",
        findings: [{ file: "src/range.ts", startLine: 23, endLine: 25 }],
      },
      {
        caseId: "clean-refactor",
        outcome: "stale",
        findings: [{ file: "src/a.ts", startLine: 1, endLine: 1 }],
      },
    ];
    expect(scoreReviewSeedRun(cases, results)).toMatchObject({ found: 0, falseAlarms: 0 });
  });

  it("scores an empty suite as all zeros", () => {
    expect(scoreReviewSeedRun([], [])).toEqual({
      defectCaseCount: 0,
      cleanControlCount: 0,
      found: 0,
      missed: 0,
      stale: 0,
      falseAlarms: 0,
      requiredCount: 0,
      requiredFound: 0,
      unmatchedResults: 0,
    });
  });
});
