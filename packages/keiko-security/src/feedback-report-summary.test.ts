import { describe, expect, it } from "vitest";

import {
  FEEDBACK_REPORT_LIMITS,
  FEEDBACK_REPORT_SCHEMA_VERSION,
  type FeedbackReportDraftV1,
} from "@oscharko-dev/keiko-contracts/feedback-report";

import { prepareFeedbackReportV1 } from "./feedback-report.js";
import { verifyCanonicalFeedbackReportBodyV1 } from "./feedback-report-verifier.js";
import { canonicalise, sha256Hex } from "./hashing.js";

function validDraft(overrides: Partial<FeedbackReportDraftV1> = {}): FeedbackReportDraftV1 {
  return {
    schemaVersion: FEEDBACK_REPORT_SCHEMA_VERSION,
    category: "defect",
    title: "Editor does not open",
    description: "The editor remains blank.",
    reproductionSteps: "Open a file.",
    expectedBehavior: "The editor opens.",
    actualBehavior: "The editor remains blank.",
    productVersion: "0.2.14",
    platform: "Linux",
    featureArea: "editor",
    impact: "Blocks core workflow",
    ...overrides,
  };
}

describe("feedback report structured summary safety", () => {
  it("does not manufacture a raw-log signature across summary fields", () => {
    const prepared = prepareFeedbackReportV1(
      validDraft({
        title: "2026-07-09T18:10:11Z",
        description: "ERROR worker failed",
      }),
    );

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.report.summary).toEqual({
      title: "2026-07-09T18:10:11Z",
      description: "ERROR worker failed",
    });
  });

  it("accepts the exact combined cap including the display separator", () => {
    const title = "t".repeat(FEEDBACK_REPORT_LIMITS.summaryBytes - 3);
    const prepared = prepareFeedbackReportV1(validDraft({ title, description: "d" }));

    expect(new TextEncoder().encode(`${title}\n\nd`)).toHaveLength(
      FEEDBACK_REPORT_LIMITS.summaryBytes,
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.report.summary).toEqual({ title, description: "d" });
  });

  it("rejects the obsolete flattened canonical summary before safety verification", () => {
    const prepared = prepareFeedbackReportV1(validDraft());
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const flattened = {
      ...prepared.value.report,
      summary: `${prepared.value.report.summary.title}\n\n${prepared.value.report.summary.description}`,
    };
    const json = canonicalise(flattened);

    expect(
      verifyCanonicalFeedbackReportBodyV1({
        bytes: new TextEncoder().encode(json),
        claimedDigest: sha256Hex(json),
      }),
    ).toEqual({ ok: false, error: { code: "invalid-report" } });
  });
});
