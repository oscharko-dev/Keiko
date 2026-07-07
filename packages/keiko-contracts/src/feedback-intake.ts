export const FEEDBACK_INTAKE_SCHEMA_VERSION = 1 as const;

export const FEEDBACK_REPORT_CATEGORIES = [
  "bug",
  "crash",
  "performance",
  "usability",
  "documentation",
  "other",
] as const;

export type FeedbackReportCategory = (typeof FEEDBACK_REPORT_CATEGORIES)[number];

export const FEEDBACK_REPORT_SEVERITIES = ["low", "medium", "high", "critical"] as const;

export type FeedbackReportSeverity = (typeof FEEDBACK_REPORT_SEVERITIES)[number];

export const FEEDBACK_INTAKE_STATUSES = [
  "new",
  "duplicate",
  "rejected",
  "follow-up-requested",
  "approved-for-github",
  "github-created",
  "archived",
] as const;

export type FeedbackIntakeStatus = (typeof FEEDBACK_INTAKE_STATUSES)[number];

export const FEEDBACK_REVIEW_ACTIONS = [
  "mark-duplicate",
  "reject",
  "request-follow-up",
  "approve-for-github",
  "archive",
] as const;

export type FeedbackReviewAction = (typeof FEEDBACK_REVIEW_ACTIONS)[number];

export const FEEDBACK_INTAKE_REJECTION_REASONS = [
  "invalid-schema",
  "payload-too-large",
  "missing-redaction-provenance",
  "unsafe-payload",
  "rate-limited",
  "duplicate",
  "intake-unavailable",
  "github-unavailable",
  "github-permission-denied",
  "github-validation-error",
] as const;

export type FeedbackIntakeRejectionReason = (typeof FEEDBACK_INTAKE_REJECTION_REASONS)[number];

export interface FeedbackDiagnostics {
  readonly keikoVersion: string;
  readonly platform: string;
  readonly os?: string | undefined;
  readonly uiMode?: string | undefined;
  readonly featureArea?: string | undefined;
}

export interface FeedbackAttachmentSummary {
  readonly name: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly textPreview?: string | undefined;
}

export interface FeedbackReportDraft {
  readonly category: FeedbackReportCategory;
  readonly severity: FeedbackReportSeverity;
  readonly title: string;
  readonly description: string;
  readonly reproductionSteps?: readonly string[] | undefined;
  readonly expectedBehavior?: string | undefined;
  readonly actualBehavior?: string | undefined;
  readonly featureArea?: string | undefined;
  readonly diagnostics?: FeedbackDiagnostics | undefined;
  readonly attachments?: readonly FeedbackAttachmentSummary[] | undefined;
}

export interface FeedbackRedactionProvenance {
  readonly engine: "keiko-feedback-redaction";
  readonly schemaVersion: typeof FEEDBACK_INTAKE_SCHEMA_VERSION;
  readonly redactedFields: readonly string[];
  readonly omittedFields: readonly string[];
  readonly blockedReasons: readonly FeedbackIntakeRejectionReason[];
}

export interface FeedbackReportPreview {
  readonly schemaVersion: typeof FEEDBACK_INTAKE_SCHEMA_VERSION;
  readonly report: FeedbackReportDraft;
  readonly provenance: FeedbackRedactionProvenance;
  readonly payloadByteLength: number;
  readonly safeToSubmit: boolean;
}

export interface FeedbackIntakeReceipt {
  readonly schemaVersion: typeof FEEDBACK_INTAKE_SCHEMA_VERSION;
  readonly intakeId: string;
  readonly status: FeedbackIntakeStatus;
  readonly dedupeKey: string;
  readonly submittedAt: string;
}

export interface FeedbackIntakeItem {
  readonly schemaVersion: typeof FEEDBACK_INTAKE_SCHEMA_VERSION;
  readonly receipt: FeedbackIntakeReceipt;
  readonly report: FeedbackReportDraft;
  readonly provenance: FeedbackRedactionProvenance;
  readonly review: FeedbackReviewState;
  readonly githubIssue?: FeedbackGithubIssueRef | undefined;
}

export interface FeedbackReviewEvent {
  readonly action: FeedbackReviewAction | "submit" | "github-create";
  readonly actor: string;
  readonly at: string;
  readonly reason?: string | undefined;
}

