export const FEEDBACK_REPORT_SCHEMA_VERSION = "1" as const;
export const FEEDBACK_PRIVACY_CONTRACT_VERSION = "1" as const;
export const FEEDBACK_REDACTION_ENGINE_VERSION = "1" as const;
export const FEEDBACK_ATTACHMENT_MAGIC_TABLE_VERSION = "1" as const;
export const FEEDBACK_REPORT_SUMMARY_DISPLAY_SEPARATOR_V1 = "\n\n" as const;

export const FEEDBACK_PLATFORMS = ["macOS", "Windows", "Linux", "Other"] as const;
export type FeedbackPlatform = (typeof FEEDBACK_PLATFORMS)[number];

export const FEEDBACK_IMPACTS = [
  "Blocks installation or startup",
  "Blocks model or credential setup",
  "Blocks core workflow",
  "Degrades core workflow",
  "Visual or usability issue",
  "Unknown",
] as const;
export type FeedbackImpact = (typeof FEEDBACK_IMPACTS)[number];

export const FEEDBACK_CATEGORIES = [
  "defect",
  "performance",
  "usability",
  "compatibility",
  "other",
] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export const FEEDBACK_FEATURE_AREAS = [
  "installation",
  "model-configuration",
  "conversation",
  "files",
  "editor",
  "terminal",
  "browser",
  "local-knowledge",
  "memory",
  "git-delivery",
  "updates",
  "voice",
  "other",
] as const;
export type FeedbackFeatureArea = (typeof FEEDBACK_FEATURE_AREAS)[number];

export const FEEDBACK_REDACTION_RULE_CODES = [
  "absolute-path",
  "authorization-secret",
  "credential-assignment",
  "credential-shape",
  "personal-identifier",
  "url-userinfo",
  "configured-literal",
] as const;
export type FeedbackRedactionRuleCode = (typeof FEEDBACK_REDACTION_RULE_CODES)[number];

export const FEEDBACK_DISPOSITION_ACTIONS_V1 = ["redacted", "quarantined", "omitted"] as const;
export type FeedbackDispositionActionV1 = (typeof FEEDBACK_DISPOSITION_ACTIONS_V1)[number];

export const FEEDBACK_DISPOSITION_REASONS_V1 = [
  "complete-sensitive-span",
  "ambiguous-credential-structure",
  "no-safe-optional-content",
] as const;
export type FeedbackDispositionReasonV1 = (typeof FEEDBACK_DISPOSITION_REASONS_V1)[number];

export const FEEDBACK_DISPOSITION_UNIT_KINDS_V1 = [
  "quoted-segment",
  "structured-value",
  "line-remainder",
  "optional-field",
  "attachment",
] as const;
export type FeedbackDispositionUnitKindV1 = (typeof FEEDBACK_DISPOSITION_UNIT_KINDS_V1)[number];

export const FEEDBACK_DRAFT_FIELD_IDS_V1 = [
  "title",
  "description",
  "reproductionSteps",
  "expectedBehavior",
  "actualBehavior",
  "productVersion",
  "browserDescription",
  "handwrittenEvidence",
] as const;
export type FeedbackDraftFieldIdV1 = (typeof FEEDBACK_DRAFT_FIELD_IDS_V1)[number];

export type FeedbackDispositionTargetV1 =
  | {
      readonly kind: "draft-field";
      readonly field: FeedbackDraftFieldIdV1;
    }
  | {
      readonly kind: "attachment";
      readonly ordinal: number;
    };

export interface FeedbackDispositionRecordV1 {
  readonly action: FeedbackDispositionActionV1;
  readonly reason: FeedbackDispositionReasonV1;
  readonly unitKind: FeedbackDispositionUnitKindV1;
  readonly target: FeedbackDispositionTargetV1;
}

export interface FeedbackDispositionSidecarV1 {
  readonly exactBodySha256: string;
  readonly records: readonly FeedbackDispositionRecordV1[];
}

export const FEEDBACK_REPORT_LIMITS = Object.freeze({
  productVersionBytes: 64,
  browserDescriptionBytes: 256,
  summaryBytes: 4 * 1024,
  stepsBytes: 32 * 1024,
  expectedResultBytes: 32 * 1024,
  actualResultBytes: 32 * 1024,
  handwrittenEvidenceBytes: 64 * 1024,
  diagnosticsBytes: 16 * 1024,
  attachmentCount: 3,
  attachmentBytes: 64 * 1024,
  attachmentAggregateBytes: 128 * 1024,
  attachmentMediaTypeBytes: 256,
  attachmentExtensionBytes: 64,
  canonicalBodyBytes: 256 * 1024,
  diagnosticCount: 1_000_000,
} as const);

