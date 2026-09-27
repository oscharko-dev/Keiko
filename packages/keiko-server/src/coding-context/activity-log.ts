import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import type { CodeContextBlockReason, CodeContextReadStatus } from "./codeContextConnector.js";

const CODING_CONTEXT_PACK_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-context.pack",
  category: "security",
  owner: "keiko-server",
  emitter: "coding-context/activity-log.recordCodingContextPack",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 256 },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["sanitized"],
    },
    effectiveMode: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["governed-assist", "supervised-coding", "autonomous-delivery"],
    },
    status: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["ready", "blocked", "degraded"],
    },
    blockedCount: { type: "integer", dataClass: "count", required: false },
    blockedReasons: {
      type: "string-array",
      dataClass: "closed-enum",
      required: false,
      values: ["missing-scope", "missing-credentials", "mode-ceiling"],
      maxItems: 3,
    },
    sanitizedItemCount: { type: "integer", dataClass: "count", required: false },
    sanitizedObjectIds: {
      type: "string-array",
      dataClass: "opaque-id",
      required: false,
      maxItems: 64,
      maxLength: 256,
    },
    sanitizedTitleBytesRemoved: { type: "integer", dataClass: "count", required: false },
    sanitizedBodyBytesRemoved: { type: "integer", dataClass: "count", required: false },
    sanitizedCommentBytesRemoved: { type: "integer", dataClass: "count", required: false },
    sanitizedContentDigest: {
      type: "string",
      dataClass: "digest",
      required: false,
      maxLength: 64,
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-context-pack"],
  proofIds: ["coding-context.pack.line"],
  releaseImpact: "patch",
});

export interface SanitizedCodingContextPackEvidence {
  readonly runId: string;
  readonly outcome: "sanitized";
  readonly sanitizedItemCount: number;
  readonly sanitizedObjectIds: readonly string[];
  readonly sanitizedTitleBytesRemoved: number;
  readonly sanitizedBodyBytesRemoved: number;
  readonly sanitizedCommentBytesRemoved: number;
  readonly sanitizedContentDigest: string;
}

export interface BlockedCodingContextPackEvidence {
  readonly runId: string;
  readonly effectiveMode: CodingWorkbenchMode;
  readonly status: CodeContextReadStatus;
  readonly blockedCount: number;
  readonly blockedReasons: readonly CodeContextBlockReason[];
}

export function recordCodingContextPack(
  sink: ServerLogSink,
  correlationId: string,
  evidence: SanitizedCodingContextPackEvidence | BlockedCodingContextPackEvidence,
): void {
  if ("outcome" in evidence) {
    sink.write(
      activityLogEvent(
        CODING_CONTEXT_PACK_OPERATION,
        { level: "info", correlationId },
        {
          runId: evidence.runId,
          outcome: evidence.outcome,
          sanitizedItemCount: evidence.sanitizedItemCount,
          sanitizedObjectIds: evidence.sanitizedObjectIds,
          sanitizedTitleBytesRemoved: evidence.sanitizedTitleBytesRemoved,
          sanitizedBodyBytesRemoved: evidence.sanitizedBodyBytesRemoved,
          sanitizedCommentBytesRemoved: evidence.sanitizedCommentBytesRemoved,
          sanitizedContentDigest: evidence.sanitizedContentDigest,
        },
      ),
    );
    return;
  }
  sink.write(
    activityLogEvent(
      CODING_CONTEXT_PACK_OPERATION,
      { level: "info", correlationId },
      {
        runId: evidence.runId,
        effectiveMode: evidence.effectiveMode,
        status: evidence.status,
        blockedCount: evidence.blockedCount,
        blockedReasons: evidence.blockedReasons,
      },
    ),
  );
}
