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

const CHUNKING_FAILED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "indexing.chunking.failed",
  category: "indexing",
  owner: "keiko-local-knowledge",
  emitter: "indexing/orchestrator-activity-log.emitIndexingActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    documentIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    lane: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["standard", "standard-chunker", "bounded"],
    },
    sourceTextLength: { type: "integer", dataClass: "count", required: false },
    cancelled: {
      type: "boolean",
      dataClass: "closed-enum",
      required: false,
    },
    policyRejection: {
      type: "boolean",
      dataClass: "closed-enum",
      required: false,
    },
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["document-chunking"],
  proofIds: ["indexing.chunking.failed.body-free"],
  releaseImpact: "patch",
});

const DOCUMENT_EMBEDDING_STARTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "indexing.document.embedding-started",
  category: "indexing",
  owner: "keiko-local-knowledge",
  emitter: "indexing/orchestrator-activity-log.emitIndexingActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    documentIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    chunkCount: { type: "integer", dataClass: "count", required: true },
    batchCount: { type: "integer", dataClass: "count", required: true },
    batchSize: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "start",
  analyzerProjection: "timeline",
  failureClasses: ["embedding-not-started"],
  proofIds: ["indexing.document.embedding-started.counts"],
  releaseImpact: "patch",
});

const DOCUMENT_SKIPPED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "indexing.document.skipped",
  category: "indexing",
  owner: "keiko-local-knowledge",
  emitter: "indexing/orchestrator-activity-log.emitIndexingActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    documentIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["unchanged", "transient-read-failure", "unsupported"],
    },
    preservedChunkCount: { type: "integer", dataClass: "count", required: false },
    skippedDocuments: { type: "integer", dataClass: "count", required: true },
    documentStatus: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["pending", "extracted", "extracted-image", "skipped", "failed", "unsupported"],
    },
    failureKind: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["document-not-refreshed"],
  proofIds: ["indexing.document.skipped.reason"],
  releaseImpact: "patch",
});

const DOCUMENT_EXTRACTION_FAILED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "indexing.document.extraction-failed",
  category: "indexing",
  owner: "keiko-local-knowledge",
  emitter: "indexing/orchestrator-activity-log.emitIndexingActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    documentIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    failedDocuments: { type: "integer", dataClass: "count", required: true },
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["document-extraction"],
  proofIds: ["indexing.document.extraction-failed.kind"],
  releaseImpact: "patch",
});

const DOCUMENT_EXTRACTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "indexing.document.extracted",
  category: "indexing",
  owner: "keiko-local-knowledge",
  emitter: "indexing/orchestrator-activity-log.emitIndexingActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    documentIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["document-extraction-gap"],
  proofIds: ["indexing.document.extracted.lifecycle"],
  releaseImpact: "patch",
});

const DOCUMENT_CHUNKED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "indexing.document.chunked",
  category: "indexing",
  owner: "keiko-local-knowledge",
  emitter: "indexing/orchestrator-activity-log.emitIndexingActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    documentIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    chunkCount: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["document-chunking-gap"],
  proofIds: ["indexing.document.chunked.count"],
  releaseImpact: "patch",
});

const DOCUMENT_FAILED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "indexing.document.failed",
  category: "indexing",
  owner: "keiko-local-knowledge",
  emitter: "indexing/orchestrator-activity-log.emitIndexingActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    documentIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    failureClass: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["transient", "terminal"],
    },
    consecutiveTransientEmbedFailures: { type: "integer", dataClass: "count", required: true },
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["document-indexing"],
  proofIds: ["indexing.document.failed.class"],
  releaseImpact: "patch",
});

const DOCUMENT_EMBEDDED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "indexing.document.embedded",
  category: "indexing",
  owner: "keiko-local-knowledge",
  emitter: "indexing/orchestrator-activity-log.emitIndexingActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    documentIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    vectorCount: { type: "integer", dataClass: "count", required: true },
    vectorsPersistedSoFar: { type: "integer", dataClass: "count", required: true },
    processedDocuments: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["document-embedding-gap"],
  proofIds: ["indexing.document.embedded.counts"],
  releaseImpact: "patch",
});

