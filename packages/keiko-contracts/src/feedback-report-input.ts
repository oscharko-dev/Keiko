import {
  FEEDBACK_REDACTION_RULE_CODES,
  FEEDBACK_REPORT_LIMITS,
  type FeedbackReportErrorCode,
  type FeedbackReportField,
} from "./feedback-report-contract.js";

type DataRecord = Record<string, unknown>;

export type FeedbackInputSnapshot =
  | { readonly ok: true; readonly value: DataRecord }
  | {
      readonly ok: false;
      readonly code: FeedbackReportErrorCode;
      readonly field: FeedbackReportField;
    };

type RecordSnapshot =
  | { readonly ok: true; readonly value: DataRecord }
  | { readonly ok: false; readonly reason: "invalid" | "unknown" };

type ArraySnapshot =
  | { readonly ok: true; readonly value: unknown[] }
  | { readonly ok: false; readonly reason: "invalid" | "not-array" | "limit" };

type ByteSnapshot =
  | { readonly ok: true; readonly value: Uint8Array }
  | { readonly ok: false; readonly reason: "invalid" | "limit" };

const REPORT_KEYS = new Set([
  "schemaVersion",
  "privacyContractVersion",
  "redactionProvenance",
  "productVersion",
  "platform",
  "browserDescription",
  "summary",
  "steps",
  "expectedResult",
  "actualResult",
  "impact",
  "handwrittenEvidence",
  "attachments",
  "diagnostics",
]);
const DRAFT_KEYS = new Set([
  "schemaVersion",
  "category",
  "title",
  "description",
  "reproductionSteps",
  "expectedBehavior",
  "actualBehavior",
  "productVersion",
  "platform",
  "featureArea",
  "browserDescription",
  "impact",
  "diagnostics",
  "handwrittenEvidence",
  "attachments",
]);
const PROVENANCE_KEYS = new Set(["engineVersion", "rules"]);
const SUMMARY_KEYS = new Set(["title", "description"]);
const RULE_KEYS = new Set(["code", "count"]);
const DIAGNOSTICS_KEYS = new Set(["category", "featureArea", "severityCounts"]);
const COUNT_KEYS = new Set(["errors", "warnings", "infos"]);
const ATTACHMENT_CANDIDATE_KEYS = new Set(["bytes", "declaredMediaType", "extension"]);
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
// eslint-disable-next-line @typescript-eslint/unbound-method -- Reflect.apply supplies the typed-array receiver after the value crosses the trust boundary.
const TYPED_ARRAY_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "length",
)?.get;
// eslint-disable-next-line @typescript-eslint/unbound-method -- Reflect.apply supplies the typed-array receiver for an intrinsic brand check.
const TYPED_ARRAY_TAG_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  Symbol.toStringTag,
)?.get;
// eslint-disable-next-line @typescript-eslint/unbound-method -- Reflect.apply supplies the fresh target and bypasses caller-owned overrides.
const UINT8_ARRAY_SET = Uint8Array.prototype.set;

function failure(code: FeedbackReportErrorCode, field: FeedbackReportField): FeedbackInputSnapshot {
  return { ok: false, code, field };
}

function plainRecord(value: unknown): object | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null ? value : undefined;
}

function keysAreAllowed(keys: readonly PropertyKey[], allowedKeys: ReadonlySet<string>): boolean {
  return keys.every((key) => typeof key === "string" && allowedKeys.has(key));
}

interface DataValue {
  readonly value: unknown;
}

function enumerableDataValue(value: object, key: PropertyKey): DataValue | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
    return undefined;
  }
  return { value: descriptor.value as unknown };
}

