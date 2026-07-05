// Unit tests for navigateDocumentation in docs-browser-api.ts. Covers the same-origin path, the
// CSRF/Content-Type header injection on the state-changing POST, the request body, and body-free
// ApiError propagation — the boundary the widget and server-route tests both mock away.

import { afterEach, describe, expect, it, vi } from "vitest";
import { navigateDocumentation } from "./docs-browser-api";
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
