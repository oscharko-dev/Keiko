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
        "connector-scope-missing",
        "invalid-arguments",
        "descriptor-drift",
        "protocol-error",
        "tool-error",
        "log-unavailable",
        "deadline-exceeded",
        "aborted",
        "closed",
        "result-too-large",
        "backoff",
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
    // Digests of the server and tool names: stable join keys that carry no name.
    serverDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    toolDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    durationMs: { type: "integer", dataClass: "duration", required: false },
    requestBytes: { type: "integer", dataClass: "count", required: false },
    resultBytes: { type: "integer", dataClass: "count", required: false },
    // Whether the tools/call frame passed the dispatch gate; false proves the call had no effect.
    dispatched: { type: "boolean", dataClass: "closed-enum", required: false },
    effect: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["none", "possible"],
    },
    // Catalog narrowing at listing: tools the registry did not allow, and descriptions cut to bound.
    omittedToolCount: { type: "integer", dataClass: "count", required: false },
    truncatedDescriptionCount: { type: "integer", dataClass: "count", required: false },
    connectCause: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["timeout", "spawn", "aborted", "closed", "protocol", "unknown"],
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["mcp-managed"],
  proofIds: ["mcp.managed.lifecycle.line"],
  releaseImpact: "minor",
});

export interface ManagedMcpLineDetails {
  readonly invocationId?: string;
  readonly processOwner?: "posix-process-group" | "windows-job";
  readonly serverDigest?: string | undefined;
  readonly toolDigest?: string;
  readonly durationMs?: number;
  readonly requestBytes?: number;
  readonly resultBytes?: number;
  readonly dispatched?: boolean;
  readonly effect?: "none" | "possible";
  readonly omittedToolCount?: number;
  readonly truncatedDescriptionCount?: number;
  readonly connectCause?: "timeout" | "spawn" | "aborted" | "closed" | "protocol" | "unknown";
}

const DETAIL_FIELDS = [
  "invocationId",
  "processOwner",
  "serverDigest",
  "toolDigest",
  "durationMs",
  "requestBytes",
  "resultBytes",
  "dispatched",
  "effect",
  "omittedToolCount",
  "truncatedDescriptionCount",
  "connectCause",
] as const;

function definedDetails(details: ManagedMcpLineDetails): Record<string, string | number | boolean> {
  const present: Record<string, string | number | boolean> = {};
  for (const key of DETAIL_FIELDS) {
    const value = details[key];
    if (value !== undefined) present[key] = value;
  }
  return present;
}

export function recordManagedMcp(
  log: ManagedMcpLogPort,
  correlationId: string,
  phase: "admitted" | "listed" | "started" | "completed" | "failed",
  toolCount: number,
  registrySha256: string,
  reason: ManagedMcpFailure | "none" = "none",
  details: ManagedMcpLineDetails = {},
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
          ...definedDetails(details),
        },
      ),
    );
  } catch {
    recordActivityLogLoss("port-sink-failed");
    // Loss of terminal evidence never changes the already observed execution outcome.
    if (phase !== "completed" && phase !== "failed") throw new ManagedMcpError("log-unavailable");
  }
}
