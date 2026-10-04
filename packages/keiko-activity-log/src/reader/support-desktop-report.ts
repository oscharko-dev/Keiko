// Desktop composition uses the same incident, query and canonical serializer as CLI export.
import { randomUUID } from "node:crypto";
import { incidentCorrelationId } from "../defect-fingerprint.js";
import {
  MAX_SUPPORT_REPORT_EVENT_BYTES,
  supportIncidentPrivateProjection,
  supportReportFileName,
  type DesktopSupportReportResponse,
  type SupportIncidentDescriptorRecord,
  type SupportReport,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  listSupportIncidents,
  SUPPORT_INCIDENT_WINDOW_BEFORE_MS,
  recordUserReportedIncident,
  prepareUnretainedUserReportIncident,
  prepareUnretainedUserReportDescriptor,
  supportIncidentSegmentFiles,
  type SupportIncidentRejection,
} from "../support-incident.js";
import { listSupportIncidentEntries } from "../support-incident-store.js";
import { attributeUnretainedReportFailure } from "./support-desktop-report-attribution.js";
import {
  DEFAULT_SUPPORT_QUERY_LIMITS,
  runSupportQuery,
  type SupportQuerySelection,
  type SupportQueryResult,
} from "./support-query.js";
import { executeLocalSupportQuery } from "./support-local-query.js";
import { ActivityLogScanner, ensureSegmentManifests } from "./support-segment-scan.js";
import { resolveSelectedSupportIncident } from "./support-incident-resolution.js";
import {
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
): SupportIncidentDescriptorRecord {
  const created = recordUserReportedIncident(stateDir, { correlationId });
  if (created.status === "rejected") {
    if (created.reason === "quota-exhausted") {
      return prepareUnretainedUserReportIncident(stateDir, correlationId);
    }
    throw new DesktopSupportReportPreparationError(created.reason);
  }
  if (created.record === undefined) throw new SupportReportError("selection-unavailable");
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

/** Only the owner thread creates incidents and retention pins. No log-content scan runs here. */
export function prepareDesktopSupportReport(
  stateDir: string,
  correlationId?: string,
  requestCorrelationId?: string,
): SupportIncidentDescriptorRecord {
  const existing =
    correlationId === undefined
      ? undefined
      : listSupportIncidents(stateDir).find(
          (record) => record.correlation.rootCorrelationId === correlationId,
        );
  return (
    existing ??
    prepareManualSupportReportIncident(
      stateDir,
      correlationId ?? requestCorrelationId ?? randomUUID(),
    )
  );
}

function recentFailureCorrelation(stateDir: string): string | undefined {
  const now = Date.now();
  const records = listSupportIncidentEntries(stateDir)
    .flatMap((entry) => {
      const record = entry.record;
      return record?.trigger === "registered-failure" &&
        !record.fingerprint.op.startsWith("support.report.") &&
        record.expiresAtMs > now &&
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
  const selected = correlationId ?? recentFailureCorrelation(stateDir);
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
  const report = buildSupportReport(
    incidentDescriptor(attributeUnretainedReportFailure(record, evidence.result), evidence.result),
    evidence.result,
  );
  return desktopReportResponse(
    report,
    evidence.manifestStats.unreadableCount,
    evidence.manifestStats.reusedCount,
  );
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
): DesktopSupportReportResponse {
  const selectedCorrelation = incidentCorrelationId(correlationId) ?? randomUUID();
  const scanner = new ActivityLogScanner("");
  const pass = ensureSegmentManifests("", [], scanner, {
    trigger: "export",
    persist: false,
    rebuild: false,
  });
  const query = runSupportQuery({
    files: [],
    scanner,
    manifests: pass.manifests,
    manifestStats: pass.stats,
    selection: { ...correlationSelection(selectedCorrelation), roots: [] },
    limits: REPORT_QUERY_LIMITS,
  });
  const incident = incidentDescriptor(
    prepareUnretainedUserReportDescriptor(selectedCorrelation),
    query,
  );
  const report = buildSupportReport(
    { ...incident, clientReport: { serverEvidence: "unavailable", availabilityReason } },
    query,
  );
  return desktopReportResponse(report, 0, 0, "client-only");
}

function desktopReportResponse(
  report: SupportReport,
  manifestUnreadableCount: number,
  manifestReusedCount: number,
  evidenceScope?: "client-only",
): DesktopSupportReportResponse {
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
      manifestUnreadableCount,
      manifestReusedCount,
    },
  };
}
