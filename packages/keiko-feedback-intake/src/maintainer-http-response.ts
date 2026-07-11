import type { IncomingMessage, ServerResponse } from "node:http";
import { FEEDBACK_MAINTAINER_SESSION_COOKIE_V1 } from "@oscharko-dev/keiko-contracts/feedback-maintainer";

export type MaintainerDiagnosticCategory =
  "not-found" | "conflict" | "invalid-domain" | "dependency-unavailable";

export interface MaintainerDiagnostics {
  event(category: MaintainerDiagnosticCategory, correlationId: string): void;
}

export function securityHeaders(): Readonly<Record<string, string>> {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; font-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=31536000",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

export function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    ...securityHeaders(),
    "Content-Type": "application/json",
    "Content-Length": String(bytes.byteLength),
    ...headers,
  });
  res.end(bytes);
}

export function fail(
  res: ServerResponse,
  status: number,
  headers: Readonly<Record<string, string>> = {},
): void {
  const error =
    status === 404
      ? "not-found"
      : status === 409
        ? "conflict"
        : status === 422
          ? "invalid-domain"
          : status === 429
            ? "rate-limited"
            : status === 503
              ? "temporarily-unavailable"
              : "request-rejected";
  json(res, status, { error }, headers);
}

export function duplicateHeader(req: IncomingMessage, name: string): boolean {
  let count = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === name) count += 1;
  }
  return count > 1;
}

export function cookie(
  req: IncomingMessage,
  name = FEEDBACK_MAINTAINER_SESSION_COOKIE_V1,
): string | undefined {
  if (duplicateHeader(req, "cookie")) return undefined;
  const header = req.headers.cookie;
  if (header === undefined) return undefined;
  const prefix = `${name}=`;
  const matches = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(prefix));
  if (matches.length !== 1) return undefined;
  const value = matches[0]?.slice(prefix.length);
  return value !== undefined && /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : undefined;
}

export function setCookie(
  res: ServerResponse,
  name: string,
  capability: string,
  maxAge: number,
): void {
  const value = `${name}=${capability}; Path=/; Max-Age=${String(maxAge)}; Secure; HttpOnly; SameSite=Lax`;
  const existing = res.getHeader("Set-Cookie");
  const values = Array.isArray(existing)
    ? existing.map(String)
    : existing === undefined
      ? []
      : [String(existing)];
  res.setHeader("Set-Cookie", [...values, value]);
}

export function setSessionCookie(res: ServerResponse, capability: string, maxAge: number): void {
  setCookie(res, FEEDBACK_MAINTAINER_SESSION_COOKIE_V1, capability, maxAge);
}

export function clearSessionCookie(res: ServerResponse): void {
  setSessionCookie(res, "", 0);
}

export function boundedLimit(value: string | null): number | undefined {
  const limit = Number(value ?? "50");
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 ? limit : undefined;
}
