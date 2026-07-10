import {
  type FeedbackDispositionRecordV1,
  type FeedbackDispositionTargetV1,
  type FeedbackDispositionUnitKindV1,
  type FeedbackRedactionRuleCountV1,
  type FeedbackReportField,
  type FeedbackReportPreparationError,
} from "@oscharko-dev/keiko-contracts/feedback-report";
import {
  containsAbsolutePath,
  containsControlOtherThanTabOrLf,
  isUnicodeScalarString,
  redactAbsolutePathsWithCount,
  stripUnsafeFormatChars,
} from "@oscharko-dev/keiko-contracts/text-safety";

import { hasKnownFeedbackMagic } from "./feedback-report-magic.js";
import type { FeedbackReportRedactionPolicyV1 } from "./feedback-report-policy.js";
import {
  containsFeedbackCredentialDetection,
  sanitizeFeedbackCredentialSpans,
} from "./credential-spans.js";
import { redactNonCredentialWithRuleCounts } from "./redaction.js";
import {
  looksLikeEuDePii,
  scanFeedbackSensitiveText,
  type SensitiveTextSignal,
} from "./sensitive-text.js";

export type FeedbackTextResult =
  | {
      readonly ok: true;
      readonly value: string;
      readonly rules: readonly FeedbackRedactionRuleCountV1[];
      readonly dispositions: readonly Omit<FeedbackDispositionRecordV1, "target">[];
    }
  | { readonly ok: false; readonly error: FeedbackReportPreparationError };

const TEXT_ENCODER = new TextEncoder();

function fail(error: FeedbackReportPreparationError): FeedbackTextResult {
  return { ok: false, error };
}

function containsExactLiteral(value: string, literals: readonly string[] | undefined): boolean {
  return literals?.some((literal) => value.includes(literal)) ?? false;
}

function safetyError(
  value: string,
  field: FeedbackReportField,
): FeedbackReportPreparationError | undefined {
  if (!isUnicodeScalarString(value)) return { code: "invalid-unicode-scalar", field };
  if (containsControlOtherThanTabOrLf(value)) return { code: "unsafe-control", field };
  if (stripUnsafeFormatChars(value) !== value) {
    return { code: "unsafe-format-character", field };
  }
  return undefined;
}

function signalError(
  signal: SensitiveTextSignal | null,
  field: FeedbackReportField,
): FeedbackReportPreparationError | undefined {
  if (signal === "raw-log-content") return { code: "raw-log-content", field };
  if (signal !== null && signal !== "credential-shape") {
    return { code: "residual-sensitive-content", field };
  }
  return undefined;
}

function residualError(
  value: string,
  field: FeedbackReportField,
  policy: FeedbackReportRedactionPolicyV1,
): FeedbackReportPreparationError | undefined {
  if (containsAbsolutePath(value)) return { code: "residual-absolute-path", field };
  if (looksLikeEuDePii(value)) return { code: "residual-sensitive-content", field };
  if (containsExactLiteral(value, policy.customerIdentifierLiterals)) {
    return { code: "residual-sensitive-content", field };
  }
  const signal = scanFeedbackSensitiveText(value);
  if (signal === null) return undefined;
  return signal === "raw-log-content"
    ? { code: "raw-log-content", field }
    : { code: "residual-sensitive-content", field };
}

function preRedactionError(
  input: string,
  field: FeedbackReportField,
  maxBytes: number,
): FeedbackReportPreparationError | undefined {
  if (input.length > maxBytes) return { code: "field-byte-limit", field };
  if (!isUnicodeScalarString(input)) return { code: "invalid-unicode-scalar", field };
  const inputBytes = TEXT_ENCODER.encode(input);
  if (inputBytes.length > maxBytes) return { code: "field-byte-limit", field };
  if (hasKnownFeedbackMagic(inputBytes)) return { code: "binary-signature", field };
  return undefined;
}

function normalizedInputError(
  value: string,
  field: FeedbackReportField,
  required: boolean,
): FeedbackReportPreparationError | undefined {
  if (required && value.trim().length === 0) return { code: "required-field", field };
  return safetyError(value, field) ?? signalError(scanFeedbackSensitiveText(value), field);
}

type LocalDisposition = Omit<FeedbackDispositionRecordV1, "target">;

function repeatedRedactions(
  count: number,
  unitKind: FeedbackDispositionUnitKindV1,
): readonly LocalDisposition[] {
  return Array.from({ length: count }, () => ({
    action: "redacted" as const,
    reason: "complete-sensitive-span" as const,
    unitKind,
  }));
}

function credentialDispositions(
  value: ReturnType<typeof sanitizeFeedbackCredentialSpans>,
): readonly LocalDisposition[] {
  return value.dispositions.map((disposition) => ({
    action: disposition.action,
    reason:
      disposition.action === "redacted"
        ? "complete-sensitive-span"
        : "ambiguous-credential-structure",
    unitKind: disposition.unitKind,
  }));
}

