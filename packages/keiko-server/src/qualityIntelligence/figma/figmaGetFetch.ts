// Shared outbound GET for the Figma HTTP and render seams. The single place that builds the
// guarded `gatewayFetch` call: `redirect: "manual"` (so a caller-supplied auth header can never
// follow a cross-origin redirect), a hard byte cap, an abort timeout and the process log sink.
// It forwards the caller-built headers verbatim, never logs or inspects them, and leaves body
// reading and error classification to the calling seam.

import {
  gatewayFetch,
  type OutboundHttpEgressConfig,
} from "@oscharko-dev/keiko-model-gateway/internal/http";
import { UNKNOWN_CORRELATION_ID } from "../../correlation.js";
import { processServerLogSink } from "../../process-log-sink.js";

export interface FigmaGetFetchOptions {
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly correlationId?: string | undefined;
}

export const figmaGetFetch = (
  request: { readonly url: string; readonly headers: Readonly<Record<string, string>> },
  options: FigmaGetFetchOptions,
  egress?: OutboundHttpEgressConfig,
  fetchImpl?: typeof fetch,
): Promise<Response> =>
  gatewayFetch(request.url, {
    method: "GET",
    headers: { ...request.headers },
    redirect: "manual",
    signal: AbortSignal.timeout(options.timeoutMs),
    maxResponseBytes: options.maxResponseBytes,
    log: processServerLogSink(),
    logContext: { correlationId: options.correlationId ?? UNKNOWN_CORRELATION_ID },
    ...(egress !== undefined ? { egress } : {}),
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
