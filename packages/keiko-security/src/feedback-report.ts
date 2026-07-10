import {
  FEEDBACK_PRIVACY_CONTRACT_VERSION,
  FEEDBACK_REDACTION_ENGINE_VERSION,
  FEEDBACK_REDACTION_RULE_CODES,
  FEEDBACK_REPORT_LIMITS,
  FEEDBACK_REPORT_SUMMARY_DISPLAY_SEPARATOR_V1,
  FEEDBACK_REPORT_SCHEMA_VERSION,
  parseFeedbackReportDraftV1,
  parseFeedbackReportV1,
  type FeedbackDispositionRecordV1,
  type FeedbackDispositionTargetV1,
  type FeedbackDraftFieldIdV1,
  type FeedbackRedactionRuleCode,
  type FeedbackRedactionRuleCountV1,
  type FeedbackReportDraftV1,
  type FeedbackReportPreparationError,
  type FeedbackReportSummaryV1,
  type FeedbackReportV1,
} from "@oscharko-dev/keiko-contracts/feedback-report";

import { prepareFeedbackText, type FeedbackTextResult } from "./feedback-report-text.js";
import { prepareFeedbackAttachments } from "./feedback-report-attachment.js";
import {
  immutablePreparedFeedbackReportV1,
  type PreparedFeedbackReportV1,
} from "./feedback-report-body.js";
import {
  EMPTY_FEEDBACK_REPORT_REDACTION_POLICY_V1,
  parseFeedbackReportRedactionPolicyV1,
  type FeedbackReportRedactionPolicyV1,
} from "./feedback-report-policy.js";
import { canonicalFeedbackReportParityError } from "./feedback-report-parity.js";
import { canonicalise, sha256Hex } from "./hashing.js";

export type PrepareFeedbackReportResultV1 =
  | { readonly ok: true; readonly value: PreparedFeedbackReportV1 }
  | { readonly ok: false; readonly errors: readonly FeedbackReportPreparationError[] };

type MutableRuleCounts = Partial<Record<FeedbackRedactionRuleCode, number>>;
type FeedbackTextFailure = Extract<FeedbackTextResult, { readonly ok: false }>;
const TEXT_ENCODER = new TextEncoder();

function addCount(counts: MutableRuleCounts, code: FeedbackRedactionRuleCode, count: number): void {
  if (count > 0) counts[code] = (counts[code] ?? 0) + count;
}

function track(
  result: FeedbackTextResult,
  counts: MutableRuleCounts,
  records: FeedbackDispositionRecordV1[],
  target: FeedbackDispositionTargetV1,
): FeedbackTextResult {
  if (result.ok) {
    for (const rule of result.rules) addCount(counts, rule.code, rule.count);
    records.push(...result.dispositions.map((disposition) => ({ ...disposition, target })));
  }
  return result;
}

function provenanceRules(counts: MutableRuleCounts): readonly FeedbackRedactionRuleCountV1[] {
  return FEEDBACK_REDACTION_RULE_CODES.flatMap((code) =>
    counts[code] === undefined ? [] : [{ code, count: counts[code] }],
  );
}

type ProjectReportResult =
  | {
      readonly ok: true;
      readonly value: FeedbackReportV1;
      readonly dispositions: readonly FeedbackDispositionRecordV1[];
    }
  | { readonly ok: false; readonly error: FeedbackReportPreparationError };

function draftTarget(field: FeedbackDraftFieldIdV1): FeedbackDispositionTargetV1 {
  return { kind: "draft-field", field };
}

function prepareTrackedDraftText(
  input: string,
  field: Parameters<typeof prepareFeedbackText>[1],
  source: FeedbackDraftFieldIdV1,
  limit: number,
  required: boolean,
  policy: FeedbackReportRedactionPolicyV1,
  counts: MutableRuleCounts,
  records: FeedbackDispositionRecordV1[],
  emptyUnitKind?: "optional-field",
): FeedbackTextResult {
  const target = draftTarget(source);
  return track(
    prepareFeedbackText(input, field, limit, required, policy, target, emptyUnitKind),
    counts,
    records,
    target,
  );
}

type PreparedSummaryResult =
  { readonly ok: true; readonly value: FeedbackReportSummaryV1 } | FeedbackTextFailure;

function summaryExceedsCombinedLimit(title: string, description: string): boolean {
  if (
    title.length + FEEDBACK_REPORT_SUMMARY_DISPLAY_SEPARATOR_V1.length + description.length >
    FEEDBACK_REPORT_LIMITS.summaryBytes
  ) {
    return true;
  }
  const display = `${title}${FEEDBACK_REPORT_SUMMARY_DISPLAY_SEPARATOR_V1}${description}`;
  return TEXT_ENCODER.encode(display).length > FEEDBACK_REPORT_LIMITS.summaryBytes;
}

function summaryFieldExceedsLimit(value: string): boolean {
  if (value.length > FEEDBACK_REPORT_LIMITS.summaryBytes) return true;
  return TEXT_ENCODER.encode(value).length > FEEDBACK_REPORT_LIMITS.summaryBytes;
}

