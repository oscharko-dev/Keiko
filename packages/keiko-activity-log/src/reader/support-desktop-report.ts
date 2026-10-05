// Desktop composition uses the same incident, query and canonical serializer as CLI export.
import { randomBytes, randomUUID } from "node:crypto";
import { computeDefectFingerprint } from "../defect-fingerprint.js";
import { serverLogProcessIdentity, reportServerLogFailure } from "../server-log.js";
import {
  clientOnlySupportReportSections,
  normalizeSupportReportCorrelationId,
  parseSupportIncidentRecord,
  supportIncidentBuild,
  supportIncidentEffectiveExpiry,
  UNATTRIBUTED_DEFECT_FINGERPRINT_INPUT,
  MAX_SUPPORT_REPORT_EVENT_BYTES,
  supportIncidentPrivateProjection,
  supportReportFileName,
  type DesktopSupportReportResponse,
  type SupportIncidentDescriptorRecord,
  type SupportIncidentRecord,
  type SupportReport,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  listSupportIncidents,
  SUPPORT_INCIDENT_WINDOW_BEFORE_MS,
  recordUserReportedIncident,
  prepareUnretainedUserReportDescriptor,
  supportIncidentSegmentFiles,
  type SupportIncidentRejection,
} from "../support-incident.js";
import {
  DEFAULT_SUPPORT_QUERY_LIMITS,
  type SupportQuerySelection,
  type SupportQueryResult,
} from "./support-query.js";
import { executeLocalSupportQuery } from "./support-local-query.js";
import { resolveSelectedSupportIncident } from "./support-incident-resolution.js";
import {
  sealSupportReport,
  buildSupportReport,
  serializeSupportReport,
  SupportReportError,
} from "./support-report.js";

const REPORT_QUERY_LIMITS = {
  ...DEFAULT_SUPPORT_QUERY_LIMITS,
  maxResultBytes: MAX_SUPPORT_REPORT_EVENT_BYTES,
};

export class DesktopSupportReportPreparationError extends Error {
  public constructor(public readonly reason: SupportIncidentRejection) {
    super("Support report incident unavailable");
    this.name = "DesktopSupportReportPreparationError";
  }
}

function correlationSelection(
  correlationId: string,
): Extract<SupportQuerySelection, { kind: "closure" }> {
  return {
    kind: "closure",
    queryClass: "correlation",
    roots: [correlationId],
    windows: [],
    requiredClasses: { kind: "observed" },
    unresolved: false,
  };
}

export function prepareManualSupportReportIncident(
  stateDir: string,
  correlationId: string,
  onCreated?: (record: SupportIncidentRecord) => void,
): SupportIncidentDescriptorRecord {
  const safeCorrelationId = normalizeSupportReportCorrelationId(correlationId) ?? randomUUID();
  const created = recordUserReportedIncident(stateDir, { correlationId: safeCorrelationId });
  if (created.status === "rejected") {
    if (
      created.reason === "quota-exhausted" ||
      created.reason === "store-unavailable" ||
      created.reason === "record-too-large"
    ) {
      return prepareUnretainedUserReportDescriptor(safeCorrelationId);
    }
    throw new DesktopSupportReportPreparationError(created.reason);
  }
  if (created.record === undefined) throw new SupportReportError("selection-unavailable");
  if (created.status === "created") onCreated?.(created.record);
  return created.record;
}

function incidentDescriptor(
  record: SupportIncidentDescriptorRecord,
  selected: SupportQueryResult,
): SupportReport["incident"] {
  return supportIncidentPrivateProjection(resolveSelectedSupportIncident(record, selected));
}

function incidentSelection(
  stateDir: string,
  record: SupportIncidentDescriptorRecord,
): SupportQuerySelection {
  const segmentIds = new Set(
    supportIncidentSegmentFiles(stateDir, record).map((segment) => segment.segmentId),
  );
  return {
    kind: "closure",
    queryClass: "incident",
    roots: [],
    windows: [{ fromMs: record.window.fromMs, toMs: record.window.toMs, segmentIds }],
    requiredClasses: { kind: "observed-failures" },
    unresolved: false,
  };
}

