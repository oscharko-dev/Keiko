import { describe, expect, it } from "vitest";
import { API_ROUTES } from "../routes.js";
import {
  APP_SESSION_CHAT_APPROVAL_COOKIE_PATH,
  serializeSessionCookies,
} from "../coding-app-session/sessionCookie.js";

// RFC 6265 section 5.1.4: the browser sends a cookie to every request path the cookie Path
// prefix-matches at a segment boundary. The projection is narrow only if no route other than the
// Chat review observation and decision lies under it.
function cookiePathMatches(cookiePath: string, requestPath: string): boolean {
  if (cookiePath === requestPath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath.charAt(cookiePath.length) === "/";
}
function concretePath(pattern: string): string {
  return pattern.replaceAll(/:[A-Za-z]+/gu, "x");
}
function activeProjectionPaths(): readonly string[] {
  return serializeSessionCookies("session.fixture-proof", { secure: false, maxAgeSeconds: 60 })
    .filter((cookie) => !cookie.includes("Max-Age=0"))
    .map((cookie) => /Path=([^;]+);/u.exec(cookie)?.[1] ?? "");
}
const GENERIC_APPROVAL_ROUTES = [
  ["GET", "/api/atlassian-connectors/action-approvals"],
  ["GET", "/api/atlassian-connectors/action-approvals/:approvalId"],
  ["POST", "/api/atlassian-connectors/action-approvals/:approvalId/approve"],
  ["POST", "/api/atlassian-connectors/action-approvals/:approvalId/reject"],
] as const;

describe("Chat review app-session cookie projection scope", () => {
  it("reaches exactly the Chat review observation and decision routes", () => {
    const reached = API_ROUTES.filter((route) =>
      cookiePathMatches(APP_SESSION_CHAT_APPROVAL_COOKIE_PATH, concretePath(route.pattern)),
    ).map((route) => `${route.method} ${route.pattern}`);
    expect([...reached].sort()).toEqual([
      "GET /api/atlassian-connectors/chat-write-approval/:approvalId",
      "POST /api/atlassian-connectors/chat-write-approval/:approvalId",
    ]);
  });

  it.each(GENERIC_APPROVAL_ROUTES)(
    "never sends any active projection to the generic %s %s route",
    (method, pattern) => {
      expect(API_ROUTES.some((route) => route.method === method && route.pattern === pattern)).toBe(
        true,
      );
      const reaching = activeProjectionPaths().filter((path) =>
        cookiePathMatches(path, concretePath(pattern)),
      );
      expect(reaching).toEqual([]);
    },
  );
});
