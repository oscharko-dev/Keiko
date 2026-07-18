import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  APP_SESSION_PATHS,
  createFakeSessionPairingPort,
  createStaticContentSource,
  extractSessionCookie,
  fakePairingRequestBody,
  postHeaders,
  startAppSessionTestServer,
  type AppSessionTestServer,
} from "./_support.js";

// Bearer-leak canary (ADR-0141 D4). The session bearer must appear in exactly one place — the
// HttpOnly Set-Cookie — and never reach a URL, a response body, a non-cookie header, browser storage,
// a log, evidence, an analytics event, or a crash report. Browser-side sinks (storage, analytics,
// crash reporters) run in page script; HttpOnly makes the bearer unreadable to all of them, so the
// server-boundary assertions below are the authoritative negative canaries.

interface CanaryCapture {
  readonly token: string;
  readonly secret: string;
  readonly sessionId: string;
  readonly logs: string;
  readonly bodies: string;
  readonly nonCookieHeaders: string;
  readonly setCookies: readonly string[];
}

let capture: CanaryCapture;
let server: AppSessionTestServer;

async function bodyText(response: Response): Promise<string> {
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (let i = 0; i < 4; i += 1) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.includes("\n\n")) break;
    }
  } finally {
    await reader.cancel();
  }
  return text;
}

function collectHeaders(response: Response, bag: string[], setCookies: string[]): void {
  for (const [key, value] of response.headers.entries()) {
    if (key.toLowerCase() === "set-cookie") continue;
    bag.push(`${key}: ${value}`);
  }
  setCookies.push(...response.headers.getSetCookie());
}

beforeAll(async () => {
  const logs: string[] = [];
  const record = (...args: unknown[]): void => void logs.push(args.map((a) => String(a)).join(" "));
  const spies = (["error", "warn", "log", "info", "debug"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(record),
  );
  server = await startAppSessionTestServer({
    sessionPairingPort: createFakeSessionPairingPort(),
    contentSource: createStaticContentSource({ kind: "probe", body: "canary" }),
  });
  const bodies: string[] = [];
  const nonCookieHeaders: string[] = [];
  const setCookies: string[] = [];
  const pair = await fetch(`${server.baseUrl}${APP_SESSION_PATHS.pair}`, {
    method: "POST",
    headers: postHeaders(),
    body: JSON.stringify(fakePairingRequestBody()),
  });
  const cookie = extractSessionCookie(pair) ?? "";
  const token = cookie.slice(cookie.indexOf("=") + 1);
  collectHeaders(pair, nonCookieHeaders, setCookies);
  bodies.push(await bodyText(pair));
  for (const path of [
    APP_SESSION_PATHS.channel,
    APP_SESSION_PATHS.stream,
    APP_SESSION_PATHS.rotate,
  ]) {
    const method = path === APP_SESSION_PATHS.rotate ? "POST" : "GET";
    const response = await fetch(`${server.baseUrl}${path}`, {
      method,
      headers: method === "POST" ? postHeaders(cookie) : { cookie },
    });
    collectHeaders(response, nonCookieHeaders, setCookies);
    bodies.push(await bodyText(response));
  }
  for (const spy of spies) spy.mockRestore();
  const separator = token.indexOf(".");
  capture = {
    token,
    secret: token.slice(separator + 1),
    sessionId: token.slice(0, separator),
    logs: logs.join("\n"),
    bodies: bodies.join("\n"),
    nonCookieHeaders: nonCookieHeaders.join("\n"),
    setCookies,
  };
});

afterAll(async () => {
  await server.close();
});

describe("session bearer leak canary", () => {
  it("mints a real bearer with a secret so the negatives below are meaningful", () => {
    expect(capture.token).toContain(".");
    expect(capture.secret.length).toBeGreaterThanOrEqual(16);
    expect(capture.sessionId.startsWith("sess_")).toBe(true);
  });

  it("never appears in a response body (URL, evidence, analytics, and crash sinks read bodies)", () => {
    expect(capture.bodies).not.toContain(capture.secret);
    expect(capture.bodies).not.toContain(capture.token);
  });

  it("never appears in a non-cookie response header (no URL/redirect bearer)", () => {
    expect(capture.nonCookieHeaders).not.toContain(capture.secret);
    expect(capture.nonCookieHeaders).not.toContain(capture.token);
  });

  it("never appears in operator logs or diagnostics", () => {
    expect(capture.logs).not.toContain(capture.secret);
    expect(capture.logs).not.toContain(capture.token);
  });

  it("is delivered only as an HttpOnly, SameSite=Strict cookie (not extractable browser storage)", () => {
    expect(capture.setCookies.length).toBeGreaterThan(0);
    for (const cookie of capture.setCookies) {
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
    }
  });
});
