import {
  FEEDBACK_DISPOSITION_ACTIONS_V1,
  FEEDBACK_DISPOSITION_REASONS_V1,
  FEEDBACK_DISPOSITION_UNIT_KINDS_V1,
  FEEDBACK_DRAFT_FIELD_IDS_V1,
  FEEDBACK_REPORT_LIMITS,
  parseFeedbackReportV1,
  type FeedbackDispositionRecordV1,
  type FeedbackDispositionSidecarV1,
  type FeedbackDispositionTargetV1,
  type FeedbackDraftFieldIdV1,
  type FeedbackReportDraftV1,
  type FeedbackReportErrorCode,
  type FeedbackReportField,
  type FeedbackReportPreparationError,
  type FeedbackReportV1,
} from "@oscharko-dev/keiko-contracts/feedback-report";

import { FeedbackApiError } from "./feedback-api-errors";
import {
  FeedbackSecurityRoutingError,
  isFeedbackSecurityRoutingResponse,
} from "./feedback-api-security";
import {
  parseFeedbackSubmitOutcomeV1,
  type FeedbackSubmitOutcomeV1,
} from "./feedback-submit-response";
export type { FeedbackSubmitOutcomeV1 } from "./feedback-submit-response";
export type { FeedbackReceiptV1 } from "./feedback-submit-response";

export { FeedbackApiError } from "./feedback-api-errors";
export {
  FeedbackSecurityRoutingError,
  revalidateFeedbackReportV1,
  type FeedbackRevalidationOutcomeV1,
} from "./feedback-api-security";

const PREVIEW_RESPONSE_KEYS = new Set([
  "report",
  "canonicalJson",
  "exactBodySha256",
  "dispositionSidecar",
]);
const SIDECAR_KEYS = new Set(["exactBodySha256", "records"]);
const DISPOSITION_KEYS = new Set(["action", "reason", "unitKind", "target"]);
const DRAFT_TARGET_KEYS = new Set(["kind", "field"]);
const ATTACHMENT_TARGET_KEYS = new Set(["kind", "ordinal"]);
const PREPARATION_RESPONSE_KEYS = new Set(["error", "errors"]);
const ERROR_ENVELOPE_KEYS = new Set(["code", "message"]);
const REPORT_ERROR_KEYS = new Set(["code", "field"]);
const REWRITE_ERROR_KEYS = new Set(["code", "target"]);
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const TEXT_ENCODER = new TextEncoder();

const DISPOSITION_ACTIONS = new Set<unknown>(FEEDBACK_DISPOSITION_ACTIONS_V1);
const DISPOSITION_REASONS = new Set<unknown>(FEEDBACK_DISPOSITION_REASONS_V1);
const DISPOSITION_UNIT_KINDS = new Set<unknown>(FEEDBACK_DISPOSITION_UNIT_KINDS_V1);
const DRAFT_FIELD_IDS = new Set<unknown>(FEEDBACK_DRAFT_FIELD_IDS_V1);
const REPORT_ERROR_CODES = new Set<unknown>([
  "invalid-shape",
  "unknown-field",
  "unsupported-version",
  "required-field",
  "invalid-type",
  "invalid-enum",
  "invalid-count",
  "invalid-unicode-scalar",
  "invalid-utf8",
  "unsafe-control",
  "unsafe-format-character",
  "binary-signature",
  "unsupported-media-type",
  "unsupported-extension",
  "raw-log-content",
  "residual-sensitive-content",
  "residual-absolute-path",
  "field-byte-limit",
  "attachment-count-limit",
  "attachment-aggregate-byte-limit",
  "canonical-body-byte-limit",
] satisfies readonly FeedbackReportErrorCode[]);
const REPORT_FIELDS = new Set<unknown>([
  "report",
  "schemaVersion",
  "privacyContractVersion",
  "redactionProvenance",
  "productVersion",
  "platform",
  "browserDescription",
  "summary",
  "summary.title",
  "summary.description",
  "steps",
  "expectedResult",
  "actualResult",
  "impact",
  "handwrittenEvidence",
  "attachments",
  "diagnostics",
] satisfies readonly FeedbackReportField[]);

