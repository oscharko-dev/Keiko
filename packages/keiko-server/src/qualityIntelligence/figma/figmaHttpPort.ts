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

// Collects the response headers into a plain lower-cased map. `Headers` already lower-cases
// names, so this is a faithful, allocation-bounded copy with no token (request-only header).
const collectHeaders = (response: Response): Readonly<Record<string, string>> => {
  const out: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    out[name] = value;
  });
  return out;
};

const parseJsonBody = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * Thin default adapter over the platform `fetch`. This is the ONLY place `fetch` is named.
 * It forwards the caller-built headers verbatim and reads the body as JSON; it does not
 * log, retry, or inspect the token. Resilience/backoff is out of scope here (#759); the
 * proxy/custom-CA transport is the platform prerequisite (#802) that replaces this adapter.
 */
export const createDefaultFigmaHttpPort = (): FigmaHttpPort => {
  return async (request: FigmaHttpRequest): Promise<FigmaHttpResponse> => {
    const response = await fetch(request.url, { method: "GET", headers: { ...request.headers } });
    const headers = collectHeaders(response);
    const json = await parseJsonBody(response);
    return { status: response.status, json, headers };
  };
};
