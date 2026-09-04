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
