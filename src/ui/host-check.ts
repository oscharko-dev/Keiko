// DNS-rebinding defense (ADR-0011 D5). The BFF binds 127.0.0.1 only and rejects any request whose
// `Host` header (or `Origin`, when present) does not name the loopback interface on the bound port.
// A rebinding attacker controls the victim's DNS but cannot forge the loopback host:port the
// browser sends, so this check blocks cross-origin access to the local server.

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
  return port === undefined || port === String(expectedPort);
}

// A request is accepted only if its `Host` is a loopback authority on the bound port and, when an
// `Origin` is present, that origin is also loopback. A missing `Host` is rejected.
export function isAllowedHost(req: IncomingMessage, expectedPort: number): boolean {
  const host = req.headers.host;
  if (host === undefined || !isLoopbackAuthority(host, expectedPort)) {
    return false;
  }
  const origin = req.headers.origin;
  if (origin === undefined || origin === "null") {
    return true;
  }
  const withoutScheme = origin.replace(/^https?:\/\//, "");
  return isLoopbackAuthority(withoutScheme, expectedPort);
}
