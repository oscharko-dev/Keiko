import { describe, expect, it, vi } from "vitest";
import { FigmaConnectorError } from "../figmaConnectorErrors.js";
import { createDefaultFigmaHttpPort } from "../figmaHttpPort.js";

const REQ = { url: "https://api.figma.com/v1/files/KEY/nodes?ids=0:1", headers: {} };

describe("createDefaultFigmaHttpPort — happy path", () => {
  it("returns { status, json, headers } for a successful response", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ nodes: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const port = createDefaultFigmaHttpPort(undefined, fetchImpl);

    const result = await port(REQ);

    expect(result.status).toBe(200);
    expect(result.json).toEqual({ nodes: {} });
    expect(result.headers["content-type"]).toContain("application/json");
  });

  it("forwards caller headers verbatim", async () => {
    const fetchSpy = vi.fn((..._args: Parameters<typeof fetch>): Promise<Response> => {
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    const port = createDefaultFigmaHttpPort(undefined, fetchSpy);

    await port({ url: REQ.url, headers: { "X-Figma-Token": "figd_test" } });

    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.method).toBe("GET");
    expect((init?.headers as Record<string, string>)["X-Figma-Token"]).toBe("figd_test");
  });

  it("surfaces a non-2xx HTTP status without throwing", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("{}", { status: 403 })));
    const port = createDefaultFigmaHttpPort(undefined, fetchImpl);

    const result = await port(REQ);

    expect(result.status).toBe(403);
  });
});

describe("createDefaultFigmaHttpPort — transport error classification", () => {
  it("classifies a TLS error (UNABLE_TO_VERIFY_LEAF_SIGNATURE) as FIGMA_TLS_CA_FAILURE", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.reject(
        Object.assign(new Error("unable to verify the first certificate"), {
          code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        }),
      ),
    );
    const port = createDefaultFigmaHttpPort(undefined, fetchImpl);

    await expect(port(REQ)).rejects.toMatchObject({
      code: "FIGMA_TLS_CA_FAILURE",
    });
    await expect(port(REQ)).rejects.toBeInstanceOf(FigmaConnectorError);
  });

  it("classifies ECONNREFUSED as FIGMA_PROXY_UNREACHABLE", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })),
    );
    const port = createDefaultFigmaHttpPort(undefined, fetchImpl);

    await expect(port(REQ)).rejects.toMatchObject({ code: "FIGMA_PROXY_UNREACHABLE" });
  });

  it("classifies TypeError('fetch failed') as FIGMA_PROXY_UNREACHABLE (message matches connectivity regex)", async () => {
    // Node/undici wraps network errors as TypeError("fetch failed"); the message matches
    // the connectivity regex so it resolves to FIGMA_PROXY_UNREACHABLE, not the generic fallback.
    const fetchImpl = vi.fn(() => Promise.reject(new TypeError("fetch failed")));
    const port = createDefaultFigmaHttpPort(undefined, fetchImpl);

    await expect(port(REQ)).rejects.toMatchObject({ code: "FIGMA_PROXY_UNREACHABLE" });
  });

  it("classifies a truly unrecognised error as FIGMA_PROXY_EGRESS_FAILED", async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error("weird egress glitch")));
    const port = createDefaultFigmaHttpPort(undefined, fetchImpl);

    await expect(port(REQ)).rejects.toMatchObject({ code: "FIGMA_PROXY_EGRESS_FAILED" });
  });

  it("re-throws a FigmaConnectorError from inside the body read unchanged", async () => {
    // Simulate a FigmaConnectorError already thrown (e.g. by a future body-parsing layer).
    const inner = new FigmaConnectorError("FIGMA_RATE_LIMITED");
    const fetchImpl = vi.fn(() => Promise.reject(inner));
    const port = createDefaultFigmaHttpPort(undefined, fetchImpl);

    await expect(port(REQ)).rejects.toBe(inner);
  });
});