/** Read a manual descriptor's bounded window without requiring a persistent candidate slot. */
export function readManualSupportReportEvidence(
  stateDir: string,
  record: SupportIncidentDescriptorRecord,
): ReturnType<typeof executeLocalSupportQuery> {
  return executeLocalSupportQuery(
    stateDir,
    incidentSelection(stateDir, record),
    REPORT_QUERY_LIMITS,
    {
      trigger: "export",
      persist: false,
    },
  );
}

function retainedReportCandidates(
  stateDir: string,
  correlationId?: string,
): readonly SupportIncidentRecord[] {
  try {
    return listSupportIncidents(stateDir, { readOnly: true });
  } catch (error) {
    // Candidate storage is optional for exporting separately guarded, readable Activity Log
    // evidence. Retain the failed lookup's cause; the creation attempt records its own refusal.
    reportServerLogFailure(error, { op: "support.incident.rejected", correlationId });
    return [];
  }
}

/** Only the owner creates incidents/pins; the legacy third argument never supplies an incident root. */
export function prepareDesktopSupportReport(
  stateDir: string,
  correlationId?: string,
  _requestCorrelationId?: string,
  onCreated?: (record: SupportIncidentRecord) => void,
): SupportIncidentDescriptorRecord {
  const selected = normalizeSupportReportCorrelationId(correlationId);
  const existing =
    selected === undefined
      ? undefined
      : retainedReportCandidates(stateDir, selected).find(
          (record) => record.correlation.rootCorrelationId === selected,
        );
  return (
    existing ?? prepareManualSupportReportIncident(stateDir, selected ?? randomUUID(), onCreated)
  );
}

function recentFailureCorrelation(stateDir: string): string | undefined {
  const now = Date.now();
  const records = retainedReportCandidates(stateDir)
    .flatMap((record) => {
      return record.trigger === "registered-failure" &&
        !record.fingerprint.op.startsWith("support.report.") &&
        supportIncidentEffectiveExpiry(record) > now &&
        record.createdAtMs >= now - SUPPORT_INCIDENT_WINDOW_BEFORE_MS
        ? [record]
        : [];
    })
    .sort((left, right) => right.createdAtMs - left.createdAtMs);
  return records[0]?.correlation.rootCorrelationId;
}

export interface DesktopSupportReportSelection {
  readonly correlationId: string | undefined;
  readonly evidence?: ReturnType<typeof executeLocalSupportQuery> | undefined;
}

export function readDesktopSupportReportSelection(
  stateDir: string,
  correlationId?: string,
): DesktopSupportReportSelection {
  const normalized = normalizeSupportReportCorrelationId(correlationId);
  if (correlationId !== undefined && normalized === undefined)
    throw new SupportReportError("selection-unavailable");
  const selected = normalized ?? recentFailureCorrelation(stateDir);
  if (selected === undefined) return { correlationId: undefined };
  const evidence = executeLocalSupportQuery(
    stateDir,
    correlationSelection(selected),
    REPORT_QUERY_LIMITS,
    { trigger: "export", persist: false },
  );
  if (evidence.result.events.length === 0) throw new SupportReportError("selection-unavailable");
  return { correlationId: selected, evidence };
}

/** Read-only selection: validate a requested error or reuse the most recent retained failure. */
export function validateDesktopSupportReportSelection(
  stateDir: string,
  correlationId?: string,
): string | undefined {
  return readDesktopSupportReportSelection(stateDir, correlationId).correlationId;
}

