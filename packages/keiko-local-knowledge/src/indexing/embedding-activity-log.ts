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

const CHUNK_RETRY_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "embedding.chunk.retry",
  category: "embedding",
  owner: "keiko-local-knowledge",
  emitter: "indexing/embedding-activity-log.emitEmbeddingActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    documentIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    attempt: { type: "integer", dataClass: "count", required: true },
    maxRetries: { type: "integer", dataClass: "count", required: true },
    delayMs: { type: "number", dataClass: "duration", required: true },
    transport: { type: "string", dataClass: "closed-enum", required: true, values: ["scalar"] },
    endpointDigest: { type: "string", dataClass: "digest", required: false, maxLength: 16 },
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
  },
  causal: "none",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["embedding-retry"],
  proofIds: ["embedding.chunk.retry.attempt"],
  releaseImpact: "patch",
});

const CHUNK_RETRY_EXHAUSTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "embedding.chunk.retry-exhausted",
  category: "embedding",
  owner: "keiko-local-knowledge",
  emitter: "indexing/embedding-activity-log.emitEmbeddingActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    documentIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    attempt: { type: "integer", dataClass: "count", required: true },
    maxRetries: { type: "integer", dataClass: "count", required: true },
    transport: { type: "string", dataClass: "closed-enum", required: true, values: ["scalar"] },
    endpointDigest: { type: "string", dataClass: "digest", required: false, maxLength: 16 },
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
  },
  causal: "none",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["embedding-retry-exhausted"],
  proofIds: ["embedding.chunk.retry-exhausted.attempt"],
  releaseImpact: "patch",
});

const BATCH_PARTIAL_PROGRESS_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "embedding.batch.partial-progress",
  category: "embedding",
  owner: "keiko-local-knowledge",
  emitter: "indexing/embedding-activity-log.emitEmbeddingActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    documentIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    attempt: { type: "integer", dataClass: "count", required: true },
    zeroProgressRetries: { type: "integer", dataClass: "count", required: true },
    maxRetries: { type: "integer", dataClass: "count", required: true },
    delayMs: { type: "number", dataClass: "duration", required: true },
    remainingCount: { type: "integer", dataClass: "count", required: true },
    completedCount: { type: "integer", dataClass: "count", required: true },
    transport: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["array-batch"],
    },
    endpointDigest: { type: "string", dataClass: "digest", required: false, maxLength: 16 },
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
  },
  causal: "none",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["embedding-partial-progress"],
  proofIds: ["embedding.batch.partial-progress.counts"],
  releaseImpact: "patch",
});

const BATCH_RETRY_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "embedding.batch.retry",
  category: "embedding",
  owner: "keiko-local-knowledge",
  emitter: "indexing/embedding-activity-log.emitEmbeddingActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    documentIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    attempt: { type: "integer", dataClass: "count", required: true },
    zeroProgressRetries: { type: "integer", dataClass: "count", required: true },
    maxRetries: { type: "integer", dataClass: "count", required: true },
    delayMs: { type: "number", dataClass: "duration", required: true },
    remainingCount: { type: "integer", dataClass: "count", required: true },
    completedCount: { type: "integer", dataClass: "count", required: true },
    transport: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["array-batch"],
    },
    endpointDigest: { type: "string", dataClass: "digest", required: false, maxLength: 16 },
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
  },
  causal: "none",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["embedding-retry"],
  proofIds: ["embedding.batch.retry.counts"],
  releaseImpact: "patch",
});

const TRANSPORT_UNAVAILABLE_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "embedding.batch.transport-unavailable",
  category: "embedding",
  owner: "keiko-local-knowledge",
  emitter: "indexing/embedding-activity-log.emitEmbeddingActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    documentIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    itemCount: { type: "integer", dataClass: "count", required: true },
    transport: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["array-batch"],
    },
  },
  causal: "none",
  lifecycle: "failure",
  analyzerProjection: "capability",
  failureClasses: ["embedding-transport-unavailable"],
  proofIds: ["embedding.batch.transport-unavailable.count"],
  releaseImpact: "patch",
});

