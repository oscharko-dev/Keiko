// Unit tests for the browserFetch wrapper in browser-api.ts. These cover the
// header-injection logic that the integration (BrowserWidget) and server-route
// tests cannot catch because both mock the fetch boundary.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserContent,
  browserNavigate,
  browserScreenshot,
  createBrowserSession,
  deleteBrowserSession,
  fetchBrowserStatus,
} from "./browser-api";

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
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
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
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
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

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Keiko-CSRF"]).toBe("1");
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
  });
});
