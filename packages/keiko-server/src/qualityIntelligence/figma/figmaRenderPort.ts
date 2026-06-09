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

export interface FigmaRenderRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface FigmaRenderResponse {
  readonly status: number;
  readonly bytes: Uint8Array;
}

export type FigmaRenderPort = (request: FigmaRenderRequest) => Promise<FigmaRenderResponse>;

/**
 * Thin default adapter over the platform `fetch`. This is the ONLY place in the render path
 * `fetch` is named. It forwards the caller-built headers verbatim and reads the body as raw
 * bytes; it does not log, retry, or inspect any token. Resilience/backoff is out of scope here
 * (#759); the proxy/custom-CA transport is the platform prerequisite (#802) that replaces this.
 */
export const createDefaultFigmaRenderPort = (): FigmaRenderPort => {
  return async (request: FigmaRenderRequest): Promise<FigmaRenderResponse> => {
    const response = await fetch(request.url, { method: "GET", headers: { ...request.headers } });
    const buffer = await response.arrayBuffer();
    return { status: response.status, bytes: new Uint8Array(buffer) };
  };
};
