// Unit tests for figma-snapshot-api.ts — focused on header injection at the
// fetch boundary (the integration + route tests mock fetch and cannot catch this).

import { afterEach, describe, expect, it, vi } from "vitest";
import { generateFigmaCode } from "./figma-snapshot-api";

function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("generateFigmaCode — HTTP request shape (#755)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends POST with Content-Type: application/json and X-Keiko-CSRF: 1", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonOk({
        runId: "fs-x",
        adapterName: "semantic-html",
        fileCount: 1,
        totalBytes: 42,
        screenCount: 1,
        files: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await generateFigmaCode("fs-x");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/figma/snapshots/fs-x/code");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect((init.headers as Record<string, string>)["X-Keiko-CSRF"]).toBe("1");
    expect(init.method).toBe("POST");
    // body must be present so fetchJson sets Content-Type — if removed this assertion fails
    expect(init.body).toBeDefined();
  });

  it("encodes special characters in runId", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonOk({
        runId: "fs/x y",
        adapterName: "semantic-html",
        fileCount: 0,
        totalBytes: 0,
        screenCount: 0,
        files: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await generateFigmaCode("fs/x y");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/figma/snapshots/fs%2Fx%20y/code");
  });
});
