import type { DiagnosticSufficiencyReason, DiagnosticSufficiencyStatus } from "./observability.js";
import type { SupportIncidentPrivateProjection } from "./support-incident.js";

export const SUPPORT_REPORT_KIND = "keiko.support.report";
export const SUPPORT_REPORT_SCHEMA_VERSION = 1;
export const MAX_SUPPORT_REPORT_BYTES = 10 * 1024 * 1024;
export const MAX_SUPPORT_REPORT_EVENT_BYTES = 16 * 1024 * 1024;
export const MAX_SUPPORT_REPORT_INCIDENT_BYTES = 1024 * 1024;
export const MAX_SUPPORT_REPORT_RECORD_BYTES = 64 * 1024;
export const MAX_SUPPORT_REPORT_RECORDS = 20_000;
export const MAX_SUPPORT_REPORT_DEPTH = 12;
export const MAX_SUPPORT_REPORT_TIMELINE_RECORDS = 80_000;
export const MAX_SUPPORT_REPORT_TIMELINE_BYTES = 64 * 1024 * 1024;

export interface SupportReportSelection {
  readonly status: DiagnosticSufficiencyStatus;
  readonly reasons: readonly DiagnosticSufficiencyReason[];
  readonly requiredBytes: number;
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