const DOCUMENT_EXTRACTION_STARTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "indexing.document.extraction-started",
  category: "indexing",
  owner: "keiko-local-knowledge",
  emitter: "indexing/orchestrator-activity-log.emitIndexingActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    documentIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    discoveredCount: { type: "integer", dataClass: "count", required: true },
    sizeBytes: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "start",
  analyzerProjection: "timeline",
  failureClasses: ["document-extraction-stall"],
  proofIds: ["indexing.document.extraction-started.counts"],
  releaseImpact: "patch",
});

const DISCOVERY_SCOPE_ERROR_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "indexing.discovery.scope-error",
  category: "indexing",
  owner: "keiko-local-knowledge",
  emitter: "indexing/orchestrator-activity-log.emitIndexingActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    scopedToFile: {
      type: "boolean",
      dataClass: "closed-enum",
      required: true,
    },
    discoveryFailedDocuments: { type: "integer", dataClass: "count", required: true },
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["discovery-scope"],
  proofIds: ["indexing.discovery.scope-error.kind"],
  releaseImpact: "patch",
});

const SOURCE_STARTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "indexing.source.started",
  category: "indexing",
  owner: "keiko-local-knowledge",
  emitter: "indexing/orchestrator-activity-log.emitIndexingActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    sourceIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    scopeKind: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["folder", "repository", "files"],
    },
  },
  causal: "correlation",
  lifecycle: "start",
  analyzerProjection: "timeline",
  failureClasses: ["source-discovery-stall"],
  proofIds: ["indexing.source.started.scope"],
  releaseImpact: "patch",
});

const SOURCE_COMPLETED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "indexing.source.completed",
  category: "indexing",
  owner: "keiko-local-knowledge",
  emitter: "indexing/orchestrator-activity-log.emitIndexingActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    sourceIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    discoveredCount: { type: "integer", dataClass: "count", required: true },
    failedCount: { type: "integer", dataClass: "count", required: true },
    walkCompleted: {
      type: "boolean",
      dataClass: "closed-enum",
      required: true,
    },
    cancelled: {
      type: "boolean",
      dataClass: "closed-enum",
      required: true,
    },
    sawScopeError: {
      type: "boolean",
      dataClass: "closed-enum",
      required: true,
    },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["source-discovery-incomplete"],
  proofIds: ["indexing.source.completed.counts"],
  releaseImpact: "patch",
});

const DISCOVERY_LIMIT_REACHED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "indexing.discovery.limit-reached",
  category: "indexing",
  owner: "keiko-local-knowledge",
  emitter: "indexing/orchestrator-activity-log.emitIndexingActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    discoveredCount: { type: "integer", dataClass: "count", required: true },
    maxFiles: { type: "integer", dataClass: "count", required: true },
    maxDepth: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "loss",
  analyzerProjection: "failure-cluster",
  failureClasses: ["discovery-truncated"],
  proofIds: ["indexing.discovery.limit-reached.bounds"],
  releaseImpact: "patch",
});

const JOB_STARTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "indexing.job.started",
  category: "indexing",
  owner: "keiko-local-knowledge",
  emitter: "indexing/orchestrator-activity-log.emitIndexingActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    sourceCount: { type: "integer", dataClass: "count", required: true },
    batchSize: { type: "integer", dataClass: "count", required: true },
    concurrency: { type: "integer", dataClass: "count", required: true },
    force: {
      type: "boolean",
      dataClass: "closed-enum",
      required: true,
    },
    resume: {
      type: "boolean",
      dataClass: "closed-enum",
      required: true,
    },
    contextualRetrieval: {
      type: "boolean",
      dataClass: "closed-enum",
      required: true,
    },
    minChunkTokens: { type: "integer", dataClass: "count", required: true },
    maxChunkTokens: { type: "integer", dataClass: "count", required: true },
    overlapTokens: { type: "integer", dataClass: "count", required: true },
    tokenizerKind: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["tokenizer", "estimator"],
    },
    endpointDigest: { type: "string", dataClass: "digest", required: false, maxLength: 16 },
  },
  causal: "correlation",
  lifecycle: "start",
  analyzerProjection: "timeline",
  failureClasses: ["indexing-job-stall"],
  proofIds: ["indexing.job.started.profile"],
  releaseImpact: "patch",
});

