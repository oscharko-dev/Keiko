import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";

import {
  APP_SESSION_EDITOR_COOKIE_PATH,
  APP_SESSION_FILES_COOKIE_PATH,
  APP_SESSION_GIT_COOKIE_PATH,
  APP_SESSION_COOKIE_NAME,
  APP_SESSION_COOKIE_PATH,
  APP_SESSION_RUNTIME_COOKIE_PATH,
  APP_SESSION_RUNS_COOKIE_PATH,
  APP_SESSION_WORKSPACES_COOKIE_PATH,
  APP_SESSION_DESKTOP_COOKIE_PATH,
  APP_SESSION_TASK_WORKSPACES_COOKIE_PATH,
  APP_SESSION_SUPPORT_REPORT_COOKIE_PATH,
  APP_SESSION_CLONE_COOKIE_PATH,
  APP_SESSION_GROUNDED_SEND_COOKIE_PATH,
  clearSessionCookie,
  clearSessionCookies,
  readSessionCookie,
  requestIsSecure,
  serializeSessionCookie,
  serializeSessionCookies,
} from "./sessionCookie.js";

const activeCookiePaths = [
  APP_SESSION_COOKIE_PATH,
  APP_SESSION_GIT_COOKIE_PATH,
  APP_SESSION_FILES_COOKIE_PATH,
  APP_SESSION_EDITOR_COOKIE_PATH,
  APP_SESSION_RUNTIME_COOKIE_PATH,
  APP_SESSION_RUNS_COOKIE_PATH,
  APP_SESSION_WORKSPACES_COOKIE_PATH,
  APP_SESSION_DESKTOP_COOKIE_PATH,
  APP_SESSION_TASK_WORKSPACES_COOKIE_PATH,
  APP_SESSION_SUPPORT_REPORT_COOKIE_PATH,
  APP_SESSION_CLONE_COOKIE_PATH,
  APP_SESSION_GROUNDED_SEND_COOKIE_PATH,
];
const retiredCookiePaths = ["/api/editor/local-history", "/api"];

function cookiePaths(cookies: readonly string[]): readonly string[] {
  return cookies.map((cookie) => /(?:^|; )Path=([^;]+)/u.exec(cookie)?.[1] ?? "");
}

function requestWith(headers: Record<string, string>, encrypted = false): IncomingMessage {
  return {
    headers,
    socket: { encrypted },
  } as unknown as IncomingMessage;
}

