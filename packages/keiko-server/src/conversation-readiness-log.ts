import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { correlationIdOrUnknown } from "./correlation.js";
import { getServerLogger } from "./observability/index.js";

export type ConversationAdmissionDisposition =
  | "allowed-untracked"
  | "allowed-fresh"
  | "allowed-continuation"
  | "model-changed"
  | "generation-changed"
  | "observation-unavailable"
  | "probe-failed"
  | "timestamp-invalid"
  | "expired";

const CONVERSATION_ADMISSION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.conversation.admission",
  owner: "keiko-server",
  category: "gateway",
  emitter: "conversation-readiness-log.logConversationAdmission",
  fields: {
    disposition: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "allowed-untracked",
        "allowed-fresh",
        "allowed-continuation",
        "model-changed",
        "generation-changed",
        "observation-unavailable",
        "probe-failed",
        "timestamp-invalid",
        "expired",
      ],
    },
    admittedGeneration: { type: "integer", dataClass: "count", required: false },
    currentGeneration: { type: "integer", dataClass: "count", required: false },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["gateway-readiness"],
  proofIds: ["gateway.conversation.admission.line"],
  releaseImpact: "patch",
});

export function logConversationAdmission(
  disposition: ConversationAdmissionDisposition,
  correlationId: string | undefined,
  admittedGeneration: number | undefined,
  currentGeneration: number | undefined,
): void {
  getServerLogger().info(
    activityLogEvent(
      CONVERSATION_ADMISSION,
      { correlationId: correlationIdOrUnknown(correlationId) },
      {
        disposition,
        ...(admittedGeneration === undefined ? {} : { admittedGeneration }),
        ...(currentGeneration === undefined ? {} : { currentGeneration }),
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}
