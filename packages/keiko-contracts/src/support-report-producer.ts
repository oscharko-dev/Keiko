import {
  DEFECT_FINGERPRINT_ALGORITHM_VERSION,
  SUPPORT_INCIDENT_SCHEMA_VERSION,
  SUPPORT_INCIDENT_TTL_MS,
  SUPPORT_INCIDENT_UNATTRIBUTED,
  parseSupportIncidentPrivateProjection,
  supportIncidentWindow,
  type SupportIncidentBuild,
  type SupportIncidentPrivateProjection,
} from "./support-incident.js";
import {
  SUPPORT_REPORT_KIND,
  SUPPORT_REPORT_SCHEMA_VERSION,
  type SupportReport,
  type SupportReportEvidence,
  type SupportReportSelection,
} from "./support-report.js";
import { canonicalSupportJson, SupportReportError } from "./support-report-json.js";
import { KEIKO_PRODUCT_VERSION } from "./version.js";

export type SupportReportSectionDigests = Pick<
  SupportReport["integrity"],
  "incidentDigest" | "selectionDigest" | "evidenceDigest"
>;
export type UnsignedSupportReport = Omit<SupportReport, "integrity"> & {
  readonly integrity: Omit<SupportReport["integrity"], "reportDigest">;
};

/** Crypto adapters supply digests of the same canonical sections in every runtime. */
export function buildSupportReportEnvelope(
  incident: SupportIncidentPrivateProjection,
  selection: SupportReportSelection,
  evidence: SupportReportEvidence,
  digests: SupportReportSectionDigests,
  minimumAnalyzerVersion: string = KEIKO_PRODUCT_VERSION,
): UnsignedSupportReport {
  return {
    kind: SUPPORT_REPORT_KIND,
    schemaVersion: SUPPORT_REPORT_SCHEMA_VERSION,
    minimumAnalyzerVersion,
    incident,
    selection,
    evidence,
    integrity: { algorithm: "sha256", authenticity: "unknown", ...digests },
  };
}

export function sealSupportReportEnvelope(
  unsigned: UnsignedSupportReport,
  reportDigest: string,
): SupportReport {
  return { ...unsigned, integrity: { ...unsigned.integrity, reportDigest } };
}

export function serializeSupportReport(report: SupportReport): string {
  return `${canonicalSupportJson(report)}\n`;
}

/** The existing level-nine deflate encoder's canonical empty event array, verified by parity tests. */
export const EMPTY_SUPPORT_REPORT_EVIDENCE: SupportReportEvidence = Object.freeze({
  encoding: "deflate-base64",
  rawBytes: 2,
  recordCount: 0,
  digest: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  payload: "eNqLjgUAARUAuQ==",
});

export interface ClientOnlySupportReportInput {
  readonly incidentId: string;
  readonly nowMs: number;
  readonly build: SupportIncidentBuild;
  readonly defectFingerprint: string;
  readonly availabilityReason: NonNullable<
    SupportIncidentPrivateProjection["clientReport"]
  >["availabilityReason"];
}

function clientOnlyIncident(input: ClientOnlySupportReportInput): SupportIncidentPrivateProjection {
  return {
    schemaVersion: SUPPORT_INCIDENT_SCHEMA_VERSION,
    incidentId: input.incidentId,
    defectFingerprint: input.defectFingerprint,
    fingerprintAlgorithm: DEFECT_FINGERPRINT_ALGORITHM_VERSION,
    trigger: "user-report",
    state: "candidate",
    productVersion: input.build.productVersion,
    platformClass: input.build.platformClass,
    surface: SUPPORT_INCIDENT_UNATTRIBUTED,
    op: SUPPORT_INCIDENT_UNATTRIBUTED,
    errorKind: "unknown",
    frameCount: 0,
    build: input.build,
    correlation: { rootCorrelationId: "id000001", childCorrelationIds: [] },
    window: supportIncidentWindow(input.nowMs),
    pin: {
      status: "rejected",
      pinnedBytes: 0,
      pinnedSegmentCount: 0,
      evidenceLostBeforePin: false,
    },
    segments: [],
    lineCount: 0,
    integrity: "supported",
    completeness: "complete",
    loss: "none",
    sufficiencyStatus: "insufficient",
    sufficiencyReasons: ["no-registered-failure", "no-registered-evidence"],
    coverage: {
      completeClassCount: 0,
      degradedClassCount: 0,
      insufficientClassCount: 0,
      presentClassCount: 0,
      requiredClassCount: 0,
    },
    createdAtMs: input.nowMs,
    expiresAtMs: input.nowMs + SUPPORT_INCIDENT_TTL_MS,
    clientReport: { serverEvidence: "unavailable", availabilityReason: input.availabilityReason },
  };
}

/** No log, filesystem, endpoint, customer text or correlation enters this limited artifact. */
export function clientOnlySupportReportSections(
  input: ClientOnlySupportReportInput,
): Pick<SupportReport, "incident" | "selection" | "evidence"> {
  const incident = parseSupportIncidentPrivateProjection(clientOnlyIncident(input));
  if (incident === undefined) throw new SupportReportError("unsafe-report");
  return {
    incident,
    selection: {
      status: "insufficient",
      reasons: ["no-registered-evidence", "no-registered-failure", "evidence-not-retained"],
      requiredBytes: 0,
      lifetimes: [],
    },
    evidence: EMPTY_SUPPORT_REPORT_EVIDENCE,
  };
}