export interface FeedbackReviewState {
  readonly status: FeedbackIntakeStatus;
  readonly events: readonly FeedbackReviewEvent[];
  readonly duplicateOf?: string | undefined;
}

export interface FeedbackGithubIssueRef {
  readonly repository: string;
  readonly number: number;
  readonly url: string;
  readonly createdAt: string;
}

export interface FeedbackGithubIssueDraft {
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

export interface FeedbackReportParseOk {
  readonly ok: true;
  readonly value: FeedbackReportDraft;
}

export interface FeedbackReportParseFail {
  readonly ok: false;
  readonly errors: readonly string[];
}

export type FeedbackReportParse = FeedbackReportParseOk | FeedbackReportParseFail;

const MAX_TITLE_CHARS = 160;
const MAX_TEXT_CHARS = 8_000;
const MAX_STEP_CHARS = 1_000;
const MAX_STEPS = 20;
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_TEXT_CHARS = 4_000;
const MAX_ATTACHMENT_BYTES = 256_000;
const MAX_TOTAL_PAYLOAD_BYTES = 64_000;
const REDACTED_SENTINEL = "[REDACTED]";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCategory(value: unknown): value is FeedbackReportCategory {
  return (
    typeof value === "string" && (FEEDBACK_REPORT_CATEGORIES as readonly string[]).includes(value)
  );
}

function isSeverity(value: unknown): value is FeedbackReportSeverity {
  return (
    typeof value === "string" && (FEEDBACK_REPORT_SEVERITIES as readonly string[]).includes(value)
  );
}

function boundedString(
  value: unknown,
  field: string,
  maxChars: number,
  errors: string[],
  required = false,
): string | undefined {
  if (value === undefined) {
    if (required) errors.push(`${field} is required`);
    return undefined;
  }
  if (typeof value !== "string") {
    errors.push(`${field} must be a string`);
    return undefined;
  }
  const trimmed = value.trim();
  if (required && trimmed.length === 0) {
    errors.push(`${field} is required`);
    return undefined;
  }
  if (trimmed.length > maxChars) {
    errors.push(`${field} must be at most ${String(maxChars)} characters`);
    return undefined;
  }
  return trimmed.length === 0 ? undefined : trimmed;
}

function parseSteps(value: unknown, errors: string[]): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push("reproductionSteps must be an array");
    return undefined;
  }
  if (value.length > MAX_STEPS) {
    errors.push(`reproductionSteps must contain at most ${String(MAX_STEPS)} entries`);
    return undefined;
  }
  const steps: string[] = [];
  for (const [index, entry] of value.entries()) {
    const step = boundedString(
      entry,
      `reproductionSteps[${String(index)}]`,
      MAX_STEP_CHARS,
      errors,
    );
    if (step !== undefined) steps.push(step);
  }
  return steps.length === 0 ? undefined : steps;
}

function parseDiagnostics(value: unknown, errors: string[]): FeedbackDiagnostics | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    errors.push("diagnostics must be an object");
    return undefined;
  }
  const keikoVersion = boundedString(
    value.keikoVersion,
    "diagnostics.keikoVersion",
    80,
    errors,
    true,
  );
  const platform = boundedString(value.platform, "diagnostics.platform", 80, errors, true);
  const os = boundedString(value.os, "diagnostics.os", 120, errors);
  const uiMode = boundedString(value.uiMode, "diagnostics.uiMode", 80, errors);
  const featureArea = boundedString(value.featureArea, "diagnostics.featureArea", 120, errors);
  if (keikoVersion === undefined || platform === undefined) return undefined;
  return {
    keikoVersion,
    platform,
    ...(os === undefined ? {} : { os }),
    ...(uiMode === undefined ? {} : { uiMode }),
    ...(featureArea === undefined ? {} : { featureArea }),
  };
}

function parseAttachmentByteLength(
  entry: Record<string, unknown>,
  fieldPrefix: string,
  errors: string[],
): number | undefined {
  if (typeof entry.byteLength !== "number" || !Number.isSafeInteger(entry.byteLength)) {
    errors.push(`${fieldPrefix}.byteLength must be an integer`);
    return undefined;
  }
  if (entry.byteLength < 0 || entry.byteLength > MAX_ATTACHMENT_BYTES) {
    errors.push(`${fieldPrefix}.byteLength exceeds the attachment limit`);
    return undefined;
  }
  return entry.byteLength;
}

