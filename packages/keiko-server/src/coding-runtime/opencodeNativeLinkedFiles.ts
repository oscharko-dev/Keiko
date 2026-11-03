import { causeChain, keikoStackFrames, type ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { scanNativeLinkedFiles, type NativeLinkedFileScan } from "@oscharko-dev/keiko-sandbox";

import { CODING_RUNTIME_FAILURE_TRACE_FIELDS } from "./codingRuntimeActivityOperations.js";
import { CodingRuntimeLaunchRejectedError } from "./launchFailure.js";

/**
 * The workspace boundary for hard links (PR #4064 review, #3900 AC2/AC5). Before a native launch
 * the workspace and every accepted external reference are scanned for regular files with more than
 * one link, and the kernel profile denies each one's contents to the whole process tree
 * (`linkedFiles`). The boundary is Keiko's own: it holds for whatever the pinned runtime reads with,
 * in this version or the next. A scan that cannot finish, or finds more linked files than one
 * profile can name, refuses the launch rather than starting with a partial list.
 */
const LINKED_FILES_RESOLVED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.linked-files.resolved",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.opencodeNativeLinkedFiles.recordNativeLinkedFileScan",
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["complete", "excessive", "incomplete"],
    },
    rootCount: { type: "integer", dataClass: "count", required: true },
    scannedFileCount: { type: "integer", dataClass: "count", required: true },
    linkedFileCount: { type: "integer", dataClass: "count", required: false },
    gitObjectLinkCount: { type: "integer", dataClass: "count", required: true },
    durationMs: { type: "integer", dataClass: "duration", required: true },
    ...CODING_RUNTIME_FAILURE_TRACE_FIELDS,
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "capability",
  diagnosticWhen: [{ field: "outcome", values: ["excessive", "incomplete"] }],
  failureClasses: ["coding-runtime-linked-files-unscanned"],
  proofIds: ["coding-runtime.linked-files.resolved.emitted-line"],
  releaseImpact: "patch",
});

/** One body-free line per native launch: counts and the closed outcome, never a path. */
export function recordNativeLinkedFileScan(
  sink: ServerLogSink,
  runId: string,
  rootCount: number,
  scan: NativeLinkedFileScan,
  durationMs: number,
  error?: unknown,
): void {
  const complete = scan.outcome === "complete";
  sink.write(
    activityLogEvent(
      LINKED_FILES_RESOLVED_OPERATION,
      complete
        ? { level: "info", correlationId: runId }
        : { level: "warn", correlationId: runId, errorKind: "conflict" },
      {
        outcome: scan.outcome,
        rootCount,
        scannedFileCount: scan.scannedFileCount,
        ...(complete ? { linkedFileCount: scan.linkedFiles.length } : {}),
        gitObjectLinkCount: scan.gitObjectLinkCount,
        durationMs: Math.max(0, Math.round(durationMs)),
        ...(error === undefined
          ? {}
          : { frames: keikoStackFrames(error), causeChain: causeChain(error) }),
      },
    ),
  );
}

/**
 * The `linkedFiles` field of a native filesystem plan for these roots, recorded on the Activity
 * Log. Refuses the launch (`workspace-unqualified`) when the scan is not complete.
 */
export function nativeLinkedFilesField(
  sink: ServerLogSink,
  runId: string,
  roots: readonly string[],
  scan: (roots: readonly string[]) => NativeLinkedFileScan = scanNativeLinkedFiles,
): { readonly linkedFiles?: readonly string[] } {
  const started = performance.now();
  let result: NativeLinkedFileScan;
  try {
    result = scan(roots);
  } catch (error) {
    // A filesystem failure the scan could not classify: the list is unknown, so nothing launches.
    const failed = { outcome: "incomplete", scannedFileCount: 0, gitObjectLinkCount: 0 } as const;
    recordNativeLinkedFileScan(
      sink,
      runId,
      roots.length,
      failed,
      performance.now() - started,
      error,
    );
    throw new CodingRuntimeLaunchRejectedError(
      "workspace-unqualified",
      false,
      "linked-files-unscanned",
    );
  }
  recordNativeLinkedFileScan(sink, runId, roots.length, result, performance.now() - started);
  if (result.outcome !== "complete") {
    throw new CodingRuntimeLaunchRejectedError(
      "workspace-unqualified",
      false,
      result.outcome === "excessive" ? "linked-files-excessive" : "linked-files-unscanned",
    );
  }
  return result.linkedFiles.length === 0 ? {} : { linkedFiles: result.linkedFiles };
}
