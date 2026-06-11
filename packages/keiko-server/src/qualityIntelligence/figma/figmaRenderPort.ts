// Figma render-byte seam (Epic #750, Issue #753).
//
// The `/v1/images` API returns an EPHEMERAL https url per rendered frame; a SECOND fetch
// downloads the PNG bytes from that url. The snapshot builder NEVER calls `fetch`/undici
// directly for that download — it depends only on this small injectable port so unit tests
// can mock the transport and a future proxy-aware / custom-CA client (#802) can be slotted in
// without touching builder logic.
//
// The request type carries the outbound headers. The render-url download itself needs no
// Figma auth header (the ephemeral url is pre-signed), but the seam still forwards whatever
// headers the caller supplies so the proxy adapter can add transport headers. The token is
// never materialised here and never logged.
//
// redirect: "manual" is set so any auth header supplied by the caller cannot follow a
// cross-origin redirect. A 3xx response surfaces as a non-2xx status; the connector
// layer treats non-2xx as upstream error.

import { classifyFigmaTransportError, FigmaConnectorError } from "./figmaConnectorErrors.js";
import {
  gatewayFetch,
  type OutboundHttpEgressConfig,
} from "@oscharko-dev/keiko-model-gateway/internal/http";

/** Default request timeout in milliseconds for Figma render downloads. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Default maximum render response body size (32 MiB). */
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export interface FigmaRenderRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface FigmaRenderResponse {
  readonly status: number;
  readonly bytes: Uint8Array;
  // Lower-cased response header names → values, so the resilience layer (#759) can honour a
  // `retry-after` on a 429 from the ephemeral render host. Never contains any auth token.
  readonly headers: Readonly<Record<string, string>>;
}

export type FigmaRenderPort = (request: FigmaRenderRequest) => Promise<FigmaRenderResponse>;

/** Optional creation-time overrides for the default render port. */
export interface FigmaRenderPortOptions {
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

/**
 * Read a streaming response body up to `maxBytes`, accumulating into a Uint8Array.
 * Throws a {@link FigmaConnectorError} with `FIGMA_RESPONSE_TOO_LARGE` if the cap is exceeded.
 */
const readBytesCapped = async (response: Response, maxBytes: number): Promise<Uint8Array> => {
  if (response.body === null) {
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new FigmaConnectorError("FIGMA_RESPONSE_TOO_LARGE");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

/**
 * Thin default adapter over the platform `fetch`. This is the ONLY place in the render path
 * `fetch` is named. It forwards the caller-built headers verbatim and reads the body as raw
 * bytes with an explicit byte cap; it does not log, retry, or inspect any token. Resilience/
 * backoff is out of scope here (#759); the proxy/custom-CA transport is the platform
 * prerequisite (#802) that replaces this.
 *
 * `redirect: "manual"` prevents any caller-supplied auth header from following a cross-origin
 * redirect. A 3xx response surfaces as a non-2xx port result; the connector treats it as
 * upstream error.
 */
export const createDefaultFigmaRenderPort = (
  egress?: OutboundHttpEgressConfig,
  fetchImpl?: typeof fetch,
  options?: FigmaRenderPortOptions,
): FigmaRenderPort => {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  return async (request: FigmaRenderRequest): Promise<FigmaRenderResponse> => {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await gatewayFetch(request.url, {
        method: "GET",
        headers: { ...request.headers },
        redirect: "manual",
        signal,
        ...(egress !== undefined ? { egress } : {}),
        ...(fetchImpl !== undefined ? { fetchImpl } : {}),
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        headers[name] = value;
      });
      const bytes = await readBytesCapped(response, maxResponseBytes);
      return { status: response.status, bytes, headers };
    } catch (err) {
      if (err instanceof FigmaConnectorError) throw err;
      throw new FigmaConnectorError(classifyFigmaTransportError(err));
    }
  };
};