function parseAttachment(
  entry: unknown,
  index: number,
  errors: string[],
): FeedbackAttachmentSummary | undefined {
  const fieldPrefix = `attachments[${String(index)}]`;
  if (!isRecord(entry)) {
    errors.push(`${fieldPrefix} must be an object`);
    return undefined;
  }
  const name = boundedString(entry.name, `${fieldPrefix}.name`, 160, errors, true);
  const mediaType = boundedString(entry.mediaType, `${fieldPrefix}.mediaType`, 120, errors, true);
  const textPreview = boundedString(
    entry.textPreview,
    `${fieldPrefix}.textPreview`,
    MAX_ATTACHMENT_TEXT_CHARS,
    errors,
  );
  const byteLength = parseAttachmentByteLength(entry, fieldPrefix, errors);
  if (name === undefined || mediaType === undefined || byteLength === undefined) return undefined;
  return {
    name,
    mediaType,
    byteLength,
    ...(textPreview === undefined ? {} : { textPreview }),
  };
}

function parseAttachmentList(
  value: unknown,
  errors: string[],
): readonly FeedbackAttachmentSummary[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push("attachments must be an array");
    return undefined;
  }
  if (value.length > MAX_ATTACHMENTS) {
    errors.push(`attachments must contain at most ${String(MAX_ATTACHMENTS)} entries`);
    return undefined;
  }
  const attachments: FeedbackAttachmentSummary[] = [];
  for (const [index, entry] of value.entries()) {
    const attachment = parseAttachment(entry, index, errors);
    if (attachment !== undefined) attachments.push(attachment);
  }
  return attachments.length === 0 ? undefined : attachments;
}

function parseCategory(value: unknown, errors: string[]): FeedbackReportCategory | undefined {
  if (isCategory(value)) return value;
  errors.push("category must be a known feedback category");
  return undefined;
}

function parseSeverity(value: unknown, errors: string[]): FeedbackReportSeverity | undefined {
  if (isSeverity(value)) return value;
  errors.push("severity must be a known feedback severity");
  return undefined;
}

interface ParsedDraftFields {
  readonly category: FeedbackReportCategory | undefined;
  readonly severity: FeedbackReportSeverity | undefined;
  readonly title: string | undefined;
  readonly description: string | undefined;
  readonly reproductionSteps: readonly string[] | undefined;
  readonly expectedBehavior: string | undefined;
  readonly actualBehavior: string | undefined;
  readonly featureArea: string | undefined;
  readonly diagnostics: FeedbackDiagnostics | undefined;
  readonly attachments: readonly FeedbackAttachmentSummary[] | undefined;
}

interface CompleteDraftFields extends ParsedDraftFields {
  readonly category: FeedbackReportCategory;
  readonly severity: FeedbackReportSeverity;
  readonly title: string;
  readonly description: string;
}

function hasCompleteDraftFields(fields: ParsedDraftFields): fields is CompleteDraftFields {
  return (
    fields.category !== undefined &&
    fields.severity !== undefined &&
    fields.title !== undefined &&
    fields.description !== undefined
  );
}

function buildParsedDraft(fields: CompleteDraftFields): FeedbackReportDraft {
  return {
    category: fields.category,
    severity: fields.severity,
    title: fields.title,
    description: fields.description,
    ...(fields.reproductionSteps === undefined
      ? {}
      : { reproductionSteps: fields.reproductionSteps }),
    ...(fields.expectedBehavior === undefined ? {} : { expectedBehavior: fields.expectedBehavior }),
    ...(fields.actualBehavior === undefined ? {} : { actualBehavior: fields.actualBehavior }),
    ...(fields.featureArea === undefined ? {} : { featureArea: fields.featureArea }),
    ...(fields.diagnostics === undefined ? {} : { diagnostics: fields.diagnostics }),
    ...(fields.attachments === undefined ? {} : { attachments: fields.attachments }),
  };
}