/** Read-only composition: safe to run off the server request event loop. */
export function createPreparedDesktopSupportReport(
  stateDir: string,
  record: SupportIncidentDescriptorRecord,
  correlationId?: string,
  selectedEvidence?: ReturnType<typeof executeLocalSupportQuery>,
): DesktopSupportReportResponse {
  const selection =
    correlationId === undefined
      ? incidentSelection(stateDir, record)
      : correlationSelection(correlationId);
  const evidence =
    selectedEvidence ??
    executeLocalSupportQuery(stateDir, selection, REPORT_QUERY_LIMITS, {
      trigger: "export",
      persist: false,
    });
  const report = buildSupportReport(incidentDescriptor(record, evidence.result), evidence.result);
  return desktopReportResponse(report, {
    manifestUnreadableCount: evidence.manifestStats.unreadableCount,
    manifestReusedCount: evidence.manifestStats.reusedCount,
    retentionDisposition: parseSupportIncidentRecord(record) === undefined ? "transient" : "stored",
  });
}

export function createDesktopSupportReport(
  stateDir: string,
  correlationId?: string,
): DesktopSupportReportResponse {
  const selected = readDesktopSupportReportSelection(stateDir, correlationId);
  return createPreparedDesktopSupportReport(
    stateDir,
    prepareDesktopSupportReport(stateDir, selected.correlationId),
    selected.correlationId,
    selected.evidence,
  );
}

/** Canonical browser availability artifact. No private state directory or log is consulted. */
export function createClientOnlySupportReport(
  correlationId: string | undefined,
  availabilityReason: NonNullable<SupportReport["incident"]["clientReport"]>["availabilityReason"],
  failure?: NonNullable<SupportReport["incident"]["clientReport"]>["failure"],
): DesktopSupportReportResponse {
  const identity = serverLogProcessIdentity();
  const sections = clientOnlySupportReportSections({
    incidentId: randomBytes(16).toString("hex"),
    nowMs: Date.now(),
    build: supportIncidentBuild(identity.productVersion, identity.platformClass),
    defectFingerprint: computeDefectFingerprint(UNATTRIBUTED_DEFECT_FINGERPRINT_INPUT),
    availabilityReason,
    ...(failure === undefined ? {} : { failure }),
    correlationId,
  });
  const report = sealSupportReport(sections.incident, sections.selection, sections.evidence);
  return desktopReportResponse(report, {
    manifestUnreadableCount: 0,
    manifestReusedCount: 0,
    evidenceScope: "client-only",
  });
}

interface DesktopReportResponseOptions {
  readonly manifestUnreadableCount: number;
  readonly manifestReusedCount: number;
  readonly evidenceScope?: "client-only";
  readonly retentionDisposition?: NonNullable<
    DesktopSupportReportResponse["summary"]
  >["retentionDisposition"];
}

function desktopReportResponse(
  report: SupportReport,
  options: DesktopReportResponseOptions,
): DesktopSupportReportResponse {
  const { manifestUnreadableCount, manifestReusedCount, evidenceScope, retentionDisposition } =
    options;
  return {
    ...(evidenceScope === undefined ? {} : { evidenceScope }),
    fileName: supportReportFileName(
      report.schemaVersion,
      report.incident.incidentId,
      report.incident.createdAtMs,
    ),
    reportJson: serializeSupportReport(report),
    summary: {
      status: report.selection.status,
      reasons: report.selection.reasons,
      recordCount: report.evidence.recordCount,
      reportDigest: report.integrity.reportDigest,
      incidentId: report.incident.incidentId,
      incidentTrigger: report.incident.trigger,
      manifestUnreadableCount,
      manifestReusedCount,
      completeness: report.incident.completeness,
      loss: report.incident.loss,
      ...(retentionDisposition === "stored" ? { pinDisposition: report.incident.pin.status } : {}),
      ...(retentionDisposition === undefined ? {} : { retentionDisposition }),
      ...(report.incident.clientReport === undefined
        ? {}
        : { availabilityReason: report.incident.clientReport.availabilityReason }),
    },
  };
}
