import { describe, expect, it } from "vitest";

import {
  FEEDBACK_REPORT_SCHEMA_VERSION,
  type FeedbackReportDraftV1,
} from "@oscharko-dev/keiko-contracts/feedback-report";

import { prepareFeedbackReportV1 } from "./feedback-report.js";
import { verifyCanonicalFeedbackReportBodyV1 } from "./feedback-report-verifier.js";
import { canonicalise, sha256Hex } from "./hashing.js";
import { redactWithRuleCounts } from "./redaction.js";

function validDraft(description: string): FeedbackReportDraftV1 {
  return {
    schemaVersion: FEEDBACK_REPORT_SCHEMA_VERSION,
    category: "defect",
    title: "Feedback disposition",
    description,
    reproductionSteps: "Open the settings form.",
    expectedBehavior: "The form remains usable.",
    actualBehavior: "The form displayed unexpected content.",
    productVersion: "0.2.14",
    platform: "Linux",
    featureArea: "model-configuration",
    impact: "Degrades core workflow",
  };
}

function expectCanonicalVerifierParity(
  description: string,
  rawAtom: string,
): ReturnType<typeof prepareFeedbackReportV1> {
  const prepared = prepareFeedbackReportV1(validDraft(description));
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) return prepared;

  expect(prepared.value.canonicalJson).not.toContain(rawAtom);
  expect(
    verifyCanonicalFeedbackReportBodyV1({
      bytes: prepared.value.canonicalBody.copyBytes(),
      claimedDigest: prepared.value.exactBodySha256,
    }).ok,
  ).toBe(true);

  const rawReport = {
    ...prepared.value.report,
    summary: { ...prepared.value.report.summary, description },
  };
  const rawJson = canonicalise(rawReport);
  expect(
    verifyCanonicalFeedbackReportBodyV1({
      bytes: new TextEncoder().encode(rawJson),
      claimedDigest: sha256Hex(rawJson),
    }),
  ).toEqual({ ok: false, error: { code: "unsafe-content" } });
  return prepared;
}

describe("feedback ambiguous credential disposition", () => {
  it("preserves the safe following line after a backslash-newline quoted assignment", () => {
    const rawAtom = "opaque-value";
    const description = `Safe prefix password="${rawAtom}\\\nSafe following line`;
    const prepared = expectCanonicalVerifierParity(description, rawAtom);
    if (!prepared.ok) return;

    expect(prepared.value.report.summary.description).toContain("Safe prefix");
    expect(prepared.value.report.summary.description).toContain("Safe following line");
    expect(prepared.value.dispositionSidecar.records).toContainEqual({
      action: "quarantined",
      reason: "ambiguous-credential-structure",
      unitKind: "line-remainder",
      target: { kind: "draft-field", field: "description" },
    });
  });

  it.each(["|", ">"] as const)(
    "quarantines a YAML %s block value while preserving legacy exact redaction",
    (indicator) => {
      const rawAtom = "opaque-yaml-value";
      const description = [
        "Safe prefix",
        `password: ${indicator}`,
        `  ${rawAtom}`,
        "Safe following line",
      ].join("\n");
      const prepared = expectCanonicalVerifierParity(description, rawAtom);
      if (!prepared.ok) return;

      expect(prepared.value.report.summary.description).toContain("Safe prefix");
      expect(prepared.value.report.summary.description).toContain("Safe following line");
      expect(prepared.value.dispositionSidecar.records).toContainEqual({
        action: "quarantined",
        reason: "ambiguous-credential-structure",
        unitKind: "structured-value",
        target: { kind: "draft-field", field: "description" },
      });
      expect(redactWithRuleCounts(description)).toEqual({
        value: "Safe prefix\npassword: [REDACTED]",
        rules: [{ code: "credential-assignment", count: 1 }],
      });
    },
  );
});
