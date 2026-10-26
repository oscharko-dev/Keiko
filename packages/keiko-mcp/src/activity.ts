import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type {
  ManagedMcpFailure,
  ManagedMcpLogPort,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";

const LIFECYCLE = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "mcp.managed.lifecycle",
  category: "process",
  owner: "keiko-mcp",
  emitter: "activity.recordManagedMcp",
  fields: {
    phase: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["admitted", "listed", "started", "completed", "failed"],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "none",
        "not-admitted",
        "invalid-arguments",
        "descriptor-drift",
        "protocol-error",
        "tool-error",
        "aborted",
        "closed",
      ],
    },
    registrySha256: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
    toolCount: { type: "integer", dataClass: "count", required: true },
    invocationId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 128 },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["mcp-managed"],
  proofIds: ["mcp.managed.lifecycle.line"],
  releaseImpact: "minor",
});

export function recordManagedMcp(
  log: ManagedMcpLogPort,
  correlationId: string,
  phase: "admitted" | "listed" | "started" | "completed" | "failed",
  toolCount: number,
  registrySha256: string,
  reason: ManagedMcpFailure | "none" = "none",
  invocationId?: string,
): void {
  log.write(
    activityLogEvent(
      LIFECYCLE,
      { correlationId, level: phase === "failed" ? "error" : "info" },
      {
        phase,
        reason,
        toolCount,
        registrySha256,
        completeness: "complete",
        loss: "none",
        ...(invocationId === undefined ? {} : { invocationId }),
      },
    ),
  );
}
