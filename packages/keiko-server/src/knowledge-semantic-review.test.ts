import { describe, expect, it } from "vitest";
import {
  compileExternalCatalogSchema,
  describeCatalogSchemaMismatch,
} from "@oscharko-dev/keiko-tool-catalog";
import type { CatalogJsonValue } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import {
  KNOWLEDGE_REVIEW_VALIDATION_REASONS,
  type KnowledgeReviewValidationReason,
} from "./knowledge-document-activity.js";
import {
  SEMANTIC_REVIEW_FORMAT,
  semanticReviewFormat,
  semanticReviewInstruction,
  parseSemanticReview,
  parseSemanticReviewDetailed,
} from "./knowledge-semantic-review.js";

const FINDING = { kind: "obligation", anchors: [0], proposal: "PRIVATE_PROPOSAL", question: "" };
function response(payload: unknown = { complete: true, findings: [FINDING] }): NormalizedResponse {
  return {
    modelId: "synthetic-model",
    content: JSON.stringify(payload),
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "synthetic-review",
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 1,
      costClass: "low",
    },
  };
}
const findingResponse = (change: Record<string, unknown>): NormalizedResponse =>
  response({ complete: true, findings: [{ ...FINDING, ...change }] });
const CASES: readonly (readonly [
  KnowledgeReviewValidationReason,
  NormalizedResponse,
  Record<string, unknown>,
])[] = [
  ["finish-reason", { ...response(), finishReason: "length" }, { reviewFinishReason: "length" }],
  [
    "tool-calls",
    { ...response(), toolCalls: [{ id: "synthetic", name: "private-tool", arguments: {} }] },
    { reviewToolCallCount: 1 },
  ],
  ["output-bound", { ...response(), content: "x".repeat(20_001) }, { reviewOutputChars: 20_001 }],
  ["json-syntax", { ...response(), content: "PRIVATE_MALFORMED_RESPONSE" }, {}],
  [
    "review-shape",
    response({ complete: true, findings: [], PRIVATE_EXTRA_FIELD: true }),
    { reviewValueType: "object" },
  ],
  [
    "complete-type",
    response({ complete: "PRIVATE_COMPLETE", findings: [] }),
    { reviewValueType: "string", reviewTextChars: 16 },
  ],
  ["findings-type", response({ complete: true, findings: null }), { reviewValueType: "null" }],
  [
    "findings-bound",
    response({ complete: true, findings: Array.from({ length: 9 }, () => FINDING) }),
    { reviewFindingCount: 9 },
  ],
  [
    "finding-shape",
    response({ complete: true, findings: [null] }),
    { reviewFindingIndex: 0, reviewValueType: "null" },
  ],
  [
    "finding-kind",
    findingResponse({ kind: "PRIVATE_KIND" }),
    { reviewFindingIndex: 0, reviewValueType: "string" },
  ],
  [
    "anchor-shape",
    findingResponse({ anchors: [] }),
    { reviewFindingIndex: 0, reviewActualCount: 0 },
  ],
  [
    "anchor-range",
    findingResponse({ anchors: [0, 999] }),
    { reviewFindingIndex: 0, reviewAnchorIndex: 1, reviewValueType: "number" },
  ],
  [
    "proposal-bound",
    findingResponse({ proposal: "   " }),
    { reviewTextChars: 3, reviewTextTrimmedChars: 0 },
  ],
  ["question-bound", findingResponse({ question: "x".repeat(161) }), { reviewTextChars: 161 }],
  [
    "conflict-anchors",
    findingResponse({ kind: "conflict", anchors: [0, 0] }),
    { reviewActualCount: 1 },
  ],
  [
    "clarification-question",
    findingResponse({ kind: "clarification", question: "  " }),
    { reviewTextTrimmedChars: 0 },
  ],
];

