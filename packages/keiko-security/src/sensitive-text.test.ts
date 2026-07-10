import { describe, expect, it } from "vitest";

import {
  FEEDBACK_REPORT_SCHEMA_VERSION,
  type FeedbackReportDraftV1,
} from "@oscharko-dev/keiko-contracts/feedback-report";

import { prepareFeedbackReportV1 } from "./feedback-report.js";
import { verifyCanonicalFeedbackReportBodyV1 } from "./feedback-report-verifier.js";
import { scanSensitiveText } from "./sensitive-text.js";

function draftWithDescription(description: string): FeedbackReportDraftV1 {
  return {
    schemaVersion: FEEDBACK_REPORT_SCHEMA_VERSION,
    category: "defect",
    title: "Credential handling feedback",
    description,
    reproductionSteps: "Open the settings form.",
    expectedBehavior: "The form behaves safely.",
    actualBehavior: "The form displayed an unexpected value.",
    productVersion: "0.2.14",
    platform: "Linux",
    featureArea: "model-configuration",
    impact: "Degrades core workflow",
  };
}

describe("scanSensitiveText", () => {
  it.each([
    ["credential shape", `Bearer ${"opaque".repeat(5)}`, "credential-shape"],
    ["private credential path", "read ~/.ssh/id_ed25519", "private-credential-path"],
    [
      "provider endpoint",
      "provider base URL https://gateway.internal.example/v1",
      "provider-base-url",
    ],
    ["timestamped log", "2026-07-09T18:10:11Z ERROR worker failed", "raw-log-content"],
    ["stack records", "at first (/a.ts:1:2)\nat second (/b.ts:3:4)", "raw-log-content"],
  ])("classifies a %s without returning matched content", (_label, value, expected) => {
    expect(scanSensitiveText(value)).toBe(expected);
  });

  it("returns null for handwritten sanitized evidence", () => {
    expect(scanSensitiveText("The editor failed after the second user action.")).toBeNull();
  });

  it.each([
    ["global", /AcmeCorp/g],
    ["sticky", /AcmeCorp/y],
  ])("resets a caller-provided %s matcher for deterministic repeated scans", (_label, matcher) => {
    expect(scanSensitiveText("AcmeCorp", [matcher])).toBe("customer-identifier");
    expect(scanSensitiveText("AcmeCorp", [matcher])).toBe("customer-identifier");
    expect(matcher.lastIndex).toBe(0);
  });

  it.each([
    ["assignment", "password=opaque-value", "redacted", "complete-sensitive-span"],
    ["pretty JSON value", '"password":\n  "opaque value"', "redacted", "complete-sensitive-span"],
    [
      "JSON separator whitespace",
      '"password"\n:\n"opaque value"',
      "redacted",
      "complete-sensitive-span",
    ],
    [
      "quoted assignment",
      'Safe prefix "password=opaque-value" safe suffix',
      "quarantined",
      "ambiguous-credential-structure",
    ],
    [
      "nested message assignment",
      'Safe prefix payload={"message":"password=opaque-value","safe":1} safe suffix',
      "quarantined",
      "ambiguous-credential-structure",
    ],
    ["authorization", "Bearer opaque-token-value", "redacted", "complete-sensitive-span"],
    [
      "URL userinfo",
      "https://user:opaque-value@host.example/repo",
      "redacted",
      "complete-sensitive-span",
    ],
  ] as const)(
    "keeps classifier, disposition, preparation, and verifier aligned for %s",
    (_label, input, action, reason) => {
      expect(scanSensitiveText(input)).toBe("credential-shape");
      const prepared = prepareFeedbackReportV1(draftWithDescription(input));
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;

      expect(prepared.value.canonicalJson).not.toContain("opaque");
      expect(prepared.value.dispositionSidecar.records).toContainEqual(
        expect.objectContaining({
          action,
          reason,
          target: { kind: "draft-field", field: "description" },
        }),
      );
      const verified = verifyCanonicalFeedbackReportBodyV1({
        bytes: prepared.value.canonicalBody.copyBytes(),
        claimedDigest: prepared.value.exactBodySha256,
      });
      expect(verified.ok).toBe(true);
      if (!verified.ok) return;
      const repeated = verifyCanonicalFeedbackReportBodyV1({
        bytes: verified.value.canonicalBody.copyBytes(),
        claimedDigest: verified.value.exactBodySha256,
      });
      expect(repeated.ok).toBe(true);
      if (!repeated.ok) return;
      expect(repeated.value.canonicalJson).toBe(verified.value.canonicalJson);
      expect(repeated.value.exactBodySha256).toBe(verified.value.exactBodySha256);
    },
  );
});
