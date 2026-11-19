// Body-free Activity Log evidence for the Files filename search (#4434, #4435). The line carries
// counts and closed values only: never the query, a path, a file name or the root.

import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { ServerLogSink } from "./observability/index.js";
import { correlationIdOrUnknown } from "./correlation.js";
import {
  contentFreeErrorClass,
  DEFAULT_SERVER_DIAGNOSTIC_SUMMARY,
  emitServerDiagnostic,
  type ServerDiagnosticSink,
} from "./diagnostics-log.js";

const FILES_SEARCH_COMPLETED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "files.search.completed",
  category: "search",
  owner: "keiko-server",
  emitter: "files-search-activity.recordFilesSearchCompleted",
  fields: {
    resultCount: { type: "integer", dataClass: "count", required: true },
    scannedFileCount: { type: "integer", dataClass: "count", required: true },
    truncated: { type: "boolean", dataClass: "closed-enum", required: true },
    // Locked or protected entries skipped instead of failing the search (#4434).
    unavailableEntryCount: { type: "integer", dataClass: "count", required: true },
    // Listed entries that vanished before inspection; the folder's current state (#4435).
    vanishedEntryCount: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  diagnosticWhen: [{ field: "unavailableEntryCount", positive: true }],
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["files-search-availability"],
  proofIds: ["files.search.completed.line"],
  releaseImpact: "patch",
});

export interface FilesSearchOutcome {
  readonly results: readonly unknown[];
  readonly scannedFileCount: number;
  readonly truncated: boolean;
  readonly unavailableEntryCount?: number;
  readonly vanishedEntryCount?: number;
}

export function recordFilesSearchCompleted(
  deps: {
    readonly activityLog?: ServerLogSink | undefined;
    readonly diagnostics?: ServerDiagnosticSink | undefined;
  },
  correlationId: string | undefined,
  outcome: FilesSearchOutcome,
): void {
  const correlation = correlationIdOrUnknown(correlationId);
  try {
    deps.activityLog?.write(
      activityLogEvent(
        FILES_SEARCH_COMPLETED_OPERATION,
        { correlationId: correlation, status: 200 },
        {
          resultCount: outcome.results.length,
          scannedFileCount: outcome.scannedFileCount,
          truncated: outcome.truncated,
          unavailableEntryCount: outcome.unavailableEntryCount ?? 0,
          vanishedEntryCount: outcome.vanishedEntryCount ?? 0,
          completeness: "complete",
          loss: "none",
        },
      ),
    );
  } catch (error) {
    emitServerDiagnostic(deps.diagnostics, {
      correlationId: correlation,
      timestamp: new Date().toISOString(),
      operation: "files.search.completed",
      source: "files.search-activity.record-completed",
      errorClass: contentFreeErrorClass(error),
      message: DEFAULT_SERVER_DIAGNOSTIC_SUMMARY,
    });
  }
}
