import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  activityLogEvent,
  defineActivityLogOperation,
  recordActivityLogLoss,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

const AUTHORIZATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "mcp.authorization.state",
  category: "security",
  owner: "keiko-server",
  emitter: "mcp.mcpAuthorizationActivity.recordMcpAuthorization",
  fields: {
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
    attemptCount: { type: "integer", dataClass: "count", required: true },
    state: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "pending",
        "complete",
        "failed",
        "expired",
        "cancelled",
        "revoked",
        "credential-ready",
        "credential-required",
        "credential-unavailable",
      ],
    },
    attemptId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["mcp-authorization"],
  proofIds: ["mcp.authorization.state.line"],
  releaseImpact: "minor",
});
export function recordMcpAuthorization(
  log: ServerLogSink,
  correlationId: string,
  attemptId: string,
  state:
    | "pending"
    | "complete"
    | "failed"
    | "expired"
    | "cancelled"
    | "revoked"
    | "credential-ready"
    | "credential-required"
    | "credential-unavailable",
): void {
  try {
    log.write(
      activityLogEvent(
        AUTHORIZATION,
        { correlationId, level: state === "failed" ? "warn" : "info" },
        { state, attemptId, completeness: "complete", loss: "none", attemptCount: 1 },
      ),
    );
  } catch (error) {
    recordActivityLogLoss("port-sink-failed");
    if (state === "pending") throw error;
  }
}
