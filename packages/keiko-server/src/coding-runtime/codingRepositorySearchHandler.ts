import { createHash } from "node:crypto";
import {
  captureCodingRepositoryRequest,
  type CodingRepositoryResult,
} from "@oscharko-dev/keiko-contracts/runtime/coding-repository-search";
import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-contracts";
import {
  CodingRepositorySearchError,
  codingRepositoryBackendReady,
  executeCodingRepositoryRequest,
  type CodingRepositorySearchOptions,
} from "@oscharko-dev/keiko-workspace/coding-repository-search";
import { isValidCorrelationId, UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { causeChain, keikoStackFrames } from "../observability/stack-frames.js";
import type { ServerLogEvent, ServerLogSink } from "../observability/server-log.js";

const CODING_REPOSITORY_HANDLER_STARTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-repository-handler.started",
  category: "search",
  owner: "keiko-server",
  emitter: "coding-runtime.codingRepositorySearchHandler.invoke",
  fields: {},
  causal: "correlation",
  lifecycle: "start",
  analyzerProjection: "process-lifecycle",
  failureClasses: ["coding-repository-search"],
  proofIds: ["coding-repository-handler.started.emitted-line"],
  releaseImpact: "patch",
});

const CODING_REPOSITORY_HANDLER_SETTLED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-repository-handler.settled",
  category: "search",
  owner: "keiko-server",
  emitter: "coding-runtime.codingRepositorySearchHandler.terminalEvent",
  fields: {
    state: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["completed", "failed"],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "none",
        "invalid-request",
        "authority-stale",
        "backend-unavailable",
        "scope-denied",
        "file-too-large",
        "file-unreadable",
        "cancelled",
        "timeout",
        "failed",
      ],
    },
    candidatesDiscovered: { type: "integer", dataClass: "count", required: false },
    filesScanned: { type: "integer", dataClass: "count", required: false },
    skippedFiles: { type: "integer", dataClass: "count", required: false },
    durationMs: { type: "integer", dataClass: "duration", required: false },
    resultCount: { type: "integer", dataClass: "count", required: false },
    outputBytes: { type: "integer", dataClass: "count", required: false },
    truncationCount: { type: "integer", dataClass: "count", required: false },
    resultPathSha256: {
      type: "string-array",
      dataClass: "digest",
      required: false,
      maxLength: 64,
      maxItems: 50,
    },
    frames: {
      type: "string-array",
      dataClass: "opaque-id",
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
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "process-lifecycle",
  failureClasses: ["coding-repository-search"],
  proofIds: ["coding-repository-handler.settled.emitted-line"],
  releaseImpact: "patch",
});

function repositoryErrorKind(result: CodingRepositoryResult): ActivityLogErrorKind | undefined {
  if (result.ok) return undefined;
  if (result.reason === "authority-stale") return "authority-denied";
  if (result.reason === "backend-unavailable") return "unavailable";
  if (result.reason === "scope-denied") return "permission-denied";
  if (result.reason === "file-unreadable") return "read-failed";
  if (result.reason === "cancelled") return "cancelled";
  if (result.reason === "timeout") return "timeout";
  if (result.reason === "invalid-request" || result.reason === "file-too-large") {
    return "validation-failed";
  }
  return "internal";
}

export interface CodingRepositorySearchHandlerOptions extends CodingRepositorySearchOptions {
  readonly workspace: WorkspaceInfo;
  readonly isCurrent: () => boolean;
  readonly log: ServerLogSink;
}

export interface CodingRepositorySearchHandlerContext {
  readonly correlationId: string;
  readonly signal: AbortSignal;
}

export interface CodingRepositorySearchHandler {
  readonly readiness: () => "ready" | "unavailable";
  readonly invoke: (
    request: unknown,
    context: CodingRepositorySearchHandlerContext,
  ) => Promise<CodingRepositoryResult>;
}

function operationCorrelation(context: CodingRepositorySearchHandlerContext): string {
  return isValidCorrelationId(context.correlationId)
    ? context.correlationId
    : UNKNOWN_CORRELATION_ID;
}

