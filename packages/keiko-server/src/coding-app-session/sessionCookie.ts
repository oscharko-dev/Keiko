// Session cookie serialization and reading for the authenticated app-session channel (ADR-0141 D4).
//
// The cookie is the only bearer. It is `HttpOnly` (unreadable by page script, so not extractable
// browser storage), `SameSite=Strict` (never sent cross-site), and scoped only to API surfaces that
// consume it. It is
// marked `Secure` only when the request arrived over TLS, because loopback HTTP — a browser-designated
// secure context — cannot carry a `Secure` cookie. The value never appears in a URL or any log.

import type { IncomingMessage } from "node:http";

/** Cookie name for the app session. Kept stable so it can be cleared reliably. */
export const APP_SESSION_COOKIE_NAME = "keiko_coding_app_session";
/** Advisory browser hygiene only; server-side expiry in the registry is the authoritative bound. */
export const APP_SESSION_COOKIE_MAX_AGE_SECONDS = 12 * 60 * 60;
/**
 * Path scopes: only API families that consume protected coding-session authority. W1.9 (#2482)
 * first added Git; the managed-worktree integration adds Files, Editor (including ADR-0147 D7
 * local-history reads), runtime capabilities, and canonical workspace-manifest projections without
 * returning to their broader `/api` ancestor. `Path` is browser hygiene, not a security boundary
 * (RFC 6265 §8.6); `HttpOnly`, `SameSite=Strict`, and loopback host scope carry bearer protection.
 */
export const APP_SESSION_COOKIE_PATH = "/api/coding-workbench";
export const APP_SESSION_GIT_COOKIE_PATH = "/api/git";
export const APP_SESSION_FILES_COOKIE_PATH = "/api/files";
export const APP_SESSION_EDITOR_COOKIE_PATH = "/api/editor";
export const APP_SESSION_RUNTIME_COOKIE_PATH = "/api/runtime";
export const APP_SESSION_RUNS_COOKIE_PATH = "/api/runs";
export const APP_SESSION_WORKSPACES_COOKIE_PATH = "/api/workspaces";
export const APP_SESSION_DESKTOP_COOKIE_PATH = "/api/desktop/chat";
export const APP_SESSION_TASK_WORKSPACES_COOKIE_PATH = "/api/task-workspaces";

// Issuance and revocation use one list so a new protected family cannot retain a stale bearer.
const APP_SESSION_ACTIVE_COOKIE_PATHS = [
  APP_SESSION_COOKIE_PATH,
  APP_SESSION_GIT_COOKIE_PATH,
  APP_SESSION_FILES_COOKIE_PATH,
  APP_SESSION_EDITOR_COOKIE_PATH,
  APP_SESSION_RUNTIME_COOKIE_PATH,
  APP_SESSION_RUNS_COOKIE_PATH,
  APP_SESSION_WORKSPACES_COOKIE_PATH,
  APP_SESSION_DESKTOP_COOKIE_PATH,
  APP_SESSION_TASK_WORKSPACES_COOKIE_PATH,
] as const;

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

/**
 * The broad `Path=/api` cookie this release replaced. A browser that paired before the narrowing
 * still holds it under the SAME name, so it keeps riding along on unrelated `/api` requests until
 * it expires on its own, and a sign-out that only clears the narrow paths would not remove it.
 * Every issuance and every clear therefore also emits an expired projection for it.
 */
const APP_SESSION_LEGACY_COOKIE_PATH = "/api";
const APP_SESSION_RETIRED_LOCAL_HISTORY_COOKIE_PATH = "/api/editor/local-history";

function expiredCookie(secure: boolean, path: string): string {
  return `${APP_SESSION_COOKIE_NAME}=; ${baseAttributes(secure, path)}; Max-Age=0`;
}

/** Serialize least-privilege cookie projections consumed by authenticated Code reads. */
export function serializeSessionCookies(
  cookieToken: string,
  options: SessionCookieOptions,
): readonly string[] {
  const maxAge = Math.max(0, Math.floor(options.maxAgeSeconds));
  const projection = (path: string): string =>
    `${APP_SESSION_COOKIE_NAME}=${cookieToken}; ${baseAttributes(options.secure, path)}; Max-Age=${String(maxAge)}`;
  return [
    ...APP_SESSION_ACTIVE_COOKIE_PATHS.map(projection),
    // Retire both predecessor projections. Otherwise a browser may send the old, narrower cookie
    // alongside the new editor projection under the same name and leave ordering browser-dependent.
    expiredCookie(options.secure, APP_SESSION_RETIRED_LOCAL_HISTORY_COOKIE_PATH),
    expiredCookie(options.secure, APP_SESSION_LEGACY_COOKIE_PATH),
  ];
}

/** Serialize the `Set-Cookie` value that clears a session on sign-out. */
export function clearSessionCookie(secure: boolean): string {
  return `${APP_SESSION_COOKIE_NAME}=; ${baseAttributes(secure, APP_SESSION_COOKIE_PATH)}; Max-Age=0`;
}

/** Clear every scoped browser projection when the shared server-side session is revoked. */
export function clearSessionCookies(secure: boolean): readonly string[] {
  const expire = (path: string): string =>
    `${APP_SESSION_COOKIE_NAME}=; ${baseAttributes(secure, path)}; Max-Age=0`;
  return [
    ...APP_SESSION_ACTIVE_COOKIE_PATHS.map(expire),
    expire(APP_SESSION_RETIRED_LOCAL_HISTORY_COOKIE_PATH),
    expire(APP_SESSION_LEGACY_COOKIE_PATH),
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