describe("serializeSessionCookie", () => {
  it("marks the cookie HttpOnly, SameSite=Strict, and path-scoped, without Secure on plain HTTP", () => {
    const cookie = serializeSessionCookie("sess_abc.secret", {
      secure: false,
      maxAgeSeconds: 3_600,
    });
    expect(cookie).toContain(`${APP_SESSION_COOKIE_NAME}=sess_abc.secret`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/api/coding-workbench;");
    expect(cookie).toContain("Max-Age=3600");
    expect(cookie).not.toContain("Secure");
  });

  it("adds Secure over TLS", () => {
    expect(serializeSessionCookie("t", { secure: true, maxAgeSeconds: 10 })).toContain("Secure");
  });

  it("issues the bearer only on protected coding-session route families", () => {
    const cookies = serializeSessionCookies("t", { secure: false, maxAgeSeconds: 10 });
    const active = cookies.filter((cookie) => !cookie.includes("Max-Age=0"));
    const expired = cookies.filter((cookie) => cookie.includes("Max-Age=0"));
    expect(new Set(cookiePaths(active))).toEqual(new Set(activeCookiePaths));
    expect(new Set(cookiePaths(expired))).toEqual(new Set(retiredCookiePaths));
    expect(new Set(cookiePaths(cookies)).size).toBe(cookies.length);
    for (const cookie of active) expect(cookie).toContain(`${APP_SESSION_COOKIE_NAME}=t;`);
    for (const cookie of expired) expect(cookie).toContain(`${APP_SESSION_COOKIE_NAME}=;`);
  });

  // Structural pin (#2627 W2-15): independent effective-attribute assertions preserve the
  // security invariant even if a future projection adds conflicting expiry attributes. The Wave-2 pre-merge audit flagged a prior iteration of this very pin that had
  // been rewritten to accept a `Path=/api` widening under a false ADR-0147 D7 attribution; the
  // reversion landed in commit fa178cd1 before the epic merged to dev, but the class of edit
  // remains the highest-consequence artifact this file can produce. Assert the invariant
  // structurally by parsing each cookie header's attributes: any `Path=/api` projection MUST
  // be a Max-Age=0 expiration with an empty value, and every other projection MUST be scoped
  // narrower than `/api` (i.e. `/api/<something>`). Substring checks alone would accept
  // conflicting attributes (a second `Max-Age=3600` appended after `Max-Age=0` would still
  // pass `toContain("Max-Age=0")`), so the parse asserts the exact effective value set.
  it("never issues a live bearer on Path=/api; any Path=/api projection is expired on issuance", (): void => {
    const cookies = serializeSessionCookies("session_secret.value", {
      secure: false,
      maxAgeSeconds: 3_600,
    });
    for (const cookie of cookies) {
      const [nameValue = ""] = cookie.split(";", 1);
      const [name, ...valueParts] = nameValue.split("=");
      const value = valueParts.join("=");
      const pathAttribute = /(?:^|; )Path=([^;]+)/u.exec(cookie)?.[1];
      const maxAgeValues = Array.from(
        cookie.matchAll(/(?:^|; )Max-Age=(\d+)/gu),
        (match): string => match[1] ?? "",
      );
      expect(name).toBe(APP_SESSION_COOKIE_NAME);
      // Exactly one Max-Age attribute per cookie header (no shadowed/conflicting values).
      expect(maxAgeValues).toHaveLength(1);
      if (pathAttribute === "/api") {
        // Legacy broad-path projection: MUST be an expiration (Max-Age=0) with an empty
        // cookie value; never a live bearer.
        expect(maxAgeValues[0]).toBe("0");
        expect(value).toBe("");
      } else {
        // Every live/non-legacy projection MUST be scoped narrower than `/api` so a future
        // edit that widens the scope trips this pin regardless of projection order.
        expect(pathAttribute).toMatch(/^\/api\/[^/]/u);
      }
    }
  });
});

describe("clearSessionCookie", () => {
  it("expires the cookie immediately", () => {
    expect(clearSessionCookie(false)).toContain("Max-Age=0");
    expect(clearSessionCookie(false)).toContain("HttpOnly");
  });

  it("expires every route-family projection", () => {
    const cookies = clearSessionCookies(false);
    const expected = [...activeCookiePaths, ...retiredCookiePaths];
    expect(new Set(cookiePaths(cookies))).toEqual(new Set(expected));
    expect(new Set(cookiePaths(cookies)).size).toBe(cookies.length);
    expect(cookies.every((cookie) => cookie.includes("Max-Age=0"))).toBe(true);
    expect(cookies.every((cookie) => cookie.startsWith(`${APP_SESSION_COOKIE_NAME}=;`))).toBe(true);
  });
});

describe("readSessionCookie", () => {
  it("returns the app-session value among several cookies", () => {
    const req = requestWith({ cookie: `other=1; ${APP_SESSION_COOKIE_NAME}=sess_x.secret; k=v` });
    expect(readSessionCookie(req)).toBe("sess_x.secret");
  });

  it("returns undefined when the cookie header is absent or the cookie is missing", () => {
    expect(readSessionCookie(requestWith({}))).toBeUndefined();
    expect(readSessionCookie(requestWith({ cookie: "other=1" }))).toBeUndefined();
  });

  it("returns undefined for an empty app-session value", () => {
    expect(
      readSessionCookie(requestWith({ cookie: `${APP_SESSION_COOKIE_NAME}=` })),
    ).toBeUndefined();
  });
});

describe("requestIsSecure", () => {
  it("reflects the TLS state of the socket", () => {
    expect(requestIsSecure(requestWith({}, true))).toBe(true);
    expect(requestIsSecure(requestWith({}, false))).toBe(false);
  });
});

it("issues and clears the exact task-workspaces projection required by issue provisioning", () => {
  const issued = serializeSessionCookies("fixture-session", { secure: false, maxAgeSeconds: 10 });
  const cleared = clearSessionCookies(false);
  expect(issued.filter((cookie) => cookie.includes("Path=/api/task-workspaces;"))).toEqual([
    `${APP_SESSION_COOKIE_NAME}=fixture-session; Path=/api/task-workspaces; HttpOnly; SameSite=Strict; Max-Age=10`,
  ]);
  expect(cleared.filter((cookie) => cookie.includes("Path=/api/task-workspaces;"))).toEqual([
    `${APP_SESSION_COOKIE_NAME}=; Path=/api/task-workspaces; HttpOnly; SameSite=Strict; Max-Age=0`,
  ]);
});