export interface FeedbackBrowserAttachmentV1 {
  readonly bytesBase64: string;
  readonly declaredMediaType?: string | undefined;
  readonly extension?: string | undefined;
}

export type FeedbackBrowserDraftV1 = Omit<FeedbackReportDraftV1, "attachments"> & {
  readonly attachments?: readonly FeedbackBrowserAttachmentV1[] | undefined;
};

export interface PreparedFeedbackSnapshotV1 {
  readonly report: FeedbackReportV1;
  readonly canonicalJson: string;
  readonly exactBodySha256: string;
  readonly dispositionSidecar: FeedbackDispositionSidecarV1;
}

export class FeedbackPreviewPreparationError extends FeedbackApiError {
  public readonly errors: readonly FeedbackReportPreparationError[];

  public constructor(errors: readonly FeedbackReportPreparationError[]) {
    super("The feedback draft needs attention.");
    this.name = "FeedbackPreviewPreparationError";
    this.errors = deepFreeze([...errors]);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.size &&
    keys.every((key) => typeof key === "string" && expected.has(key))
  );
}

function dispositionTarget(value: unknown): FeedbackDispositionTargetV1 | undefined {
  if (!isPlainRecord(value) || typeof value.kind !== "string") return undefined;
  if (value.kind === "draft-field") {
    if (!hasExactKeys(value, DRAFT_TARGET_KEYS) || !DRAFT_FIELD_IDS.has(value.field)) {
      return undefined;
    }
    return { kind: "draft-field", field: value.field as FeedbackDraftFieldIdV1 };
  }
  if (
    value.kind !== "attachment" ||
    !hasExactKeys(value, ATTACHMENT_TARGET_KEYS) ||
    !Number.isSafeInteger(value.ordinal) ||
    (value.ordinal as number) < 0 ||
    (value.ordinal as number) >= FEEDBACK_REPORT_LIMITS.attachmentCount
  ) {
    return undefined;
  }
  return { kind: "attachment", ordinal: value.ordinal as number };
}

function dispositionRecord(value: unknown): FeedbackDispositionRecordV1 | undefined {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, DISPOSITION_KEYS) ||
    !DISPOSITION_ACTIONS.has(value.action) ||
    !DISPOSITION_REASONS.has(value.reason) ||
    !DISPOSITION_UNIT_KINDS.has(value.unitKind)
  ) {
    return undefined;
  }
  const target = dispositionTarget(value.target);
  if (target === undefined) return undefined;
  return {
    action: value.action as FeedbackDispositionRecordV1["action"],
    reason: value.reason as FeedbackDispositionRecordV1["reason"],
    unitKind: value.unitKind as FeedbackDispositionRecordV1["unitKind"],
    target,
  };
}

function dispositionSidecar(
  value: unknown,
  exactBodySha256: string,
): FeedbackDispositionSidecarV1 | undefined {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, SIDECAR_KEYS) ||
    value.exactBodySha256 !== exactBodySha256 ||
    !Array.isArray(value.records)
  ) {
    return undefined;
  }
  const records: FeedbackDispositionRecordV1[] = [];
  for (const candidate of value.records) {
    const record = dispositionRecord(candidate);
    if (record === undefined) return undefined;
    records.push(record);
  }
  return { exactBodySha256, records };
}

function preparationError(value: unknown): FeedbackReportPreparationError | undefined {
  if (!isPlainRecord(value) || typeof value.code !== "string") return undefined;
  if (value.code === "rewrite-required") {
    if (!hasExactKeys(value, REWRITE_ERROR_KEYS)) return undefined;
    const target = dispositionTarget(value.target);
    return target === undefined ? undefined : { code: "rewrite-required", target };
  }
  if (
    !hasExactKeys(value, REPORT_ERROR_KEYS) ||
    !REPORT_ERROR_CODES.has(value.code) ||
    !REPORT_FIELDS.has(value.field)
  ) {
    return undefined;
  }
  return {
    code: value.code as FeedbackReportErrorCode,
    field: value.field as FeedbackReportField,
  };
}

