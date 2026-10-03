import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { correlationIdOrUnknown } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";

export type EditorBufferSafetyOutcome = "registered" | "refreshed" | "released" | "refused";
const BUFFER_SAFETY_STATE = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "editor.buffer-safety.state",
  category: "security",
  owner: "keiko-server",
  emitter: "editor.bufferSafetyEvidence.recordBufferSafetyState",
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["registered", "refreshed", "released", "refused"],
    },
    dirtyFileCount: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "capability",
  failureClasses: ["git-delivery-dirty-buffer"],
  proofIds: ["editor.buffer-safety.state.lifecycle"],
  releaseImpact: "patch",
});

export function recordBufferSafetyState(
  outcome: EditorBufferSafetyOutcome,
  dirtyFileCount: number,
  correlationId: string | undefined,
): void {
  processServerLogSink().write(
    activityLogEvent(
      BUFFER_SAFETY_STATE,
      {
        correlationId: correlationIdOrUnknown(correlationId),
        level: outcome === "refused" ? "warn" : "info",
        ...(outcome === "refused" ? ({ errorKind: "conflict" } as const) : {}),
      },
      { outcome, dirtyFileCount, completeness: "complete", loss: "none" },
    ),
  );
}
