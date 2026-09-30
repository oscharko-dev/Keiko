import { projectSupportLogFields } from "../log-redaction.js";
import { deflateSync, inflateSync } from "node:zlib";
import {
  SUPPORT_REPORT_KIND,
  SUPPORT_REPORT_SCHEMA_VERSION,
  MAX_SUPPORT_REPORT_BYTES,
  MAX_SUPPORT_REPORT_INCIDENT_BYTES,
  MAX_SUPPORT_REPORT_RECORD_BYTES,
  MAX_SUPPORT_REPORT_EVENT_BYTES,
  MAX_SUPPORT_REPORT_RECORDS,
  DIAGNOSTIC_SUFFICIENCY_REASONS,
  diagnosticSufficiencyStatus,
  isActivityLogIdentityDigest,
  isActivityLogProductVersion,
  parseActivityLogSegmentId,
  parseSupportIncidentPrivateProjection,
  type SupportIncidentPrivateProjection,
  type SupportReport,
  type SupportReportEvent,
  type SupportReportEvidence,
  type SupportReportSelection,
  type DiagnosticSufficiencyReason,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { KEIKO_PRODUCT_VERSION } from "@oscharko-dev/keiko-contracts/runtime/version";
import {
  analyzeLogText,
  buildReproductionSeedFromAnalysis,
  isSupportReportEvent,
  findTimeline,
  type AnalyzeAllResult,
  type SupportAnalyzeOptions,
  type ReproductionSeed,
} from "./support-analyze.js";
import {
  activityLogFailureClassesOf,
  restrictActivityLogSufficiency,
} from "./support-analyze-sufficiency.js";
import type { SupportQueryResult } from "./support-query.js";
import { type SupportReaderRegistry } from "./support-registry.js";
import { findSupportRegistry } from "./support-registry-history.js";
import {
  canonicalSupportJson,
  parseCanonicalSupportJson,
  reportCount,
  reportKeys,
  reportObject,
  SupportReportError,
  supportReportDigest,
} from "./support-report-json.js";

export {
  canonicalSupportJson,
  SupportReportError,
  supportReportDigest,
} from "./support-report-json.js";

const REPORT_KEYS = [
  "kind",
  "schemaVersion",
  "minimumAnalyzerVersion",
  "incident",
  "selection",
  "evidence",
  "integrity",
] as const;
const INTEGRITY_KEYS = [
  "algorithm",
  "authenticity",
  "incidentDigest",
  "selectionDigest",
  "evidenceDigest",
  "reportDigest",
] as const;

function reasons(
  values: readonly DiagnosticSufficiencyReason[],
): readonly DiagnosticSufficiencyReason[] {
  return DIAGNOSTIC_SUFFICIENCY_REASONS.filter((reason) => values.includes(reason));
}

export function encodeSupportReportEvidence(
  events: readonly SupportReportEvent[],
): SupportReportEvidence {
  if (
    events.some(
      (event) => Buffer.byteLength(canonicalSupportJson(event)) > MAX_SUPPORT_REPORT_RECORD_BYTES,
    )
  )
    throw new SupportReportError("report-budget-exceeded");
  const text = canonicalSupportJson(events);
  const rawBytes = Buffer.byteLength(text);
  if (rawBytes > MAX_SUPPORT_REPORT_EVENT_BYTES)
    throw new SupportReportError("report-budget-exceeded");
  return {
    encoding: "deflate-base64",
    rawBytes,
    recordCount: events.length,
    digest: supportReportDigest(text),
    payload: deflateSync(text, { level: 9 }).toString("base64"),
  };
}

export function sealSupportReport(
  incident: SupportIncidentPrivateProjection,
  selection: SupportReportSelection,
  evidence: SupportReportEvidence,
): SupportReport {
  const integrity = {
    algorithm: "sha256" as const,
    authenticity: "unknown" as const,
    incidentDigest: supportReportDigest(canonicalSupportJson(incident)),
    selectionDigest: supportReportDigest(canonicalSupportJson(selection)),
    evidenceDigest: supportReportDigest(canonicalSupportJson(evidence)),
  };
  const unsigned = {
    kind: SUPPORT_REPORT_KIND as typeof SUPPORT_REPORT_KIND,
    schemaVersion: SUPPORT_REPORT_SCHEMA_VERSION as typeof SUPPORT_REPORT_SCHEMA_VERSION,
    minimumAnalyzerVersion: KEIKO_PRODUCT_VERSION,
    incident,
    selection,
    evidence,
    integrity,
  };
  return {
    ...unsigned,
    integrity: { ...integrity, reportDigest: supportReportDigest(canonicalSupportJson(unsigned)) },
  };
}

function queryEvents(query: SupportQueryResult): readonly SupportReportEvent[] {
  return query.events.map((event) => {
    const record: unknown = JSON.parse(event.text);
    if (!reportObject(record)) throw new SupportReportError("unsafe-report");
    return {
      sourceSegmentId: event.file.segmentId ?? "legacy",
      record: projectSupportLogFields(record),
    };
  });
}

function selectedEvidence(
  incident: SupportIncidentPrivateProjection,
  query: SupportQueryResult,
  registry: SupportReaderRegistry,
): { evidence: SupportReportEvidence; selectedReasons: readonly DiagnosticSufficiencyReason[] } {
  let events = queryEvents(query);
  let selectedReasons = reasons([
    ...query.diagnosticSufficiency.reasons,
    ...incident.sufficiencyReasons,
  ]);
  if (!events.every((event) => isSupportReportEvent(event.record, registry))) {
    events = [];
    selectedReasons = reasons([...selectedReasons, "unsupported-evidence"]);
  }
  let evidence: SupportReportEvidence;
  try {
    evidence = encodeSupportReportEvidence(events);
  } catch (error) {
    if (!(error instanceof SupportReportError) || error.reason !== "report-budget-exceeded")
      throw error;
    events = [];
    evidence = encodeSupportReportEvidence([]);
    selectedReasons = reasons([...selectedReasons, "report-budget-exceeded"]);
  }
  selectedReasons = reasons([
    ...selectedReasons,
    ...projectedEvidenceReasons(incident, events, registry),
  ]);
  return { evidence, selectedReasons };
}

/** Generates only the canonical private projection and registered causal evidence. */
export function buildSupportReport(
  incident: SupportIncidentPrivateProjection,
  query: SupportQueryResult,
  maxBytes = MAX_SUPPORT_REPORT_BYTES,
): SupportReport {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_SUPPORT_REPORT_BYTES)
    throw new SupportReportError("report-budget-exceeded");
  if (parseSupportIncidentPrivateProjection(incident) === undefined)
    throw new SupportReportError("unsafe-report");
  if (Buffer.byteLength(canonicalSupportJson(incident)) > MAX_SUPPORT_REPORT_INCIDENT_BYTES)
    throw new SupportReportError("report-budget-exceeded");
  const registry = findSupportRegistry(incident.build);
  if (registry === undefined) throw new SupportReportError("unsupported-report");
  const { evidence, selectedReasons } = selectedEvidence(incident, query, registry);
  const selection = {
    status: diagnosticSufficiencyStatus(selectedReasons),
    reasons: selectedReasons,
    requiredBytes: query.truncation.requiredBytes,
  };
  let report = sealSupportReport(incident, selection, evidence);
  if (Buffer.byteLength(serializeSupportReport(report)) > maxBytes) {
    const budgetReasons = reasons([
      ...selectedReasons,
      "report-budget-exceeded",
      ...projectedEvidenceReasons(incident, [], registry),
    ]);
    report = sealSupportReport(
      incident,
      { ...selection, status: "insufficient", reasons: budgetReasons },
      encodeSupportReportEvidence([]),
    );
  }
  if (Buffer.byteLength(serializeSupportReport(report)) > maxBytes)
    throw new SupportReportError("report-budget-exceeded");
  parseSupportReport(serializeSupportReport(report));
  return report;
}

