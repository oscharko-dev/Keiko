import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";

import {
  APP_SESSION_COOKIE_NAME,
  clearSessionCookie,
  readSessionCookie,
  requestIsSecure,
  serializeSessionCookie,
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
    // ADR-0147 adds authenticated editor local-history beside coding-workbench, so `/api` is the
    // narrow common path on which the browser must present the HttpOnly session.
    expect(cookie).toContain("Path=/api;");
    expect(cookie).toContain("Max-Age=3600");
    expect(cookie).not.toContain("Secure");
  });

  it("adds Secure over TLS", () => {
    expect(serializeSessionCookie("t", { secure: true, maxAgeSeconds: 10 })).toContain("Secure");
  });
});

describe("clearSessionCookie", () => {
  it("expires the cookie immediately", () => {
    expect(clearSessionCookie(false)).toContain("Max-Age=0");
    expect(clearSessionCookie(false)).toContain("HttpOnly");
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
