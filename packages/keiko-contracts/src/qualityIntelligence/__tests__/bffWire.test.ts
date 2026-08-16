import { describe, expect, it } from "vitest";
import {
  QUALITY_INTELLIGENCE_RUN_STATUSES,
  QUALITY_INTELLIGENCE_ERROR_CODES,
  deriveQualityIntelligenceTerminalDegradation,
  type QualityIntelligenceRunStatus,
  type QualityIntelligenceErrorCode,
  type QualityIntelligenceRunStreamEvent,
  type QualityIntelligenceSkippedSource,
  type QualityIntelligenceSourceSummary,
  type QualityIntelligenceRunStreamError,
} from "../bffWire.js";
import { isQualityIntelligenceJudgeEligible } from "../../index.js";
import type { ModelCapability } from "../../gateway.js";

function chatCapability(overrides: Partial<ModelCapability> = {}): ModelCapability {
  return {
    id: "judge-candidate",
    kind: "chat",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: true,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "test",
    preferredUseCases: ["Quality Intelligence"],
    knownLimitations: [],
    ...overrides,
  };
}

describe("Quality Intelligence run-status union (GEN-DUP-SEMANTIC-010)", () => {
  it("pins the canonical run-status set", () => {
    expect(QUALITY_INTELLIGENCE_RUN_STATUSES).toEqual<readonly QualityIntelligenceRunStatus[]>([
      "running",
      "succeeded",
      "failed",
      "cancelled",
    ]);
  });
});

describe("Quality Intelligence degraded terminal projection (#3186)", () => {
  const judgeFailure = [{ stage: "judge" as const, reasonSummary: "qi-judge-unavailable" }];

  it("derives degradation from persisted model-stage failure evidence", () => {
    expect(deriveQualityIntelligenceTerminalDegradation("succeeded", judgeFailure)).toEqual({
      degraded: true,
      reasonSummary: "qi-judge-unavailable",
    });
  });

  it("keeps a clean inexpensive chat-only success unqualified", () => {
    expect(deriveQualityIntelligenceTerminalDegradation("succeeded", undefined)).toBeUndefined();
    expect(deriveQualityIntelligenceTerminalDegradation("succeeded", [])).toBeUndefined();
  });

  it("does not relabel a failed run as degraded", () => {
    expect(deriveQualityIntelligenceTerminalDegradation("failed", judgeFailure)).toBeUndefined();
  });
});

describe("Quality Intelligence judge eligibility (#2804)", (): void => {
  it("requires a chat model with structured output enforced by response_format", (): void => {
    expect(
      isQualityIntelligenceJudgeEligible(chatCapability({ supportsResponseFormat: true })),
    ).toBe(true);
    expect(
      isQualityIntelligenceJudgeEligible(chatCapability({ supportsResponseFormat: false })),
    ).toBe(false);
    expect(isQualityIntelligenceJudgeEligible(chatCapability())).toBe(false);
    expect(
      isQualityIntelligenceJudgeEligible(
        chatCapability({ structuredOutput: false, supportsResponseFormat: true }),
      ),
    ).toBe(false);
    expect(
      isQualityIntelligenceJudgeEligible(
        chatCapability({ kind: "embedding", supportsResponseFormat: true }),
      ),
    ).toBe(false);
  });
});

// KEIKO-0274: the BFF wire re-declared in-package protocol unions (run-event kind, inline-source
// kind) as bare `string`, so a UI consumer could never get a compile error from an unhandled or
// misspelled value. These are type-level regression tests: a bogus literal must fail to type-check
// once the field is narrowed. Each `@ts-expect-error` below fails today (the field is `string`, so
// the assignment compiles and the directive itself is reported "unused") and starts passing once
// the field is retyped to the matching in-package union.
describe("QualityIntelligenceRunStreamEvent.kind is a narrow union, not a bare string", () => {
  it("rejects an event kind that is not one of the twelve declared run-event kinds", () => {
    const bogus: QualityIntelligenceRunStreamEvent = {
      type: "event",
      // @ts-expect-error — "bogus:not-a-real-kind" is not a QualityIntelligenceRunEventKind member
      kind: "bogus:not-a-real-kind",
      sequence: 0,
    };
    // Still a plain object at runtime — the guard is compile-time only, so this remains reachable.
    expect(bogus.kind).toBe("bogus:not-a-real-kind");
  });

  it("accepts every real run-event kind", () => {
    const event: QualityIntelligenceRunStreamEvent = {
      type: "event",
      kind: "candidate:proposed",
      sequence: 1,
    };
    expect(event.kind).toBe("candidate:proposed");
  });
});