describe("semantic review refusal diagnostics", () => {
  it("pins a meaningful case for every closed validation reason", () => {
    expect(CASES.map(([reason]) => reason)).toEqual([...KNOWLEDGE_REVIEW_VALIDATION_REASONS]);
  });

  it.each(CASES)(
    "reports %s without exposing values or producing a usable review",
    (reason, answer, facts) => {
      const result = parseSemanticReviewDetailed(answer, 2);
      expect(result).toMatchObject({
        ok: false,
        validationReason: reason,
        observation: {
          reviewFailureStage: "model-output-invalid",
          reviewValidationReason: reason,
          reviewAnchorCount: 2,
          reviewOutputChars: answer.content.length,
          ...facts,
        },
      });
      expect(result).not.toHaveProperty("review");
      expect(JSON.stringify(result.observation)).not.toMatch(
        /PRIVATE|private-tool|synthetic-model/,
      );
      for (const value of Object.values(result.observation))
        if (typeof value === "number") {
          expect(Number.isInteger(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(0xffff_ffff);
        }
    },
  );

  it.each([
    ["proposal", 300],
    ["question", 160],
  ] as const)("keeps the exact %s type and character bound", (field, limit) => {
    for (const value of [null, false, limit, "x".repeat(limit + 1)])
      expect(parseSemanticReviewDetailed(findingResponse({ [field]: value }), 1)).toMatchObject({
        ok: false,
        validationReason: `${field}-bound`,
      });
    expect(parseSemanticReviewDetailed(findingResponse({ [field]: "x".repeat(limit) }), 1).ok).toBe(
      true,
    );
  });

  it("preserves admitted complete, partial, empty and structured results without a second parse", () => {
    for (const complete of [true, false]) {
      const value = { complete, findings: [FINDING] };
      expect(parseSemanticReviewDetailed(response(value), 1)).toMatchObject({
        ok: true,
        review: value,
      });
      expect(parseSemanticReview(response(value), 1)).toEqual(value);
    }
    expect(
      parseSemanticReviewDetailed(response({ complete: true, findings: [] }), 1),
    ).toMatchObject({ ok: true, review: { complete: true, findings: [] } });
    const value = { complete: true, findings: [FINDING] };
    const structured = { ...response(), content: "PRIVATE_NOT_JSON", structuredOutput: value };
    expect(parseSemanticReviewDetailed(structured, 1)).toMatchObject({ ok: true, review: value });
  });

  it("retains legacy SyntaxError behavior and refuses truncated output before JSON parsing", () => {
    const malformed = { ...response(), content: "PRIVATE_NOT_JSON" };
    const parsed = parseSemanticReviewDetailed(malformed, 1);
    expect(parsed).toMatchObject({
      ok: false,
      validationReason: "json-syntax",
    });
    expect("syntaxError" in parsed ? parsed.syntaxError : undefined).toBeInstanceOf(SyntaxError);
    expect(() => parseSemanticReview(malformed, 1)).toThrow(SyntaxError);
    expect(parseSemanticReview({ ...malformed, finishReason: "length" }, 1)).toBeUndefined();
  });
});

function schemaAccepts(schema: Record<string, unknown>, payload: CatalogJsonValue): boolean {
  return describeCatalogSchemaMismatch(compileExternalCatalogSchema(schema), payload) === undefined;
}

describe("source-bound semantic review response format", () => {
  it("excludes the observed impossible conflict in a one-anchor window", () => {
    const payload = { complete: true, findings: [{ ...FINDING, kind: "conflict" }] };
    // The generic fallback documents why the previously static outbound schema admitted it.
    expect(schemaAccepts(SEMANTIC_REVIEW_FORMAT.schema, payload)).toBe(true);
    expect(schemaAccepts(semanticReviewFormat(1).schema, payload)).toBe(false);
    expect(parseSemanticReviewDetailed(response(payload), 1)).toMatchObject({
      ok: false,
      validationReason: "conflict-anchors",
    });
  });
  it.each([1, 2, 8])("advertises only the actual %i source anchor indices", (count) => {
    const schema = semanticReviewFormat(count).schema;
    for (const id of [0, count - 1])
      expect(
        schemaAccepts(schema, { complete: true, findings: [{ ...FINDING, anchors: [id] }] }),
      ).toBe(true);
    for (const id of [-1, count, 999, 0.5])
      expect(
        schemaAccepts(schema, { complete: true, findings: [{ ...FINDING, anchors: [id] }] }),
      ).toBe(false);
  });
  it("bounds anchor cardinality without narrowing ordinary or two-source conflict findings", () => {
    expect(
      schemaAccepts(semanticReviewFormat(1).schema, {
        complete: true,
        findings: [{ ...FINDING, anchors: [0, 0] }],
      }),
    ).toBe(false);
    for (const finding of [FINDING, { ...FINDING, kind: "conflict", anchors: [0, 1] }]) {
      const payload = { complete: true, findings: [finding] };
      expect(schemaAccepts(semanticReviewFormat(2).schema, payload)).toBe(true);
      expect(parseSemanticReviewDetailed(response(payload), 2)).toMatchObject({
        ok: true,
        review: payload,
      });
    }
    // Per-kind distinctness remains the existing strict parser's authority; no unsupported
    // provider schema dialect is introduced merely to express this dependent constraint.
    expect(
      parseSemanticReviewDetailed(findingResponse({ kind: "conflict", anchors: [0, 0] }), 2),
    ).toMatchObject({ ok: false, validationReason: "conflict-anchors" });
  });
  it("renders the identical source-bound schema into its instruction", () => {
    for (const count of [1, 2, 8]) {
      const format = semanticReviewFormat(count);
      expect(semanticReviewInstruction(format)).toContain(JSON.stringify(format.schema));
    }
  });
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 6001])(
    "rejects impossible source anchor counts %s",
    (count) => {
      expect(() => semanticReviewFormat(count)).toThrow(RangeError);
    },
  );
});