export function serializeSupportReport(report: SupportReport): string {
  return `${canonicalSupportJson(report)}\n`;
}

function readHeader(value: unknown): Record<string, unknown> {
  if (!reportObject(value) || !reportKeys(value, REPORT_KEYS))
    throw new SupportReportError("unsafe-report");
  if (!isActivityLogProductVersion(value.minimumAnalyzerVersion))
    throw new SupportReportError("unsafe-report");
  if (value.kind !== SUPPORT_REPORT_KIND || value.schemaVersion !== SUPPORT_REPORT_SCHEMA_VERSION) {
    throw new SupportReportError("unsupported-report", value.minimumAnalyzerVersion);
  }
  return value;
}

function validSelection(value: unknown): value is SupportReportSelection {
  if (!reportObject(value) || !reportKeys(value, ["status", "reasons", "requiredBytes"]))
    return false;
  const declared = value.reasons;
  if (
    !Array.isArray(declared) ||
    !declared.every((reason: unknown) =>
      DIAGNOSTIC_SUFFICIENCY_REASONS.includes(reason as DiagnosticSufficiencyReason),
    )
  )
    return false;
  const safe = declared as DiagnosticSufficiencyReason[];
  return (
    canonicalSupportJson(safe) === canonicalSupportJson(reasons(safe)) &&
    value.status === diagnosticSufficiencyStatus(safe) &&
    reportCount(value.requiredBytes)
  );
}

