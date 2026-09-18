// Body-free Activity Log evidence for manifest maintenance, streaming queries and selective export
// (#3531). Every field is a closed enum, a count, or a closed reason list: never query text, a
// correlation id, an incident id, a segment name, a path, or an event body. One operation's lines
// share its correlation id, so `keiko support analyze` reconstructs the query from the log alone.

import {
  DIAGNOSTIC_SUFFICIENCY_REASONS,
  DIAGNOSTIC_SUFFICIENCY_STATUSES,
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { SupportQueryClass, SupportQueryResult } from "./support-query.js";
import type { SegmentManifestPassStats } from "./support-segment-scan.js";

const SURFACE_FIELD = {
  type: "string",
  dataClass: "closed-enum",
  required: true,
  values: ["query", "export", "rebuild", "verify"],
} as const;

const QUERY_CLASS_FIELD = {
  type: "string",
  dataClass: "closed-enum",
  required: true,
  values: [
    "correlation",
    "incident",
    "defect-fingerprint",
    "parent-correlation",
    "operation",
    "error-kind",
    "failure-class",
    "time-window",
  ],
} as const;

const COUNT = { type: "integer", dataClass: "count", required: true } as const;

export const SUPPORT_MANIFEST_REBUILT_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "support.manifest.rebuilt",
  category: "diagnostic",
  owner: "keiko-cli",
  emitter: "support-query-evidence.emitSupportManifestEvidence",
  fields: {
    surface: SURFACE_FIELD,
    persisted: { type: "boolean", dataClass: "closed-enum", required: true },
    segmentCount: COUNT,
    reusedCount: COUNT,
    builtCount: COUNT,
    replacedCount: COUNT,
    removedOrphanCount: COUNT,
    unreadableCount: COUNT,
    writeFailedCount: COUNT,
    verifiedCount: COUNT,
    mismatchCount: COUNT,
    missingCount: COUNT,
    manifestBytes: COUNT,
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "capability",
  failureClasses: ["support-query"],
  proofIds: ["support.manifest.rebuilt.manifest-evidence"],
  releaseImpact: "minor",
});

export const SUPPORT_QUERY_COMPLETED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "support.query.completed",
  category: "diagnostic",
  owner: "keiko-cli",
  emitter: "support-query-evidence.emitSupportQueryEvidence",
  fields: {
    surface: SURFACE_FIELD,
    queryClass: QUERY_CLASS_FIELD,
    segmentCount: COUNT,
    candidateSegmentCount: COUNT,
    prunedSegmentCount: COUNT,
    openedSegmentCount: COUNT,
    unreadableSegmentCount: COUNT,
    scannedBytes: COUNT,
    candidateEventCount: COUNT,
    resultEventCount: COUNT,
    contextEventCount: COUNT,
    closureCorrelationCount: COUNT,
    selectedBytes: COUNT,
    requiredBytes: COUNT,
    truncation: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["none", "context-truncated", "budget-exceeded"],
    },
    evidenceClassification: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["supported", "legacy", "unsupported", "corrupt", "truncated", "incomplete"],
    },
    sufficiency: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [...DIAGNOSTIC_SUFFICIENCY_STATUSES],
    },
    sufficiencyReasons: {
      type: "string-array",
      dataClass: "closed-enum",
      required: false,
      maxItems: 17,
      values: [...DIAGNOSTIC_SUFFICIENCY_REASONS],
    },
    lossEventCount: COUNT,
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "capability",
  failureClasses: ["support-query"],
  proofIds: ["support.query.completed.query-evidence"],
  releaseImpact: "minor",
});

export const SUPPORT_QUERY_FAILED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "support.query.failed",
  category: "diagnostic",
  owner: "keiko-cli",
  emitter: "support-query-evidence.emitSupportQueryFailure",
  fields: {
    surface: SURFACE_FIELD,
    queryClass: { ...QUERY_CLASS_FIELD, required: false },
    failureStage: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["store-listing", "incident-lookup", "manifest", "scan"],
    },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["support-query"],
  proofIds: ["support.query.failed.failure-evidence"],
  releaseImpact: "minor",
});