const IDENTITY_REJECTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "embedding.identity.rejected",
  category: "embedding",
  owner: "keiko-local-knowledge",
  emitter: "indexing/embedding-activity-log.emitEmbeddingActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    documentIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    pinnedDimensions: { type: "integer", dataClass: "count", required: true },
    observedDimensions: { type: "integer", dataClass: "count", required: true },
    pinnedNormalization: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["l2", "none", "unknown"],
    },
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
  },
  causal: "none",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["embedding-identity-mismatch"],
  proofIds: ["embedding.identity.rejected.dimensions"],
  releaseImpact: "patch",
});

const BATCH_FAILED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "embedding.batch.failed",
  category: "embedding",
  owner: "keiko-local-knowledge",
  emitter: "indexing/embedding-activity-log.emitEmbeddingActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    documentIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    itemCount: { type: "integer", dataClass: "count", required: true },
    failureClass: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["transient", "terminal"],
    },
    transport: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["array-batch"],
    },
    endpointDigest: { type: "string", dataClass: "digest", required: false, maxLength: 16 },
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
  },
  causal: "none",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["embedding-batch"],
  proofIds: ["embedding.batch.failed.class"],
  releaseImpact: "patch",
});

const BUDGETING_FAILED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "embedding.batch.budgeting-failed",
  category: "embedding",
  owner: "keiko-local-knowledge",
  emitter: "indexing/embedding-activity-log.emitEmbeddingActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    documentIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    uniqueChunkCount: { type: "integer", dataClass: "count", required: true },
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
  },
  causal: "none",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["embedding-budgeting"],
  proofIds: ["embedding.batch.budgeting-failed.count"],
  releaseImpact: "patch",
});

const BATCH_GROUPED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "embedding.batch.grouped",
  category: "embedding",
  owner: "keiko-local-knowledge",
  emitter: "indexing/embedding-activity-log.emitEmbeddingActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    documentIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    uniqueChunkCount: { type: "integer", dataClass: "count", required: true },
    batchCount: { type: "integer", dataClass: "count", required: true },
    concurrency: { type: "integer", dataClass: "count", required: true },
    endpointDigest: { type: "string", dataClass: "digest", required: false, maxLength: 16 },
  },
  causal: "none",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["embedding-batch-grouping"],
  proofIds: ["embedding.batch.grouped.counts"],
  releaseImpact: "patch",
});

const TRANSPORT_SELECTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "embedding.batch.transport-selected",
  category: "embedding",
  owner: "keiko-local-knowledge",
  emitter: "indexing/embedding-activity-log.emitEmbeddingActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    documentIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    transport: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["array-batch", "scalar"],
    },
    chunkCount: { type: "integer", dataClass: "count", required: true },
    uniqueChunkCount: { type: "integer", dataClass: "count", required: true },
    dedupedCount: { type: "integer", dataClass: "count", required: true },
    concurrency: { type: "integer", dataClass: "count", required: true },
    endpointDigest: { type: "string", dataClass: "digest", required: false, maxLength: 16 },
  },
  causal: "none",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["embedding-transport-selection"],
  proofIds: ["embedding.batch.transport-selected.profile"],
  releaseImpact: "patch",
});

const PERSIST_FAILED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "embedding.batch.persist-failed",
  category: "embedding",
  owner: "keiko-local-knowledge",
  emitter: "indexing/embedding-activity-log.emitEmbeddingActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    documentIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    chunkCount: { type: "integer", dataClass: "count", required: true },
    vectorCount: { type: "integer", dataClass: "count", required: true },
    errorCount: { type: "integer", dataClass: "count", required: true },
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
  },
  causal: "none",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["embedding-persistence"],
  proofIds: ["embedding.batch.persist-failed.counts"],
  releaseImpact: "patch",
});

const BATCH_COMPLETED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "embedding.batch.completed",
  category: "embedding",
  owner: "keiko-local-knowledge",
  emitter: "indexing/embedding-activity-log.emitEmbeddingActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    documentIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    chunkCount: { type: "integer", dataClass: "count", required: true },
    vectorCount: { type: "integer", dataClass: "count", required: true },
    errorCount: { type: "integer", dataClass: "count", required: true },
  },
  causal: "none",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["embedding-partial-failure"],
  proofIds: ["embedding.batch.completed.counts"],
  releaseImpact: "patch",
});

