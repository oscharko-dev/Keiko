import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import { correlationIdOrUnknown } from "./correlation.js";
import type { ServerLogSink } from "./observability/index.js";

const MEMORY_AUDIT_STATE_CACHE_SEEDED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "memory.audit.state-cache.seeded",
  category: "memory",
  owner: "keiko-server",
  emitter: "deps-activity.logMemoryAuditStateCacheSeeded",
  fields: {
    recordCount: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["memory-audit-state-cache"],
  proofIds: ["memory.audit.state-cache.seeded.count"],
  releaseImpact: "patch",
});

const TASK_WORKSPACE_REPOSITORY_REGISTRATION_REFUSED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "task-workspace.repository.registration-refused",
  category: "security",
  owner: "keiko-server",
  emitter: "deps-activity.logTaskWorkspaceRepositoryRegistration.refused",
  fields: {
    repositoryId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["ui-database-inside-repository"],
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["task-workspace-repository-registration"],
  proofIds: ["task-workspace.repository.registration-refused.reason"],
  releaseImpact: "patch",
});

const TASK_WORKSPACE_REPOSITORY_REGISTERED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "task-workspace.repository.registered",
  category: "security",
  owner: "keiko-server",
  emitter: "deps-activity.logTaskWorkspaceRepositoryRegistration.registered",
  fields: {
    repositoryId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    granted: { type: "boolean", dataClass: "closed-enum", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["task-workspace-repository-registration"],
  proofIds: ["task-workspace.repository.registered.restricted"],
  releaseImpact: "patch",
});

const SERVER_RUNTIME_SHUTDOWN_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "server.runtime.shutdown",
  category: "process",
  owner: "keiko-server",
  emitter: "deps-activity.logRuntimeShutdown",
  fields: {
    state: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["started", "completed"],
    },
    openSseStreamCount: { type: "integer", dataClass: "count", required: true },
    activeRunCount: { type: "integer", dataClass: "count", required: true },
    durationMs: { type: "integer", dataClass: "duration", required: false },
    runtimeShutdown: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["not-applicable", "ended", "refused", "faulted"],
    },
    cleanup: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["completed", "faulted"],
    },
    errorClass: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
    code: { type: "string", dataClass: "opaque-id", required: false, maxLength: 256 },
    gatewayRequestId: {
      type: "string",
      dataClass: "opaque-id",
      required: false,
      maxLength: 160,
    },
    httpStatus: { type: "integer", dataClass: "count", required: false },
    retryAfterMs: { type: "integer", dataClass: "duration", required: false },
    promptTokens: { type: "integer", dataClass: "count", required: false },
    completionTokens: { type: "integer", dataClass: "count", required: false },
    frames: {
      type: "string-array",
      dataClass: "safe-platform-class",
      required: false,
      maxLength: 512,
      maxItems: 8,
    },
    causeChain: {
      type: "string-array",
      dataClass: "error-kind",
      required: false,
      maxLength: 128,
      maxItems: 5,
    },
    failedStepCount: { type: "integer", dataClass: "count", required: false },
    failedStepErrorClasses: {
      type: "string-array",
      dataClass: "error-kind",
      required: false,
      maxLength: 64,
      maxItems: 16,
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "process-lifecycle",
  failureClasses: ["runtime-shutdown"],
  proofIds: ["server.runtime.shutdown.lifecycle"],
  releaseImpact: "patch",
});

export interface RuntimeShutdownCleanup {
  readonly cleanup: "completed" | "faulted";
  readonly errorClass?: string | undefined;
  readonly code?: string | undefined;
  readonly gatewayRequestId?: string | undefined;
  readonly httpStatus?: number | undefined;
  readonly retryAfterMs?: number | undefined;
  readonly promptTokens?: number | undefined;
  readonly completionTokens?: number | undefined;
  readonly frames?: readonly string[] | undefined;
  readonly causeChain?: readonly string[] | undefined;
  readonly failedStepCount?: number | undefined;
  readonly failedStepErrorClasses?: readonly string[] | undefined;
}

type RuntimeShutdownDisposition = "not-applicable" | "ended" | "refused" | "faulted";

export type RuntimeShutdownEvidence =
  | {
      readonly state: "started";
      readonly openSseStreamCount: number;
      readonly activeRunCount: number;
    }
  | (RuntimeShutdownCleanup & {
      readonly state: "completed";
      readonly openSseStreamCount: number;
      readonly activeRunCount: number;
      readonly durationMs: number;
      readonly runtimeShutdown: RuntimeShutdownDisposition;
    });

export function logMemoryAuditStateCacheSeeded(
  sink: ServerLogSink,
  correlationId: string | undefined,
  recordCount: number,
): void {
  sink.write(
    activityLogEvent(
      MEMORY_AUDIT_STATE_CACHE_SEEDED_OPERATION,
      { correlationId: correlationIdOrUnknown(correlationId) },
      { recordCount, completeness: "complete", loss: "none" },
    ),
  );
}

export function logTaskWorkspaceRepositoryRegistration(
  sink: ServerLogSink,
  correlationId: string | undefined,
  evidence:
    | {
        readonly outcome: "refused";
        readonly repositoryId: string;
        readonly reason: "ui-database-inside-repository";
      }
    | { readonly outcome: "registered"; readonly repositoryId: string; readonly granted: false },
): void {
  const resolvedCorrelationId = correlationIdOrUnknown(correlationId);
  if (evidence.outcome === "refused") {
    sink.write(
      activityLogEvent(
        TASK_WORKSPACE_REPOSITORY_REGISTRATION_REFUSED_OPERATION,
        { level: "warn", correlationId: resolvedCorrelationId, errorKind: "unsafe-target" },
        {
          repositoryId: evidence.repositoryId,
          reason: evidence.reason,
          completeness: "complete",
          loss: "none",
        },
      ),
    );
    return;
  }
  sink.write(
    activityLogEvent(
      TASK_WORKSPACE_REPOSITORY_REGISTERED_OPERATION,
      { correlationId: resolvedCorrelationId },
      {
        repositoryId: evidence.repositoryId,
        granted: evidence.granted,
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}

export function logRuntimeShutdown(
  sink: ServerLogSink,
  correlationId: string | undefined,
  evidence: RuntimeShutdownEvidence,
): void {
  const cleanupFaulted = evidence.state === "completed" && evidence.cleanup === "faulted";
  sink.write(
    activityLogEvent(
      SERVER_RUNTIME_SHUTDOWN_OPERATION,
      {
        level: evidence.state === "started" || cleanupFaulted ? "warn" : "info",
        correlationId: correlationIdOrUnknown(correlationId),
        ...(cleanupFaulted ? { errorKind: "internal" as const } : {}),
      },
      { ...evidence, completeness: "complete", loss: "none" },
    ),
  );
}
