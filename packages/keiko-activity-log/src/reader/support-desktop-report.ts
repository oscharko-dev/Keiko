// Desktop composition uses the same incident, query and canonical serializer as CLI export.
import { randomUUID } from "node:crypto";
import {
  MAX_SUPPORT_REPORT_EVENT_BYTES,
  supportIncidentPrivateProjection,
  supportReportFileName,
  type DesktopSupportReportResponse,
  type SupportIncidentRecord,
  type SupportReport,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  listSupportIncidents,
  recordUserReportedIncident,
  supportIncidentSegmentFiles,
} from "../support-incident.js";
import { DEFAULT_SUPPORT_QUERY_LIMITS, type SupportQuerySelection } from "./support-query.js";
import { executeLocalSupportQuery } from "./support-local-query.js";
import {
  resolveSupportIncident,
  unresolvedSupportIncident,
  SupportIncidentWindowError,
} from "./support-incident-resolution.js";
import {
  buildSupportReport,
  serializeSupportReport,
  SupportReportError,
} from "./support-report.js";

const REPORT_QUERY_LIMITS = {
  ...DEFAULT_SUPPORT_QUERY_LIMITS,
  maxResultBytes: MAX_SUPPORT_REPORT_EVENT_BYTES,
};

function correlationSelection(correlationId: string): SupportQuerySelection {
  return {
    kind: "closure",
    queryClass: "correlation",
    roots: [correlationId],
    windows: [],
    requiredClasses: { kind: "observed" },
    unresolved: false,
  };
}

function createReportIncident(stateDir: string, correlationId: string): SupportIncidentRecord {
  const created = recordUserReportedIncident(stateDir, { correlationId });
  if (created.status === "rejected" || created.record === undefined)
    throw new SupportReportError("selection-unavailable");
  return created.record;
}

function incidentDescriptor(
  stateDir: string,
  record: SupportIncidentRecord,
): SupportReport["incident"] {
  const segments = supportIncidentSegmentFiles(stateDir, record);
  try {
    return supportIncidentPrivateProjection(resolveSupportIncident(record, segments, stateDir));
  } catch (error) {
    if (!(error instanceof SupportIncidentWindowError)) throw error;
    return supportIncidentPrivateProjection(
      unresolvedSupportIncident(record, segments, error.reason),
    );
  }
}

function incidentSelection(stateDir: string, record: SupportIncidentRecord): SupportQuerySelection {
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

/** Only the owner thread creates incidents and retention pins. No log-content scan runs here. */
export function prepareDesktopSupportReport(
  stateDir: string,
  correlationId?: string,
): SupportIncidentRecord {
  const existing =
    correlationId === undefined
      ? undefined
      : listSupportIncidents(stateDir).find(
          (record) => record.correlation.rootCorrelationId === correlationId,
        );
  return existing ?? createReportIncident(stateDir, correlationId ?? randomUUID());
}

/** Validate a specific error before the owner creates a retained incident for it. */
export function validateDesktopSupportReportSelection(
  stateDir: string,
  correlationId?: string,
): void {
  if (correlationId === undefined) return;
  const query = executeLocalSupportQuery(
    stateDir,
    correlationSelection(correlationId),
    REPORT_QUERY_LIMITS,
    { trigger: "export", persist: false },
  );
  if (query.result.events.length === 0) throw new SupportReportError("selection-unavailable");
}

/** Read-only composition: safe to run off the server request event loop. */
export function createPreparedDesktopSupportReport(
  stateDir: string,
  record: SupportIncidentRecord,
  correlationId?: string,
): DesktopSupportReportResponse {
  const selection =
    correlationId === undefined
      ? incidentSelection(stateDir, record)
      : correlationSelection(correlationId);
  const evidence = executeLocalSupportQuery(stateDir, selection, REPORT_QUERY_LIMITS, {
    trigger: "export",
    persist: false,
  });
  const report = buildSupportReport(incidentDescriptor(stateDir, record), evidence.result);
  return {
    fileName: supportReportFileName(
      report.schemaVersion,
      report.incident.incidentId,
      report.incident.createdAtMs,
    ),
    reportJson: serializeSupportReport(report),
  };
}

export function createDesktopSupportReport(
  stateDir: string,
  correlationId?: string,
): DesktopSupportReportResponse {
  validateDesktopSupportReportSelection(stateDir, correlationId);
  return createPreparedDesktopSupportReport(
    stateDir,
    prepareDesktopSupportReport(stateDir, correlationId),
    correlationId,
  );
}