export function parseFeedbackReportDraft(input: unknown): FeedbackReportParse {
  if (!isRecord(input)) return { ok: false, errors: ["request must be an object"] };
  const errors: string[] = [];
  const fields: ParsedDraftFields = {
    category: parseCategory(input.category, errors),
    severity: parseSeverity(input.severity, errors),
    title: boundedString(input.title, "title", MAX_TITLE_CHARS, errors, true),
    description: boundedString(input.description, "description", MAX_TEXT_CHARS, errors, true),
    reproductionSteps: parseSteps(input.reproductionSteps, errors),
    expectedBehavior: boundedString(
      input.expectedBehavior,
      "expectedBehavior",
      MAX_TEXT_CHARS,
      errors,
    ),
    actualBehavior: boundedString(input.actualBehavior, "actualBehavior", MAX_TEXT_CHARS, errors),
    featureArea: boundedString(input.featureArea, "featureArea", 120, errors),
    diagnostics: parseDiagnostics(input.diagnostics, errors),
    attachments: parseAttachmentList(input.attachments, errors),
  };
  if (errors.length > 0 || !hasCompleteDraftFields(fields)) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: buildParsedDraft(fields),
  };
}

function redactField(
  value: string | undefined,
  field: string,
  redactString: (input: string) => string,
  redactedFields: string[],
): string | undefined {
  if (value === undefined) return undefined;
  const redacted = redactString(value);
  if (redacted !== value) redactedFields.push(field);
  return redacted;
}

function redactDiagnostics(
  value: FeedbackDiagnostics | undefined,
  redactString: (input: string) => string,
  redactedFields: string[],
): FeedbackDiagnostics | undefined {
  if (value === undefined) return undefined;
  return {
    keikoVersion:
      redactField(value.keikoVersion, "diagnostics.keikoVersion", redactString, redactedFields) ??
      "",
    platform:
      redactField(value.platform, "diagnostics.platform", redactString, redactedFields) ?? "",
    ...(value.os === undefined
      ? {}
      : { os: redactField(value.os, "diagnostics.os", redactString, redactedFields) }),
    ...(value.uiMode === undefined
      ? {}
      : { uiMode: redactField(value.uiMode, "diagnostics.uiMode", redactString, redactedFields) }),
    ...(value.featureArea === undefined
      ? {}
      : {
          featureArea: redactField(
            value.featureArea,
            "diagnostics.featureArea",
            redactString,
            redactedFields,
          ),
        }),
  };
}

function redactAttachments(
  value: readonly FeedbackAttachmentSummary[] | undefined,
  redactString: (input: string) => string,
  redactedFields: string[],
): readonly FeedbackAttachmentSummary[] | undefined {
  if (value === undefined) return undefined;
  return value.map((attachment, index) => ({
    name:
      redactField(
        attachment.name,
        `attachments[${String(index)}].name`,
        redactString,
        redactedFields,
      ) ?? "",
    mediaType: attachment.mediaType,
    byteLength: attachment.byteLength,
    ...(attachment.textPreview === undefined
      ? {}
      : {
          textPreview: redactField(
            attachment.textPreview,
            `attachments[${String(index)}].textPreview`,
            redactString,
            redactedFields,
          ),
        }),
  }));
}

function redactSteps(
  steps: readonly string[] | undefined,
  redactString: (input: string) => string,
  redactedFields: string[],
): Pick<FeedbackReportDraft, "reproductionSteps"> {
  if (steps === undefined) return {};
  return {
    reproductionSteps: steps.map(
      (step, index) =>
        redactField(step, `reproductionSteps[${String(index)}]`, redactString, redactedFields) ??
        "",
    ),
  };
}

function redactOptionalTextFields(
  draft: FeedbackReportDraft,
  redactString: (input: string) => string,
  redactedFields: string[],
): Pick<FeedbackReportDraft, "expectedBehavior" | "actualBehavior" | "featureArea"> {
  return {
    ...(draft.expectedBehavior === undefined
      ? {}
      : {
          expectedBehavior: redactField(
            draft.expectedBehavior,
            "expectedBehavior",
            redactString,
            redactedFields,
          ),
        }),
    ...(draft.actualBehavior === undefined
      ? {}
      : {
          actualBehavior: redactField(
            draft.actualBehavior,
            "actualBehavior",
            redactString,
            redactedFields,
          ),
        }),
    ...(draft.featureArea === undefined
      ? {}
      : {
          featureArea: redactField(draft.featureArea, "featureArea", redactString, redactedFields),
        }),
  };
}

