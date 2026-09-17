import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
  type ActivityLogEventEnvelope,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import {
  emitKnowledgeLogEvent,
  knowledgeLogCorrelationId,
  type KnowledgeLogSink,
} from "../knowledge-log.js";
import type { IndexingLogContext } from "./types.js";

const PREFLIGHT_STARTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "embedding.preflight.started",
  category: "embedding",
  owner: "keiko-local-knowledge",
  emitter: "indexing/preflight-activity-log.emitPreflightActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    providerDigest: { type: "string", dataClass: "digest", required: true, maxLength: 16 },
    modelIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 16 },
    expectedDimensions: { type: "integer", dataClass: "count", required: false },
    fingerprinted: {
      type: "boolean",
      dataClass: "closed-enum",
      required: true,
      values: ["true", "false"],
    },
    endpointDigest: { type: "string", dataClass: "digest", required: false, maxLength: 16 },
    cached: {
      type: "boolean",
      dataClass: "closed-enum",
      required: true,
      values: ["true", "false"],
    },
  },
  causal: "correlation",
  lifecycle: "start",
  analyzerProjection: "capability",
  failureClasses: ["embedding-preflight-stall"],
  proofIds: ["embedding.preflight.started.profile"],
  releaseImpact: "patch",
});

const PREFLIGHT_FAILED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "embedding.preflight.failed",
  category: "embedding",
  owner: "keiko-local-knowledge",
  emitter: "indexing/preflight-activity-log.emitPreflightActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    providerDigest: { type: "string", dataClass: "digest", required: false, maxLength: 16 },
    modelIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 16 },
    expectedDimensions: { type: "integer", dataClass: "count", required: false },
    fingerprinted: {
      type: "boolean",
      dataClass: "closed-enum",
      required: false,
      values: ["true", "false"],
    },
    endpointDigest: { type: "string", dataClass: "digest", required: false, maxLength: 16 },
    failureSource: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["result", "throw"],
    },
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["embedding-preflight"],
  proofIds: ["embedding.preflight.failed.kind"],
  releaseImpact: "patch",
});

const PREFLIGHT_COMPLETED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "embedding.preflight.completed",
  category: "embedding",
  owner: "keiko-local-knowledge",
  emitter: "indexing/preflight-activity-log.emitPreflightActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    providerDigest: { type: "string", dataClass: "digest", required: true, maxLength: 16 },
    modelIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 16 },
    expectedDimensions: { type: "integer", dataClass: "count", required: false },
    fingerprinted: {
      type: "boolean",
      dataClass: "closed-enum",
      required: true,
      values: ["true", "false"],
    },
    endpointDigest: { type: "string", dataClass: "digest", required: false, maxLength: 16 },
    observedDimensions: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "capability",
  failureClasses: ["embedding-preflight-identity"],
  proofIds: ["embedding.preflight.completed.dimensions"],
  releaseImpact: "patch",
});

const PREFLIGHT_CACHE_HIT_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "embedding.preflight.cache-hit",
  category: "embedding",
  owner: "keiko-local-knowledge",
  emitter: "indexing/preflight-activity-log.emitPreflightActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    providerDigest: { type: "string", dataClass: "digest", required: true, maxLength: 16 },
    modelIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 16 },
    expectedDimensions: { type: "integer", dataClass: "count", required: false },
    fingerprinted: {
      type: "boolean",
      dataClass: "closed-enum",
      required: true,
      values: ["true", "false"],
    },
    endpointDigest: { type: "string", dataClass: "digest", required: false, maxLength: 16 },
    cached: {
      type: "boolean",
      dataClass: "closed-enum",
      required: true,
      values: ["true", "false"],
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "capability",
  failureClasses: ["embedding-preflight-cache"],
  proofIds: ["embedding.preflight.cache-hit.profile"],
  releaseImpact: "patch",
});

const PREFLIGHT_IDENTITY_REJECTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "embedding.preflight.identity-rejected",
  category: "embedding",
  owner: "keiko-local-knowledge",
  emitter: "indexing/preflight-activity-log.emitPreflightActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    pinnedDimensions: { type: "integer", dataClass: "count", required: true },
    observedDimensions: { type: "integer", dataClass: "count", required: true },
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["embedding-identity-mismatch"],
  proofIds: ["embedding.preflight.identity-rejected.dimensions"],
  releaseImpact: "patch",
});

