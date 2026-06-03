// ADR-0017 D2 — pure URL validation. NO filesystem, NO network. The localhost→127.0.0.1 rewrite
// happens here so that downstream code never hands `localhost` to the OS resolver, eliminating the
// /etc/hosts attack surface even if a downstream caller forgets the rule.

import { BrowserToolError } from "./errors.js";
import type { NormalizedNavigateUrl } from "./types.js";

const MIN_PORT = 1024;
const MAX_PORT = 65535;
const ALLOWED_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:"]);
// Strict literal-host policy: IPv4-mapped IPv6 forms like `::ffff:127.0.0.1` are
// REJECTED on purpose. ADR-0017 D2 normalises only `localhost`/`127.0.0.1`/`::1`.
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1"]);

export function normalizeCdpPort(value: unknown): number {
  if (typeof value !== "number") {
    throw new BrowserToolError("BAD_PORT", "CDP port must be a number.");
  }
  if (!Number.isInteger(value)) {
    throw new BrowserToolError("BAD_PORT", "CDP port must be an integer.");
  }
  if (value < MIN_PORT || value > MAX_PORT) {
    throw new BrowserToolError(
      "BAD_PORT",
      `CDP port must be in the range ${String(MIN_PORT)}-${String(MAX_PORT)}.`,
    );
  }
  return value;
}

// Parses the URL with the WHATWG parser, rejects non-http(s) schemes, rewrites `localhost` to its
// literal IP before any further use, then enforces literal-IP loopback + bounded-port. Returns the
// canonical {url, originOnly, host, port} struct the CDP layer consumes.
export function normalizeNavigateUrl(raw: unknown): NormalizedNavigateUrl {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new BrowserToolError("BAD_URL", "Navigate URL must be a non-empty string.");
  }
  const parsed = parseUrlOrThrow(raw);
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new BrowserToolError(
      "SCHEME_NOT_ALLOWED",
      "Navigate URL must use the http or https scheme.",
    );
  }
  const rewritten = rewriteLocalhost(parsed);
  const host = bareHost(rewritten);
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new BrowserToolError(
      "ORIGIN_NOT_ALLOWED",
      "Navigate URL host must be a loopback literal (127.0.0.1 or ::1).",
    );
  }
  if (rewritten.port === "") {
    throw new BrowserToolError("BAD_PORT", "Navigate URL must include an explicit port.");
  }
  const port = normalizeCdpPort(Number.parseInt(rewritten.port, 10));
  return {
    url: rewritten.toString(),
    host,
    originOnly: rewritten.origin,
    port,
  };
}

function parseUrlOrThrow(raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new BrowserToolError("BAD_URL", "Navigate URL is not a valid URL.");
  }
}

// `URL.hostname` returns `localhost` unchanged; we rewrite to 127.0.0.1 and rebuild the URL so the
// canonical .url field handed to CDP never contains `localhost`.
function rewriteLocalhost(parsed: URL): URL {
  if (parsed.hostname !== "localhost") return parsed;
  const clone = new URL(parsed.toString());
  clone.hostname = "127.0.0.1";
  return clone;
}

// URL.hostname returns `[::1]` for IPv6 input; strip brackets so the LOOPBACK_HOSTS set comparison
// is performed against the bare literal `::1`.
function bareHost(parsed: URL): string {
  const h = parsed.hostname;
  if (h.startsWith("[") && h.endsWith("]")) return h.slice(1, -1);
  return h;
}

// Narrow host-string check: takes a bare hostname (no scheme, no port, no brackets stripped)
// and returns true if it is a loopback literal. Used by session.ts to validate the host
// component of webSocketDebuggerUrl returned by /json/version (ADR-0017 D2 H1).
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

// Re-check after a navigation completes (ADR-0017 D2 layer 2). The CDP `frameNavigated` event
// reports the effective URL; if it drifted to a non-loopback origin (server-side redirect), the
// session manager must stop loading and refuse subsequent capture. Pure: takes the post-navigate
// URL string and returns the typed result.
export function isLoopbackUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) return false;
  const host = bareHost(parsed);
  return LOOPBACK_HOSTS.has(host);
}
