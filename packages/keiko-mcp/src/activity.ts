import {
  activityLogEvent,
  defineActivityLogOperation,
  recordActivityLogLoss,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type {
  ManagedMcpFailure,
  ManagedMcpLogPort,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { ManagedMcpError } from "./definitions.js";

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
        "log-unavailable",
        "deadline-exceeded",
        "aborted",
        "closed",
      ],
    },
    registrySha256: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
    toolCount: { type: "integer", dataClass: "count", required: true },
    processOwner: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["posix-process-group", "windows-job"],
    },
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
  details: {
    readonly invocationId?: string;
    readonly processOwner?: "posix-process-group" | "windows-job";
  } = {},
): void {
  try {
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
          ...(details.invocationId === undefined ? {} : { invocationId: details.invocationId }),
          ...(details.processOwner === undefined ? {} : { processOwner: details.processOwner }),
        },
      ),
    );
  } catch {
    recordActivityLogLoss("port-sink-failed");
    // Loss of terminal evidence never changes the already observed execution outcome.
    if (phase !== "completed" && phase !== "failed") throw new ManagedMcpError("log-unavailable");
  }
}