function preparationErrors(value: unknown): readonly FeedbackReportPreparationError[] | undefined {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, PREPARATION_RESPONSE_KEYS) ||
    !isPlainRecord(value.error) ||
    !hasExactKeys(value.error, ERROR_ENVELOPE_KEYS) ||
    value.error.code !== "FEEDBACK_PREVIEW_REJECTED" ||
    value.error.message !== "The feedback draft needs attention." ||
    !Array.isArray(value.errors) ||
    value.errors.length === 0 ||
    value.errors.length > 64
  ) {
    return undefined;
  }
  const errors: FeedbackReportPreparationError[] = [];
  for (const candidate of value.errors) {
    const error = preparationError(candidate);
    if (error === undefined) return undefined;
    errors.push(error);
  }
  return errors;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

async function sha256Hex(value: string): Promise<string> {
  if (globalThis.crypto?.subtle === undefined) throw new FeedbackApiError();
  const digest = await globalThis.crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

interface FeedbackJsonResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly value: unknown;
}

async function requestJson(path: string, body: unknown): Promise<FeedbackJsonResponse> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Keiko-CSRF": "1",
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new FeedbackApiError();
  }
  try {
    return { ok: response.ok, status: response.status, value: (await response.json()) as unknown };
  } catch {
    throw new FeedbackApiError();
  }
}

function parsedReport(value: unknown): FeedbackReportV1 | undefined {
  const parsed = parseFeedbackReportV1(value);
  return parsed.ok ? parsed.value : undefined;
}

async function preparedSnapshot(value: unknown): Promise<PreparedFeedbackSnapshotV1> {
  if (!isPlainRecord(value) || !hasExactKeys(value, PREVIEW_RESPONSE_KEYS)) {
    throw new FeedbackApiError();
  }
  if (
    typeof value.canonicalJson !== "string" ||
    typeof value.exactBodySha256 !== "string" ||
    !SHA256_HEX.test(value.exactBodySha256)
  ) {
    throw new FeedbackApiError();
  }
  let canonicalValue: unknown;
  try {
    canonicalValue = JSON.parse(value.canonicalJson) as unknown;
  } catch {
    throw new FeedbackApiError();
  }
  const canonicalReport = parsedReport(canonicalValue);
  const responseReport = parsedReport(value.report);
  if (
    canonicalReport === undefined ||
    responseReport === undefined ||
    stableJson(canonicalReport) !== value.canonicalJson ||
    stableJson(canonicalReport) !== stableJson(responseReport) ||
    (await sha256Hex(value.canonicalJson)) !== value.exactBodySha256
  ) {
    throw new FeedbackApiError();
  }
  const sidecar = dispositionSidecar(value.dispositionSidecar, value.exactBodySha256);
  if (sidecar === undefined) throw new FeedbackApiError();
  return deepFreeze({
    report: canonicalReport,
    canonicalJson: value.canonicalJson,
    exactBodySha256: value.exactBodySha256,
    dispositionSidecar: sidecar,
  });
}

export async function previewFeedbackReportV1(
  draft: FeedbackBrowserDraftV1,
): Promise<PreparedFeedbackSnapshotV1> {
  const response = await requestJson("/api/feedback/preview", draft);
  if (!response.ok) {
    if (response.status === 422 && isFeedbackSecurityRoutingResponse(response.value)) {
      throw new FeedbackSecurityRoutingError();
    }
    const errors = response.status === 422 ? preparationErrors(response.value) : undefined;
    if (errors !== undefined) throw new FeedbackPreviewPreparationError(errors);
    throw new FeedbackApiError();
  }
  return preparedSnapshot(response.value);
}

export async function submitFeedbackReportV1(
  prepared: Pick<PreparedFeedbackSnapshotV1, "canonicalJson" | "exactBodySha256">,
): Promise<FeedbackSubmitOutcomeV1> {
  const response = await requestJson("/api/feedback/submit", {
    canonicalJson: prepared.canonicalJson,
    exactBodySha256: prepared.exactBodySha256,
  });
  if (!response.ok) throw new FeedbackApiError();
  const outcome = parseFeedbackSubmitOutcomeV1(response.value);
  if (outcome === undefined) throw new FeedbackApiError();
  return outcome;
}
