import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { correlationIdOrUnknown } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";

// #4429: the assured pre-filter copies the workspace into a disposable mutation-testing root and
// skips every link (a symbolic link or, on Windows, a directory junction) instead of copying it. The
// copy left no evidence before, so a run whose gates failed because a link was absent could not be
// told apart from one whose candidate failed. Counts only: never a path.
const ASSURED_COPY_COMPLETED = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "editor.assured-copy.completed",
  category: "security",
  owner: "keiko-server",
  emitter: "editor.assuredCopyEvidence.recordAssuredCopyCompleted",
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["copied"],
    },
    copiedEntryCount: { type: "integer", dataClass: "count", required: true },
    skippedLinkCount: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "capability",
  failureClasses: ["editor-assured-copy-containment"],
  proofIds: ["editor.assured-copy.completed.links-skipped"],
  releaseImpact: "patch",
});

export interface AssuredCopyCounts {
  readonly copiedEntryCount: number;
  readonly skippedLinkCount: number;
}

export function recordAssuredCopyCompleted(
  counts: AssuredCopyCounts,
  correlationId: string | undefined,
): void {
  processServerLogSink().write(
    activityLogEvent(
      ASSURED_COPY_COMPLETED,
      { correlationId: correlationIdOrUnknown(correlationId), level: "info" },
      {
        outcome: "copied",
        copiedEntryCount: counts.copiedEntryCount,
        skippedLinkCount: counts.skippedLinkCount,
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}
