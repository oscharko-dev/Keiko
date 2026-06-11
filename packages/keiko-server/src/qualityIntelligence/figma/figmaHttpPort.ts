// Figma HTTP seam (Epic #750, Issue #751).
//
// The core connector NEVER calls `fetch`/undici directly. It depends only on this small
// injectable port so unit tests can mock the transport and a future proxy-aware /
// custom-CA client (#802) can be slotted in without touching connector logic.
//
// The request type intentionally carries the outbound headers (including the
// `X-Figma-Token` auth header). The token is materialised into that header ONLY by the
// default adapter below, immediately before the platform `fetch` call — it is never
// logged here and never re-emitted by the port.
//
// redirect: "manual" is set so the PAT auth header can never silently follow a
// cross-origin redirect. A 3xx response surfaces as a non-2xx status; the connector
// layer treats any non-2xx as an upstream error.

import { classifyFigmaTransportError, FigmaConnectorError } from "./figmaConnectorErrors.js";
import {
  gatewayFetch,
  readJsonCapped,
  type OutboundHttpEgressConfig,
} from "@oscharko-dev/keiko-model-gateway/internal/http";

/** Default request timeout in milliseconds for Figma HTTP API calls. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Default maximum JSON response body size (10 MiB). */
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export interface FigmaHttpRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface FigmaHttpResponse {
  readonly status: number;
  readonly json: unknown;
  // Lower-cased response header names → values. Carried so the resilience layer (#759) can read
  // `retry-after` on a 429 without re-issuing the request. Never contains the outbound token.
  readonly headers: Readonly<Record<string, string>>;
}

export type FigmaHttpPort = (request: FigmaHttpRequest) => Promise<FigmaHttpResponse>;

/** Optional creation-time overrides for the default HTTP port. */
export interface FigmaHttpPortOptions {
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

// Collects the response headers into a plain lower-cased map. `Headers` already lower-cases
// names, so this is a faithful, allocation-bounded copy with no token (request-only header).
const collectHeaders = (response: Response): Readonly<Record<string, string>> => {
  const out: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    out[name] = value;
  });
  return out;
};

/**
 * Thin default adapter over the platform `fetch`. This is the ONLY place `fetch` is named.
 * It forwards the caller-built headers verbatim and reads the body as JSON with an explicit
 * byte cap; it does not log, retry, or inspect the token. Resilience/backoff is out of scope
 * here (#759); the proxy/custom-CA transport is the platform prerequisite (#802) that replaces
 * this adapter.
 *
 * `redirect: "manual"` prevents the PAT auth header from following a cross-origin redirect.
 * A 3xx response surfaces as a non-2xx port result; the connector treats non-2xx as upstream error.
 */
export const createDefaultFigmaHttpPort = (
  egress?: OutboundHttpEgressConfig,
  fetchImpl?: typeof fetch,
  options?: FigmaHttpPortOptions,
): FigmaHttpPort => {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  return async (request: FigmaHttpRequest): Promise<FigmaHttpResponse> => {
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
      const headers = collectHeaders(response);
      let json: unknown;
      try {
        json = await readJsonCapped(response, maxResponseBytes);
      } catch {
        throw new FigmaConnectorError("FIGMA_RESPONSE_TOO_LARGE");
      }
      return { status: response.status, json, headers };
    } catch (err) {
      if (err instanceof FigmaConnectorError) throw err;
      throw new FigmaConnectorError(classifyFigmaTransportError(err));
    }
  };
};