function prepareSummary(
  draft: FeedbackReportDraftV1,
  counts: MutableRuleCounts,
  records: FeedbackDispositionRecordV1[],
  policy: FeedbackReportRedactionPolicyV1,
): PreparedSummaryResult {
  if (summaryFieldExceedsLimit(draft.title)) {
    return { ok: false, error: { code: "field-byte-limit", field: "summary.title" } };
  }
  if (summaryFieldExceedsLimit(draft.description)) {
    return { ok: false, error: { code: "field-byte-limit", field: "summary.description" } };
  }
  if (summaryExceedsCombinedLimit(draft.title, draft.description)) {
    return { ok: false, error: { code: "field-byte-limit", field: "summary" } };
  }
  const title = prepareTrackedDraftText(
    draft.title,
    "summary.title",
    "title",
    FEEDBACK_REPORT_LIMITS.summaryBytes,
    true,
    policy,
    counts,
    records,
  );
  if (!title.ok) return title;
  const description = prepareTrackedDraftText(
    draft.description,
    "summary.description",
    "description",
    FEEDBACK_REPORT_LIMITS.summaryBytes,
    true,
    policy,
    counts,
    records,
  );
  if (!description.ok) return description;
  if (summaryExceedsCombinedLimit(title.value, description.value)) {
    return { ok: false, error: { code: "field-byte-limit", field: "summary" } };
  }
  return { ok: true, value: { title: title.value, description: description.value } };
}

function prepareRequiredText(
  draft: FeedbackReportDraftV1,
  counts: MutableRuleCounts,
  records: FeedbackDispositionRecordV1[],
  policy: FeedbackReportRedactionPolicyV1,
):
  | { readonly ok: true; readonly value: readonly [string, string, string, string] }
  | FeedbackTextFailure {
  const fields = [
    [
      draft.productVersion,
      "productVersion",
      "productVersion",
      FEEDBACK_REPORT_LIMITS.productVersionBytes,
    ],
    [draft.reproductionSteps, "steps", "reproductionSteps", FEEDBACK_REPORT_LIMITS.stepsBytes],
    [
      draft.expectedBehavior,
      "expectedResult",
      "expectedBehavior",
      FEEDBACK_REPORT_LIMITS.expectedResultBytes,
    ],
    [
      draft.actualBehavior,
      "actualResult",
      "actualBehavior",
      FEEDBACK_REPORT_LIMITS.actualResultBytes,
    ],
  ] as const;
  const values: string[] = [];
  for (const [input, field, source, limit] of fields) {
    const result = prepareTrackedDraftText(
      input,
      field,
      source,
      limit,
      true,
      policy,
      counts,
      records,
    );
    if (!result.ok) return result;
    values.push(result.value);
  }
  return { ok: true, value: values as [string, string, string, string] };
}

function prepareOptionalDraftText(
  input: string | undefined,
  field: "browserDescription" | "handwrittenEvidence",
  source: "browserDescription" | "handwrittenEvidence",
  limit: number,
  policy: FeedbackReportRedactionPolicyV1,
  counts: MutableRuleCounts,
  records: FeedbackDispositionRecordV1[],
): FeedbackTextResult | undefined {
  if (input === undefined) return undefined;
  return prepareTrackedDraftText(
    input,
    field,
    source,
    limit,
    false,
    policy,
    counts,
    records,
    "optional-field",
  );
}

function nonEmptyPreparedValue(result: FeedbackTextResult | undefined): string | undefined {
  if (result === undefined || !result.ok || result.value.trim().length === 0) return undefined;
  return result.value;
}

function prepareOptionalText(
  draft: FeedbackReportDraftV1,
  counts: MutableRuleCounts,
  records: FeedbackDispositionRecordV1[],
  policy: FeedbackReportRedactionPolicyV1,
):
  | { readonly ok: true; readonly browser?: string; readonly evidence?: string }
  | FeedbackTextFailure {
  const browser = prepareOptionalDraftText(
    draft.browserDescription,
    "browserDescription",
    "browserDescription",
    FEEDBACK_REPORT_LIMITS.browserDescriptionBytes,
    policy,
    counts,
    records,
  );
  if (browser !== undefined && !browser.ok) return browser;
  const evidence = prepareOptionalDraftText(
    draft.handwrittenEvidence,
    "handwrittenEvidence",
    "handwrittenEvidence",
    FEEDBACK_REPORT_LIMITS.handwrittenEvidenceBytes,
    policy,
    counts,
    records,
  );
  if (evidence !== undefined && !evidence.ok) return evidence;
  const browserValue = nonEmptyPreparedValue(browser);
  const evidenceValue = nonEmptyPreparedValue(evidence);
  return {
    ok: true,
    ...(browserValue === undefined ? {} : { browser: browserValue }),
    ...(evidenceValue === undefined ? {} : { evidence: evidenceValue }),
  };
}

