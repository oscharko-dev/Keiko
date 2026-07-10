import { describe, expect, it } from "vitest";

import {
  FEEDBACK_REPORT_SCHEMA_VERSION,
  type FeedbackReportDraftV1,
  type FeedbackReportV1,
} from "@oscharko-dev/keiko-contracts/feedback-report";

import { prepareFeedbackReportV1, type PreparedFeedbackReportV1 } from "./feedback-report.js";
import { verifyCanonicalFeedbackReportBodyV1 } from "./feedback-report-verifier.js";
import { canonicalise, sha256Hex } from "./hashing.js";
import { redact, redactWithRuleCounts } from "./redaction.js";
import { scanSensitiveText } from "./sensitive-text.js";

function validDraft(description: string): FeedbackReportDraftV1 {
  return {
    schemaVersion: FEEDBACK_REPORT_SCHEMA_VERSION,
    category: "defect",
    title: "Feedback safety regression",
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

function prepareAndVerify(description: string): PreparedFeedbackReportV1 | undefined {
  const prepared = prepareFeedbackReportV1(validDraft(description));
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) return undefined;
  expect(
    verifyCanonicalFeedbackReportBodyV1({
      bytes: prepared.value.canonicalBody.copyBytes(),
      claimedDigest: prepared.value.exactBodySha256,
    }).ok,
  ).toBe(true);
  return prepared.value;
}

function expectRawDescriptionRejected(
  baseline: PreparedFeedbackReportV1,
  description: string,
): void {
  const report: FeedbackReportV1 = {
    ...baseline.report,
    summary: { ...baseline.report.summary, description },
  };
  const json = canonicalise(report);
  expect(
    verifyCanonicalFeedbackReportBodyV1({
      bytes: new TextEncoder().encode(json),
      claimedDigest: sha256Hex(json),
    }),
  ).toEqual({ ok: false, error: { code: "unsafe-content" } });
}

function indexedReadsDuringPublicScan(value: string): number {
  let reads = 0;
  const target = Object(value) as object;
  const counted = new Proxy(target, {
    get: (object, key): unknown => {
      if (typeof key === "string" && /^[0-9]+$/u.test(key)) reads += 1;
      if (key === Symbol.toPrimitive) return (): string => value;
      const member = Reflect.get(object, key, object) as unknown;
      return typeof member === "function" ? member.bind(object) : member;
    },
  });
  expect(scanSensitiveText(counted as unknown as string)).toBe("credential-shape");
  return reads;
}

describe("feedback intake follow-up regressions", () => {
  it.each(["password", "api_key", "token"])(
    "restores conservative shared %s colon-assignment coverage",
    (key) => {
      const input = `authentication failed with ${key}: hunter2 today`;
      const redacted = redactWithRuleCounts(input);

      expect(redacted.value).not.toContain("hunter2");
      expect(redacted.value).toContain("authentication failed with");
      expect(redacted.rules).toEqual([{ code: "credential-assignment", count: 1 }]);
      expect(redact(input)).not.toContain("hunter2");
      expect(scanSensitiveText(input)).toBe("credential-shape");
    },
  );

  it("keeps feedback's lower-false-positive natural-language policy", () => {
    const description = "The password: reset guidance is public.";
    const prepared = prepareAndVerify(description);

    expect(prepared?.report.summary.description).toBe(description);
    expect(prepared?.dispositionSidecar.records).toEqual([]);
  });

  it("bounds indexed reads for repeated unterminated containers linearly", () => {
    const build = (lines: number): string =>
      Array.from({ length: lines }, () => 'password={"unterminated').join("\n");
    const small = indexedReadsDuringPublicScan(build(20));
    const doubled = indexedReadsDuringPublicScan(build(40));

    expect(doubled).toBeLessThan(small * 3);
  });

  it.each(["|", ">"] as const)(
    "preserves the first safe line after an empty YAML %s block",
    (indicator) => {
      const input = `Safe prefix\npassword: ${indicator}\nSafe following line`;
      const prepared = prepareAndVerify(input);

      expect(prepared?.report.summary.description).toContain("Safe prefix");
      expect(prepared?.report.summary.description).toContain("Safe following line");
      expect(prepared?.report.summary.description).not.toContain(`password: ${indicator}`);
      expect(prepared?.dispositionSidecar.records).toContainEqual({
        action: "quarantined",
        reason: "ambiguous-credential-structure",
        unitKind: "structured-value",
        target: { kind: "draft-field", field: "description" },
      });
    },
  );

  it.each([
    ["JWT", "eyJ" + "abcdefgh.abcdefghijk.abcdefghijk"],
    ["13-19 digit", "4111111111111111"],
  ])("redacts a complete %s span while preserving safe prose", (_label, secret) => {
    const input = `Safe prefix ${secret} safe suffix`;
    const prepared = prepareAndVerify(input);
    if (prepared === undefined) return;

    expect(prepared.report.summary.description).toBe("Safe prefix [REDACTED] safe suffix");
    expect(prepared.report.redactionProvenance.rules).toContainEqual({
      code: "credential-shape",
      count: 1,
    });
    expect(prepared.dispositionSidecar.records).toContainEqual({
      action: "redacted",
      reason: "complete-sensitive-span",
      unitKind: "structured-value",
      target: { kind: "draft-field", field: "description" },
    });
    expectRawDescriptionRejected(prepared, input);
  });
});
