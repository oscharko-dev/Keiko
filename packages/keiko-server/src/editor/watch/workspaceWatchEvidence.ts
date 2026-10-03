import type { EditorM7WatchHealth, EditorM7WatchSnapshot } from "@oscharko-dev/keiko-contracts";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { correlationIdOrUnknown } from "../../correlation.js";
import { processServerLogSink } from "../../process-log-sink.js";

const WATCH_HEALTH = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "editor.workspace-watch.health-changed",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "editor.watch.workspaceWatchEvidence.recordWorkspaceWatchHealth",
  fields: {
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
    health: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["healthy", "degraded", "rescanRequired", "stopped"],
    },
    previousHealth: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["healthy", "degraded", "rescanRequired", "stopped"],
    },
    reasons: {
      type: "string-array",
      dataClass: "closed-enum",
      required: true,
      maxLength: 32,
      maxItems: 8,
      values: [
        "native-watch-unavailable",
        "unsupported-recursive-watch",
        "event-overflow",
        "sequence-gap",
        "ambiguous-event",
        "unsafe-path",
        "root-replaced",
        "shutdown",
      ],
    },
    rootToken: { type: "string", dataClass: "digest", required: true, maxLength: 24 },
    sequence: { type: "integer", dataClass: "count", required: true },
    eventCount: { type: "integer", dataClass: "count", required: true },
    subscriberCount: { type: "integer", dataClass: "count", required: true },
    queueDepth: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "capability",
  failureClasses: ["editor-workspace-watch-availability"],
  proofIds: ["editor.workspace-watch.health-changed.transitions"],
  releaseImpact: "patch",
});

/** Persist closed availability state, including the actual reason, once per transition. */
export function recordWorkspaceWatchHealth(
  snapshot: EditorM7WatchSnapshot,
  previousHealth: EditorM7WatchHealth,
  correlationId: string | undefined,
): void {
  const degraded = snapshot.health === "degraded" || snapshot.health === "rescanRequired";
  processServerLogSink().write(
    activityLogEvent(
      WATCH_HEALTH,
      {
        level: degraded ? "warn" : "info",
        correlationId: correlationIdOrUnknown(correlationId),
        ...(degraded ? { errorKind: "unavailable" } : {}),
      },
      {
        health: snapshot.health,
        previousHealth,
        completeness: "complete",
        loss: "none",
        reasons: snapshot.degradedReasons,
        rootToken: snapshot.rootToken,
        sequence: snapshot.sequence,
        eventCount: snapshot.eventCount,
        subscriberCount: snapshot.subscriberCount,
        queueDepth: snapshot.queueDepth,
      },
    ),
  );
}