const BATCH_REJECTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "embedding.batch.rejected",
  category: "embedding",
  owner: "keiko-local-knowledge",
  emitter: "indexing/embedding-activity-log.emitEmbeddingActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    documentIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    chunkCount: { type: "integer", dataClass: "count", required: true },
    vectorCount: { type: "integer", dataClass: "count", required: true },
    errorCount: { type: "integer", dataClass: "count", required: true },
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
  },
  causal: "none",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["embedding-identity-rejection"],
  proofIds: ["embedding.batch.rejected.counts"],
  releaseImpact: "patch",
});

const BATCH_CANCELLED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "embedding.batch.cancelled",
  category: "embedding",
  owner: "keiko-local-knowledge",
  emitter: "indexing/embedding-activity-log.emitEmbeddingActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    documentIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    chunkCount: { type: "integer", dataClass: "count", required: true },
    vectorCount: { type: "integer", dataClass: "count", required: true },
    errorCount: { type: "integer", dataClass: "count", required: true },
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
  },
  causal: "none",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["embedding-cancelled"],
  proofIds: ["embedding.batch.cancelled.counts"],
  releaseImpact: "patch",
});

interface RetryFields {
  readonly attempt: number;
  readonly maxRetries: number;
  readonly delayMs?: number;
  readonly zeroProgressRetries?: number;
  readonly remainingCount?: number;
  readonly completedCount?: number;
  readonly transport: "scalar" | "array-batch";
  readonly endpointDigest?: string;
}

interface ClosingFields {
  readonly chunkCount: number;
  readonly vectorCount: number;
  readonly errorCount: number;
}

export type EmbeddingActivity =
  | ({ readonly op: "embedding.chunk.retry" | "embedding.chunk.retry-exhausted" } & RetryFields &
      FailureEnvelope)
  | ({ readonly op: "embedding.batch.partial-progress" | "embedding.batch.retry" } & RetryFields &
      Required<
        Pick<RetryFields, "delayMs" | "zeroProgressRetries" | "remainingCount" | "completedCount">
      > &
      FailureEnvelope)
  | { readonly op: "embedding.batch.transport-unavailable"; readonly itemCount: number }
  | {
      readonly op: "embedding.identity.rejected";
      readonly pinnedDimensions: number;
      readonly observedDimensions: number;
      readonly pinnedNormalization: "l2" | "none" | "unknown";
      readonly failureKind: string;
    }
  | ({
      readonly op: "embedding.batch.failed";
      readonly itemCount: number;
      readonly failureClass: "transient" | "terminal";
      readonly endpointDigest?: string;
    } & FailureEnvelope)
  | ({
      readonly op: "embedding.batch.budgeting-failed";
      readonly uniqueChunkCount: number;
    } & FailureEnvelope)
  | {
      readonly op: "embedding.batch.grouped";
      readonly uniqueChunkCount: number;
      readonly batchCount: number;
      readonly concurrency: number;
      readonly endpointDigest?: string;
    }
  | {
      readonly op: "embedding.batch.transport-selected";
      readonly transport: "scalar" | "array-batch";
      readonly chunkCount: number;
      readonly uniqueChunkCount: number;
      readonly dedupedCount: number;
      readonly concurrency: number;
      readonly endpointDigest?: string;
    }
  | ({
      readonly op:
        "embedding.batch.persist-failed" | "embedding.batch.rejected" | "embedding.batch.cancelled";
    } & ClosingFields &
      FailureEnvelope)
  | ({ readonly op: "embedding.batch.completed" } & ClosingFields & {
        readonly level: "info" | "warn";
        readonly durationMs: number;
      });

interface FailureEnvelope {
  readonly failureKind: string;
  readonly durationMs?: number | undefined;
  readonly status?: number | undefined;
}

function contextFields(context: IndexingLogContext | undefined): {
  readonly capsuleIdDigest?: string;
  readonly documentIdDigest?: string;
} {
  return context === undefined
    ? {}
    : {
        capsuleIdDigest: context.capsuleIdDigest,
        ...(context.documentIdDigest === undefined
          ? {}
          : { documentIdDigest: context.documentIdDigest }),
      };
}

function failureErrorKind(kind: string): ActivityLogErrorKind {
  switch (kind) {
    case "rate-limited":
    case "timeout":
    case "cancelled":
      return kind;
    case "proxy-blocked-by-policy":
      return "authority-denied";
    case "wrong-header":
    case "unsupported-model":
    case "invalid-response":
    case "INCOMPATIBLE_EMBEDDING_IDENTITY":
      return "validation-failed";
    default:
      return "unavailable";
  }
}

