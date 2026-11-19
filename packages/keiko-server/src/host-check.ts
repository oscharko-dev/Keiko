// DNS-rebinding defense (ADR-0011 D5). The BFF binds 127.0.0.1 only and rejects any request whose
// `Host` header (or `Origin`, when present) does not name the loopback interface on the bound port.
// A rebinding attacker controls the victim's DNS but cannot forge the loopback host:port the
// browser sends, so this check blocks cross-origin access to the local server. The one exception
// is a confined Windows coding runtime's own bearer-authenticated request through its pipe relay
// (isRelayedRuntimeRequest below).

import type { IncomingMessage } from "node:http";

// Hostnames that legitimately resolve to the loopback interface.
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

// Parses a `host:port` authority into its host (lowercased) and optional port. IPv6 literals are
// kept in their bracketed form so they compare against LOOPBACK_HOSTS.
function splitAuthority(authority: string): { host: string; port: string | undefined } {
  const trimmed = authority.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    const host = close === -1 ? trimmed : trimmed.slice(0, close + 1);
    const rest = close === -1 ? "" : trimmed.slice(close + 1);
    const port = rest.startsWith(":") ? rest.slice(1) : undefined;
    return { host, port };
  }
  const colon = trimmed.lastIndexOf(":");
  if (colon === -1) {
    return { host: trimmed, port: undefined };
  }
  return { host: trimmed.slice(0, colon), port: trimmed.slice(colon + 1) };
}

function isLoopbackAuthority(authority: string, expectedPort: number): boolean {
  const { host, port } = splitAuthority(authority);
  if (!LOOPBACK_HOSTS.has(host)) {
    return false;
  }
  return port === String(expectedPort);
}

function originAuthority(origin: string): string | undefined {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return parsed.host;
  } catch {
    return undefined;
  }
}

// A request is accepted only if its `Host` is a loopback authority on the bound port and, when an
// `Origin` is present, that origin is also loopback on the bound port. Opaque `Origin: null` is
// rejected because state-changing API routes are reachable from sandboxed/file origins otherwise.
// A missing `Host` is rejected.
export function isAllowedHost(req: IncomingMessage, expectedPort: number): boolean {
  const host = req.headers.host;
  if (host === undefined) return false;
  if (!isLoopbackAuthority(host, expectedPort)) return isRelayedRuntimeRequest(req, host);
  const origin = req.headers.origin;
  if (origin === undefined) {
    return true;
  }
  const authority = originAuthority(origin);
  return authority !== undefined && isLoopbackAuthority(authority, expectedPort);
}

// The routes a coding runtime calls itself; each authenticates its bearer capability before it acts.
const RUNTIME_ROUTES: ReadonlySet<string> = new Set([
  "/api/coding-sidecar/gateway/chat/completions",
  "/api/coding-sidecar/tool",
]);
const RUNTIME_MCP_ROUTE_PREFIX = "/api/coding-sidecar/mcp/";
const PORT_PATTERN = /^[1-9]\d{0,4}$/u;

function isRuntimeRoute(url: string | undefined): boolean {
  const pathname = (url ?? "").split("?", 1)[0] ?? "";
  if (RUNTIME_ROUTES.has(pathname)) return true;
  const relayId = pathname.slice(RUNTIME_MCP_ROUTE_PREFIX.length);
  return pathname.startsWith(RUNTIME_MCP_ROUTE_PREFIX) && relayId !== "" && !relayId.includes("/");
}

/**
 * #4068: a confined Windows runtime reaches this server through its run's pipe relay, whose
 * listener inside the AppContainer has its own loopback port, so the runtime's `Host` names that
 * port. Only the runtime's own routes accept it, only for a loopback host name, only without an
 * `Origin` (no browser sends such a request), and only with a bearer credential, which each of
 * those routes authenticates before it acts. A rebinding attacker controls the host name, which
 * stays limited to loopback; the port carries no authority there.
 */
function isRelayedRuntimeRequest(req: IncomingMessage, host: string): boolean {
  const { host: name, port } = splitAuthority(host);
  const authorization = req.headers.authorization;
  return (
    LOOPBACK_HOSTS.has(name) &&
    port !== undefined &&
    PORT_PATTERN.test(port) &&
    req.headers.origin === undefined &&
    typeof authorization === "string" &&
    authorization.startsWith("Bearer ") &&
    isRuntimeRoute(req.url)
  );
}
