import { computeDefectFingerprint } from "../defect-fingerprint.js";
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
  MAX_SUPPORT_REPORT_TIMELINE_RECORDS,
  MAX_SUPPORT_REPORT_TIMELINE_BYTES,
  DIAGNOSTIC_SUFFICIENCY_REASONS,
  SUPPORT_INCIDENT_UNATTRIBUTED,
  UNATTRIBUTED_DEFECT_FINGERPRINT_INPUT,
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
import {
  KEIKO_PRODUCT_VERSION,
  compareProductVersions,
} from "@oscharko-dev/keiko-contracts/runtime/version";
import {
  ACTIVITY_LOG_EVIDENCE_INTEGRITY,
  analyzeLogText,
  ActivityLogAnalyzeBudgetError,
  buildReproductionSeedFromAnalysis,
  isSupportReportEvent,
  findTimeline,
  timelineSufficiency,
  type AnalyzeAllResult,
  type LogTimeline,
  type SupportAnalyzeOptions,
  type ReproductionSeed,
} from "./support-analyze.js";
import {
  activityLogFailureClassesOf,
  restrictActivityLogSufficiency,
  type ActivityLogSufficiency,
} from "./support-analyze-sufficiency.js";
import type { SupportQueryResult } from "./support-query.js";
import { findSupportRegistry, type SupportReaderRegistry } from "./support-registry.js";
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
  minimumAnalyzerVersion: string = KEIKO_PRODUCT_VERSION,
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
    minimumAnalyzerVersion,
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

interface SelectedEvidence {
  readonly evidence: SupportReportEvidence;
  readonly selectedReasons: readonly DiagnosticSufficiencyReason[];
  readonly requiredBytes: number;
}