function prepareAttachments(
  draft: FeedbackReportDraftV1,
  counts: MutableRuleCounts,
  records: FeedbackDispositionRecordV1[],
  policy: FeedbackReportRedactionPolicyV1,
): { readonly ok: true; readonly value?: readonly string[] } | FeedbackTextFailure {
  const result = prepareFeedbackAttachments(draft.attachments, policy);
  if (!result.ok) return result;
  for (const rule of result.rules) addCount(counts, rule.code, rule.count);
  records.push(...result.dispositions);
  return result;
}

function projectReport(
  draft: FeedbackReportDraftV1,
  counts: MutableRuleCounts,
  policy: FeedbackReportRedactionPolicyV1,
): ProjectReportResult {
  const dispositions: FeedbackDispositionRecordV1[] = [];
  const summary = prepareSummary(draft, counts, dispositions, policy);
  if (!summary.ok) return { ok: false, error: summary.error };
  const required = prepareRequiredText(draft, counts, dispositions, policy);
  if (!required.ok) return { ok: false, error: required.error };
  const optional = prepareOptionalText(draft, counts, dispositions, policy);
  if (!optional.ok) return { ok: false, error: optional.error };
  const attachments = prepareAttachments(draft, counts, dispositions, policy);
  if (!attachments.ok) return { ok: false, error: attachments.error };
  const [productVersion, steps, expectedResult, actualResult] = required.value;
  return {
    ok: true,
    dispositions,
    value: {
      schemaVersion: FEEDBACK_REPORT_SCHEMA_VERSION,
      privacyContractVersion: FEEDBACK_PRIVACY_CONTRACT_VERSION,
      productVersion,
      platform: draft.platform,
      ...(optional.browser === undefined ? {} : { browserDescription: optional.browser }),
      summary: summary.value,
      steps,
      expectedResult,
      actualResult,
      impact: draft.impact,
      ...(optional.evidence === undefined ? {} : { handwrittenEvidence: optional.evidence }),
      ...(attachments.value === undefined ? {} : { attachments: attachments.value }),
      diagnostics: {
        category: draft.category,
        featureArea: draft.featureArea,
        ...(draft.diagnostics === undefined ? {} : { severityCounts: draft.diagnostics }),
      },
      redactionProvenance: {
        engineVersion: FEEDBACK_REDACTION_ENGINE_VERSION,
        rules: provenanceRules(counts),
      },
    },
  };
}

export function prepareFeedbackReportV1(
  input: unknown,
  policy: FeedbackReportRedactionPolicyV1 = EMPTY_FEEDBACK_REPORT_REDACTION_POLICY_V1,
): PrepareFeedbackReportResultV1 {
  try {
    const parsedPolicy = parseFeedbackReportRedactionPolicyV1(policy);
    if (!parsedPolicy.ok) return { ok: false, errors: [parsedPolicy.error] };
    const parsed = parseFeedbackReportDraftV1(input);
    if (!parsed.ok) return parsed;
    const draft = parsed.value;
    const counts: MutableRuleCounts = {};
    const projected = projectReport(draft, counts, parsedPolicy.value);
    if (!projected.ok) return { ok: false, errors: [projected.error] };
    const report = projected.value;
    const validated = parseFeedbackReportV1(report);
    if (!validated.ok) return validated;
    const canonicalJson = canonicalise(report);
    const canonicalBytes = TEXT_ENCODER.encode(canonicalJson);
    if (canonicalBytes.length > FEEDBACK_REPORT_LIMITS.canonicalBodyBytes) {
      return {
        ok: false,
        errors: [{ code: "canonical-body-byte-limit", field: "report" }],
      };
    }
    const exactBodySha256 = sha256Hex(canonicalJson);
    const parityError = canonicalFeedbackReportParityError(
      canonicalBytes,
      exactBodySha256,
      parsedPolicy.value,
    );
    if (parityError !== undefined) return { ok: false, errors: [parityError] };
    return {
      ok: true,
      value: immutablePreparedFeedbackReportV1(
        report,
        canonicalJson,
        canonicalBytes,
        exactBodySha256,
        projected.dispositions,
      ),
    };
  } catch {
    return { ok: false, errors: [{ code: "invalid-shape", field: "report" }] };
  }
}

export type { FeedbackCanonicalBodyV1, PreparedFeedbackReportV1 } from "./feedback-report-body.js";

export type {
  FeedbackReportRedactionPolicyParseV1,
  FeedbackReportRedactionPolicyV1,
} from "./feedback-report-policy.js";
export {
  FEEDBACK_REPORT_REDACTION_POLICY_LIMITS_V1,
  parseFeedbackReportRedactionPolicyV1,
} from "./feedback-report-policy.js";
export type {
  FeedbackCanonicalBodyErrorCodeV1,
  VerifyCanonicalFeedbackReportBodyInputV1,
  VerifyCanonicalFeedbackReportBodyResultV1,
} from "./feedback-report-verifier.js";
export {
  FEEDBACK_CANONICAL_BODY_ERROR_CODES_V1,
  verifyCanonicalFeedbackReportBodyV1,
} from "./feedback-report-verifier.js";