const PREFLIGHT_IDENTITY_ADOPTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "embedding.preflight.identity-adopted",
  category: "embedding",
  owner: "keiko-local-knowledge",
  emitter: "indexing/preflight-activity-log.emitPreflightActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    observedDimensions: { type: "integer", dataClass: "count", required: true },
    providerDigest: { type: "string", dataClass: "digest", required: true, maxLength: 16 },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "capability",
  failureClasses: ["embedding-identity-adoption"],
  proofIds: ["embedding.preflight.identity-adopted.dimensions"],
  releaseImpact: "patch",
});

const PREFLIGHT_IDENTITY_REFRESHED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "embedding.preflight.identity-refreshed",
  category: "embedding",
  owner: "keiko-local-knowledge",
  emitter: "indexing/preflight-activity-log.emitPreflightActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    observedDimensions: { type: "integer", dataClass: "count", required: true },
    providerDigest: { type: "string", dataClass: "digest", required: true, maxLength: 16 },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "capability",
  failureClasses: ["embedding-identity-refresh"],
  proofIds: ["embedding.preflight.identity-refreshed.dimensions"],
  releaseImpact: "patch",
});

export interface PreflightProbeFields {
  readonly providerDigest: string;
  readonly modelIdDigest: string;
  readonly expectedDimensions?: number;
  readonly fingerprinted: boolean;
  readonly endpointDigest?: string;
}

export type PreflightActivity =
  | ({ readonly op: "embedding.preflight.started"; readonly cached: false } & PreflightProbeFields)
  | ({
      readonly op: "embedding.preflight.failed";
      readonly failureKind: string;
      readonly failureSource: "result" | "throw";
      readonly durationMs?: number;
    } & Partial<PreflightProbeFields>)
  | ({
      readonly op: "embedding.preflight.completed";
      readonly observedDimensions: number;
      readonly durationMs: number;
    } & PreflightProbeFields)
  | ({ readonly op: "embedding.preflight.cache-hit"; readonly cached: true } & PreflightProbeFields)
  | {
      readonly op: "embedding.preflight.identity-rejected";
      readonly pinnedDimensions: number;
      readonly observedDimensions: number;
      readonly failureKind: string;
    }
  | {
      readonly op:
        "embedding.preflight.identity-adopted" | "embedding.preflight.identity-refreshed";
      readonly observedDimensions: number;
      readonly providerDigest: string;
    };

function failureErrorKind(kind: string): ActivityLogErrorKind {
  switch (kind) {
    case "cancelled":
    case "CANCELLED":
      return "cancelled";
    case "timeout":
      return "timeout";
    case "rate-limited":
      return "rate-limited";
    case "proxy-blocked-by-policy":
      return "authority-denied";
    case "dimension-mismatch":
    case "incompatible-with-stored-identity":
    case "INCOMPATIBLE_EMBEDDING_IDENTITY":
      return "validation-failed";
    default:
      return "unavailable";
  }
}

