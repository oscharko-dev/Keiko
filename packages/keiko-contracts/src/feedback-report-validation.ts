import {
  containsAbsolutePath,
  containsControlOtherThanTabOrLf,
  isUnicodeScalarString,
  stripUnsafeFormatChars,
} from "./text-safety.js";
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_FEATURE_AREAS,
  FEEDBACK_IMPACTS,
  FEEDBACK_PLATFORMS,
  FEEDBACK_PRIVACY_CONTRACT_VERSION,
  FEEDBACK_REDACTION_ENGINE_VERSION,
  FEEDBACK_REDACTION_RULE_CODES,
  FEEDBACK_REPORT_LIMITS,
  FEEDBACK_REPORT_SUMMARY_DISPLAY_SEPARATOR_V1,
  FEEDBACK_REPORT_SCHEMA_VERSION,
  type FeedbackReportErrorCode,
  type FeedbackReportDraftParse,
  type FeedbackReportDraftV1,
  type FeedbackReportField,
  type FeedbackReportParse,
  type FeedbackReportV1,
} from "./feedback-report-contract.js";
import {
  snapshotFeedbackDraftInput,
  snapshotFeedbackReportInput,
} from "./feedback-report-input.js";

const TEXT_ENCODER = new TextEncoder();
type FeedbackReportFailure = Extract<FeedbackReportParse, { readonly ok: false }>;

function fail(code: FeedbackReportErrorCode, field: FeedbackReportField): FeedbackReportFailure {
  return { ok: false, errors: [{ code, field }] };
}

function isMember<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function textContentError(
  value: string,
  field: FeedbackReportField,
  maxBytes: number,
): FeedbackReportFailure | undefined {
  if (!isUnicodeScalarString(value)) return fail("invalid-unicode-scalar", field);
  if (containsControlOtherThanTabOrLf(value)) return fail("unsafe-control", field);
  if (stripUnsafeFormatChars(value) !== value) return fail("unsafe-format-character", field);
  if (containsAbsolutePath(value)) return fail("residual-absolute-path", field);
  if (TEXT_ENCODER.encode(value).length > maxBytes) return fail("field-byte-limit", field);
  return undefined;
}

function textError(
  value: unknown,
  field: FeedbackReportField,
  maxBytes: number,
  required: boolean,
): FeedbackReportFailure | undefined {
  if (value === undefined) return required ? fail("required-field", field) : undefined;
  if (typeof value !== "string") return fail("invalid-type", field);
  if (required && value.trim().length === 0) return fail("required-field", field);
  return textContentError(value, field, maxBytes);
}

function validateRule(value: unknown): FeedbackReportFailure | undefined {
  const rule = value as Readonly<Record<string, unknown>>;
  if (!isMember(rule.code, FEEDBACK_REDACTION_RULE_CODES)) {
    return fail("invalid-enum", "redactionProvenance");
  }
  if (
    !Number.isSafeInteger(rule.count) ||
    Number(rule.count) <= 0 ||
    Number(rule.count) > FEEDBACK_REPORT_LIMITS.canonicalBodyBytes
  ) {
    return fail("invalid-count", "redactionProvenance");
  }
  return undefined;
}

function validateProvenance(value: unknown): FeedbackReportFailure | undefined {
  const provenance = value as Readonly<Record<string, unknown>>;
  if (provenance.engineVersion !== FEEDBACK_REDACTION_ENGINE_VERSION) {
    return fail("unsupported-version", "redactionProvenance");
  }
  if (
    !Array.isArray(provenance.rules) ||
    provenance.rules.length > FEEDBACK_REDACTION_RULE_CODES.length
  ) {
    return fail("invalid-shape", "redactionProvenance");
  }
  const seen = new Set<string>();
  let previousCodeIndex = -1;
  for (const rule of provenance.rules) {
    const error = validateRule(rule);
    if (error !== undefined) return error;
    const code = (rule as Readonly<Record<string, unknown>>).code as string;
    if (seen.has(code)) return fail("invalid-shape", "redactionProvenance");
    const codeIndex = (FEEDBACK_REDACTION_RULE_CODES as readonly string[]).indexOf(code);
    if (codeIndex <= previousCodeIndex) return fail("invalid-shape", "redactionProvenance");
    seen.add(code);
    previousCodeIndex = codeIndex;
  }
  return undefined;
}

function validCount(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= FEEDBACK_REPORT_LIMITS.diagnosticCount
  );
}

function validateSeverityCounts(value: unknown): FeedbackReportFailure | undefined {
  if (value === undefined) return undefined;
  const counts = value as Readonly<Record<string, unknown>>;
  return [counts.errors, counts.warnings, counts.infos].every(validCount)
    ? undefined
    : fail("invalid-count", "diagnostics");
}