// A record the incident's exact registry cannot validate (for example one written by another
// release after an upgrade) is left out and named; every other selected record is retained.
function selectedEvidence(
  incident: SupportIncidentPrivateProjection,
  query: SupportQueryResult,
  registry: SupportReaderRegistry,
): SelectedEvidence {
  const selected = queryEvents(query);
  const events = selected.filter((event) => isSupportReportEvent(event.record, registry));
  const selectedReasons = reasons([
    ...query.diagnosticSufficiency.reasons,
    ...incident.sufficiencyReasons,
    ...(events.length < selected.length ? (["unsupported-evidence"] as const) : []),
  ]);
  try {
    return {
      evidence: encodeSupportReportEvidence(events),
      selectedReasons: reasons([
        ...selectedReasons,
        ...projectedEvidenceReasons(incident, events, registry),
      ]),
      requiredBytes: query.truncation.requiredBytes,
    };
  } catch (error) {
    if (!(error instanceof SupportReportError) || error.reason !== "report-budget-exceeded")
      throw error;
    return {
      evidence: encodeSupportReportEvidence([]),
      selectedReasons: reasons([
        ...selectedReasons,
        "report-budget-exceeded",
        ...projectedEvidenceReasons(incident, [], registry),
      ]),
      requiredBytes: query.truncation.requiredBytes,
    };
  }
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
  const { evidence, selectedReasons, requiredBytes } = selectedEvidence(incident, query, registry);
  const selection = {
    status: diagnosticSufficiencyStatus(selectedReasons),
    reasons: selectedReasons,
    requiredBytes,
  };
  let report = sealSupportReport(incident, selection, evidence);
  const completeBytes = Buffer.byteLength(serializeSupportReport(report));
  if (completeBytes > maxBytes) {
    const budgetReasons = reasons([
      ...selectedReasons,
      "report-budget-exceeded",
      ...projectedEvidenceReasons(incident, [], registry),
    ]);
    // The report-budget metric names what the complete report would need: --max-bytes at least
    // this large (within the hard ceiling) carries the whole selection.
    report = sealSupportReport(
      incident,
      { status: "insufficient", reasons: budgetReasons, requiredBytes: completeBytes },
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

// A newer schema may add sections, so its declared minimum analyzer and schema are judged before
// the closed section set: an unsupported report names the analyzer it needs instead of "unsafe".
function readHeader(value: unknown): Record<string, unknown> {
  if (!reportObject(value) || !isActivityLogProductVersion(value.minimumAnalyzerVersion))
    throw new SupportReportError("unsafe-report");
  validateMinimumAnalyzerVersion(value.minimumAnalyzerVersion);
  if (value.kind !== SUPPORT_REPORT_KIND || value.schemaVersion !== SUPPORT_REPORT_SCHEMA_VERSION) {
    throw new SupportReportError("unsupported-report");
  }
  if (!reportKeys(value, REPORT_KEYS)) throw new SupportReportError("unsafe-report");
  return value;
}

function validateMinimumAnalyzerVersion(version: string): void {
  let comparison: number;
  try {
    comparison = compareProductVersions(version, KEIKO_PRODUCT_VERSION);
  } catch {
    throw new SupportReportError("unsafe-report");
  }
  if (comparison > 0) throw new SupportReportError("unsupported-report", version);
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
      maxOutputLength: Math.max(1, evidence.rawBytes),
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

function reportRegistry(incident: SupportIncidentPrivateProjection): SupportReaderRegistry {
  const registry = findSupportRegistry(incident.build);
  if (registry === undefined) throw new SupportReportError("unsupported-report");
  if (
    incident.trigger === "registered-failure" &&
    registry.operations.get(incident.op)?.lifecycle !== "failure"
  )
    throw new SupportReportError("unsafe-report");
  return registry;
}

const UNATTRIBUTED_DEFECT_FINGERPRINT = computeDefectFingerprint(
  UNATTRIBUTED_DEFECT_FINGERPRINT_INPUT,
);

// A user-reported incident attributes nothing: its fingerprint inputs are the fixed constants.
function unattributedIncident(incident: SupportIncidentPrivateProjection): boolean {
  return (
    incident.surface === SUPPORT_INCIDENT_UNATTRIBUTED &&
    incident.op === SUPPORT_INCIDENT_UNATTRIBUTED &&
    incident.errorKind === UNATTRIBUTED_DEFECT_FINGERPRINT_INPUT.errorKind &&
    incident.frameCount === 0 &&
    incident.defectFingerprint === UNATTRIBUTED_DEFECT_FINGERPRINT
  );
}

/**
 * The relations the producer guarantees between the incident header and its evidence. A header
 * that contradicts them, or contradicts its own retained failure line, is refused: the declared
 * integrity maps to its completeness and loss, the window is anchored at creation, a user report
 * carries the unattributed constants, and a retained failure line agrees on its error kind.
 */
function validateIncidentProvenance(
  incident: SupportIncidentPrivateProjection,
  events: readonly SupportReportEvent[],
): void {
  const integrity = ACTIVITY_LOG_EVIDENCE_INTEGRITY[incident.integrity];
  if (
    integrity.completeness !== incident.completeness ||
    integrity.loss !== incident.loss ||
    incident.window.incidentAtMs !== incident.createdAtMs
  )
    throw new SupportReportError("unsafe-report");
  if (incident.trigger === "user-report") {
    if (!unattributedIncident(incident)) throw new SupportReportError("unsafe-report");
    return;
  }
  const failures = events.filter((event) => event.record.op === incident.op);
  if (
    failures.length > 0 &&
    !failures.some((event) => (event.record.errorKind ?? "unknown") === incident.errorKind)
  )
    throw new SupportReportError("unsafe-report");
}

// A canonical report is exactly one line. The retired open JSONL bundle starts with its
// `$section` manifest and a raw Activity Log with a timestamped record: both are refused by name,
// so the receiver regenerates on the originating installation instead of suspecting tampering.
function isLegacySupportInput(text: string): boolean {
  return text.startsWith('{"$section"') || text.startsWith('{"ts"');
}

/** Validates every byte and section before any renderer or agent receives a value. Pure, offline. */
export function parseSupportReport(text: string): SupportReport {
  return parseValidatedSupportReport(text).report;
}

interface ValidatedSupportReport {
  readonly report: SupportReport;
  readonly events: readonly SupportReportEvent[];
  readonly registry: SupportReaderRegistry;
  readonly analysis: AnalyzeAllResult;
  readonly selection: SupportReportSelection;
}

function parseValidatedSupportReport(text: string): ValidatedSupportReport {
  if (isLegacySupportInput(text)) throw new SupportReportError("legacy-input");
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
  const registry = reportRegistry(incident);
  const events = decodeEvidence(value.evidence, registry);
  validateIncidentProvenance(incident, events);
  const report = value as unknown as SupportReport;
  const analysis = eventAnalysis(events, registry);
  const selection = effectiveSelection(report, events, registry, analysis);
  return { report, events, registry, analysis, selection };
}

function eventAnalysis(
  events: readonly SupportReportEvent[],
  registry: SupportReaderRegistry,
  options: SupportAnalyzeOptions = {},
): AnalyzeAllResult {
  try {
    return analyzeLogText(
      events.map((event) => canonicalSupportJson(event.record)).join("\n") +
        (events.length === 0 ? "" : "\n"),
      {
        ...options,
        registry,
        sourceKind: "support-report",
        maxTimelineRecords: MAX_SUPPORT_REPORT_TIMELINE_RECORDS,
        maxTimelineBytes: MAX_SUPPORT_REPORT_TIMELINE_BYTES,
      },
    );
  } catch (error) {
    if (error instanceof ActivityLogAnalyzeBudgetError)
      throw new SupportReportError("report-budget-exceeded");
    throw error;
  }
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
  analysis = eventAnalysis(events, registry),
): readonly DiagnosticSufficiencyReason[] {
  const projected = restrictActivityLogSufficiency(
    analysis.sufficiency,
    reportFailureClasses(incident, events, registry),
  ).reasons;
  const correlations = [
    incident.correlation.rootCorrelationId,
    ...incident.correlation.childCorrelationIds,
  ].filter((value): value is string => value !== undefined);
  // A registered failure is reconstructable only with its own failing line: without it neither the
  // failure site nor the cause chain can be localized, whatever else the closure retained.
  const failureRetained =
    incident.trigger !== "registered-failure" ||
    events.some((event) => event.record.op === incident.op);
  if (
    !failureRetained ||
    correlations.some((correlation) => findTimeline(analysis, correlation) === undefined)
  )
    return reasons([...projected, "evidence-not-retained"]);
  return projected;
}

/**
 * The analyzer recomputes sufficiency from the evidence and the exact matched registry. A report
 * can only lose status here, never gain it: every declared reason is kept and every recomputed one
 * added, so a forged "complete" over absent evidence reads as insufficient, and a later analyzer's
 * stricter rule never makes an older, honestly declared report unreadable.
 */
function effectiveSelection(
  report: SupportReport,
  events: readonly SupportReportEvent[],
  registry: SupportReaderRegistry,
  analysis: AnalyzeAllResult,
): SupportReportSelection {
  const effective = reasons([
    ...projectedEvidenceReasons(report.incident, events, registry, analysis),
    ...report.incident.sufficiencyReasons,
    ...report.selection.reasons,
  ]);
  return {
    status: diagnosticSufficiencyStatus(effective),
    reasons: effective,
    requiredBytes: report.selection.requiredBytes,
  };
}

export interface AnalyzedSupportReport {
  readonly kind: "keiko.support.report-analysis";
  readonly schemaVersion: 1;
  readonly authenticity: "unknown";
  // The analyzer that validated the report; the producer's build and registry are incident.build.
  readonly analyzerVersion: string;
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
  const validated = parseValidatedSupportReport(text);
  const { report, events, registry, selection } = validated;
  const analysis =
    Object.keys(options).length === 0
      ? validated.analysis
      : eventAnalysis(events, registry, options);
  const sourceArtifactDigest = supportReportDigest(text);
  const artifact: AnalyzedSupportReport = {
    kind: "keiko.support.report-analysis",
    schemaVersion: 1,
    authenticity: "unknown",
    analyzerVersion: KEIKO_PRODUCT_VERSION,
    reportDigest: report.integrity.reportDigest,
    sourceArtifactDigest,
    incident: report.incident,
    selection,
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
  const registry = reportRegistry(artifact.incident);
  return buildReproductionSeedFromAnalysis(
    artifact.analysis,
    {
      kind: "support-report",
      lineCount: artifact.analysis.evidence.supportedLineCount,
      sha256: artifact.sourceArtifactDigest,
      firstLine: undefined,
    },
    correlationId,
    new Date(artifact.incident.createdAtMs),
    { ...options, registry },
  );
}

export interface AnalyzedSupportReportTimeline extends LogTimeline {
  readonly kind: "keiko.support.report-timeline";
  readonly schemaVersion: 1;
  readonly authenticity: "unknown";
  readonly analyzerVersion: string;
  readonly reportDigest: string;
  readonly sourceArtifactDigest: string;
  readonly sufficiency: ActivityLogSufficiency;
}

/** The validated timeline of one correlation, or undefined when the report holds none. */
export function supportReportTimeline(
  artifact: AnalyzedSupportReport,
  correlationId: string,
): AnalyzedSupportReportTimeline | undefined {
  const timeline = findTimeline(artifact.analysis, correlationId);
  if (timeline === undefined) return undefined;
  return {
    kind: "keiko.support.report-timeline",
    schemaVersion: 1,
    authenticity: "unknown",
    analyzerVersion: artifact.analyzerVersion,
    reportDigest: artifact.reportDigest,
    sourceArtifactDigest: artifact.sourceArtifactDigest,
    ...timeline,
    sufficiency: timelineSufficiency(
      artifact.analysis,
      timeline,
      reportRegistry(artifact.incident),
    ),
  };
}
