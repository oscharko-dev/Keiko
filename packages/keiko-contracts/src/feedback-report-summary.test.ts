import { describe, expect, it } from "vitest";

import {
  FEEDBACK_PRIVACY_CONTRACT_VERSION,
  FEEDBACK_REDACTION_ENGINE_VERSION,
  FEEDBACK_REPORT_SCHEMA_VERSION,
  parseFeedbackReportDraftV1,
  parseFeedbackReportV1,
} from "./feedback-report.js";

function validReport(): Record<string, unknown> {
  return {
    schemaVersion: FEEDBACK_REPORT_SCHEMA_VERSION,
    privacyContractVersion: FEEDBACK_PRIVACY_CONTRACT_VERSION,
    redactionProvenance: { engineVersion: FEEDBACK_REDACTION_ENGINE_VERSION, rules: [] },
    productVersion: "0.2.14",
    platform: "Linux",
    summary: { title: "Title", description: "Description" },
    steps: "Steps",
    expectedResult: "Expected",
    actualResult: "Actual",
    impact: "Unknown",
    diagnostics: { category: "defect", featureArea: "editor" },
  };
}

function validDraft(): Record<string, unknown> {
  return {
    schemaVersion: FEEDBACK_REPORT_SCHEMA_VERSION,
    category: "defect",
    title: "Title",
    description: "Description",
    reproductionSteps: "Steps",
    expectedBehavior: "Expected",
    actualBehavior: "Actual",
    productVersion: "0.2.14",
    platform: "Linux",
    featureArea: "editor",
    impact: "Unknown",
  };
}

describe("feedback report structured summary contract", () => {
  it.each([
    ["POSIX", "Path:/Users/Alice/private.txt"],
    ["drive", "Path:C:\\Users\\Alice\\private.txt"],
    ["backslash UNC", "Path:\\\\server\\share\\private.txt"],
  ])("rejects a colon-labeled %s path in the description", (_label, description) => {
    const report = validReport();
    report.summary = { title: "Title", description };

    expect(parseFeedbackReportV1(report)).toEqual({
      ok: false,
      errors: [{ code: "residual-absolute-path", field: "summary.description" }],
    });
  });

  it("rejects the obsolete flattened summary shape", () => {
    expect(parseFeedbackReportV1({ ...validReport(), summary: "Title\n\nDescription" })).toEqual({
      ok: false,
      errors: [{ code: "invalid-shape", field: "summary" }],
    });
  });

  it.each([
    ["missing title", { description: "Description" }, "required-field", "summary.title"],
    [
      "non-string description",
      { title: "Title", description: 1 },
      "invalid-type",
      "summary.description",
    ],
    [
      "unknown nested member",
      { title: "Title", description: "Description", raw: "private" },
      "unknown-field",
      "summary",
    ],
  ])("rejects a structured summary with %s", (_label, summary, code, field) => {
    expect(parseFeedbackReportV1({ ...validReport(), summary })).toEqual({
      ok: false,
      errors: [{ code, field }],
    });
  });

  it.each([
    ["missing title", { title: undefined }, "required-field", "summary.title"],
    ["non-string description", { description: 1 }, "invalid-type", "summary.description"],
  ])("targets the exact draft control for %s", (_label, patch, code, field) => {
    expect(parseFeedbackReportDraftV1({ ...validDraft(), ...patch })).toEqual({
      ok: false,
      errors: [{ code, field }],
    });
  });
});
