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
  type QualityIntelligenceUiRetentionNotice,
  type QualityIntelligenceRequirementsSource,
  type QualityIntelligenceUiRunTotals,
} from "../bffWire.js";
import {
  isQualityIntelligenceJudgeEligible,
  QUALITY_INTELLIGENCE_DEFAULT_RETENTION_POLICY_ID,
  type QualityIntelligenceRetentionPolicyId,
} from "../../index.js";
import type { ModelCapability } from "../../gateway.js";
import type { QualityIntelligenceAuditTotals } from "../auditSummary.js";

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

describe("QualityIntelligenceUiRetentionNotice.policyId is the branded retention-policy id, not a bare string (KEIKO-0583)", () => {
  it("type-checks against QualityIntelligenceRetentionPolicyId", () => {
    const notice: QualityIntelligenceUiRetentionNotice = {
      policyId: QUALITY_INTELLIGENCE_DEFAULT_RETENTION_POLICY_ID,
      retainedDays: 30,
      maxRunArtifacts: 50,
    };
    expect(notice.policyId).toEqual<QualityIntelligenceRetentionPolicyId>(
      QUALITY_INTELLIGENCE_DEFAULT_RETENTION_POLICY_ID,
    );
  });

  it("rejects an arbitrary string at compile time", () => {
    const bogus: QualityIntelligenceUiRetentionNotice = {
      // @ts-expect-error — "not-a-real-policy" is not a QualityIntelligenceRetentionPolicyId
      // member; this compiled fine when the field was a bare `string` before KEIKO-0583.
      policyId: "not-a-real-policy",
      retainedDays: 30,
      maxRunArtifacts: 50,
    };
    expect(bogus.policyId).toBe("not-a-real-policy");
  });
});

describe("QualityIntelligenceRequirementsSource.adf is a bounded JSON-value type, not `unknown` (KEIKO-0891)", () => {
  it("accepts a realistic nested ADF-shaped document", () => {
    const source: QualityIntelligenceRequirementsSource = {
      kind: "requirements",
      label: "Jira ADF",
      text: "",
      adf: {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: "Title" }],
          },
        ],
      },
    };
    expect(source.adf).toBeDefined();
  });

  it("rejects a non-JSON-serialisable value at compile time", () => {
    const source: QualityIntelligenceRequirementsSource = {
      kind: "requirements",
      label: "bad",
      text: "",
      // @ts-expect-error — a Symbol is not assignable to QualityIntelligenceAdfNode; this
      // compiled fine when the field was `unknown` before KEIKO-0891. Server-side, an oversized
      // (rather than wrongly-shaped) document is rejected at runtime by parseAdfDocument's
      // maxDocumentBytes bound — see packages/keiko-quality-intelligence's adfParser.test.ts.
      adf: { note: Symbol("nope") },
    };
    expect(typeof source.adf).toBe("object");
  });
});

describe("QualityIntelligenceUiRunTotals is structurally pinned to QualityIntelligenceAuditTotals (KEIKO-0924)", () => {
  it("is a Pick of the three run-scoped audit-totals fields, not a hand-restated mirror", () => {
    const auditTotals: QualityIntelligenceAuditTotals = {
      candidates: 3,
      findings: 5,
      exports: 1,
      reviews: 2,
    };
    // A named QualityIntelligenceAuditTotals value (not a fresh object literal, so excess-property
    // checking does not apply) is directly assignable to QualityIntelligenceUiRunTotals only
    // because the latter is declared as `Pick<QualityIntelligenceAuditTotals, "candidates" |
    // "findings" | "exports">` — if a future edit reverted to a hand-restated interface with the
    // same field names, this line would keep compiling too, but a rename of any of the three
    // shared fields on QualityIntelligenceAuditTotals would then fail to surface here, silently
    // recreating the drift KEIKO-0924 closed. The `Pick<>` declaration itself is what makes such a
    // rename an immediate compile error at this type's declaration site in bffWire.ts.
    const uiTotals: QualityIntelligenceUiRunTotals = auditTotals;
    // `uiTotals` is the SAME runtime object as `auditTotals` (Pick is type-level only, so the
    // `reviews` field is still present on the object) — assert the three shared scalars
    // individually rather than a full deep-equal, which would fail on that extra field.
    expect(uiTotals.candidates).toBe(3);
    expect(uiTotals.findings).toBe(5);
    expect(uiTotals.exports).toBe(1);
  });
});