export type SupportQuerySurface = "query" | "export" | "rebuild" | "verify";
export type SupportQueryFailureStage = "store-listing" | "incident-lookup" | "manifest" | "scan";

/** The one write port these emitters need; the CLI hands in the file sink of the state dir. */
export interface SupportQueryEvidenceSink {
  write(event: object): void;
}

export function emitSupportManifestEvidence(
  sink: SupportQueryEvidenceSink,
  correlationId: string,
  stats: SegmentManifestPassStats,
): void {
  const partial = stats.unreadableCount > 0 || stats.writeFailedCount > 0;
  sink.write(
    activityLogEvent(
      SUPPORT_MANIFEST_REBUILT_OPERATION,
      { level: partial ? "warn" : "info", correlationId },
      {
        surface: stats.trigger,
        persisted: stats.persisted,
        segmentCount: stats.segmentCount,
        reusedCount: stats.reusedCount,
        builtCount: stats.builtCount,
        replacedCount: stats.replacedCount,
        removedOrphanCount: stats.removedOrphanCount,
        unreadableCount: stats.unreadableCount,
        writeFailedCount: stats.writeFailedCount,
        verifiedCount: stats.verifiedCount,
        mismatchCount: stats.mismatchCount,
        missingCount: stats.missingCount,
        manifestBytes: stats.manifestBytes,
        completeness: partial ? "partial" : "complete",
        loss: "none",
      },
    ),
  );
}

export function emitSupportQueryEvidence(
  sink: SupportQueryEvidenceSink,
  correlationId: string,
  surface: "query" | "export",
  result: SupportQueryResult,
): void {
  const { segments, metrics, integrity, diagnosticSufficiency } = result;
  sink.write(
    activityLogEvent(
      SUPPORT_QUERY_COMPLETED_OPERATION,
      { level: diagnosticSufficiency.status === "insufficient" ? "warn" : "info", correlationId },
      {
        surface,
        queryClass: result.query.class,
        segmentCount: segments.total,
        candidateSegmentCount: segments.candidate,
        prunedSegmentCount: segments.pruned,
        openedSegmentCount: segments.opened,
        unreadableSegmentCount: segments.unreadable,
        scannedBytes: metrics.scannedBytes,
        candidateEventCount: metrics.candidateEventCount,
        resultEventCount: metrics.resultEventCount,
        contextEventCount: metrics.contextEventCount,
        closureCorrelationCount: result.closure?.correlationCount ?? 0,
        selectedBytes: metrics.selectedBytes,
        requiredBytes: result.truncation.requiredBytes,
        truncation: result.truncation.state,
        evidenceClassification: integrity.classification,
        sufficiency: diagnosticSufficiency.status,
        sufficiencyReasons: [...diagnosticSufficiency.reasons],
        lossEventCount: result.loss.lossEventCount,
        completeness: integrity.completeness,
        loss: integrity.loss,
      },
    ),
  );
}

export function emitSupportQueryFailure(
  sink: SupportQueryEvidenceSink,
  correlationId: string,
  failure: {
    readonly surface: SupportQuerySurface;
    readonly queryClass: SupportQueryClass | undefined;
    readonly stage: SupportQueryFailureStage;
    readonly errorKind: ActivityLogErrorKind;
  },
): void {
  sink.write(
    activityLogEvent(
      SUPPORT_QUERY_FAILED_OPERATION,
      { level: "error", correlationId, errorKind: failure.errorKind },
      {
        surface: failure.surface,
        ...(failure.queryClass === undefined ? {} : { queryClass: failure.queryClass }),
        failureStage: failure.stage,
        completeness: "unknown",
        loss: "none",
      },
    ),
  );
}