function validateDiagnostics(value: unknown): FeedbackReportFailure | undefined {
  const diagnostics = value as Readonly<Record<string, unknown>>;
  if (!isMember(diagnostics.category, FEEDBACK_CATEGORIES)) {
    return fail("invalid-enum", "diagnostics");
  }
  if (!isMember(diagnostics.featureArea, FEEDBACK_FEATURE_AREAS)) {
    return fail("invalid-enum", "diagnostics");
  }
  const countsError = validateSeverityCounts(diagnostics.severityCounts);
  if (countsError !== undefined) return countsError;
  return TEXT_ENCODER.encode(JSON.stringify(diagnostics)).length >
    FEEDBACK_REPORT_LIMITS.diagnosticsBytes
    ? fail("field-byte-limit", "diagnostics")
    : undefined;
}

function validateAttachments(value: unknown): FeedbackReportFailure | undefined {
  if (value === undefined) return undefined;
  const attachments = value as readonly unknown[];
  if (attachments.some((entry) => typeof entry !== "string")) {
    return fail("invalid-type", "attachments");
  }
  if (attachments.length > FEEDBACK_REPORT_LIMITS.attachmentCount) {
    return fail("attachment-count-limit", "attachments");
  }
  let aggregate = 0;
  for (const attachment of attachments as readonly string[]) {
    const error = textError(
      attachment,
      "attachments",
      FEEDBACK_REPORT_LIMITS.attachmentBytes,
      false,
    );
    if (error !== undefined) return error;
    aggregate += TEXT_ENCODER.encode(attachment).length;
  }
  return aggregate > FEEDBACK_REPORT_LIMITS.attachmentAggregateBytes
    ? fail("attachment-aggregate-byte-limit", "attachments")
    : undefined;
}

function validateEnums(
  value: Readonly<Record<string, unknown>>,
): FeedbackReportFailure | undefined {
  if (value.schemaVersion !== FEEDBACK_REPORT_SCHEMA_VERSION) {
    return fail("unsupported-version", "schemaVersion");
  }
  if (value.privacyContractVersion !== FEEDBACK_PRIVACY_CONTRACT_VERSION) {
    return fail("unsupported-version", "privacyContractVersion");
  }
  if (!isMember(value.platform, FEEDBACK_PLATFORMS)) return fail("invalid-enum", "platform");
  return isMember(value.impact, FEEDBACK_IMPACTS) ? undefined : fail("invalid-enum", "impact");
}

const REPORT_TEXT_FIELDS = [
  ["productVersion", FEEDBACK_REPORT_LIMITS.productVersionBytes, true],
  ["browserDescription", FEEDBACK_REPORT_LIMITS.browserDescriptionBytes, false],
  ["steps", FEEDBACK_REPORT_LIMITS.stepsBytes, true],
  ["expectedResult", FEEDBACK_REPORT_LIMITS.expectedResultBytes, true],
  ["actualResult", FEEDBACK_REPORT_LIMITS.actualResultBytes, true],
  ["handwrittenEvidence", FEEDBACK_REPORT_LIMITS.handwrittenEvidenceBytes, false],
] as const;

function validateSummary(value: unknown): FeedbackReportFailure | undefined {
  if (value === undefined) return fail("required-field", "summary");
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("invalid-type", "summary");
  }
  const summary = value as Readonly<Record<string, unknown>>;
  const titleError = textError(
    summary.title,
    "summary.title",
    FEEDBACK_REPORT_LIMITS.summaryBytes,
    true,
  );
  if (titleError !== undefined) return titleError;
  const descriptionError = textError(
    summary.description,
    "summary.description",
    FEEDBACK_REPORT_LIMITS.summaryBytes,
    true,
  );
  if (descriptionError !== undefined) return descriptionError;
  const combined = `${String(summary.title)}${FEEDBACK_REPORT_SUMMARY_DISPLAY_SEPARATOR_V1}${String(
    summary.description,
  )}`;
  return TEXT_ENCODER.encode(combined).length > FEEDBACK_REPORT_LIMITS.summaryBytes
    ? fail("field-byte-limit", "summary")
    : undefined;
}

function validateFields(
  value: Readonly<Record<string, unknown>>,
): FeedbackReportFailure | undefined {
  const earlyError = validateEnums(value) ?? validateProvenance(value.redactionProvenance);
  if (earlyError !== undefined) return earlyError;
  const summaryError = validateSummary(value.summary);
  if (summaryError !== undefined) return summaryError;
  for (const [field, limit, required] of REPORT_TEXT_FIELDS) {
    const error = textError(value[field], field, limit, required);
    if (error !== undefined) return error;
  }
  return validateAttachments(value.attachments) ?? validateDiagnostics(value.diagnostics);
}

