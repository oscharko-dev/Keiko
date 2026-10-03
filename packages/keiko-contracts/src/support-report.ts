import type { DiagnosticSufficiencyReason, DiagnosticSufficiencyStatus } from "./observability.js";
import type { SupportIncidentPrivateProjection } from "./support-incident.js";

export const SUPPORT_REPORT_KIND = "keiko.support.report";
/** The default export directory under the state directory. */
export const SUPPORT_REPORT_DIRECTORY_NAME = "support-reports";
export const SUPPORT_REPORT_SCHEMA_VERSION = 1;
export const MAX_SUPPORT_REPORT_BYTES = 10 * 1024 * 1024;
export const MAX_SUPPORT_REPORT_EVENT_BYTES = 16 * 1024 * 1024;
export const MAX_SUPPORT_REPORT_INCIDENT_BYTES = 1024 * 1024;
export const MAX_SUPPORT_REPORT_RECORD_BYTES = 64 * 1024;
export const MAX_SUPPORT_REPORT_RECORDS = 20_000;
export const MAX_SUPPORT_REPORT_DEPTH = 12;
// Shape bounds checked before JSON.parse allocates untrusted text: a small deflated payload such
// as `[{},{},…]` would otherwise expand into millions of objects. Arrays are bounded by
// MAX_SUPPORT_REPORT_RECORDS. Legitimate reports stay far below each bound (#3534).
export const MAX_SUPPORT_REPORT_CONTAINERS = 250_000;
export const MAX_SUPPORT_REPORT_VALUES = 3_000_000;
export const MAX_SUPPORT_REPORT_OBJECT_KEYS = 256;
export const MAX_SUPPORT_REPORT_TIMELINE_RECORDS = 80_000;
export const MAX_SUPPORT_REPORT_TIMELINE_BYTES = 64 * 1024 * 1024;

/**
 * Why a report export or analysis stopped. The first four judge a report; legacy-input names a
 * retired open JSONL bundle or raw Activity Log handed to analyze, which must be regenerated on its
 * originating installation; selection-unavailable names a requested incident, correlation or
 * fingerprint that does not exist or cannot be read; seed-unavailable a replay preparation the
 * validated evidence cannot support.
 */
export const SUPPORT_REPORT_FAILURES = [
  "corrupt-report",
  "unsafe-report",
  "unsupported-report",
  "report-budget-exceeded",
  "legacy-input",
  "selection-unavailable",
  "seed-unavailable",
] as const;
export type SupportReportFailure = (typeof SUPPORT_REPORT_FAILURES)[number];

/**
 * How a process lifetime the evidence shows accounts for its start (#3534): `selected` travels in
 * the evidence, `absent` means its whole beginning is held and never had one (a one-shot command),
 * and `lost` means the log can no longer account for it.
 */
export type SupportLifetimeStart = "selected" | "absent" | "lost";

export interface SupportLifetimeProvenance {
  readonly pid: number;
  readonly instanceId: string;
  readonly start: SupportLifetimeStart;
}

export interface SupportReportSelection {
  readonly status: DiagnosticSufficiencyStatus;
  readonly reasons: readonly DiagnosticSufficiencyReason[];
  readonly requiredBytes: number;
  // Exactly the lifetimes the evidence shows, in (pid, instanceId) order.
  readonly lifetimes: readonly SupportLifetimeProvenance[];
}

export interface SupportReportEvidence {
  readonly encoding: "deflate-base64";
  readonly rawBytes: number;
  readonly recordCount: number;
  readonly digest: string;
  readonly payload: string;
}

/** Integrity detects corruption. It never authenticates an untrusted sender. */
export interface SupportReport {
  readonly kind: typeof SUPPORT_REPORT_KIND;
  readonly schemaVersion: typeof SUPPORT_REPORT_SCHEMA_VERSION;
  readonly minimumAnalyzerVersion: string;
  readonly incident: SupportIncidentPrivateProjection;
  readonly selection: SupportReportSelection;
  readonly evidence: SupportReportEvidence;
  readonly integrity: {
    readonly algorithm: "sha256";
    readonly authenticity: "unknown";
    readonly incidentDigest: string;
    readonly selectionDigest: string;
    readonly evidenceDigest: string;
    readonly reportDigest: string;
  };
}

export interface SupportReportEvent {
  readonly sourceSegmentId: string;
  readonly record: Readonly<Record<string, unknown>>;
}

const SUPPORT_REPORT_FILE_NAME_PATTERN =
  /^keiko-support-v[1-9]\d{0,3}-[a-f0-9]{12}-\d{4}-\d{2}-\d{2}\.json$/u;

/**
 * The closed report file name: product prefix, schema version, incident prefix and the incident's
 * UTC date. It never carries a host, user, workspace or path name.
 */
export function supportReportFileName(
  schemaVersion: number,
  incidentId: string,
  createdAtMs: number,
): string {
  const date = new Date(createdAtMs).toISOString().slice(0, 10);
  return `keiko-support-v${String(schemaVersion)}-${incidentId.slice(0, 12)}-${date}.json`;
}

export function isSupportReportFileName(name: string): boolean {
  return SUPPORT_REPORT_FILE_NAME_PATTERN.test(name);
}
