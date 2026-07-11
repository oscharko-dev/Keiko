const APPROVED = new Set([
  "GET /global/health",
  "GET /global/event",
  "GET /session",
  "POST /session",
  "POST /sync/history",
  "GET /permission",
  "GET /question",
]);
const MAX_BODY = 1024 * 1024;
export type OpenCodeHttpResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reason: "endpoint-invalid" | "request-denied" | "http-failed" | "response-invalid";
    };
export interface OpenCodeHttpClient {
  health(): Promise<OpenCodeHttpResult<Record<string, unknown>>>;
  request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<OpenCodeHttpResult<Record<string, unknown>>>;
}
export interface OpenCodeHttpClientOptions {
  readonly endpoint: string;
  readonly password: string;
  readonly fetch?: typeof globalThis.fetch | undefined;
}
export function parseOpenCodeChildEndpoint(
  output: string,
):
  | { readonly ok: true; readonly endpoint: string }
  | { readonly ok: false; readonly reason: "endpoint-invalid" } {
  const values = [...output.matchAll(/http:\/\/127\.0\.0\.1:[0-9]{1,5}/gu)].map(
    (match) => match[0],
  );
  if (values.length !== 1 || values[0] === undefined)
    return { ok: false, reason: "endpoint-invalid" };
  try {
    const url = new URL(values[0]);
    return url.port !== "" && url.pathname === "/" && url.username === "" && url.password === ""
      ? { ok: true, endpoint: url.origin }
      : { ok: false, reason: "endpoint-invalid" };
  } catch {
    return { ok: false, reason: "endpoint-invalid" };
  }
}
export function createOpenCodeHttpClient(options: OpenCodeHttpClientOptions): OpenCodeHttpClient {
  const parsed = parseEndpoint(options.endpoint);
  const auth = `Basic ${Buffer.from(`opencode:${options.password}`, "utf8").toString("base64")}`;
  // eslint-disable-next-line complexity -- independent network and protocol failures must not leak secrets.
  async function call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<OpenCodeHttpResult<Record<string, unknown>>> {
    if (parsed === undefined || !APPROVED.has(`${method} ${path}`))
      return { ok: false, reason: "request-denied" };
    try {
      const response = await (options.fetch ?? globalThis.fetch)(new URL(path, parsed), {
        method,
        redirect: "manual",
        headers: {
          Authorization: auth,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok || response.type === "opaqueredirect")
        return { ok: false, reason: "http-failed" };
      const type = response.headers.get("content-type") ?? "";
      if (!type.startsWith("application/json")) return { ok: false, reason: "response-invalid" };
      const text = await response.text();
      if (new TextEncoder().encode(text).length > MAX_BODY)
        return { ok: false, reason: "response-invalid" };
      const value: unknown = JSON.parse(text);
      return isRecord(value) ? { ok: true, value } : { ok: false, reason: "response-invalid" };
    } catch {
      return { ok: false, reason: "http-failed" };
    }
  }
  return { health: () => call("GET", "/global/health"), request: call };
}
function parseEndpoint(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port !== "" &&
      url.pathname === "/" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