const JOB_RECEIVED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "indexing.job.received",
  category: "indexing",
  owner: "keiko-local-knowledge",
  emitter: "indexing/orchestrator-activity-log.emitIndexingActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    sourceIdFilterCount: { type: "integer", dataClass: "count", required: true },
    force: {
      type: "boolean",
      dataClass: "closed-enum",
      required: true,
    },
    resume: {
      type: "boolean",
      dataClass: "closed-enum",
      required: true,
    },
  },
  causal: "correlation",
  lifecycle: "start",
  analyzerProjection: "timeline",
  failureClasses: ["indexing-prologue"],
  proofIds: ["indexing.job.received.prologue"],
  releaseImpact: "patch",
});

const JOB_FINISHED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "indexing.job.finished",
  category: "indexing",
  owner: "keiko-local-knowledge",
  emitter: "indexing/orchestrator-activity-log.emitIndexingActivity",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    jobStatus: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["succeeded", "cancelled", "failed"],
    },
    totalDocuments: { type: "integer", dataClass: "count", required: true },
    processedDocuments: { type: "integer", dataClass: "count", required: true },
    failedDocuments: { type: "integer", dataClass: "count", required: true },
    skippedDocuments: { type: "integer", dataClass: "count", required: true },
    vectorsPersisted: { type: "integer", dataClass: "count", required: true },
    failureKind: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["indexing-job-failed", "indexing-job-cancelled"],
  proofIds: ["indexing.job.finished.counts"],
  releaseImpact: "patch",
});

interface DocumentContext extends IndexingLogContext {
  readonly documentIdDigest: string;
}

interface ClosingCounts {
  readonly totalDocuments: number;
  readonly processedDocuments: number;
  readonly failedDocuments: number;
  readonly skippedDocuments: number;
  readonly vectorsPersisted: number;
}

export type IndexingActivity =
  | {
      readonly op: "indexing.chunking.failed";
      readonly context: DocumentContext;
      readonly lane: "standard" | "standard-chunker" | "bounded";
      readonly failureKind: string;
      readonly sourceTextLength?: number;
      readonly cancelled?: boolean;
      readonly policyRejection?: boolean;
    }
  | {
      readonly op: "indexing.document.embedding-started";
      readonly context: DocumentContext;
      readonly chunkCount: number;
      readonly batchCount: number;
      readonly batchSize: number;
    }
  | {
      readonly op: "indexing.document.skipped";
      readonly context: DocumentContext;
      readonly reason: "unchanged" | "transient-read-failure" | "unsupported";
      readonly skippedDocuments: number;
      readonly preservedChunkCount?: number;
      readonly documentStatus?:
        "pending" | "extracted" | "extracted-image" | "skipped" | "failed" | "unsupported";
      readonly failureKind?: string;
    }
  | {
      readonly op: "indexing.document.extraction-failed";
      readonly context: DocumentContext;
      readonly failedDocuments: number;
      readonly failureKind: string;
    }
  | { readonly op: "indexing.document.extracted"; readonly context: DocumentContext }
  | {
      readonly op: "indexing.document.chunked";
      readonly context: DocumentContext;
      readonly chunkCount: number;
    }
  | {
      readonly op: "indexing.document.failed";
      readonly context: DocumentContext;
      readonly failureKind: string;
      readonly failureClass: "transient" | "terminal";
      readonly consecutiveTransientEmbedFailures: number;
    }
  | {
      readonly op: "indexing.document.embedded";
      readonly context: DocumentContext;
      readonly vectorCount: number;
      readonly vectorsPersistedSoFar: number;
      readonly processedDocuments: number;
    }
  | {
      readonly op: "indexing.document.extraction-started";
      readonly context: DocumentContext;
      readonly discoveredCount: number;
      readonly sizeBytes: number;
    }
  | {
      readonly op: "indexing.discovery.scope-error";
      readonly context: IndexingLogContext;
      readonly failureKind: string;
      readonly scopedToFile: boolean;
      readonly discoveryFailedDocuments: number;
    }
  | {
      readonly op: "indexing.source.started";
      readonly context: IndexingLogContext;
      readonly sourceIdDigest: string;
      readonly scopeKind: "folder" | "repository" | "files";
    }
  | {
      readonly op: "indexing.source.completed";
      readonly context: IndexingLogContext;
      readonly durationMs: number;
      readonly sourceIdDigest: string;
      readonly discoveredCount: number;
      readonly failedCount: number;
      readonly walkCompleted: boolean;
      readonly cancelled: boolean;
      readonly sawScopeError: boolean;
    }
  | {
      readonly op: "indexing.discovery.limit-reached";
      readonly context: IndexingLogContext;
      readonly discoveredCount: number;
      readonly maxFiles: number;
      readonly maxDepth: number;
    }
  | {
      readonly op: "indexing.job.started";
      readonly context: IndexingLogContext;
      readonly sourceCount: number;
      readonly batchSize: number;
      readonly concurrency: number;
      readonly force: boolean;
      readonly resume: boolean;
      readonly contextualRetrieval: boolean;
      readonly minChunkTokens: number;
      readonly maxChunkTokens: number;
      readonly overlapTokens: number;
      readonly tokenizerKind: "tokenizer" | "estimator";
      readonly endpointDigest?: string;
    }
  | {
      readonly op: "indexing.job.received";
      readonly context: IndexingLogContext;
      readonly sourceIdFilterCount: number;
      readonly force: boolean;
      readonly resume: boolean;
    }
  | ({
      readonly op: "indexing.job.finished";
      readonly context: IndexingLogContext;
      readonly durationMs: number;
      readonly jobStatus: "succeeded" | "cancelled" | "failed";
      readonly failureKind?: string;
    } & ClosingCounts);