export interface FeedbackSeverityCountsV1 {
  readonly errors: number;
  readonly warnings: number;
  readonly infos: number;
}

export interface FeedbackDiagnosticsV1 {
  readonly category: FeedbackCategory;
  readonly featureArea: FeedbackFeatureArea;
  readonly severityCounts?: FeedbackSeverityCountsV1 | undefined;
}

export interface FeedbackRedactionRuleCountV1 {
  readonly code: FeedbackRedactionRuleCode;
  /** Number of concrete matches replaced across all outbound fields. */
  readonly count: number;
}

export interface FeedbackRedactionProvenanceV1 {
  readonly engineVersion: typeof FEEDBACK_REDACTION_ENGINE_VERSION;
  readonly rules: readonly FeedbackRedactionRuleCountV1[];
}

export interface FeedbackReportSummaryV1 {
  readonly title: string;
  readonly description: string;
}

export interface FeedbackReportV1 {
  readonly schemaVersion: typeof FEEDBACK_REPORT_SCHEMA_VERSION;
  readonly privacyContractVersion: typeof FEEDBACK_PRIVACY_CONTRACT_VERSION;
  readonly redactionProvenance: FeedbackRedactionProvenanceV1;
  readonly productVersion: string;
  readonly platform: FeedbackPlatform;
  readonly browserDescription?: string | undefined;
  readonly summary: FeedbackReportSummaryV1;
  readonly steps: string;
  readonly expectedResult: string;
  readonly actualResult: string;
  readonly impact: FeedbackImpact;
  readonly handwrittenEvidence?: string | undefined;
  readonly attachments?: readonly string[] | undefined;
  readonly diagnostics: FeedbackDiagnosticsV1;
}

export interface FeedbackTextAttachmentCandidateV1 {
  readonly bytes: Uint8Array;
  readonly declaredMediaType?: string | undefined;
  readonly extension?: string | undefined;
}

export interface FeedbackReportDraftV1 {
  readonly schemaVersion: typeof FEEDBACK_REPORT_SCHEMA_VERSION;
  readonly category: FeedbackCategory;
  readonly title: string;
  readonly description: string;
  readonly reproductionSteps: string;
  readonly expectedBehavior: string;
  readonly actualBehavior: string;
  readonly productVersion: string;
  readonly platform: FeedbackPlatform;
  readonly featureArea: FeedbackFeatureArea;
  readonly browserDescription?: string | undefined;
  readonly impact: FeedbackImpact;
  readonly diagnostics?: FeedbackSeverityCountsV1 | undefined;
  readonly handwrittenEvidence?: string | undefined;
  readonly attachments?: readonly FeedbackTextAttachmentCandidateV1[] | undefined;
}

export type FeedbackReportField =
  | "report"
  | "schemaVersion"
  | "privacyContractVersion"
  | "redactionProvenance"
  | "productVersion"
  | "platform"
  | "browserDescription"
  | "summary"
  | "summary.title"
  | "summary.description"
  | "steps"
  | "expectedResult"
  | "actualResult"
  | "impact"
  | "handwrittenEvidence"
  | "attachments"
  | "diagnostics";

export type FeedbackReportErrorCode =
  | "invalid-shape"
  | "unknown-field"
  | "unsupported-version"
  | "required-field"
  | "invalid-type"
  | "invalid-enum"
  | "invalid-count"
  | "invalid-unicode-scalar"
  | "invalid-utf8"
  | "unsafe-control"
  | "unsafe-format-character"
  | "binary-signature"
  | "unsupported-media-type"
  | "unsupported-extension"
  | "raw-log-content"
  | "residual-sensitive-content"
  | "residual-absolute-path"
  | "field-byte-limit"
  | "attachment-count-limit"
  | "attachment-aggregate-byte-limit"
  | "canonical-body-byte-limit";

export interface FeedbackReportError {
  readonly code: FeedbackReportErrorCode;
  readonly field: FeedbackReportField;
}

export interface FeedbackReportRewriteError {
  readonly code: "rewrite-required";
  readonly target: FeedbackDispositionTargetV1;
}

export type FeedbackReportPreparationError = FeedbackReportError | FeedbackReportRewriteError;

export type FeedbackReportParse =
  | { readonly ok: true; readonly value: FeedbackReportV1 }
  | { readonly ok: false; readonly errors: readonly FeedbackReportError[] };

export type FeedbackReportDraftParse =
  | { readonly ok: true; readonly value: FeedbackReportDraftV1 }
  | { readonly ok: false; readonly errors: readonly FeedbackReportError[] };
