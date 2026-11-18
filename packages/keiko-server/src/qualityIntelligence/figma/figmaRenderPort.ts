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
import { figmaGetFetch } from "./figmaGetFetch.js";
import {
  GatewayResponseBodyValidationError,
  readBytesCapped,
  type OutboundHttpEgressConfig,
} from "@oscharko-dev/keiko-model-gateway/internal/http";

/** Default request timeout in milliseconds for Figma render downloads. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Maximum amount of image data accepted per screen. */
export const MAX_FIGMA_RENDER_BYTES = 25 * 1024 * 1024;

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
  readonly correlationId?: string;
}

async function readRenderResponse(
  response: Response,
  maxBytes: number,
): Promise<FigmaRenderResponse> {
  const headers = Object.fromEntries(response.headers);
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { status: response.status, bytes: new Uint8Array(0), headers };
  }
  const bytes = await readBytesCapped(response, maxBytes);
  return { status: response.status, bytes, headers };
}

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
  const maxResponseBytes = options?.maxResponseBytes ?? MAX_FIGMA_RENDER_BYTES;

  return async (request: FigmaRenderRequest): Promise<FigmaRenderResponse> => {
    try {
      const response = await figmaGetFetch(
        request,
        { timeoutMs, maxResponseBytes, correlationId: options?.correlationId },
        egress,
        fetchImpl,
      );
      return await readRenderResponse(response, maxResponseBytes);
    } catch (err) {
      if (err instanceof FigmaConnectorError) throw err;
      if (err instanceof GatewayResponseBodyValidationError && err.validation === "size-exceeded") {
        throw new FigmaConnectorError("FIGMA_RESPONSE_TOO_LARGE");
      }
      throw new FigmaConnectorError(classifyFigmaTransportError(err));
    }
  };
};
