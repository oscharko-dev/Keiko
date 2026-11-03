import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { correlationIdOrUnknown } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";
import type { EditorAgentQueueRefusal } from "./agentSessionRegistry.js";

// #4107: the editor action queue answers QUEUE_FULL (HTTP 429) for three different bounds, the
// in-flight count and the serialized bytes of the session or of the process. The 429 alone could
// not say which one refused, nor how much was held, so a customer log could not tell a runaway
// producer from a legitimately large changeset. Counts and bytes only: never the action.
const EDITOR_ACTION_QUEUE = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "editor.agent.action-queue",
  category: "security",
  owner: "keiko-server",
  emitter: "editor.actionQueueEvidence.recordActionQueueRefusal",
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["refused"],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["queue-count", "session-bytes", "process-bytes"],
    },
    actionBytes: { type: "integer", dataClass: "count", required: true },
    sessionQueuedCount: { type: "integer", dataClass: "count", required: true },
    sessionQueuedBytes: { type: "integer", dataClass: "count", required: true },
    processQueuedBytes: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "capability",
  failureClasses: ["editor-action-queue-refusal"],
  proofIds: ["editor.agent.action-queue.refusal"],
  releaseImpact: "patch",
});

export function recordActionQueueRefusal(
  refusal: EditorAgentQueueRefusal,
  correlationId: string | undefined,
): void {
  processServerLogSink().write(
    activityLogEvent(
      EDITOR_ACTION_QUEUE,
      {
        correlationId: correlationIdOrUnknown(correlationId),
        level: "warn",
        errorKind: "rate-limited",
      },
      {
        outcome: "refused",
        reason: refusal.reason,
        actionBytes: refusal.actionBytes,
        sessionQueuedCount: refusal.sessionQueuedCount,
        sessionQueuedBytes: refusal.sessionQueuedBytes,
        processQueuedBytes: refusal.processQueuedBytes,
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}
