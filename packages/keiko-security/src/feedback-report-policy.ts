import type { FeedbackReportError } from "@oscharko-dev/keiko-contracts/feedback-report";
import {
  containsControlOtherThanTabOrLf,
  isUnicodeScalarString,
  stripUnsafeFormatChars,
} from "@oscharko-dev/keiko-contracts/text-safety";

/** Trusted, process-owned exact literals applied by the feedback privacy engine. */
export interface FeedbackReportRedactionPolicyV1 {
  readonly sensitiveLiterals?: readonly string[] | undefined;
  readonly customerIdentifierLiterals?: readonly string[] | undefined;
}

export const EMPTY_FEEDBACK_REPORT_REDACTION_POLICY_V1: FeedbackReportRedactionPolicyV1 =
  Object.freeze({});

export const FEEDBACK_REPORT_REDACTION_POLICY_LIMITS_V1 = Object.freeze({
  literalCount: 64,
  literalBytes: 256,
  aggregateBytes: 8 * 1024,
  minimumLiteralCharacters: 4,
} as const);

export type FeedbackReportRedactionPolicyParseV1 =
  | { readonly ok: true; readonly value: FeedbackReportRedactionPolicyV1 }
  | { readonly ok: false; readonly error: FeedbackReportError };

const POLICY_KEYS = new Set(["sensitiveLiterals", "customerIdentifierLiterals"]);
const TEXT_ENCODER = new TextEncoder();
const RESERVED_REDACTION_SENTINELS = ["[REDACTED]", "[REDACTED_PATH]"] as const;

function invalidPolicy(): FeedbackReportRedactionPolicyParseV1 {
  return { ok: false, error: { code: "invalid-shape", field: "report" } };
}

function overPolicyLimit(): FeedbackReportRedactionPolicyParseV1 {
  return { ok: false, error: { code: "field-byte-limit", field: "report" } };
}

function validLiteral(value: string): boolean {
  return (
    value.length >= FEEDBACK_REPORT_REDACTION_POLICY_LIMITS_V1.minimumLiteralCharacters &&
    isUnicodeScalarString(value) &&
    !containsControlOtherThanTabOrLf(value) &&
    stripUnsafeFormatChars(value) === value
  );
}

interface PolicyFields {
  readonly sensitive: unknown;
  readonly customer: unknown;
}

function ownDataValue(descriptor: PropertyDescriptor | undefined): unknown {
  return descriptor === undefined ? undefined : (descriptor.value as unknown);
}

function plainPolicyRecord(value: unknown): value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function closedPolicyKeys(value: object): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && POLICY_KEYS.has(key));
}

function optionalOwnDataDescriptor(descriptor: PropertyDescriptor | undefined): boolean {
  return descriptor === undefined || ("value" in descriptor && descriptor.enumerable === true);
}

function policyFields(value: unknown): PolicyFields | undefined {
  if (!plainPolicyRecord(value) || !closedPolicyKeys(value)) return undefined;
  const sensitive = Object.getOwnPropertyDescriptor(value, "sensitiveLiterals");
  const customer = Object.getOwnPropertyDescriptor(value, "customerIdentifierLiterals");
  if (!optionalOwnDataDescriptor(sensitive) || !optionalOwnDataDescriptor(customer)) {
    return undefined;
  }
  return { sensitive: ownDataValue(sensitive), customer: ownDataValue(customer) };
}

interface PolicyArrayHeader {
  readonly value: readonly unknown[];
  readonly length: number;
}

const EMPTY_POLICY_ARRAY: readonly unknown[] = Object.freeze([]);

function policyArrayHeader(value: unknown): PolicyArrayHeader | undefined {
  if (value === undefined) return { value: EMPTY_POLICY_ARRAY, length: 0 };
  if (!Array.isArray(value)) return undefined;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) return undefined;
  const length = lengthDescriptor.value as unknown;
  return typeof length === "number" && Number.isSafeInteger(length) && length >= 0
    ? { value, length }
    : undefined;
}

function copyPolicyArray(header: PolicyArrayHeader): readonly string[] | undefined {
  if (Object.getPrototypeOf(header.value) !== Array.prototype) return undefined;
  if (Reflect.ownKeys(header.value).length !== header.length + 1) return undefined;
  const copy: string[] = [];
  for (let index = 0; index < header.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(header.value, String(index));
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      typeof descriptor.value !== "string"
    ) {
      return undefined;
    }
    copy.push(descriptor.value);
  }
  return copy;
}

function exceedsLiteralCount(sensitiveLength: number, customerLength: number): boolean {
  const limit = FEEDBACK_REPORT_REDACTION_POLICY_LIMITS_V1.literalCount;
  return (
    sensitiveLength > limit || customerLength > limit || sensitiveLength + customerLength > limit
  );
}

function literalPolicyError(literals: readonly string[]): "invalid" | "limit" | undefined {
  if (new Set(literals).size !== literals.length) return "invalid";
  let aggregateBytes = 0;
  for (const literal of literals) {
    if (literal.length > FEEDBACK_REPORT_REDACTION_POLICY_LIMITS_V1.literalBytes) return "limit";
    if (RESERVED_REDACTION_SENTINELS.some((sentinel) => sentinel.includes(literal))) {
      return "invalid";
    }
    if (!validLiteral(literal)) return "invalid";
    const literalBytes = TEXT_ENCODER.encode(literal).length;
    if (literalBytes > FEEDBACK_REPORT_REDACTION_POLICY_LIMITS_V1.literalBytes) return "limit";
    aggregateBytes += literalBytes;
    if (aggregateBytes > FEEDBACK_REPORT_REDACTION_POLICY_LIMITS_V1.aggregateBytes) return "limit";
  }
  return undefined;
}

export function parseFeedbackReportRedactionPolicyV1(
  value: unknown,
): FeedbackReportRedactionPolicyParseV1 {
  try {
    const fields = policyFields(value);
    if (fields === undefined) return invalidPolicy();
    const sensitiveHeader = policyArrayHeader(fields.sensitive);
    const customerHeader = policyArrayHeader(fields.customer);
    if (sensitiveHeader === undefined || customerHeader === undefined) return invalidPolicy();
    if (exceedsLiteralCount(sensitiveHeader.length, customerHeader.length)) {
      return overPolicyLimit();
    }
    const sensitive = copyPolicyArray(sensitiveHeader);
    const customer = copyPolicyArray(customerHeader);
    if (sensitive === undefined || customer === undefined) return invalidPolicy();
    const literalError = literalPolicyError([...sensitive, ...customer]);
    if (literalError === "invalid") return invalidPolicy();
    if (literalError === "limit") return overPolicyLimit();
    return {
      ok: true,
      value: Object.freeze({
        sensitiveLiterals: Object.freeze(sensitive),
        customerIdentifierLiterals: Object.freeze(customer),
      }),
    };
  } catch {
    return invalidPolicy();
  }
}