function failureEnvelope(event: FailureEnvelope): ActivityLogEventEnvelope {
  return {
    level: "warn",
    errorKind: failureErrorKind(event.failureKind),
    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
    ...(event.status === undefined ? {} : { status: event.status }),
  };
}

function correlatedEnvelope(
  context: IndexingLogContext | undefined,
  envelope: ActivityLogEventEnvelope,
): ActivityLogEventEnvelope {
  return context === undefined
    ? envelope
    : { ...envelope, correlationId: knowledgeLogCorrelationId(context.jobId) };
}

function emitRetryActivity(
  sink: KnowledgeLogSink | undefined,
  context: IndexingLogContext | undefined,
  event: EmbeddingActivity,
): boolean {
  const base = contextFields(context);
  switch (event.op) {
    case "embedding.chunk.retry":
      emitKnowledgeLogEvent(
        sink,
        activityLogEvent(
          CHUNK_RETRY_OPERATION,
          correlatedEnvelope(context, failureEnvelope(event)),
          {
            ...base,
            attempt: event.attempt,
            maxRetries: event.maxRetries,
            delayMs: event.delayMs ?? 0,
            transport: "scalar",
            ...(event.endpointDigest === undefined ? {} : { endpointDigest: event.endpointDigest }),
            failureKind: event.failureKind,
          },
        ),
      );
      return true;
    case "embedding.chunk.retry-exhausted":
      emitKnowledgeLogEvent(
        sink,
        activityLogEvent(
          CHUNK_RETRY_EXHAUSTED_OPERATION,
          correlatedEnvelope(context, failureEnvelope(event)),
          {
            ...base,
            attempt: event.attempt,
            maxRetries: event.maxRetries,
            transport: "scalar",
            ...(event.endpointDigest === undefined ? {} : { endpointDigest: event.endpointDigest }),
            failureKind: event.failureKind,
          },
        ),
      );
      return true;
    case "embedding.batch.partial-progress":
    case "embedding.batch.retry": {
      const fields = {
        ...base,
        attempt: event.attempt,
        zeroProgressRetries: event.zeroProgressRetries,
        maxRetries: event.maxRetries,
        delayMs: event.delayMs,
        remainingCount: event.remainingCount,
        completedCount: event.completedCount,
        transport: "array-batch" as const,
        ...(event.endpointDigest === undefined ? {} : { endpointDigest: event.endpointDigest }),
        failureKind: event.failureKind,
      };
      if (event.op === "embedding.batch.partial-progress") {
        emitKnowledgeLogEvent(
          sink,
          activityLogEvent(
            BATCH_PARTIAL_PROGRESS_OPERATION,
            correlatedEnvelope(context, failureEnvelope(event)),
            fields,
          ),
        );
      } else {
        emitKnowledgeLogEvent(
          sink,
          activityLogEvent(
            BATCH_RETRY_OPERATION,
            correlatedEnvelope(context, failureEnvelope(event)),
            fields,
          ),
        );
      }
      return true;
    }
    default:
      return false;
  }
}

