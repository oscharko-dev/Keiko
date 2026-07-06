// Unit tests for navigateDocumentation in docs-browser-api.ts. Covers the same-origin path, the
// CSRF/Content-Type header injection on the state-changing POST, the request body, and body-free
// ApiError propagation — the boundary the widget and server-route tests both mock away.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  approveDocumentationIndexing,
  navigateDocumentation,
  proposeDocumentationIndexing,
} from "./docs-browser-api";
import { ApiError } from "./api";

function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const okResult = {
  schemaVersion: "1",
  targetClass: "intranet-http",
  originSummary: "https://intranet",
  pathSummary: "/…",
  reason: "rendering-deferred",
  severity: "limitation",
  capability: {
    previewAvailable: false,
    backendAvailable: false,
    indexingProposalAvailable: false,
  },
};

describe("navigateDocumentation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to the docs-browser route with CSRF headers and a target body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonOk(okResult));
    vi.stubGlobal("fetch", fetchMock);

    const result = await navigateDocumentation("https://intranet/handbook");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(path).toBe("/api/docs-browser/navigate");
    expect(init.method).toBe("POST");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Keiko-CSRF"]).toBe("1");
    expect(init.body).toBe(JSON.stringify({ target: "https://intranet/handbook" }));
    expect(result.reason).toBe("rendering-deferred");
  });

  it("propagates a governed ApiError without exposing the response body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "BAD_REQUEST", message: "bad target" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(navigateDocumentation("::::")).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "bad target",
      status: 400,
    } satisfies Partial<ApiError>);
  });
});

describe("proposeDocumentationIndexing / approveDocumentationIndexing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the target to the propose route with CSRF headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonOk({ state: "likely-manual" }));
    vi.stubGlobal("fetch", fetchMock);

    await proposeDocumentationIndexing("https://intranet/handbook/index.html");

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(path).toBe("/api/docs-browser/propose");
    expect(init.method).toBe("POST");
    expect(headers["X-Keiko-CSRF"]).toBe("1");
    expect(init.body).toBe(
      JSON.stringify({
        target: "https://intranet/handbook/index.html",
        lastNavigationReason: null,
      }),
    );
  });

  it("threads the last navigation reason through the propose request body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonOk({ state: "authentication-required" }));
    vi.stubGlobal("fetch", fetchMock);

    await proposeDocumentationIndexing(
      "https://intranet/handbook/index.html",
      "authentication-required",
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe(
      JSON.stringify({
        target: "https://intranet/handbook/index.html",
        lastNavigationReason: "authentication-required",
      }),
    );
  });

  it("POSTs the target to the approve route with CSRF headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonOk({ approved: true }));
    vi.stubGlobal("fetch", fetchMock);

    await approveDocumentationIndexing("https://intranet/handbook/index.html");

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/docs-browser/approve");
    expect(init.method).toBe("POST");
  });

  it("propagates a governed 409 without exposing the response body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: "ALREADY_INDEXED", message: "already covered" } }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(approveDocumentationIndexing("https://intranet/x")).rejects.toMatchObject({
      code: "ALREADY_INDEXED",
      status: 409,
    } satisfies Partial<ApiError>);
  });
});
