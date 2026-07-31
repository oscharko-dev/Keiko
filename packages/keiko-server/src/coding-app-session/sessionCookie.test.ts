import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";

import {
  APP_SESSION_EDITOR_COOKIE_PATH,
  APP_SESSION_FILES_COOKIE_PATH,
  APP_SESSION_GIT_COOKIE_PATH,
  APP_SESSION_COOKIE_NAME,
  APP_SESSION_RUNTIME_COOKIE_PATH,
  APP_SESSION_RUNS_COOKIE_PATH,
  APP_SESSION_WORKSPACES_COOKIE_PATH,
  APP_SESSION_DESKTOP_COOKIE_PATH,
  clearSessionCookie,
  clearSessionCookies,
  readSessionCookie,
  requestIsSecure,
  serializeSessionCookie,
  serializeSessionCookies,
} from "./sessionCookie.js";

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

    expect(cookies).toHaveLength(10);
    expect(cookies[0]).toContain("Path=/api/coding-workbench;");
    expect(cookies[1]).toContain(`Path=${APP_SESSION_GIT_COOKIE_PATH};`);
    expect(cookies[2]).toContain(`Path=${APP_SESSION_FILES_COOKIE_PATH};`);
    expect(cookies[3]).toContain(`Path=${APP_SESSION_EDITOR_COOKIE_PATH};`);
    expect(cookies[4]).toContain(`Path=${APP_SESSION_RUNTIME_COOKIE_PATH};`);
    expect(cookies[5]).toContain(`Path=${APP_SESSION_RUNS_COOKIE_PATH};`);
    expect(cookies[6]).toContain(`Path=${APP_SESSION_WORKSPACES_COOKIE_PATH};`);
    expect(cookies[7]).toContain(`Path=${APP_SESSION_DESKTOP_COOKIE_PATH};`);
    // The predecessor broad-path bearer is expired on issuance: a browser that paired before the
    // narrowing holds the SAME cookie name at Path=/api and would keep sending it to unrelated
    // /api routes until it lapsed on its own.
    expect(cookies[8]).toContain("Path=/api/editor/local-history;");
    expect(cookies[8]).toContain("Max-Age=0");
    expect(cookies[9]).toContain("Path=/api;");
    expect(cookies[9]).toContain("Max-Age=0");
    // Only the final expiring projection may carry the broad path; no live bearer does.
    expect(cookies.slice(0, -1).every((cookie) => !cookie.includes("Path=/api;"))).toBe(true);
  });

  // Structural pin (#2627 W2-15): the by-index assertions above catch the current narrow
  // projections, but a future edit that reorders indices — or adds another projection at
  // `Path=/api` with a live Max-Age — could re-widen the bearer scope while every index assertion
  // still passed. The Wave-2 pre-merge audit flagged a prior iteration of this very pin that had
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

    expect(cookies).toHaveLength(10);
    expect(cookies.every((cookie) => cookie.includes("Max-Age=0"))).toBe(true);
    expect(cookies[1]).toContain(`Path=${APP_SESSION_GIT_COOKIE_PATH};`);
    expect(cookies[2]).toContain(`Path=${APP_SESSION_FILES_COOKIE_PATH};`);
    expect(cookies[3]).toContain(`Path=${APP_SESSION_EDITOR_COOKIE_PATH};`);
    expect(cookies[4]).toContain(`Path=${APP_SESSION_RUNTIME_COOKIE_PATH};`);
    expect(cookies[5]).toContain(`Path=${APP_SESSION_RUNS_COOKIE_PATH};`);
    expect(cookies[6]).toContain(`Path=${APP_SESSION_WORKSPACES_COOKIE_PATH};`);
    expect(cookies[7]).toContain(`Path=${APP_SESSION_DESKTOP_COOKIE_PATH};`);
    expect(cookies[8]).toContain("Path=/api/editor/local-history;");
    // Sign-out must also remove the predecessor broad-path bearer, not just the narrow ones.
    expect(cookies[9]).toContain("Path=/api;");
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