function emitBatchDecisionActivity(
  sink: KnowledgeLogSink | undefined,
  context: IndexingLogContext | undefined,
  event: EmbeddingActivity,
): boolean {
  const base = contextFields(context);
  switch (event.op) {
    case "embedding.batch.transport-unavailable":
      emitKnowledgeLogEvent(
        sink,
        activityLogEvent(
          TRANSPORT_UNAVAILABLE_OPERATION,
          correlatedEnvelope(context, { level: "debug", errorKind: "unavailable" }),
          { ...base, itemCount: event.itemCount, transport: "array-batch" },
        ),
      );
      return true;
    case "embedding.identity.rejected":
      emitKnowledgeLogEvent(
        sink,
        activityLogEvent(
          IDENTITY_REJECTED_OPERATION,
          correlatedEnvelope(context, { level: "error", errorKind: "validation-failed" }),
          {
            ...base,
            pinnedDimensions: event.pinnedDimensions,
            observedDimensions: event.observedDimensions,
            pinnedNormalization: event.pinnedNormalization,
            failureKind: event.failureKind,
          },
        ),
      );
      return true;
    case "embedding.batch.failed":
      emitKnowledgeLogEvent(
        sink,
        activityLogEvent(
          BATCH_FAILED_OPERATION,
          correlatedEnvelope(context, failureEnvelope(event)),
          {
            ...base,
            itemCount: event.itemCount,
            failureClass: event.failureClass,
            transport: "array-batch",
            ...(event.endpointDigest === undefined ? {} : { endpointDigest: event.endpointDigest }),
            failureKind: event.failureKind,
          },
        ),
      );
      return true;
    case "embedding.batch.budgeting-failed":
      emitKnowledgeLogEvent(
        sink,
        activityLogEvent(
          BUDGETING_FAILED_OPERATION,
          correlatedEnvelope(context, failureEnvelope(event)),
          { ...base, uniqueChunkCount: event.uniqueChunkCount, failureKind: event.failureKind },
        ),
      );
      return true;
    case "embedding.batch.grouped":
      emitKnowledgeLogEvent(
        sink,
        activityLogEvent(BATCH_GROUPED_OPERATION, correlatedEnvelope(context, { level: "info" }), {
          ...base,
          uniqueChunkCount: event.uniqueChunkCount,
          batchCount: event.batchCount,
          concurrency: event.concurrency,
          ...(event.endpointDigest === undefined ? {} : { endpointDigest: event.endpointDigest }),
        }),
      );
      return true;
    case "embedding.batch.transport-selected":
      emitKnowledgeLogEvent(
        sink,
        activityLogEvent(
          TRANSPORT_SELECTED_OPERATION,
          correlatedEnvelope(context, { level: "info" }),
          {
            ...base,
            transport: event.transport,
            chunkCount: event.chunkCount,
            uniqueChunkCount: event.uniqueChunkCount,
            dedupedCount: event.dedupedCount,
            concurrency: event.concurrency,
            ...(event.endpointDigest === undefined ? {} : { endpointDigest: event.endpointDigest }),
          },
        ),
      );
      return true;
    default:
      return false;
  }
}

function emitClosingActivity(
  sink: KnowledgeLogSink | undefined,
  context: IndexingLogContext | undefined,
  event: EmbeddingActivity,
): boolean {
  const base = contextFields(context);
  switch (event.op) {
    case "embedding.batch.persist-failed":
      emitKnowledgeLogEvent(
        sink,
        activityLogEvent(
          PERSIST_FAILED_OPERATION,
          correlatedEnvelope(context, { ...failureEnvelope(event), level: "error" }),
          {
            ...base,
            chunkCount: event.chunkCount,
            vectorCount: event.vectorCount,
            errorCount: event.errorCount,
            failureKind: event.failureKind,
          },
        ),
      );
      return true;
    case "embedding.batch.completed":
      emitKnowledgeLogEvent(
        sink,
        activityLogEvent(
          BATCH_COMPLETED_OPERATION,
          correlatedEnvelope(context, { level: event.level, durationMs: event.durationMs }),
          {
            ...base,
            chunkCount: event.chunkCount,
            vectorCount: event.vectorCount,
            errorCount: event.errorCount,
          },
        ),
      );
      return true;
    case "embedding.batch.rejected":
      emitKnowledgeLogEvent(
        sink,
        activityLogEvent(
          BATCH_REJECTED_OPERATION,
          correlatedEnvelope(context, { ...failureEnvelope(event), level: "error" }),
          {
            ...base,
            chunkCount: event.chunkCount,
            vectorCount: event.vectorCount,
            errorCount: event.errorCount,
            failureKind: event.failureKind,
          },
        ),
      );
      return true;
    case "embedding.batch.cancelled":
      emitKnowledgeLogEvent(
        sink,
        activityLogEvent(
          BATCH_CANCELLED_OPERATION,
          correlatedEnvelope(context, { ...failureEnvelope(event), level: "warn" }),
          {
            ...base,
            chunkCount: event.chunkCount,
            vectorCount: event.vectorCount,
            errorCount: event.errorCount,
            failureKind: event.failureKind,
          },
        ),
      );
      return true;
    default:
      return false;
  }
}

export function emitEmbeddingActivity(
  sink: KnowledgeLogSink | undefined,
  context: IndexingLogContext | undefined,
  event: EmbeddingActivity,
): void {
  if (emitRetryActivity(sink, context, event)) return;
  if (emitBatchDecisionActivity(sink, context, event)) return;
  emitClosingActivity(sink, context, event);
}