function validEvidence(value: unknown): value is SupportReportEvidence {
  if (
    !reportObject(value) ||
    !reportKeys(value, ["encoding", "rawBytes", "recordCount", "digest", "payload"])
  )
    return false;
  return (
    value.encoding === "deflate-base64" &&
    reportCount(value.rawBytes) &&
    value.rawBytes <= MAX_SUPPORT_REPORT_EVENT_BYTES &&
    reportCount(value.recordCount) &&
    value.recordCount <= MAX_SUPPORT_REPORT_RECORDS &&
    isActivityLogIdentityDigest(value.digest) &&
    typeof value.payload === "string" &&
    /^[A-Za-z0-9+/]*={0,2}$/u.test(value.payload)
  );
}

function verifyIntegrity(value: Record<string, unknown>): void {
  const integrity = value.integrity;
  if (
    !reportObject(integrity) ||
    !reportKeys(integrity, INTEGRITY_KEYS) ||
    integrity.algorithm !== "sha256" ||
    integrity.authenticity !== "unknown"
  )
    throw new SupportReportError("unsafe-report");
  for (const section of ["incident", "selection", "evidence"] as const) {
    if (integrity[`${section}Digest`] !== supportReportDigest(canonicalSupportJson(value[section])))
      throw new SupportReportError("corrupt-report");
  }
  const { reportDigest, ...sectionIntegrity } = integrity;
  if (
    reportDigest !==
    supportReportDigest(canonicalSupportJson({ ...value, integrity: sectionIntegrity }))
  )
    throw new SupportReportError("corrupt-report");
}

function validEvent(value: unknown, registry: SupportReaderRegistry): value is SupportReportEvent {
  if (
    !reportObject(value) ||
    !reportKeys(value, ["sourceSegmentId", "record"]) ||
    !reportObject(value.record)
  )
    return false;
  if (Buffer.byteLength(canonicalSupportJson(value)) > MAX_SUPPORT_REPORT_RECORD_BYTES)
    return false;
  const segment = value.sourceSegmentId;
  if (typeof segment !== "string") return false;
  const identity = parseActivityLogSegmentId(segment);
  if (
    segment !== "legacy" &&
    (identity === undefined ||
      identity.pid !== value.record.pid ||
      identity.instanceId !== value.record.instanceId)
  )
    return false;
  return isSupportReportEvent(value.record, registry);
}

