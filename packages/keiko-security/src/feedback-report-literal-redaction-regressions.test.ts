import { describe, expect, it } from "vitest";

import {
  FEEDBACK_REPORT_LIMITS,
  FEEDBACK_REPORT_SCHEMA_VERSION,
  type FeedbackReportDraftV1,
} from "@oscharko-dev/keiko-contracts/feedback-report";

import { prepareFeedbackReportV1 } from "./feedback-report.js";
import { verifyCanonicalFeedbackReportBodyV1 } from "./feedback-report-verifier.js";
import { redactWithRuleCounts } from "./redaction.js";

function validDraft(handwrittenEvidence: string): FeedbackReportDraftV1 {
  return {
    schemaVersion: FEEDBACK_REPORT_SCHEMA_VERSION,
    category: "defect",
    title: "Literal overlap regression",
    description: "The editor remained stable.",
    reproductionSteps: "Open the editor.",
    expectedBehavior: "The editor remains usable.",
    actualBehavior: "The editor remained usable.",
    productVersion: "0.2.14",
    platform: "Linux",
    featureArea: "editor",
    impact: "Unknown",
    handwrittenEvidence,
  };
}

function withCountedLiteralSearches<T>(
  literals: ReadonlySet<string>,
  run: () => T,
): { readonly value: T; readonly searches: number } {
  const descriptor = Object.getOwnPropertyDescriptor(String.prototype, "indexOf");
  if (descriptor === undefined || typeof descriptor.value !== "function") {
    throw new Error("String#indexOf descriptor unavailable");
  }
  const original = descriptor.value as typeof String.prototype.indexOf;
  let searches = 0;
  Object.defineProperty(String.prototype, "indexOf", {
    ...descriptor,
    value(this: string, searchString: string, position?: number): number {
      if (literals.has(searchString)) searches += 1;
      return Reflect.apply(original, this, [searchString, position]);
    },
  });
  try {
    return { value: run(), searches };
  } finally {
    Object.defineProperty(String.prototype, "indexOf", descriptor);
  }
}

describe("feedback configured-literal overlap bounds", () => {
  it.each([
    ["overlapping", "ababa", ["aba", "bab"], "[REDACTED]", 1],
    ["adjacent", "foofoo", ["foo"], "[REDACTED][REDACTED]", 2],
  ] as const)("preserves %s interval-union semantics", (_label, input, literals, value, count) => {
    expect(redactWithRuleCounts(input, literals)).toEqual({
      value,
      rules: [{ code: "configured-literal", count }],
    });
  });

  it("prepares and verifies a maximum admitted field and overlapping policy with bounded searches", () => {
    const literals = Array.from({ length: 64 }, (_, index) => "a".repeat(index + 4));
    const literalSet = new Set(literals);
    const evidence = "a".repeat(FEEDBACK_REPORT_LIMITS.handwrittenEvidenceBytes);
    const policy = { sensitiveLiterals: literals };
    const measured = withCountedLiteralSearches(literalSet, () =>
      prepareFeedbackReportV1(validDraft(evidence), policy),
    );

    expect(measured.searches).toBeLessThan(evidence.length * 8);
    expect(measured.value.ok).toBe(true);
    if (!measured.value.ok) return;
    const prepared = measured.value.value;
    expect(prepared.report.handwrittenEvidence).toBe("[REDACTED]");
    expect(prepared.canonicalJson).not.toContain("a".repeat(68));
    expect(prepared.report.redactionProvenance.rules).toContainEqual({
      code: "configured-literal",
      count: 1,
    });
    expect(prepared.dispositionSidecar.records).toContainEqual({
      action: "redacted",
      reason: "complete-sensitive-span",
      unitKind: "structured-value",
      target: { kind: "draft-field", field: "handwrittenEvidence" },
    });
    const verified = verifyCanonicalFeedbackReportBodyV1({
      bytes: prepared.canonicalBody.copyBytes(),
      claimedDigest: prepared.exactBodySha256,
      policy,
    });
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.value.canonicalJson).toBe(prepared.canonicalJson);

    const reversed = prepareFeedbackReportV1(validDraft(evidence), {
      sensitiveLiterals: [...literals].reverse(),
    });
    expect(reversed.ok).toBe(true);
    if (!reversed.ok) return;
    expect(reversed.value.canonicalJson).toBe(prepared.canonicalJson);
    expect(reversed.value.dispositionSidecar.records).toEqual(prepared.dispositionSidecar.records);
  });
});