export function buildFeedbackReportPreview(
  draft: FeedbackReportDraft,
  redactString: (input: string) => string,
): FeedbackReportPreview {
  const redactedFields: string[] = [];
  const omittedFields: string[] = [];
  const report = redactReport(draft, redactString, redactedFields);
  const payloadByteLength = Buffer.byteLength(JSON.stringify(report), "utf8");
  const blockedReasons =
    payloadByteLength > MAX_TOTAL_PAYLOAD_BYTES
      ? (["payload-too-large"] satisfies readonly FeedbackIntakeRejectionReason[])
      : [];
  return {
    schemaVersion: FEEDBACK_INTAKE_SCHEMA_VERSION,
    report,
    provenance: {
      engine: "keiko-feedback-redaction",
      schemaVersion: FEEDBACK_INTAKE_SCHEMA_VERSION,
      redactedFields,
      omittedFields,
      blockedReasons,
    },
    payloadByteLength,
    safeToSubmit: blockedReasons.length === 0,
  };
}

function redactReport(
  draft: FeedbackReportDraft,
  redactString: (input: string) => string,
  redactedFields: string[],
): FeedbackReportDraft {
  const report: FeedbackReportDraft = {
    category: draft.category,
    severity: draft.severity,
    title: redactField(draft.title, "title", redactString, redactedFields) ?? "",
    description: redactField(draft.description, "description", redactString, redactedFields) ?? "",
    ...redactSteps(draft.reproductionSteps, redactString, redactedFields),
    ...redactOptionalTextFields(draft, redactString, redactedFields),
    ...(draft.diagnostics === undefined
      ? {}
      : { diagnostics: redactDiagnostics(draft.diagnostics, redactString, redactedFields) }),
    ...(draft.attachments === undefined
      ? {}
      : { attachments: redactAttachments(draft.attachments, redactString, redactedFields) }),
  };
  return report;
}

export function feedbackPreviewHasRedactionProvenance(
  value: unknown,
): value is FeedbackReportPreview {
  return (
    isRecord(value) &&
    value.schemaVersion === FEEDBACK_INTAKE_SCHEMA_VERSION &&
    isRecord(value.provenance) &&
    value.provenance.engine === "keiko-feedback-redaction" &&
    value.provenance.schemaVersion === FEEDBACK_INTAKE_SCHEMA_VERSION &&
    Array.isArray(value.provenance.redactedFields) &&
    Array.isArray(value.provenance.omittedFields) &&
    Array.isArray(value.provenance.blockedReasons)
  );
}

export function feedbackReviewStatusAfter(
  current: FeedbackIntakeStatus,
  action: FeedbackReviewAction,
): FeedbackIntakeStatus | undefined {
  if (current === "github-created") return undefined;
  if (current === "archived") return undefined;
  switch (action) {
    case "mark-duplicate":
      return "duplicate";
    case "reject":
      return "rejected";
    case "request-follow-up":
      return "follow-up-requested";
    case "approve-for-github":
      return "approved-for-github";
    case "archive":
      return "archived";
  }
}

export function buildFeedbackGithubIssueDraft(item: FeedbackIntakeItem): FeedbackGithubIssueDraft {
  const labels = [
    "feedback",
    `feedback:${item.report.category}`,
    `severity:${item.report.severity}`,
  ];
  const lines = [
    "## Summary",
    item.report.description,
    "",
    "## Category",
    item.report.category,
    "",
    "## Severity",
    item.report.severity,
  ];
  if (item.report.reproductionSteps !== undefined) {
    lines.push("", "## Reproduction Steps");
    for (const [index, step] of item.report.reproductionSteps.entries()) {
      lines.push(`${String(index + 1)}. ${step}`);
    }
  }
  if (item.report.expectedBehavior !== undefined) {
    lines.push("", "## Expected Behavior", item.report.expectedBehavior);
  }
  if (item.report.actualBehavior !== undefined) {
    lines.push("", "## Actual Behavior", item.report.actualBehavior);
  }
  if (item.report.diagnostics !== undefined) {
    lines.push(
      "",
      "## Redacted Diagnostics",
      "```json",
      JSON.stringify(item.report.diagnostics, null, 2),
      "```",
    );
  }
  lines.push("", "## Intake", `Redacted intake receipt: ${item.receipt.intakeId}`);
  return {
    title: item.report.title,
    body: lines.join("\n"),
    labels,
  };
}

export function containsRedactedSentinel(preview: FeedbackReportPreview): boolean {
  return JSON.stringify(preview.report).includes(REDACTED_SENTINEL);
}