function ruleDispositions(
  rules: readonly FeedbackRedactionRuleCountV1[],
  unitKind: FeedbackDispositionUnitKindV1,
): readonly LocalDisposition[] {
  return rules.flatMap((rule) => repeatedRedactions(rule.count, unitKind));
}

interface SanitizedFeedbackText {
  readonly value: string;
  readonly rules: FeedbackRedactionRuleCountV1[];
  readonly dispositions: LocalDisposition[];
}

function policyLiterals(policy: FeedbackReportRedactionPolicyV1): readonly string[] {
  return [...(policy.sensitiveLiterals ?? []), ...(policy.customerIdentifierLiterals ?? [])];
}

function targetUnitKind(target: FeedbackDispositionTargetV1): FeedbackDispositionUnitKindV1 {
  return target.kind === "attachment" ? "attachment" : "structured-value";
}

function sanitizeFeedbackText(
  normalized: string,
  policy: FeedbackReportRedactionPolicyV1,
  target: FeedbackDispositionTargetV1,
): SanitizedFeedbackText {
  const pathRedaction = redactAbsolutePathsWithCount(normalized);
  const credentials = sanitizeFeedbackCredentialSpans(pathRedaction.value);
  const redacted = redactNonCredentialWithRuleCounts(credentials.value, policyLiterals(policy));
  const rules: FeedbackRedactionRuleCountV1[] = [...credentials.rules, ...redacted.rules];
  const unitKind = targetUnitKind(target);
  if (pathRedaction.count > 0) {
    rules.unshift({ code: "absolute-path", count: pathRedaction.count });
  }
  return {
    value: redacted.value,
    rules,
    dispositions: [
      ...repeatedRedactions(pathRedaction.count, unitKind),
      ...credentialDispositions(credentials),
      ...ruleDispositions(redacted.rules, unitKind),
    ],
  };
}

function postRedactionError(
  value: string,
  field: FeedbackReportField,
  maxBytes: number,
  required: boolean,
  policy: FeedbackReportRedactionPolicyV1,
  target: FeedbackDispositionTargetV1,
): FeedbackReportPreparationError | undefined {
  const residual = safetyError(value, field) ?? residualError(value, field, policy);
  if (residual !== undefined) return residual;
  if (required && value.trim().length === 0) return { code: "rewrite-required", target };
  if (TEXT_ENCODER.encode(value).length > maxBytes) return { code: "field-byte-limit", field };
  return undefined;
}

function omittedDisposition(
  value: string,
  required: boolean,
  unitKind: "optional-field" | "attachment" | undefined,
): LocalDisposition | undefined {
  if (required || value.trim().length > 0 || unitKind === undefined) return undefined;
  return { action: "omitted", reason: "no-safe-optional-content", unitKind };
}

export function prepareFeedbackText(
  input: unknown,
  field: FeedbackReportField,
  maxBytes: number,
  required: boolean,
  policy: FeedbackReportRedactionPolicyV1,
  target: FeedbackDispositionTargetV1,
  emptyUnitKind?: "optional-field" | "attachment",
): FeedbackTextResult {
  if (typeof input !== "string") return fail({ code: "invalid-type", field });
  const preRedaction = preRedactionError(input, field, maxBytes);
  if (preRedaction !== undefined) return fail(preRedaction);
  const normalized = input.replace(/\r\n?/gu, "\n");
  const normalizedError = normalizedInputError(normalized, field, required);
  if (normalizedError !== undefined) return fail(normalizedError);
  const sanitized = sanitizeFeedbackText(normalized, policy, target);
  const finalError = postRedactionError(sanitized.value, field, maxBytes, required, policy, target);
  if (finalError !== undefined) return fail(finalError);
  const omitted = omittedDisposition(sanitized.value, required, emptyUnitKind);
  if (omitted !== undefined) sanitized.dispositions.push(omitted);
  return { ok: true, ...sanitized };
}

export function canonicalFeedbackTextError(
  value: string,
  field: FeedbackReportField,
  maxBytes: number,
  required: boolean,
  policy: FeedbackReportRedactionPolicyV1,
): FeedbackReportPreparationError | undefined {
  const preRedaction = preRedactionError(value, field, maxBytes);
  if (preRedaction !== undefined) return preRedaction;
  if (value.includes("\r")) return { code: "unsafe-control", field };
  const normalizedError = normalizedInputError(value, field, required);
  if (normalizedError !== undefined) return normalizedError;
  const pathRedaction = redactAbsolutePathsWithCount(value);
  if (pathRedaction.value !== value) return { code: "residual-absolute-path", field };
  if (containsFeedbackCredentialDetection(value)) {
    return { code: "residual-sensitive-content", field };
  }
  const redacted = redactNonCredentialWithRuleCounts(value, policyLiterals(policy));
  if (redacted.value !== value) return { code: "residual-sensitive-content", field };
  return safetyError(value, field) ?? residualError(value, field, policy);
}

export function composedFeedbackTextError(
  value: string,
  field: FeedbackReportField,
  maxBytes: number,
  policy: FeedbackReportRedactionPolicyV1,
): FeedbackReportPreparationError | undefined {
  return canonicalFeedbackTextError(value, field, maxBytes, true, policy);
}
