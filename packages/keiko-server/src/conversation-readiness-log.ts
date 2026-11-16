import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { correlationIdOrUnknown } from "./correlation.js";
import { getServerLogger } from "./observability/index.js";
import type { ToolCallingReadinessReason } from "./conversation-readiness-error.js";

export type ConversationAdmissionDisposition =
  | "allowed-untracked"
  | "allowed-fresh"
  | "allowed-cached"
  | "model-changed"
  | "generation-changed"
  | "observation-unavailable"
  | "probe-failed"
  | "timestamp-invalid"
  | "provider-rejected";

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
        "allowed-cached",
        "model-changed",
        "generation-changed",
        "observation-unavailable",
        "probe-failed",
        "timestamp-invalid",
        "provider-rejected",
      ],
    },
    admittedGeneration: { type: "integer", dataClass: "count", required: false },
    currentGeneration: { type: "integer", dataClass: "count", required: false },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["unsupported", "unverified", "stale", "configuration-changed"],
    },
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
  reason?: ToolCallingReadinessReason,
): void {
  getServerLogger().info(
    activityLogEvent(
      CONVERSATION_ADMISSION,
      { correlationId: correlationIdOrUnknown(correlationId) },
      {
        disposition,
        ...(admittedGeneration === undefined ? {} : { admittedGeneration }),
        ...(currentGeneration === undefined ? {} : { currentGeneration }),
        ...(reason === undefined ? {} : { reason }),
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}
