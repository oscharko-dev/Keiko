import { describe, expect, it } from "vitest";
import {
  buildFeedbackGithubIssueDraft,
  buildFeedbackReportPreview,
  containsRedactedSentinel,
  feedbackPreviewHasRedactionProvenance,
  feedbackReviewStatusAfter,
  parseFeedbackReportDraft,
  type FeedbackIntakeItem,
} from "./feedback-intake.js";

const redact = (input: string): string =>
  input.replaceAll("ghp_0123456789abcdef0123456789abcdef0123", "[REDACTED]");

describe("feedback intake contracts", () => {
  it("parses a bounded report draft", () => {
    const parsed = parseFeedbackReportDraft({
      category: "bug",
      severity: "high",
      title: "Preview does not render",
      description: "The report preview panel stays empty.",
      reproductionSteps: ["Open feedback", "Click preview"],
      diagnostics: { keikoVersion: "0.2.11", platform: "win32" },
    });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.reproductionSteps).toHaveLength(2);
    }
  });

  it("rejects unknown categories and oversized step lists", () => {
    const parsed = parseFeedbackReportDraft({
      category: "telemetry",
      severity: "high",
      title: "x",
      description: "y",
      reproductionSteps: Array.from({ length: 21 }, (_, index) => `step ${String(index)}`),
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors.join("\n")).toContain("category");
      expect(parsed.errors.join("\n")).toContain("reproductionSteps");
    }
  });

  it("redacts every string-bearing preview field and records provenance", () => {
    const parsed = parseFeedbackReportDraft({
      category: "bug",
      severity: "medium",
      title: "Token ghp_0123456789abcdef0123456789abcdef0123",
      description: "Body ghp_0123456789abcdef0123456789abcdef0123",
      attachments: [
        {
          name: "log-ghp_0123456789abcdef0123456789abcdef0123.txt",
          mediaType: "text/plain",
          byteLength: 42,
          textPreview: "token ghp_0123456789abcdef0123456789abcdef0123",
        },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const preview = buildFeedbackReportPreview(parsed.value, redact);

    expect(JSON.stringify(preview.report)).not.toContain("ghp_0123456789abcdef");
    expect(preview.provenance.redactedFields).toEqual([
      "title",
      "description",
      "attachments[0].name",
      "attachments[0].textPreview",
    ]);
    expect(feedbackPreviewHasRedactionProvenance(preview)).toBe(true);
    expect(containsRedactedSentinel(preview)).toBe(true);
  });

  it("blocks terminal review states from further transitions", () => {
    expect(feedbackReviewStatusAfter("new", "approve-for-github")).toBe("approved-for-github");
    expect(feedbackReviewStatusAfter("github-created", "archive")).toBeUndefined();
    expect(feedbackReviewStatusAfter("archived", "reject")).toBeUndefined();
  });

  it("builds a GitHub issue draft from the redacted intake item", () => {
    const item: FeedbackIntakeItem = {
      schemaVersion: 1,
      receipt: {
        schemaVersion: 1,
        intakeId: "fb_1",
        status: "approved-for-github",
        dedupeKey: "dedupe",
        submittedAt: "2026-07-07T00:00:00.000Z",
      },
      report: {
        category: "bug",
        severity: "high",
        title: "Preview failure",
        description: "The preview fails after redaction.",
      },
      provenance: {
        engine: "keiko-feedback-redaction",
        schemaVersion: 1,
        redactedFields: [],
        omittedFields: [],
        blockedReasons: [],
      },
      review: { status: "approved-for-github", events: [] },
    };

    const issue = buildFeedbackGithubIssueDraft(item);

    expect(issue.title).toBe("Preview failure");
    expect(issue.labels).toContain("feedback:bug");
    expect(issue.body).toContain("Redacted intake receipt: fb_1");
  });
});