export function parseFeedbackReportV1(value: unknown): FeedbackReportParse {
  try {
    const snapshot = snapshotFeedbackReportInput(value);
    if (!snapshot.ok) return fail(snapshot.code, snapshot.field);
    const fieldError = validateFields(snapshot.value);
    if (fieldError !== undefined) return fieldError;
    if (
      TEXT_ENCODER.encode(JSON.stringify(snapshot.value)).length >
      FEEDBACK_REPORT_LIMITS.canonicalBodyBytes
    ) {
      return fail("canonical-body-byte-limit", "report");
    }
    return { ok: true, value: snapshot.value as unknown as FeedbackReportV1 };
  } catch {
    return fail("invalid-shape", "report");
  }
}

function draftTextTypeError(
  value: Readonly<Record<string, unknown>>,
): FeedbackReportFailure | undefined {
  const fields = [
    ["title", "summary.title"],
    ["description", "summary.description"],
    ["reproductionSteps", "steps"],
    ["expectedBehavior", "expectedResult"],
    ["actualBehavior", "actualResult"],
    ["productVersion", "productVersion"],
  ] as const;
  for (const [key, field] of fields) {
    if (value[key] === undefined) return fail("required-field", field);
    if (typeof value[key] !== "string") return fail("invalid-type", field);
  }
  if (value.browserDescription !== undefined && typeof value.browserDescription !== "string") {
    return fail("invalid-type", "browserDescription");
  }
  if (value.handwrittenEvidence !== undefined && typeof value.handwrittenEvidence !== "string") {
    return fail("invalid-type", "handwrittenEvidence");
  }
  return undefined;
}

function draftEnumError(
  value: Readonly<Record<string, unknown>>,
): FeedbackReportFailure | undefined {
  if (value.schemaVersion !== FEEDBACK_REPORT_SCHEMA_VERSION) {
    return fail("unsupported-version", "schemaVersion");
  }
  if (!isMember(value.category, FEEDBACK_CATEGORIES)) return fail("invalid-enum", "diagnostics");
  if (!isMember(value.featureArea, FEEDBACK_FEATURE_AREAS)) {
    return fail("invalid-enum", "diagnostics");
  }
  if (!isMember(value.platform, FEEDBACK_PLATFORMS)) return fail("invalid-enum", "platform");
  return isMember(value.impact, FEEDBACK_IMPACTS) ? undefined : fail("invalid-enum", "impact");
}

function exceedsUtf8ByteLimit(value: string, limit: number): boolean {
  if (value.length > limit) return true;
  return TEXT_ENCODER.encode(value).length > limit;
}

function attachmentMetadataError(value: unknown, limit: number): FeedbackReportFailure | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return fail("invalid-type", "attachments");
  return exceedsUtf8ByteLimit(value, limit) ? fail("field-byte-limit", "attachments") : undefined;
}

function attachmentCandidateError(value: unknown): FeedbackReportFailure | undefined {
  const candidate = value as Readonly<Record<string, unknown>>;
  if (!(candidate.bytes instanceof Uint8Array)) return fail("invalid-type", "attachments");
  return (
    attachmentMetadataError(
      candidate.declaredMediaType,
      FEEDBACK_REPORT_LIMITS.attachmentMediaTypeBytes,
    ) ??
    attachmentMetadataError(candidate.extension, FEEDBACK_REPORT_LIMITS.attachmentExtensionBytes)
  );
}

function draftAttachmentsError(value: unknown): FeedbackReportFailure | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return fail("invalid-type", "attachments");
  if (value.length > FEEDBACK_REPORT_LIMITS.attachmentCount) {
    return fail("attachment-count-limit", "attachments");
  }
  for (const candidate of value) {
    const error = attachmentCandidateError(candidate);
    if (error !== undefined) return error;
  }
  return undefined;
}

export function parseFeedbackReportDraftV1(value: unknown): FeedbackReportDraftParse {
  try {
    const snapshot = snapshotFeedbackDraftInput(value);
    if (!snapshot.ok) return fail(snapshot.code, snapshot.field);
    const error =
      draftEnumError(snapshot.value) ??
      draftTextTypeError(snapshot.value) ??
      validateSeverityCounts(snapshot.value.diagnostics) ??
      draftAttachmentsError(snapshot.value.attachments);
    if (error !== undefined) return error;
    return { ok: true, value: snapshot.value as unknown as FeedbackReportDraftV1 };
  } catch {
    return fail("invalid-shape", "report");
  }
}