const EXACT_FAILURE_ERROR_KINDS: Readonly<Record<string, ActivityLogErrorKind>> = {
  CANCELLED: "cancelled",
  POLICY_DENIED: "authority-denied",
  READ_FAILED: "read-failed",
  PATH_ESCAPE: "unsafe-target",
  PERMISSION_DENIED: "permission-denied",
  LIMIT_REACHED: "validation-failed",
  INVALID_SCOPE: "validation-failed",
};

function failureErrorKind(kind: string): ActivityLogErrorKind {
  const exact = EXACT_FAILURE_ERROR_KINDS[kind];
  if (exact !== undefined) return exact;
  if (kind.includes("TIMEOUT")) return "timeout";
  if (kind.includes("INVALID") || kind.includes("INCOMPATIBLE")) return "validation-failed";
  return "internal";
}

function envelope(
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

function contextFields(context: IndexingLogContext): { readonly capsuleIdDigest: string } {
  return { capsuleIdDigest: context.capsuleIdDigest };
}

function documentFields(context: DocumentContext): {
  readonly capsuleIdDigest: string;
  readonly documentIdDigest: string;
} {
  return {
    capsuleIdDigest: context.capsuleIdDigest,
    documentIdDigest: context.documentIdDigest,
  };
}

function emitDocumentStart(sink: KnowledgeLogSink | undefined, event: IndexingActivity): boolean {
  if (event.op === "indexing.document.embedding-started") {
    emitKnowledgeLogEvent(
      sink,
      activityLogEvent(DOCUMENT_EMBEDDING_STARTED_OPERATION, envelope(event.context, "info"), {
        ...documentFields(event.context),
        chunkCount: event.chunkCount,
        batchCount: event.batchCount,
        batchSize: event.batchSize,
      }),
    );
    return true;
  }
  if (event.op === "indexing.document.extraction-started") {
    emitKnowledgeLogEvent(
      sink,
      activityLogEvent(DOCUMENT_EXTRACTION_STARTED_OPERATION, envelope(event.context, "info"), {
        ...documentFields(event.context),
        discoveredCount: event.discoveredCount,
        sizeBytes: event.sizeBytes,
      }),
    );
    return true;
  }
  return false;
}

function emitDocumentState(sink: KnowledgeLogSink | undefined, event: IndexingActivity): boolean {
  if (event.op === "indexing.document.extracted") {
    emitKnowledgeLogEvent(
      sink,
      activityLogEvent(DOCUMENT_EXTRACTED_OPERATION, envelope(event.context, "info"), {
        ...documentFields(event.context),
      }),
    );
    return true;
  }
  if (event.op === "indexing.document.chunked") {
    emitKnowledgeLogEvent(
      sink,
      activityLogEvent(DOCUMENT_CHUNKED_OPERATION, envelope(event.context, "info"), {
        ...documentFields(event.context),
        chunkCount: event.chunkCount,
      }),
    );
    return true;
  }
  return false;
}

function emitDocumentFailure(sink: KnowledgeLogSink | undefined, event: IndexingActivity): boolean {
  if (event.op === "indexing.chunking.failed") {
    emitKnowledgeLogEvent(
      sink,
      activityLogEvent(
        CHUNKING_FAILED_OPERATION,
        envelope(event.context, "warn", event.failureKind),
        {
          ...documentFields(event.context),
          lane: event.lane,
          ...(event.sourceTextLength === undefined
            ? {}
            : { sourceTextLength: event.sourceTextLength }),
          ...(event.cancelled === undefined ? {} : { cancelled: event.cancelled }),
          ...(event.policyRejection === undefined
            ? {}
            : { policyRejection: event.policyRejection }),
          failureKind: event.failureKind,
        },
      ),
    );
    return true;
  }
  if (event.op === "indexing.document.extraction-failed") {
    emitKnowledgeLogEvent(
      sink,
      activityLogEvent(
        DOCUMENT_EXTRACTION_FAILED_OPERATION,
        envelope(event.context, "warn", event.failureKind),
        {
          ...documentFields(event.context),
          failedDocuments: event.failedDocuments,
          failureKind: event.failureKind,
        },
      ),
    );
    return true;
  }
  return false;
}

function emitDocumentTerminal(
  sink: KnowledgeLogSink | undefined,
  event: IndexingActivity,
): boolean {
  if (event.op === "indexing.document.failed") {
    emitKnowledgeLogEvent(
      sink,
      activityLogEvent(
        DOCUMENT_FAILED_OPERATION,
        envelope(event.context, "warn", event.failureKind),
        {
          ...documentFields(event.context),
          failureClass: event.failureClass,
          consecutiveTransientEmbedFailures: event.consecutiveTransientEmbedFailures,
          failureKind: event.failureKind,
        },
      ),
    );
    return true;
  }
  if (event.op === "indexing.document.embedded") {
    emitKnowledgeLogEvent(
      sink,
      activityLogEvent(DOCUMENT_EMBEDDED_OPERATION, envelope(event.context, "info"), {
        ...documentFields(event.context),
        vectorCount: event.vectorCount,
        vectorsPersistedSoFar: event.vectorsPersistedSoFar,
        processedDocuments: event.processedDocuments,
      }),
    );
    return true;
  }
  return false;
}

function emitDocumentSkipped(sink: KnowledgeLogSink | undefined, event: IndexingActivity): boolean {
  if (event.op !== "indexing.document.skipped") return false;
  emitKnowledgeLogEvent(
    sink,
    activityLogEvent(
      DOCUMENT_SKIPPED_OPERATION,
      envelope(event.context, event.failureKind === undefined ? "info" : "warn", event.failureKind),
      {
        ...documentFields(event.context),
        reason: event.reason,
        skippedDocuments: event.skippedDocuments,
        ...(event.preservedChunkCount === undefined
          ? {}
          : { preservedChunkCount: event.preservedChunkCount }),
        ...(event.documentStatus === undefined ? {} : { documentStatus: event.documentStatus }),
        ...(event.failureKind === undefined ? {} : { failureKind: event.failureKind }),
      },
    ),
  );
  return true;
}

function emitDiscoveryActivity(
  sink: KnowledgeLogSink | undefined,
  event: IndexingActivity,
): boolean {
  if (event.op === "indexing.discovery.scope-error") {
    emitKnowledgeLogEvent(
      sink,
      activityLogEvent(
        DISCOVERY_SCOPE_ERROR_OPERATION,
        envelope(event.context, "warn", event.failureKind),
        {
          ...contextFields(event.context),
          scopedToFile: event.scopedToFile,
          discoveryFailedDocuments: event.discoveryFailedDocuments,
          failureKind: event.failureKind,
        },
      ),
    );
    return true;
  }
  if (event.op === "indexing.discovery.limit-reached") {
    emitKnowledgeLogEvent(
      sink,
      activityLogEvent(DISCOVERY_LIMIT_REACHED_OPERATION, envelope(event.context, "warn"), {
        ...contextFields(event.context),
        discoveredCount: event.discoveredCount,
        maxFiles: event.maxFiles,
        maxDepth: event.maxDepth,
      }),
    );
    return true;
  }
  return false;
}

function emitSourceActivity(sink: KnowledgeLogSink | undefined, event: IndexingActivity): boolean {
  if (event.op === "indexing.source.started") {
    emitKnowledgeLogEvent(
      sink,
      activityLogEvent(SOURCE_STARTED_OPERATION, envelope(event.context, "info"), {
        ...contextFields(event.context),
        sourceIdDigest: event.sourceIdDigest,
        scopeKind: event.scopeKind,
      }),
    );
    return true;
  }
  if (event.op === "indexing.source.completed") {
    emitKnowledgeLogEvent(
      sink,
      activityLogEvent(
        SOURCE_COMPLETED_OPERATION,
        envelope(event.context, "info", undefined, event.durationMs),
        {
          ...contextFields(event.context),
          sourceIdDigest: event.sourceIdDigest,
          discoveredCount: event.discoveredCount,
          failedCount: event.failedCount,
          walkCompleted: event.walkCompleted,
          cancelled: event.cancelled,
          sawScopeError: event.sawScopeError,
        },
      ),
    );
    return true;
  }
  return false;
}

function emitJobActivity(sink: KnowledgeLogSink | undefined, event: IndexingActivity): boolean {
  if (event.op === "indexing.job.received") {
    emitKnowledgeLogEvent(
      sink,
      activityLogEvent(JOB_RECEIVED_OPERATION, envelope(event.context, "info"), {
        ...contextFields(event.context),
        sourceIdFilterCount: event.sourceIdFilterCount,
        force: event.force,
        resume: event.resume,
      }),
    );
    return true;
  }
  if (event.op === "indexing.job.started") {
    emitKnowledgeLogEvent(
      sink,
      activityLogEvent(JOB_STARTED_OPERATION, envelope(event.context, "info"), {
        ...contextFields(event.context),
        sourceCount: event.sourceCount,
        batchSize: event.batchSize,
        concurrency: event.concurrency,
        force: event.force,
        resume: event.resume,
        contextualRetrieval: event.contextualRetrieval,
        minChunkTokens: event.minChunkTokens,
        maxChunkTokens: event.maxChunkTokens,
        overlapTokens: event.overlapTokens,
        tokenizerKind: event.tokenizerKind,
        ...(event.endpointDigest === undefined ? {} : { endpointDigest: event.endpointDigest }),
      }),
    );
    return true;
  }
  return false;
}

function emitJobFinished(sink: KnowledgeLogSink | undefined, event: IndexingActivity): boolean {
  if (event.op !== "indexing.job.finished") return false;
  const level =
    event.jobStatus === "succeeded" ? "info" : event.jobStatus === "failed" ? "error" : "warn";
  emitKnowledgeLogEvent(
    sink,
    activityLogEvent(
      JOB_FINISHED_OPERATION,
      envelope(event.context, level, event.failureKind, event.durationMs),
      {
        ...contextFields(event.context),
        jobStatus: event.jobStatus,
        totalDocuments: event.totalDocuments,
        processedDocuments: event.processedDocuments,
        failedDocuments: event.failedDocuments,
        skippedDocuments: event.skippedDocuments,
        vectorsPersisted: event.vectorsPersisted,
        ...(event.failureKind === undefined ? {} : { failureKind: event.failureKind }),
      },
    ),
  );
  return true;
}

export function emitIndexingActivity(
  sink: KnowledgeLogSink | undefined,
  event: IndexingActivity,
): void {
  if (emitDocumentStart(sink, event)) return;
  if (emitDocumentState(sink, event)) return;
  if (emitDocumentFailure(sink, event)) return;
  if (emitDocumentTerminal(sink, event)) return;
  if (emitDocumentSkipped(sink, event)) return;
  if (emitDiscoveryActivity(sink, event)) return;
  if (emitSourceActivity(sink, event)) return;
  if (emitJobActivity(sink, event)) return;
  emitJobFinished(sink, event);
}
