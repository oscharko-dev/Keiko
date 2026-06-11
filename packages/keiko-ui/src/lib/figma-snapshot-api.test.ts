// Unit tests for figma-snapshot-api.ts — focused on header injection at the
// fetch boundary (the integration + route tests mock fetch and cannot catch this).

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import {
  generateFigmaCode,
  loadFigmaSnapshotSummary,
  revokeFigmaToken,
  triggerFigmaSnapshot,
} from "./figma-snapshot-api";

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

  it("threads the abort signal into the fetch init", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonOk({
        runId: "fs-sig",
        adapterName: "html-css",
        fileCount: 0,
        totalBytes: 0,
        screenCount: 0,
        files: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    await generateFigmaCode("fs-sig", controller.signal);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });
});

describe("triggerFigmaSnapshot — coded BFF errors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves a proxy-egress 502 envelope as an ApiError for the widget", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonOk(
        {
          error: {
            code: "FIGMA_PROXY_EGRESS_FAILED",
            message:
              "The forward proxy rejected the Figma egress request. Check proxy configuration.",
          },
        },
        502,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const expectedError: Partial<ApiError> = {
      name: "ApiError",
      code: "FIGMA_PROXY_EGRESS_FAILED",
      message: "The forward proxy rejected the Figma egress request. Check proxy configuration.",
      status: 502,
    };

    await expect(
      triggerFigmaSnapshot("https://www.figma.com/design/AbCdEfGhIjKl/Board?node-id=1%3A2", {
        acknowledgeReadOnly: true,
      }),
    ).rejects.toMatchObject(expectedError);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/figma/snapshots");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Keiko-CSRF"]).toBe("1");
    expect(JSON.parse(init.body as string)).toEqual({
      boardLink: "https://www.figma.com/design/AbCdEfGhIjKl/Board?node-id=1%3A2",
      acknowledgeReadOnly: true,
    });
  });

  it("threads the abort signal into the fetch init", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonOk({
        runId: "r",
        fileKey: "k",
        nodeId: "1:2",
        version: undefined,
        fetchedAt: "now",
        screenCount: 0,
        skippedCount: 0,
        reductionHint: "",
        integrityHash: "",
        screens: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    await triggerFigmaSnapshot("https://www.figma.com/design/K/N?node-id=1:2", {
      signal: controller.signal,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });
});

describe("loadFigmaSnapshotSummary — abort signal", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("threads the abort signal into the fetch init", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonOk({
        runId: "r",
        fileKey: "k",
        nodeId: "1:2",
        version: undefined,
        fetchedAt: "now",
        screenCount: 0,
        skippedCount: 0,
        reductionHint: "",
        integrityHash: "",
        screens: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    await loadFigmaSnapshotSummary("fs-abc", controller.signal);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/figma/snapshots/fs-abc");
    expect(init.signal).toBe(controller.signal);
  });

  it("rejects on a 404 ApiError for unknown runId", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonOk(
            { error: { code: "FIGMA_SNAPSHOT_NOT_FOUND", message: "No snapshot found." } },
            404,
          ),
        ),
    );
    await expect(loadFigmaSnapshotSummary("dead-run-id")).rejects.toMatchObject({
      code: "FIGMA_SNAPSHOT_NOT_FOUND",
      status: 404,
    });
  });
});

describe("revokeFigmaToken — HTTP request shape (#758)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends DELETE /api/figma/token with X-Keiko-CSRF: 1", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonOk({ code: "FIGMA_TOKEN_REVOKED_OK", message: "The stored Figma PAT was removed." }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await revokeFigmaToken();

    expect(result.code).toBe("FIGMA_TOKEN_REVOKED_OK");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/figma/token");
    expect(init.method).toBe("DELETE");
    expect((init.headers as Record<string, string>)["X-Keiko-CSRF"]).toBe("1");
  });

  it("rejects with ApiError on a BFF error response", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonOk({ error: { code: "FIGMA_TOKEN_MISSING", message: "No token is stored." } }, 404),
        ),
    );
    await expect(revokeFigmaToken()).rejects.toMatchObject({
      code: "FIGMA_TOKEN_MISSING",
      status: 404,
    });
  });
});
