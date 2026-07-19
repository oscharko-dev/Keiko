// Session cookie serialization and reading for the authenticated app-session channel (ADR-0141 D4).
//
// The cookie is the only bearer. It is `HttpOnly` (unreadable by page script, so not extractable
// browser storage), `SameSite=Strict` (never sent cross-site), and scoped to the two API surfaces
// that consume it. It is
// marked `Secure` only when the request arrived over TLS, because loopback HTTP — a browser-designated
// secure context — cannot carry a `Secure` cookie. The value never appears in a URL or any log.

import type { IncomingMessage } from "node:http";

/** Cookie name for the app session. Kept stable so it can be cleared reliably. */
export const APP_SESSION_COOKIE_NAME = "keiko_coding_app_session";
/**
 * Path scopes: the coding-workbench and Git API surfaces. W1.9 (#2482) issues the same bearer on
 * the two least-privilege paths rather than their broader `/api` ancestor, so managed-worktree Git
 * reads receive it without presenting it to unrelated BFF routes. `Path` is browser hygiene, not a
 * security boundary (RFC 6265 §8.6); `HttpOnly`, `SameSite=Strict`, and loopback host scope carry
 * bearer protection.
 */
export const APP_SESSION_COOKIE_PATH = "/api/coding-workbench";
export const APP_SESSION_GIT_COOKIE_PATH = "/api/git";

export interface SessionCookieOptions {
  readonly secure: boolean;
  readonly maxAgeSeconds: number;
}

function baseAttributes(secure: boolean, path: string): string {
  const attributes = [`Path=${path}`, "HttpOnly", "SameSite=Strict"];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

/** Serialize the `Set-Cookie` value that issues a session. */
export function serializeSessionCookie(cookieToken: string, options: SessionCookieOptions): string {
  const maxAge = Math.max(0, Math.floor(options.maxAgeSeconds));
  return `${APP_SESSION_COOKIE_NAME}=${cookieToken}; ${baseAttributes(options.secure, APP_SESSION_COOKIE_PATH)}; Max-Age=${String(maxAge)}`;
}

/** Serialize both least-privilege cookie projections consumed by authenticated Code reads. */
export function serializeSessionCookies(
  cookieToken: string,
  options: SessionCookieOptions,
): readonly string[] {
  const codingCookie = serializeSessionCookie(cookieToken, options);
  const maxAge = Math.max(0, Math.floor(options.maxAgeSeconds));
  const gitCookie = `${APP_SESSION_COOKIE_NAME}=${cookieToken}; ${baseAttributes(options.secure, APP_SESSION_GIT_COOKIE_PATH)}; Max-Age=${String(maxAge)}`;
  return [codingCookie, gitCookie];
}

/** Serialize the `Set-Cookie` value that clears a session on sign-out. */
export function clearSessionCookie(secure: boolean): string {
  return `${APP_SESSION_COOKIE_NAME}=; ${baseAttributes(secure, APP_SESSION_COOKIE_PATH)}; Max-Age=0`;
}

/** Clear both scoped browser projections when the shared server-side session is revoked. */
export function clearSessionCookies(secure: boolean): readonly string[] {
  return [
    clearSessionCookie(secure),
    `${APP_SESSION_COOKIE_NAME}=; ${baseAttributes(secure, APP_SESSION_GIT_COOKIE_PATH)}; Max-Age=0`,
  ];
}

/** Read the app-session cookie value from a request, or `undefined` when it is absent. */
export function readSessionCookie(req: IncomingMessage): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== "string") return undefined;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    if (trimmed.slice(0, separator) === APP_SESSION_COOKIE_NAME) {
      const value = trimmed.slice(separator + 1);
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}

/** Whether the request arrived over TLS, gating the `Secure` cookie attribute. */
export function requestIsSecure(req: IncomingMessage): boolean {
  // A plain (non-TLS) socket has no `encrypted` field; Node types a `TLSSocket`'s as the literal
  // `true`, so read through a widened shape to keep the comparison meaningful for both.
  const socket = req.socket as { readonly encrypted?: boolean };
  return socket.encrypted === true;
}
