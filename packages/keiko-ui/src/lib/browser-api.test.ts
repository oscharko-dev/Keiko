// Unit tests for the browserFetch wrapper in browser-api.ts. These cover the
// header-injection logic that the integration (BrowserWidget) and server-route
// tests cannot catch because both mock the fetch boundary.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserApplyScreenshot,
  browserContent,
  browserEventsUrl,
  browserNavigate,
  browserScreenshot,
  createBrowserSession,
  deleteBrowserSession,
  fetchBrowserStatus,
} from "./browser-api";
import { ApiError } from "./api";

function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("browserFetch header injection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GET (fetchBrowserStatus) sends no Content-Type or CSRF headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonOk({
        reachable: true,
        userAgent: null,
        browserVersion: null,
        webSocketDebuggerUrl: null,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchBrowserStatus(9222);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBeUndefined();
    expect(headers["X-Keiko-CSRF"]).toBeUndefined();
    expect(headers["Accept"]).toBe("application/json");
  });

  it("DELETE (deleteBrowserSession) sends Content-Type: application/json and CSRF header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonOk({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await deleteBrowserSession("sess-1");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    // Both headers must be present on DELETE even though DELETE carries no body —
    // the server's rejectIfInvalidStateChange gate checks Content-Type for all
    // state-changing methods including DELETE.
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Keiko-CSRF"]).toBe("1");
  });

  it("POST (createBrowserSession) sends Content-Type and CSRF headers", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonOk({ sessionId: "s-1", cdpPort: 9222, targetId: "T-1", status: "open", createdAt: 1 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await createBrowserSession(9222);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Keiko-CSRF"]).toBe("1");
  });

  it("POST (browserNavigate) sends Content-Type and CSRF headers", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonOk({ originOnly: "http://127.0.0.1:5173", httpStatus: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await browserNavigate("s-1", "http://127.0.0.1:5173/");

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Keiko-CSRF"]).toBe("1");
    expect(path).toBe(`/api/browser/sessions/${encodeURIComponent("s-1")}/navigate`);
    expect(init.body).toBe(JSON.stringify({ url: "http://127.0.0.1:5173/" }));
  });

  it("POST (browserScreenshot) sends Content-Type and CSRF headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonOk({
        seq: 1,
        viewportPx: { width: 1280, height: 800 },
        dataBase64: "AAAA",
        persisted: false,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await browserScreenshot("s-1");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Keiko-CSRF"]).toBe("1");
  });

  it("POST (browserApplyScreenshot) sends captureSeq and URL-encodes session id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonOk({
        seq: 2,
        viewportPx: { width: 1280, height: 800 },
        dataBase64: "BBBB",
        persisted: true,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await browserApplyScreenshot("session/with slash", 7);

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(path).toBe(`/api/browser/sessions/${encodeURIComponent("session/with slash")}/apply`);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Keiko-CSRF"]).toBe("1");
    expect(init.body).toBe(JSON.stringify({ captureSeq: 7 }));
  });

  it("POST (browserContent) sends Content-Type and CSRF headers", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonOk({ seq: 1, byteLength: 9, redactedHtml: "<html/>" }));
    vi.stubGlobal("fetch", fetchMock);

    await browserContent("s-1");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Keiko-CSRF"]).toBe("1");
    expect(init.body).toBe(JSON.stringify({}));
  });

  it("returns undefined for 204 deletes while preserving the encoded route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteBrowserSession("session/with slash")).resolves.toBeUndefined();

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(`/api/browser/sessions/${encodeURIComponent("session/with slash")}`);
    expect(init.method).toBe("DELETE");
  });

  it("throws ApiError envelopes without exposing response bodies", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: "BROWSER_NOT_REACHABLE", message: "CDP unavailable" } }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(createBrowserSession(9222)).rejects.toMatchObject({
      code: "BROWSER_NOT_REACHABLE",
      message: "CDP unavailable",
      status: 503,
    } satisfies Partial<ApiError>);
  });

  it("falls back to a generic ApiError when error JSON cannot be parsed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("not-json", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchBrowserStatus(9222)).rejects.toMatchObject({
      code: "INTERNAL",
      message: "HTTP 500",
      status: 500,
    } satisfies Partial<ApiError>);
  });

  it("builds the browser SSE URL with encoded session id", () => {
    expect(browserEventsUrl("session/with slash")).toBe(
      `/api/browser/sessions/${encodeURIComponent("session/with slash")}/events`,
    );
  });
});