function eventEnvelope(
  context: IndexingLogContext,
  level: "info" | "warn" | "error",
  failureKind?: string,
  durationMs?: number,
): ActivityLogEventEnvelope {
  return {
    level,
    correlationId: knowledgeLogCorrelationId(context.jobId),
    ...(failureKind === undefined ? {} : { errorKind: failureErrorKind(failureKind) }),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

function probeFields(
  context: IndexingLogContext,
  event: PreflightProbeFields,
): {
  readonly capsuleIdDigest: string;
  readonly providerDigest: string;
  readonly modelIdDigest: string;
  readonly expectedDimensions?: number;
  readonly fingerprinted: boolean;
  readonly endpointDigest?: string;
} {
  return {
    capsuleIdDigest: context.capsuleIdDigest,
    providerDigest: event.providerDigest,
    modelIdDigest: event.modelIdDigest,
    ...(event.expectedDimensions === undefined
      ? {}
      : { expectedDimensions: event.expectedDimensions }),
    fingerprinted: event.fingerprinted,
    ...(event.endpointDigest === undefined ? {} : { endpointDigest: event.endpointDigest }),
  };
}

function emitProbeLifecycle(
  sink: KnowledgeLogSink | undefined,
  context: IndexingLogContext,
  event: PreflightActivity,
): boolean {
  if (event.op === "embedding.preflight.started") {
    emitKnowledgeLogEvent(
      sink,
      activityLogEvent(PREFLIGHT_STARTED_OPERATION, eventEnvelope(context, "info"), {
        ...probeFields(context, event),
        cached: event.cached,
      }),
    );
    return true;
  }
  if (event.op === "embedding.preflight.completed") {
    emitKnowledgeLogEvent(
      sink,
      activityLogEvent(
        PREFLIGHT_COMPLETED_OPERATION,
        eventEnvelope(context, "info", undefined, event.durationMs),
        { ...probeFields(context, event), observedDimensions: event.observedDimensions },
      ),
    );
    return true;
  }
  if (event.op === "embedding.preflight.cache-hit") {
    emitKnowledgeLogEvent(
      sink,
      activityLogEvent(PREFLIGHT_CACHE_HIT_OPERATION, eventEnvelope(context, "info"), {
        ...probeFields(context, event),
        cached: event.cached,
      }),
    );
    return true;
  }
  return false;
}

function emitPreflightFailure(
  sink: KnowledgeLogSink | undefined,
  context: IndexingLogContext,
  event: PreflightActivity,
): boolean {
  if (event.op === "embedding.preflight.failed") {
    const level = event.failureKind === "CANCELLED" ? "warn" : "error";
    emitKnowledgeLogEvent(
      sink,
      activityLogEvent(
        PREFLIGHT_FAILED_OPERATION,
        eventEnvelope(context, level, event.failureKind, event.durationMs),
        {
          capsuleIdDigest: context.capsuleIdDigest,
          ...(event.providerDigest === undefined ? {} : { providerDigest: event.providerDigest }),
          ...(event.modelIdDigest === undefined ? {} : { modelIdDigest: event.modelIdDigest }),
          ...(event.expectedDimensions === undefined
            ? {}
            : { expectedDimensions: event.expectedDimensions }),
          ...(event.fingerprinted === undefined ? {} : { fingerprinted: event.fingerprinted }),
          ...(event.endpointDigest === undefined ? {} : { endpointDigest: event.endpointDigest }),
          failureSource: event.failureSource,
          failureKind: event.failureKind,
        },
      ),
    );
    return true;
  }
  if (event.op === "embedding.preflight.identity-rejected") {
    emitKnowledgeLogEvent(
      sink,
      activityLogEvent(
        PREFLIGHT_IDENTITY_REJECTED_OPERATION,
        eventEnvelope(context, "error", event.failureKind),
        {
          capsuleIdDigest: context.capsuleIdDigest,
          pinnedDimensions: event.pinnedDimensions,
          observedDimensions: event.observedDimensions,
          failureKind: event.failureKind,
        },
      ),
    );
    return true;
  }
  return false;
}

function emitIdentityState(
  sink: KnowledgeLogSink | undefined,
  context: IndexingLogContext,
  event: PreflightActivity,
): void {
  if (
    event.op !== "embedding.preflight.identity-adopted" &&
    event.op !== "embedding.preflight.identity-refreshed"
  ) {
    return;
  }
  const fields = {
    capsuleIdDigest: context.capsuleIdDigest,
    observedDimensions: event.observedDimensions,
    providerDigest: event.providerDigest,
  };
  if (event.op === "embedding.preflight.identity-adopted") {
    emitKnowledgeLogEvent(
      sink,
      activityLogEvent(
        PREFLIGHT_IDENTITY_ADOPTED_OPERATION,
        eventEnvelope(context, "info"),
        fields,
      ),
    );
    return;
  }
  if (event.op === "embedding.preflight.identity-refreshed") {
    emitKnowledgeLogEvent(
      sink,
      activityLogEvent(
        PREFLIGHT_IDENTITY_REFRESHED_OPERATION,
        eventEnvelope(context, "info"),
        fields,
      ),
    );
  }
}

export function emitPreflightActivity(
  sink: KnowledgeLogSink | undefined,
  context: IndexingLogContext,
  event: PreflightActivity,
): void {
  if (emitProbeLifecycle(sink, context, event)) return;
  if (emitPreflightFailure(sink, context, event)) return;
  emitIdentityState(sink, context, event);
}
