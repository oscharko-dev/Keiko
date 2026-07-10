import {
  FEEDBACK_REPORT_LIMITS,
  parseFeedbackReportV1,
  type FeedbackReportField,
  type FeedbackReportV1,
} from "@oscharko-dev/keiko-contracts/feedback-report";

import { hasUtf8Bom } from "./feedback-report-magic.js";
import {
  immutablePreparedFeedbackReportV1,
  type PreparedFeedbackReportV1,
} from "./feedback-report-body.js";
import { canonicalFeedbackTextError } from "./feedback-report-text.js";
import {
  EMPTY_FEEDBACK_REPORT_REDACTION_POLICY_V1,
  parseFeedbackReportRedactionPolicyV1,
  type FeedbackReportRedactionPolicyV1,
} from "./feedback-report-policy.js";
import { canonicalise, sha256Hex } from "./hashing.js";

export const FEEDBACK_CANONICAL_BODY_ERROR_CODES_V1 = [
  "invalid-body",
  "body-byte-limit",
  "bom-not-allowed",
  "invalid-utf8",
  "invalid-json",
  "invalid-report",
  "noncanonical-body",
  "digest-mismatch",
  "invalid-policy",
  "unsafe-content",
] as const;
export type FeedbackCanonicalBodyErrorCodeV1 =
  (typeof FEEDBACK_CANONICAL_BODY_ERROR_CODES_V1)[number];

export interface VerifyCanonicalFeedbackReportBodyInputV1 {
  readonly bytes: Uint8Array;
  readonly claimedDigest: string;
  readonly policy?: FeedbackReportRedactionPolicyV1 | undefined;
}

export type VerifyCanonicalFeedbackReportBodyResultV1 =
  | { readonly ok: true; readonly value: PreparedFeedbackReportV1 }
  | { readonly ok: false; readonly error: { readonly code: FeedbackCanonicalBodyErrorCodeV1 } };

type VerifierFailure = Extract<VerifyCanonicalFeedbackReportBodyResultV1, { readonly ok: false }>;

function failure(code: FeedbackCanonicalBodyErrorCodeV1): VerifierFailure {
  return { ok: false, error: { code } };
}

function decodeCanonicalUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

type JsonParse = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

function parseJson(value: string): JsonParse {
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch {
    return { ok: false };
  }
}

const REPORT_TEXT_FIELDS = [
  ["productVersion", FEEDBACK_REPORT_LIMITS.productVersionBytes, true],
  ["browserDescription", FEEDBACK_REPORT_LIMITS.browserDescriptionBytes, false],
  ["steps", FEEDBACK_REPORT_LIMITS.stepsBytes, true],
  ["expectedResult", FEEDBACK_REPORT_LIMITS.expectedResultBytes, true],
  ["actualResult", FEEDBACK_REPORT_LIMITS.actualResultBytes, true],
  ["handwrittenEvidence", FEEDBACK_REPORT_LIMITS.handwrittenEvidenceBytes, false],
] as const satisfies readonly (readonly [FeedbackReportField, number, boolean])[];

function reportHasUnsafeContent(
  report: FeedbackReportV1,
  policy: FeedbackReportRedactionPolicyV1,
): boolean {
  if (
    canonicalFeedbackTextError(
      report.summary.title,
      "summary.title",
      FEEDBACK_REPORT_LIMITS.summaryBytes,
      true,
      policy,
    ) !== undefined ||
    canonicalFeedbackTextError(
      report.summary.description,
      "summary.description",
      FEEDBACK_REPORT_LIMITS.summaryBytes,
      true,
      policy,
    ) !== undefined
  ) {
    return true;
  }
  for (const [field, maxBytes, required] of REPORT_TEXT_FIELDS) {
    const value = report[field as keyof FeedbackReportV1];
    if (value === undefined) continue;
    if (typeof value !== "string") return true;
    if (canonicalFeedbackTextError(value, field, maxBytes, required, policy) !== undefined) {
      return true;
    }
  }
  for (const attachment of report.attachments ?? []) {
    if (
      canonicalFeedbackTextError(
        attachment,
        "attachments",
        FEEDBACK_REPORT_LIMITS.attachmentBytes,
        true,
        policy,
      ) !== undefined
    ) {
      return true;
    }
  }
  return false;
}

type ValidatedVerifierInput =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      readonly claimedDigest: string;
      readonly policy: FeedbackReportRedactionPolicyV1;
    }
  | VerifierFailure;

const VERIFIER_INPUT_KEYS = new Set(["bytes", "claimedDigest", "policy"]);

interface VerifierInputFields {
  readonly bytes: unknown;
  readonly claimedDigest: unknown;
  readonly policy: unknown;
}

interface VerifierInputDescriptors {
  readonly bytes: PropertyDescriptor | undefined;
  readonly claimedDigest: PropertyDescriptor | undefined;
  readonly policy: PropertyDescriptor | undefined;
}

interface DataDescriptorValue {
  readonly value: unknown;
}

function dataDescriptorValue(
  descriptor: PropertyDescriptor | undefined,
): DataDescriptorValue | undefined {
  if (descriptor === undefined || !("value" in descriptor)) return undefined;
  return { value: descriptor.value as unknown };
}