function decodeEvidence(
  evidence: SupportReportEvidence,
  registry: SupportReaderRegistry,
): readonly SupportReportEvent[] {
  const encoded = Buffer.from(evidence.payload, "base64");
  if (encoded.toString("base64") !== evidence.payload)
    throw new SupportReportError("corrupt-report");
  let bytes: Buffer;
  try {
    const inflated = inflateSync(encoded, {
      maxOutputLength: MAX_SUPPORT_REPORT_EVENT_BYTES,
      info: true,
    }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (inflated.engine.bytesWritten !== encoded.length)
      throw new SupportReportError("corrupt-report");
    bytes = inflated.buffer;
  } catch {
    throw new SupportReportError("corrupt-report");
  }
  const text = bytes.toString("utf8");
  if (
    bytes.length !== evidence.rawBytes ||
    supportReportDigest(text) !== evidence.digest ||
    !bytes.equals(Buffer.from(text))
  )
    throw new SupportReportError("corrupt-report");
  const events = parseCanonicalSupportJson(text, MAX_SUPPORT_REPORT_EVENT_BYTES);
  if (
    !Array.isArray(events) ||
    events.length !== evidence.recordCount ||
    !events.every((event: unknown) => validEvent(event, registry))
  )
    throw new SupportReportError("unsafe-report");
  return events;
}

function reportRegistry(
  incident: SupportIncidentPrivateProjection,
  minimumVersion: string,
): SupportReaderRegistry {
  const registry = findSupportRegistry(incident.build);
  if (registry === undefined) throw new SupportReportError("unsupported-report", minimumVersion);
  if (
    incident.trigger === "registered-failure" &&
    registry.operations.get(incident.op)?.lifecycle !== "failure"
  )
    throw new SupportReportError("unsafe-report");
  return registry;
}

/** Validates every byte and section before any renderer or agent receives a value. Pure, offline. */
export function parseSupportReport(text: string): SupportReport {
  if (!text.endsWith("\n")) throw new SupportReportError("corrupt-report");
  const value = readHeader(
    parseCanonicalSupportJson(text.slice(0, -1), MAX_SUPPORT_REPORT_BYTES - 1),
  );
  const incident = parseSupportIncidentPrivateProjection(value.incident);
  if (incident === undefined || !validSelection(value.selection) || !validEvidence(value.evidence))
    throw new SupportReportError("unsafe-report");
  if (Buffer.byteLength(canonicalSupportJson(incident)) > MAX_SUPPORT_REPORT_INCIDENT_BYTES)
    throw new SupportReportError("report-budget-exceeded");
  verifyIntegrity(value);
  const registry = reportRegistry(incident, String(value.minimumAnalyzerVersion));
  const events = decodeEvidence(value.evidence, registry);
  const report = value as unknown as SupportReport;
  validateReportSufficiency(report, events, registry);
  return report;
}

function eventAnalysis(
  events: readonly SupportReportEvent[],
  registry: SupportReaderRegistry,
  options: SupportAnalyzeOptions = {},
): AnalyzeAllResult {
  return analyzeLogText(
    events.map((event) => canonicalSupportJson(event.record)).join("\n") +
      (events.length === 0 ? "" : "\n"),
    { ...options, registry },
  );
}

function reportFailureClasses(
  incident: SupportIncidentPrivateProjection,
  events: readonly SupportReportEvent[],
  registry: SupportReaderRegistry,
): readonly string[] {
  const ops =
    incident.trigger === "registered-failure"
      ? [incident.op]
      : events
          .filter(
            (event) => registry.operations.get(String(event.record.op))?.lifecycle === "failure",
          )
          .map((event) => String(event.record.op));
  return activityLogFailureClassesOf(ops, registry);
}

function projectedEvidenceReasons(
  incident: SupportIncidentPrivateProjection,
  events: readonly SupportReportEvent[],
  registry: SupportReaderRegistry,
): readonly DiagnosticSufficiencyReason[] {
  const analysis = eventAnalysis(events, registry);
  const projected = restrictActivityLogSufficiency(
    analysis.sufficiency,
    reportFailureClasses(incident, events, registry),
  ).reasons;
  const correlations = [
    incident.correlation.rootCorrelationId,
    ...incident.correlation.childCorrelationIds,
  ].filter((value): value is string => value !== undefined);
  if (correlations.some((correlation) => findTimeline(analysis, correlation) === undefined))
    return reasons([...projected, "evidence-not-retained"]);
  return projected;
}

function validateReportSufficiency(
  report: SupportReport,
  events: readonly SupportReportEvent[],
  registry: SupportReaderRegistry,
): void {
  const expected = reasons([
    ...projectedEvidenceReasons(report.incident, events, registry),
    ...report.incident.sufficiencyReasons,
    ...report.selection.reasons,
  ]);
  if (canonicalSupportJson(expected) !== canonicalSupportJson(report.selection.reasons))
    throw new SupportReportError("corrupt-report");
}

export interface AnalyzedSupportReport {
  readonly kind: "keiko.support.report-analysis";
  readonly schemaVersion: 1;
  readonly authenticity: "unknown";
  readonly reportDigest: string;
  readonly sourceArtifactDigest: string;
  readonly seed?: ReproductionSeed;
  readonly incident: SupportIncidentPrivateProjection;
  readonly selection: SupportReportSelection;
  readonly analysis: AnalyzeAllResult;
}

export function analyzeSupportReport(
  text: string,
  options: SupportAnalyzeOptions = {},
): AnalyzedSupportReport {
  const report = parseSupportReport(text);
  const registry = reportRegistry(report.incident, report.minimumAnalyzerVersion);
  const analysis = eventAnalysis(decodeEvidence(report.evidence, registry), registry, options);
  const sourceArtifactDigest = supportReportDigest(text);
  const artifact: AnalyzedSupportReport = {
    kind: "keiko.support.report-analysis",
    schemaVersion: 1,
    authenticity: "unknown",
    reportDigest: report.integrity.reportDigest,
    sourceArtifactDigest,
    incident: report.incident,
    selection: report.selection,
    analysis,
  };
  const seed = prepareSupportReportSeed(artifact, undefined, options);
  return seed === undefined ? artifact : { ...artifact, seed };
}

/** Seed preparation shares the exact validated historical registry and deterministic clock. */
export function prepareSupportReportSeed(
  artifact: AnalyzedSupportReport,
  correlationId = artifact.incident.correlation.rootCorrelationId,
  options: SupportAnalyzeOptions = {},
): ReproductionSeed | undefined {
  if (correlationId === undefined) return undefined;
  const registry = reportRegistry(artifact.incident, KEIKO_PRODUCT_VERSION);
  return buildReproductionSeedFromAnalysis(
    artifact.analysis,
    {
      lineCount: artifact.analysis.evidence.supportedLineCount,
      sha256: artifact.sourceArtifactDigest,
      firstLine: undefined,
    },
    correlationId,
    new Date(artifact.incident.createdAtMs),
    { ...options, registry },
  );
}
