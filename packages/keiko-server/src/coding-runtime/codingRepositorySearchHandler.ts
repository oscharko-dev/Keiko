import { createHash } from "node:crypto";
import {
  captureCodingRepositoryRequest,
  type CodingRepositoryResult,
} from "@oscharko-dev/keiko-contracts/runtime/coding-repository-search";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-contracts";
import {
  CodingRepositorySearchError,
  codingRepositoryBackendReady,
  executeCodingRepositoryRequest,
  type CodingRepositorySearchOptions,
} from "@oscharko-dev/keiko-workspace/coding-repository-search";
import { isValidCorrelationId, UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { contentFreeErrorClass } from "../observability/error-classification.js";
import { causeChain, keikoStackFrames } from "../observability/stack-frames.js";
import type { ServerLogEvent, ServerLogSink } from "../observability/server-log.js";

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
  return {
    category: "search",
    op: "coding-repository-handler.settled",
    correlationId,
    durationMs,
    ...(error === undefined ? {} : { errorKind: contentFreeErrorClass(error) }),
    extra: {
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
  };
}

async function invoke(
  options: CodingRepositorySearchHandlerOptions,
  request: unknown,
  context: CodingRepositorySearchHandlerContext,
): Promise<CodingRepositoryResult> {
  const correlationId = operationCorrelation(context);
  const nowMs = options.nowMs ?? Date.now;
  const startedAtMs = nowMs();
  options.log.write({ category: "search", op: "coding-repository-handler.started", correlationId });
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