function snapshotRecord(value: unknown, allowedKeys: ReadonlySet<string>): RecordSnapshot {
  try {
    const record = plainRecord(value);
    if (record === undefined) return { ok: false, reason: "invalid" };
    const keys = Reflect.ownKeys(record);
    if (!keysAreAllowed(keys, allowedKeys)) return { ok: false, reason: "unknown" };
    const snapshot: DataRecord = {};
    for (const key of keys as string[]) {
      const data = enumerableDataValue(record, key);
      if (data === undefined) return { ok: false, reason: "invalid" };
      snapshot[key] = data.value;
    }
    return { ok: true, value: snapshot };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

function arrayLength(value: object): number | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (descriptor === undefined || !("value" in descriptor)) return undefined;
  const length = descriptor.value as unknown;
  return Number.isSafeInteger(length) && Number(length) >= 0 ? Number(length) : undefined;
}

function arrayKeysAreClosed(keys: readonly PropertyKey[], length: number): boolean {
  return keys.length === length + 1 && keys.includes("length");
}

function snapshotArray(value: unknown, maxLength: number): ArraySnapshot {
  try {
    if (!Array.isArray(value)) return { ok: false, reason: "not-array" };
    if (Object.getPrototypeOf(value) !== Array.prototype) return { ok: false, reason: "invalid" };
    const length = arrayLength(value);
    if (length === undefined) return { ok: false, reason: "invalid" };
    if (length > maxLength) return { ok: false, reason: "limit" };
    const keys = Reflect.ownKeys(value);
    if (!arrayKeysAreClosed(keys, length)) return { ok: false, reason: "invalid" };
    const snapshot: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const data = enumerableDataValue(value, String(index));
      if (data === undefined) return { ok: false, reason: "invalid" };
      snapshot.push(data.value);
    }
    return { ok: true, value: snapshot };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

function genuineUint8Array(value: unknown): value is Uint8Array {
  if (typeof value !== "object" || value === null || TYPED_ARRAY_TAG_GETTER === undefined) {
    return false;
  }
  return Reflect.apply(TYPED_ARRAY_TAG_GETTER, value, []) === "Uint8Array";
}

function intrinsicByteLength(value: Uint8Array): unknown {
  return TYPED_ARRAY_LENGTH_GETTER === undefined
    ? undefined
    : Reflect.apply(TYPED_ARRAY_LENGTH_GETTER, value, []);
}

function validByteLength(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function snapshotBytes(value: unknown): ByteSnapshot {
  try {
    if (!genuineUint8Array(value)) return { ok: false, reason: "invalid" };
    const length = intrinsicByteLength(value);
    if (!validByteLength(length)) return { ok: false, reason: "invalid" };
    if (length > FEEDBACK_REPORT_LIMITS.attachmentBytes) {
      return { ok: false, reason: "limit" };
    }
    const snapshot = new Uint8Array(length);
    Reflect.apply(UINT8_ARRAY_SET, snapshot, [value]);
    return Object.getPrototypeOf(snapshot) === Uint8Array.prototype
      ? { ok: true, value: snapshot }
      : { ok: false, reason: "invalid" };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

function nestedRecord(
  value: unknown,
  keys: ReadonlySet<string>,
  field: FeedbackReportField,
  unknownCode: FeedbackReportErrorCode = "invalid-shape",
): FeedbackInputSnapshot {
  const snapshot = snapshotRecord(value, keys);
  if (snapshot.ok) return snapshot;
  return failure(snapshot.reason === "unknown" ? unknownCode : "invalid-shape", field);
}

function snapshotRules(value: unknown): FeedbackInputSnapshot {
  const rules = snapshotArray(value, FEEDBACK_REDACTION_RULE_CODES.length);
  if (!rules.ok) return failure("invalid-shape", "redactionProvenance");
  const snapshots: DataRecord[] = [];
  for (const rule of rules.value) {
    const snapshot = nestedRecord(rule, RULE_KEYS, "redactionProvenance");
    if (!snapshot.ok) return snapshot;
    snapshots.push(snapshot.value);
  }
  return { ok: true, value: { rules: snapshots } };
}

function snapshotProvenance(value: unknown): FeedbackInputSnapshot {
  const provenance = nestedRecord(value, PROVENANCE_KEYS, "redactionProvenance");
  if (!provenance.ok) return provenance;
  const rules = snapshotRules(provenance.value.rules);
  if (!rules.ok) return rules;
  provenance.value.rules = rules.value.rules;
  return provenance;
}

function snapshotCounts(value: unknown): FeedbackInputSnapshot {
  return nestedRecord(value, COUNT_KEYS, "diagnostics");
}

function snapshotDiagnostics(value: unknown): FeedbackInputSnapshot {
  const diagnostics = nestedRecord(value, DIAGNOSTICS_KEYS, "diagnostics");
  if (!diagnostics.ok || diagnostics.value.severityCounts === undefined) return diagnostics;
  const counts = snapshotCounts(diagnostics.value.severityCounts);
  if (!counts.ok) return counts;
  diagnostics.value.severityCounts = counts.value;
  return diagnostics;
}

function snapshotAttachments(value: unknown): FeedbackInputSnapshot {
  const attachments = snapshotArray(value, FEEDBACK_REPORT_LIMITS.attachmentCount);
  if (!attachments.ok) {
    if (attachments.reason === "limit") return failure("attachment-count-limit", "attachments");
    return failure(
      attachments.reason === "not-array" ? "invalid-type" : "invalid-shape",
      "attachments",
    );
  }
  return { ok: true, value: { attachments: attachments.value } };
}

function snapshotDraftAttachments(value: unknown): FeedbackInputSnapshot {
  const attachments = snapshotArray(value, FEEDBACK_REPORT_LIMITS.attachmentCount);
  if (!attachments.ok) {
    if (attachments.reason === "limit") return failure("attachment-count-limit", "attachments");
    return failure(
      attachments.reason === "not-array" ? "invalid-type" : "invalid-shape",
      "attachments",
    );
  }
  const candidates: DataRecord[] = [];
  for (const candidate of attachments.value) {
    const snapshot = nestedRecord(
      candidate,
      ATTACHMENT_CANDIDATE_KEYS,
      "attachments",
      "unknown-field",
    );
    if (!snapshot.ok) return snapshot;
    const bytes = snapshotBytes(snapshot.value.bytes);
    if (!bytes.ok) {
      return failure(bytes.reason === "limit" ? "field-byte-limit" : "invalid-type", "attachments");
    }
    snapshot.value.bytes = bytes.value;
    candidates.push(snapshot.value);
  }
  return { ok: true, value: { attachments: candidates } };
}

export function snapshotFeedbackReportInput(value: unknown): FeedbackInputSnapshot {
  const report = nestedRecord(value, REPORT_KEYS, "report", "unknown-field");
  if (!report.ok) return report;
  const provenance = snapshotProvenance(report.value.redactionProvenance);
  if (!provenance.ok) return provenance;
  report.value.redactionProvenance = provenance.value;
  if (report.value.summary !== undefined) {
    const summary = nestedRecord(report.value.summary, SUMMARY_KEYS, "summary", "unknown-field");
    if (!summary.ok) return summary;
    report.value.summary = summary.value;
  }
  if (report.value.attachments !== undefined) {
    const attachments = snapshotAttachments(report.value.attachments);
    if (!attachments.ok) return attachments;
    report.value.attachments = attachments.value.attachments;
  }
  const diagnostics = snapshotDiagnostics(report.value.diagnostics);
  if (!diagnostics.ok) return diagnostics;
  report.value.diagnostics = diagnostics.value;
  return report;
}

export function snapshotFeedbackDraftInput(value: unknown): FeedbackInputSnapshot {
  const draft = nestedRecord(value, DRAFT_KEYS, "report", "unknown-field");
  if (!draft.ok) return draft;
  if (draft.value.diagnostics !== undefined) {
    const diagnostics = snapshotCounts(draft.value.diagnostics);
    if (!diagnostics.ok) return diagnostics;
    draft.value.diagnostics = diagnostics.value;
  }
  if (draft.value.attachments !== undefined) {
    const attachments = snapshotDraftAttachments(draft.value.attachments);
    if (!attachments.ok) return attachments;
    draft.value.attachments = attachments.value.attachments;
  }
  return draft;
}