function verifierKeysAreClosed(value: object): boolean {
  return Reflect.ownKeys(value).every(
    (key) => typeof key === "string" && VERIFIER_INPUT_KEYS.has(key),
  );
}

function verifierInputDescriptors(value: unknown): VerifierInputDescriptors | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    if (Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    if (!verifierKeysAreClosed(value)) return undefined;
    return {
      bytes: Object.getOwnPropertyDescriptor(value, "bytes"),
      claimedDigest: Object.getOwnPropertyDescriptor(value, "claimedDigest"),
      policy: Object.getOwnPropertyDescriptor(value, "policy"),
    };
  } catch {
    return undefined;
  }
}

function verifierInputFields(value: unknown): VerifierInputFields | undefined {
  const descriptors = verifierInputDescriptors(value);
  if (descriptors === undefined) return undefined;
  const bytes = dataDescriptorValue(descriptors.bytes);
  const claimedDigest = dataDescriptorValue(descriptors.claimedDigest);
  const policy =
    descriptors.policy === undefined
      ? { value: undefined }
      : dataDescriptorValue(descriptors.policy);
  if (bytes === undefined || claimedDigest === undefined || policy === undefined) return undefined;
  return { bytes: bytes.value, claimedDigest: claimedDigest.value, policy: policy.value };
}

// eslint-disable-next-line @typescript-eslint/unbound-method -- Reflect.apply supplies the typed-array receiver after the value crosses the trust boundary.
const TYPED_ARRAY_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  "length",
)?.get;
// eslint-disable-next-line @typescript-eslint/unbound-method -- Reflect.apply supplies the fresh target and must bypass caller-owned overrides.
const UINT8_ARRAY_SET = Uint8Array.prototype.set;

function boundedByteCopy(value: unknown): Uint8Array | "too-large" | undefined {
  try {
    if (!(value instanceof Uint8Array)) return undefined;
    if (TYPED_ARRAY_LENGTH_GETTER === undefined) return undefined;
    const length = Reflect.apply(TYPED_ARRAY_LENGTH_GETTER, value, []) as unknown;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return undefined;
    if (length > FEEDBACK_REPORT_LIMITS.canonicalBodyBytes) return "too-large";
    const copy = new Uint8Array(length);
    Reflect.apply(UINT8_ARRAY_SET, copy, [value]);
    return Object.getPrototypeOf(copy) === Uint8Array.prototype ? copy : undefined;
  } catch {
    return undefined;
  }
}

function verifierPolicy(value: unknown): FeedbackReportRedactionPolicyV1 | undefined {
  try {
    const parsed = parseFeedbackReportRedactionPolicyV1(value);
    return parsed.ok ? parsed.value : undefined;
  } catch {
    return undefined;
  }
}

function validateVerifierInput(input: unknown): ValidatedVerifierInput {
  const fields = verifierInputFields(input);
  if (fields === undefined || typeof fields.claimedDigest !== "string") {
    return failure("invalid-body");
  }
  const bytes = boundedByteCopy(fields.bytes);
  if (bytes === "too-large") return failure("body-byte-limit");
  if (bytes === undefined) return failure("invalid-body");
  const policy = verifierPolicy(
    fields.policy === undefined ? EMPTY_FEEDBACK_REPORT_REDACTION_POLICY_V1 : fields.policy,
  );
  return policy !== undefined
    ? {
        ok: true,
        bytes,
        claimedDigest: fields.claimedDigest,
        policy,
      }
    : failure("invalid-policy");
}

type ParsedCanonicalReport =
  { readonly ok: true; readonly json: string; readonly report: FeedbackReportV1 } | VerifierFailure;

function parseCanonicalReport(bytes: Uint8Array): ParsedCanonicalReport {
  if (hasUtf8Bom(bytes)) return failure("bom-not-allowed");
  const json = decodeCanonicalUtf8(bytes);
  if (json === undefined) return failure("invalid-utf8");
  const value = parseJson(json);
  if (!value.ok) return failure("invalid-json");
  const parsed = parseFeedbackReportV1(value.value);
  if (!parsed.ok) return failure("invalid-report");
  return canonicalise(parsed.value) === json
    ? { ok: true, json, report: parsed.value }
    : failure("noncanonical-body");
}

export function verifyCanonicalFeedbackReportBodyV1(
  input: unknown,
): VerifyCanonicalFeedbackReportBodyResultV1 {
  const validated = validateVerifierInput(input);
  if (!validated.ok) return validated;
  const parsed = parseCanonicalReport(validated.bytes);
  if (!parsed.ok) return parsed;
  if (
    !/^[0-9a-f]{64}$/u.test(validated.claimedDigest) ||
    sha256Hex(parsed.json) !== validated.claimedDigest
  ) {
    return failure("digest-mismatch");
  }
  if (reportHasUnsafeContent(parsed.report, validated.policy)) return failure("unsafe-content");
  return {
    ok: true,
    value: immutablePreparedFeedbackReportV1(
      parsed.report,
      parsed.json,
      validated.bytes,
      validated.claimedDigest,
    ),
  };
}
