import { UiStoreError } from "./errors.js";
import {
  activityLogEvent,
  defineActivityLogOperation,
  recordActivityLogLoss,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { ServerLogSink } from "../observability/index.js";
import type { ChatToolMutationRecord } from "./chatToolMutationTypes.js";
const MUTATION_STATE = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "chat.tool-mutation",
  category: "process",
  owner: "keiko-server",
  emitter: "store.chatToolMutationActivity.recordChatToolMutation",
  fields: {
    invocationId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    actionDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    event: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["prepared", "replayed", "dispatched", "response", "settled"],
    },
    phase: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["prepared", "dispatched", "acknowledged", "settled"],
    },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "none",
        "not-dispatched",
        "rejected",
        "succeeded",
        "succeeded-unconfirmed",
        "unknown",
      ],
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["chat-tool-mutation"],
  proofIds: ["chat.tool-mutation.emitted-line"],
  releaseImpact: "patch",
});
export function recordChatToolMutation(
  log: ServerLogSink,
  record: ChatToolMutationRecord,
  event: "prepared" | "replayed" | "dispatched" | "response" | "settled",
): void {
  try {
    log.write(
      activityLogEvent(
        MUTATION_STATE,
        {
          correlationId: record.correlationId,
          level: record.outcome === "unknown" ? "warn" : "info",
        },
        {
          invocationId: record.invocationId,
          actionDigest: record.actionDigest,
          event,
          phase: record.phase,
          outcome: record.outcome ?? "none",
          completeness: "complete",
          loss: "none",
        },
      ),
    );
  } catch {
    recordActivityLogLoss("port-sink-failed");
    if (event === "prepared" || event === "dispatched")
      throw new UiStoreError(
        "INTERNAL",
        "The mutation journal activity could not be recorded.",
        500,
      );
  }
}
