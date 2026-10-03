// Shared incident resolution for desktop and CLI support reports.
import {
  activityLogOperationSchema,
  type SupportIncident,
  type SupportIncidentRecord,
  type SupportIncidentSufficiency,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { openSafeArtifactFile } from "@oscharko-dev/keiko-security/fs-hardening";
import type { SupportIncidentSegmentFile } from "../support-incident.js";
import { ActivityLogReadError, readActivityLogFileLines } from "./activity-log-line-reader.js";
import {
  ACTIVITY_LOG_EVIDENCE_INTEGRITY,
  analyzeLogLines,
  type ActivityLogEvidenceSummary,
  type ActivityLogTextLine,
  type AnalyzeAllResult,
} from "./support-analyze.js";
import {
  activityLogFailureClassesOf,
  restrictActivityLogSufficiency,
} from "./support-analyze-sufficiency.js";

/** The window is analyzed whole or not at all: a partial read could never be labeled complete. */
export const MAX_SUPPORT_INCIDENT_WINDOW_BYTES = 64 * 1024 * 1024;

export class SupportIncidentWindowError extends Error {
  public override readonly name = "SupportIncidentWindowError";
  public readonly reason: "window-too-large" | "segment-unreadable";

  public constructor(reason: "window-too-large" | "segment-unreadable") {
    super(`support incident window ${reason}`);
    this.reason = reason;
  }
}

function openIncidentSegment(path: string, stateDir: string): number {
  return openSafeArtifactFile(path, {
    artifactClass: "activity-log",
    mode: "read",
    trustedRoot: stateDir,
  });
}

// Streams every covered segment's lines, in order, through the same hardened, state-dir-rooted
// safe-artifact open and bounded chunked reader the query engine uses
// (support-segment-scan.ts's `ActivityLogScanner`) — never a whole segment, let alone the whole
// window, in one buffer (#3531 audit). Each line keeps the reader's own termination, so a crashed
// writer's torn tail is truncated evidence here exactly as in the query engine, never a corrupt
// record (#3534). `onChunk` is the reader's own observability seam (never used in production): it
// lets a test prove every read stayed inside one bounded chunk instead of trusting the
// implementation by inspection.
function* supportIncidentWindowLines(
  segments: readonly SupportIncidentSegmentFile[],
  stateDir: string,
  onChunk?: (chunk: Uint8Array) => void,
): Generator<ActivityLogTextLine> {
  for (const segment of segments) {
    try {
      for (const line of readActivityLogFileLines(
        () => openIncidentSegment(segment.path, stateDir),
        onChunk === undefined ? {} : { onChunk },
      )) {
        yield { text: line.text, terminated: line.terminated };
      }
    } catch (error) {
      if (!(error instanceof ActivityLogReadError)) throw error;
      throw new SupportIncidentWindowError("segment-unreadable");
    }
  }
}

/**
 * Analyzes the incident's covered segments in one bounded streaming pass — never the whole pinned
 * window in one buffer. The window is analyzed whole or not at all: fails closed, synchronously,
 * either before any file is opened (`window-too-large`, from the segments' own recorded sizes) or
 * the moment any covered segment cannot be opened or read in full (`segment-unreadable`); no
 * partial result is ever returned. `onChunk` is a test-only observability seam (see
 * `supportIncidentWindowLines`); production callers never pass it.
 */
export function resolveSupportIncidentEvidence(
  segments: readonly SupportIncidentSegmentFile[],
  stateDir: string,
  onChunk?: (chunk: Uint8Array) => void,
): AnalyzeAllResult {
  const total = segments.reduce((sum, segment) => sum + segment.sizeBytes, 0);
  if (total > MAX_SUPPORT_INCIDENT_WINDOW_BYTES) {
    throw new SupportIncidentWindowError("window-too-large");
  }
  return analyzeLogLines(supportIncidentWindowLines(segments, stateDir, onChunk));
}

function incidentFailureClasses(
  record: SupportIncidentRecord,
  analysis: AnalyzeAllResult,
): readonly string[] {
  if (record.trigger === "registered-failure") {
    return activityLogFailureClassesOf([record.fingerprint.op]);
  }
  // A user report attributes no operation itself; only registered failures in its window count.
  const failureOps = analysis.clusters
    .map((cluster) => cluster.op)
    .filter((op) => activityLogOperationSchema(op)?.lifecycle === "failure");
  return activityLogFailureClassesOf(failureOps);
}

function incidentSufficiency(
  record: SupportIncidentRecord,
  analysis: AnalyzeAllResult,
): SupportIncidentSufficiency {
  const required = incidentFailureClasses(record, analysis);
  const narrowed = restrictActivityLogSufficiency(analysis.sufficiency, required);
  return {
    status: narrowed.status,
    reasons: narrowed.reasons,
    coverage: {
      requiredClassCount: required.length,
      presentClassCount: narrowed.coverage.observedClassCount,
      completeClassCount: narrowed.coverage.completeClassCount,
      degradedClassCount: narrowed.coverage.degradedClassCount,
      insufficientClassCount: narrowed.coverage.insufficientClassCount,
    },
  };
}

function evidenceLineCount(evidence: ActivityLogEvidenceSummary): number {
  return (
    evidence.supportedLineCount +
    evidence.legacyLineCount +
    evidence.unsupportedLineCount +
    evidence.corruptLineCount +
    evidence.truncatedLineCount +
    evidence.incompleteLineCount
  );
}

/** Builds the canonical SupportIncident descriptor from a record and its window's evidence. */
export function resolveSupportIncident(
  record: SupportIncidentRecord,
  segments: readonly SupportIncidentSegmentFile[],
  stateDir: string,
): SupportIncident {
  return resolveSupportIncidentAnalysis(
    record,
    segments,
    resolveSupportIncidentEvidence(segments, stateDir),
  );
}

/** A selected causal closure supplies its own evidence, independent of the report click time. */
export function resolveSupportIncidentAnalysis(
  record: SupportIncidentRecord,
  segments: readonly SupportIncidentSegmentFile[],
  analysis: AnalyzeAllResult,
): SupportIncident {
  const classification = analysis.evidence.classification;
  return {
    ...record,
    evidence: {
      segments: segments.map(({ segmentId, state, sizeBytes }) => ({
        segmentId,
        state,
        sizeBytes,
      })),
      lineCount: evidenceLineCount(analysis.evidence),
      integrity: classification,
      ...ACTIVITY_LOG_EVIDENCE_INTEGRITY[classification],
    },
    sufficiency: incidentSufficiency(record, analysis),
  };
}

/**
 * The descriptor of an incident whose window cannot be read whole: a covered segment is unreadable,
 * or the window exceeds its byte bound. Nothing is read. The window is described by its segment
 * references alone and is explicitly insufficient with the closed reason, so an export can still
 * publish an honest report instead of failing.
 */
export function unresolvedSupportIncident(
  record: SupportIncidentRecord,
  segments: readonly SupportIncidentSegmentFile[],
  reason: SupportIncidentWindowError["reason"],
): SupportIncident {
  const required =
    record.trigger === "registered-failure"
      ? activityLogFailureClassesOf([record.fingerprint.op])
      : [];
  return {
    ...record,
    evidence: {
      segments: segments.map(({ segmentId, state, sizeBytes }) => ({
        segmentId,
        state,
        sizeBytes,
      })),
      lineCount: 0,
      integrity: "incomplete",
      ...ACTIVITY_LOG_EVIDENCE_INTEGRITY.incomplete,
    },
    sufficiency: {
      status: "insufficient",
      reasons: [reason === "window-too-large" ? "report-budget-exceeded" : "segment-unreadable"],
      coverage: {
        requiredClassCount: required.length,
        presentClassCount: 0,
        completeClassCount: 0,
        degradedClassCount: 0,
        insufficientClassCount: 0,
      },
    },
  };
}
