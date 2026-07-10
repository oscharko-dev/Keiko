import type { FeedbackReportV1 } from "@oscharko-dev/keiko-contracts/feedback-report";

export const PUBLIC_FEEDBACK_FORM_URL_V1 =
  "https://github.com/oscharko-dev/Keiko/issues/new?template=user_finding.yml" as const;
export const PUBLIC_FEEDBACK_URL_MAX_BYTES_V1 = 8_192;

const TEXT_ENCODER = new TextEncoder();

export interface FeedbackPublicProjectionV1 {
  readonly mode: "prefilled" | "copy-fallback";
  readonly href: string;
  readonly copyText: string;
}

interface PublicFeedbackFieldsV1 {
  readonly title: string;
  readonly version: string;
  readonly platform: string;
  readonly browser?: string | undefined;
  readonly summary: string;
  readonly steps: string;
  readonly expected: string;
  readonly actual: string;
  readonly evidence?: string | undefined;
  readonly diagnostics: string;
  readonly impact: string;
}

function feedbackEvidence(report: FeedbackReportV1): string | undefined {
  const sections: string[] = [];
  if (report.handwrittenEvidence !== undefined) sections.push(report.handwrittenEvidence);
  for (const [index, attachment] of (report.attachments ?? []).entries()) {
    sections.push(`Attachment ${String(index + 1)}:\n${attachment}`);
  }
  return sections.length === 0 ? undefined : sections.join("\n\n");
}

function feedbackDiagnostics(report: FeedbackReportV1): string {
  const counts = report.diagnostics.severityCounts;
  return [
    `Category: ${report.diagnostics.category}`,
    `Feature area: ${report.diagnostics.featureArea}`,
    ...(counts === undefined
      ? []
      : [
          `Errors: ${String(counts.errors)}`,
          `Warnings: ${String(counts.warnings)}`,
          `Infos: ${String(counts.infos)}`,
        ]),
  ].join("\n");
}

function publicFields(report: FeedbackReportV1): PublicFeedbackFieldsV1 {
  const evidence = feedbackEvidence(report);
  return {
    title: report.summary.title,
    version: report.productVersion,
    platform: report.platform,
    ...(report.browserDescription === undefined ? {} : { browser: report.browserDescription }),
    summary: `${report.summary.title}\n\n${report.summary.description}`,
    steps: report.steps,
    expected: report.expectedResult,
    actual: report.actualResult,
    ...(evidence === undefined ? {} : { evidence }),
    diagnostics: feedbackDiagnostics(report),
    impact: report.impact,
  };
}

function issueTitle(fields: PublicFeedbackFieldsV1): string {
  return `[User Finding]: ${fields.title}`;
}

function prefilledUrl(fields: PublicFeedbackFieldsV1): string {
  const url = new URL(PUBLIC_FEEDBACK_FORM_URL_V1);
  url.searchParams.set("title", issueTitle(fields));
  url.searchParams.set("version", fields.version);
  if (fields.browser !== undefined) url.searchParams.set("browser", fields.browser);
  url.searchParams.set("summary", fields.summary);
  url.searchParams.set("steps", fields.steps);
  url.searchParams.set("expected", fields.expected);
  url.searchParams.set("actual", fields.actual);
  const diagnostics = fieldBlock("Diagnostics", fields.diagnostics);
  url.searchParams.set(
    "evidence",
    fields.evidence === undefined ? diagnostics : `${fields.evidence}\n\n${diagnostics}`,
  );
  return url.toString();
}

function fieldBlock(label: string, value: string): string {
  return `${label}:\n${value}`;
}

function copyText(fields: PublicFeedbackFieldsV1): string {
  return [
    fieldBlock("Issue title", issueTitle(fields)),
    fieldBlock("Keiko version", fields.version),
    fieldBlock("Platform", fields.platform),
    ...(fields.browser === undefined ? [] : [fieldBlock("Browser", fields.browser)]),
    fieldBlock("Summary", fields.summary),
    fieldBlock("Steps to reproduce", fields.steps),
    fieldBlock("Expected result", fields.expected),
    fieldBlock("Actual result", fields.actual),
    ...(fields.evidence === undefined ? [] : [fieldBlock("Evidence", fields.evidence)]),
    fieldBlock("Diagnostics", fields.diagnostics),
    fieldBlock("User impact", fields.impact),
  ].join("\n\n");
}

export function createFeedbackPublicProjectionV1(
  report: FeedbackReportV1,
): FeedbackPublicProjectionV1 {
  const fields = publicFields(report);
  const href = prefilledUrl(fields);
  const completeCopyText = copyText(fields);
  if (TEXT_ENCODER.encode(href).length > PUBLIC_FEEDBACK_URL_MAX_BYTES_V1) {
    return {
      mode: "copy-fallback",
      href: PUBLIC_FEEDBACK_FORM_URL_V1,
      copyText: completeCopyText,
    };
  }
  return {
    mode: "prefilled",
    href,
    copyText: completeCopyText,
  };
}