function terminalEvent(
  result: CodingRepositoryResult,
  correlationId: string,
  durationMs: number,
  error?: unknown,
): ServerLogEvent {
  return activityLogEvent(
    CODING_REPOSITORY_HANDLER_SETTLED_OPERATION,
    {
      correlationId,
      durationMs,
      ...(result.ok ? {} : { level: "error", errorKind: repositoryErrorKind(result) }),
    },
    {
      state: result.ok ? "completed" : "failed",
      reason: result.ok ? "none" : result.reason,
      ...(result.ok
        ? {
            ...result.metrics,
            resultCount: result.kind === "search" ? result.hits.length : 1,
            outputBytes: Buffer.byteLength(JSON.stringify(result)),
            truncationCount: result.truncationReasons.length,
            ...(result.kind === "search"
              ? {
                  resultPathSha256: result.hits.map((hit) =>
                    createHash("sha256").update(hit.path, "utf8").digest("hex"),
                  ),
                }
              : {}),
          }
        : {}),
      ...(error === undefined
        ? {}
        : { frames: keikoStackFrames(error), causeChain: causeChain(error) }),
    },
  );
}

async function invoke(
  options: CodingRepositorySearchHandlerOptions,
  request: unknown,
  context: CodingRepositorySearchHandlerContext,
): Promise<CodingRepositoryResult> {
  const correlationId = operationCorrelation(context);
  const nowMs = options.nowMs ?? Date.now;
  const startedAtMs = nowMs();
  options.log.write(
    activityLogEvent(CODING_REPOSITORY_HANDLER_STARTED_OPERATION, { correlationId }, {}),
  );
  let result: CodingRepositoryResult;
  let failure: unknown;
  try {
    const captured = captureCodingRepositoryRequest(request);
    if (captured === undefined) throw new CodingRepositorySearchError("invalid-request");
    if (!options.isCurrent()) throw new CodingRepositorySearchError("authority-stale");
    result = await executeCodingRepositoryRequest(options.workspace, captured, {
      ...options,
      signal:
        options.signal === undefined
          ? context.signal
          : AbortSignal.any([options.signal, context.signal]),
    });
    if (!result.ok) throw new CodingRepositorySearchError(result.reason);
    if (!options.isCurrent()) throw new CodingRepositorySearchError("authority-stale");
  } catch (error) {
    failure = error;
    result = {
      ok: false,
      reason: error instanceof CodingRepositorySearchError ? error.reason : "failed",
    };
  }
  options.log.write(
    terminalEvent(result, correlationId, Math.max(0, nowMs() - startedAtMs), failure),
  );
  return result;
}

/** Trusted composition supplies the bound workspace and live authority guard; requests cannot. */
export function createCodingRepositorySearchHandler(
  options: CodingRepositorySearchHandlerOptions,
): CodingRepositorySearchHandler {
  return {
    readiness: (): "ready" | "unavailable" =>
      options.isCurrent() && codingRepositoryBackendReady(options) ? "ready" : "unavailable",
    invoke: (request, context): Promise<CodingRepositoryResult> =>
      invoke(options, request, context),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isCodingRepositoryHit(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    isFiniteNumber(value.startLine) &&
    isFiniteNumber(value.endLine) &&
    typeof value.snippet === "string" &&
    typeof value.redacted === "boolean" &&
    typeof value.snippetTruncated === "boolean"
  );
}

function isCodingRepositoryMetrics(value: unknown): boolean {
  return (
    isRecord(value) &&
    isFiniteNumber(value.candidatesDiscovered) &&
    isFiniteNumber(value.filesScanned) &&
    isFiniteNumber(value.skippedFiles) &&
    isFiniteNumber(value.durationMs)
  );
}

function isCodingRepositorySuccess(value: Record<string, unknown>): boolean {
  if (
    !isCodingRepositoryMetrics(value.metrics) ||
    !Array.isArray(value.truncationReasons) ||
    !value.truncationReasons.every((reason) => typeof reason === "string")
  ) {
    return false;
  }
  return value.kind === "search"
    ? Array.isArray(value.hits) && value.hits.every(isCodingRepositoryHit)
    : value.kind === "read" && isCodingRepositoryHit(value.excerpt);
}

/**
 * Re-validates a `CodingRepositoryResult` the governed delegate boundary returns as `unknown`
 * (codingToolFacade.ts's defense-in-depth boundary, same treatment as every other governed
 * result type). Checks shape only, never a limit already enforced by the producing handler.
 */
export function isCodingRepositoryResult(value: unknown): value is CodingRepositoryResult {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  return value.ok
    ? isCodingRepositorySuccess(value)
    : typeof value.reason === "string" && value.reason.length > 0;
}
