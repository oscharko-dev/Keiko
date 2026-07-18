// Security-critical unit proof for the gateway-backed HTTP ManualCrawlFetcher (Issue #2063, trust-9).
// Hermetic: an injected fetchImpl fake replaces the platform fetch (gatewayFetch skips DNS pinning
// when a fetchImpl is supplied), so no request leaves the process. Drives the full failure matrix.

import { describe, expect, it } from "vitest";
import { createGatewayManualFetcher } from "./manual-crawl-fetcher.js";

const HTTP_TARGET = { kind: "http", url: "https://manual.example.com/guide/index.html" } as const;
const OPTIONS = { maxBytes: 1024 };

function fetchFake(
  status: number,
  init: { readonly headers?: Record<string, string>; readonly body?: Uint8Array | string } = {},
): { readonly fetchImpl: typeof fetch; readonly calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = ((input: string | URL | Request): Promise<Response> => {
    calls.push(typeof input === "string" ? input : input.toString());
    const body = init.body ?? null;
    return Promise.resolve(new Response(body, { status, headers: init.headers ?? {} }));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function throwingFetch(error: Error): typeof fetch {
  return (() => Promise.reject(error)) as typeof fetch;
}

describe("createGatewayManualFetcher — success + content classification", () => {
  it("returns the bytes, content type, and status for a 2xx html page within the cap", async () => {
    const { fetchImpl, calls } = fetchFake(200, {
      headers: { "content-type": "text/html; charset=utf-8" },
      body: "<html><body>manual</body></html>",
    });
    const fetcher = createGatewayManualFetcher({ fetchImpl });
    const result = await fetcher.fetchManualPage(HTTP_TARGET, OPTIONS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(new TextDecoder().decode(result.bytes)).toContain("manual");
      expect(result.contentType).toContain("text/html");
      expect(result.status).toBe(200);
      expect(result.truncated).toBe(false);
    }
    expect(calls).toEqual(["https://manual.example.com/guide/index.html"]);
  });

  it("marks the page truncated only when the body strictly exceeds the per-page cap", async () => {
    const body = "x".repeat(50);
    const under = await createGatewayManualFetcher({
      fetchImpl: fetchFake(200, { headers: { "content-type": "text/html" }, body }).fetchImpl,
    }).fetchManualPage(HTTP_TARGET, { maxBytes: 50 });
    expect(under.ok && under.truncated).toBe(false);

    const over = await createGatewayManualFetcher({
      fetchImpl: fetchFake(200, { headers: { "content-type": "text/html" }, body }).fetchImpl,
    }).fetchManualPage(HTTP_TARGET, { maxBytes: 49 });
    expect(over.ok && over.truncated).toBe(true);
    if (over.ok) expect(over.bytes.length).toBe(49);
  });

  it("passes the content type through unchanged (non-html classification is the runner's job)", async () => {
    const { fetchImpl } = fetchFake(200, {
      headers: { "content-type": "application/pdf" },
      body: "%PDF-1.7",
    });
    const result = await createGatewayManualFetcher({ fetchImpl }).fetchManualPage(
      HTTP_TARGET,
      OPTIONS,
    );
    expect(result.ok && result.contentType).toBe("application/pdf");
  });

  it("returns an empty body for a 2xx with no content (runner denies empty-page)", async () => {
    const { fetchImpl } = fetchFake(200, { headers: { "content-type": "text/html" } });
    const result = await createGatewayManualFetcher({ fetchImpl }).fetchManualPage(
      HTTP_TARGET,
      OPTIONS,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bytes.length).toBe(0);
  });
});

describe("createGatewayManualFetcher — fail-closed matrix", () => {
  it("refuses a local target (the WorkspaceFs fetcher owns local manuals)", async () => {
    const result = await createGatewayManualFetcher({
      fetchImpl: fetchFake(200).fetchImpl,
    }).fetchManualPage({ kind: "local", rootPath: "/root", relativePath: "a.html" }, OPTIONS);
    expect(result).toEqual({ ok: false, reason: "fetch-failed" });
  });

  it("refuses a non-http/https scheme without any fetch", async () => {
    const { fetchImpl, calls } = fetchFake(200);
    const result = await createGatewayManualFetcher({ fetchImpl }).fetchManualPage(
      { kind: "http", url: "ftp://manual.example.com/x" },
      OPTIONS,
    );
    expect(result).toEqual({ ok: false, reason: "unsupported-scheme" });
    expect(calls).toEqual([]);
  });

  it("refuses a URL that embeds credentials without any fetch", async () => {
    const { fetchImpl, calls } = fetchFake(200);
    const result = await createGatewayManualFetcher({ fetchImpl }).fetchManualPage(
      { kind: "http", url: "https://user:secret@manual.example.com/x" },
      OPTIONS,
    );
    expect(result).toEqual({ ok: false, reason: "credentialed-url" });
    expect(calls).toEqual([]);
  });

  it("surfaces a 3xx as a refused redirect (never followed), with an empty body", async () => {
    const { fetchImpl } = fetchFake(302, {
      headers: { location: "https://manual.example.com/login" },
    });
    const result = await createGatewayManualFetcher({ fetchImpl }).fetchManualPage(
      HTTP_TARGET,
      OPTIONS,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.redirected).toBe(true);
      expect(result.bytes.length).toBe(0);
    }
  });

  it("fails closed on a 4xx error page (never indexed)", async () => {
    const { fetchImpl } = fetchFake(404, {
      headers: { "content-type": "text/html" },
      body: "<h1>not found</h1>",
    });
    const result = await createGatewayManualFetcher({ fetchImpl }).fetchManualPage(
      HTTP_TARGET,
      OPTIONS,
    );
    expect(result).toEqual({ ok: false, reason: "fetch-failed" });
  });

  it("fails closed on a 5xx error page", async () => {
    const { fetchImpl } = fetchFake(503, {
      headers: { "content-type": "text/html" },
      body: "oops",
    });
    const result = await createGatewayManualFetcher({ fetchImpl }).fetchManualPage(
      HTTP_TARGET,
      OPTIONS,
    );
    expect(result).toEqual({ ok: false, reason: "fetch-failed" });
  });

  it("fails closed and drops the error text on a transport failure (SSRF/TLS/DNS/timeout)", async () => {
    const fetchImpl = throwingFetch(new Error("ECONNREFUSED 169.254.169.254:80 secret-detail"));
    const result = await createGatewayManualFetcher({ fetchImpl }).fetchManualPage(
      HTTP_TARGET,
      OPTIONS,
    );
    expect(result).toEqual({ ok: false, reason: "fetch-failed" });
    // The upstream error text can never ride into the result.
    expect(JSON.stringify(result)).not.toContain("169.254");
  });

  it("fails closed on an aborted/timed-out request", async () => {
    const fetchImpl = throwingFetch(new DOMException("The operation timed out.", "TimeoutError"));
    const result = await createGatewayManualFetcher({ fetchImpl }).fetchManualPage(
      HTTP_TARGET,
      OPTIONS,
    );
    expect(result).toEqual({ ok: false, reason: "fetch-failed" });
  });
});