describe("QualityIntelligenceSkippedSource.kind / QualityIntelligenceSourceSummary.kind are the shared inline-source-kind union", () => {
  it("rejects a skipped-source kind outside the seven declared inline source kinds", () => {
    const bogus: QualityIntelligenceSkippedSource = {
      label: "example",
      // @ts-expect-error — "not-a-real-source-kind" is not a QualityIntelligenceInlineSourceKind member
      kind: "not-a-real-source-kind",
      code: "QI_SOURCE_EMPTY",
    };
    expect(bogus.kind).toBe("not-a-real-source-kind");
  });

  it("accepts every real inline source kind for both skipped-source and source-summary rows", () => {
    const skipped: QualityIntelligenceSkippedSource = {
      label: "example",
      kind: "capsule",
      code: "QI_CAPSULE_UNAVAILABLE",
    };
    const summary: QualityIntelligenceSourceSummary = {
      label: "example",
      kind: "workspace",
      atomCount: 3,
    };
    expect(skipped.kind).toBe("capsule");
    expect(summary.kind).toBe("workspace");
  });
});

describe("QualityIntelligenceErrorCode (KEIKO-0274)", () => {
  it("pins the derived error-code set, including the two acceptance-criterion codes", () => {
    expect(QUALITY_INTELLIGENCE_ERROR_CODES).toContain("QI_CAPSULE_UNAVAILABLE");
    expect(QUALITY_INTELLIGENCE_ERROR_CODES).toContain("QI_FIGMA_SNAPSHOT_UNAVAILABLE");
  });

  it("has no duplicate members", () => {
    expect(new Set(QUALITY_INTELLIGENCE_ERROR_CODES).size).toBe(
      QUALITY_INTELLIGENCE_ERROR_CODES.length,
    );
  });

  it("accepts every declared error code on both coded wire fields", () => {
    for (const code of QUALITY_INTELLIGENCE_ERROR_CODES) {
      const skipped: QualityIntelligenceSkippedSource = { label: "l", kind: "file", code };
      const error: QualityIntelligenceRunStreamError = { type: "error", code, message: "m" };
      expect(skipped.code).toBe(code);
      expect(error.code).toBe(code);
    }
  });

  it("stays a closed union on its own — only the wire `code` fields widen it", () => {
    // @ts-expect-error — the bare type has no (string & {}) escape; only the `code` fields below do
    const notWidened: QualityIntelligenceErrorCode = "QI_SOME_FUTURE_CODE_NOT_YET_LISTED";
    // Confirms the negative-test literal genuinely is outside today's declared set, rather than
    // re-asserting the assignment that was just made (that assignment is checked at compile time
    // by the `@ts-expect-error` above, not by a runtime comparison against itself).
    expect(QUALITY_INTELLIGENCE_ERROR_CODES).not.toContain(notWidened);
  });

  it("still widens to (string & {}) so an un-migrated server release stays wire-compatible", () => {
    // Deliberately NOT `@ts-expect-error`: keiko-server may add a new coded rejection without a
    // lockstep contracts release (see the KEIKO-0274 remediation record), so an unlisted code must
    // remain assignable on the wire fields — closing this off is a regression, not a tightening.
    // (`QualityIntelligenceErrorCode` alone is closed; the widening lives on the `code` fields via
    // `QualityIntelligenceErrorCode | (string & {})`, which is what this constructs against.)
    const error: QualityIntelligenceRunStreamError = {
      type: "error",
      code: "QI_SOME_FUTURE_CODE_NOT_YET_LISTED",
      message: "m",
    };
    expect(error.code).toBe("QI_SOME_FUTURE_CODE_NOT_YET_LISTED");
  });
});
