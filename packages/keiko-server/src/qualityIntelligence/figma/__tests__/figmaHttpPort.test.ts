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

  it("sends redirect: manual so the PAT header cannot follow a cross-origin redirect", async () => {
    const fetchSpy = vi.fn((..._args: Parameters<typeof fetch>): Promise<Response> => {
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    const port = createDefaultFigmaHttpPort(undefined, fetchSpy);

    await port(REQ);

    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.redirect).toBe("manual");
  });

  it("throws FIGMA_RESPONSE_TOO_LARGE when the JSON body exceeds maxResponseBytes", async () => {
    const bigJson = JSON.stringify({ data: "x".repeat(100) });
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(bigJson, { status: 200 })));
    // Set a tiny cap (10 bytes) to trigger the oversize guard.
    const port = createDefaultFigmaHttpPort(undefined, fetchImpl, { maxResponseBytes: 10 });

    await expect(port(REQ)).rejects.toMatchObject({ code: "FIGMA_RESPONSE_TOO_LARGE" });
    await expect(port(REQ)).rejects.toBeInstanceOf(FigmaConnectorError);
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

  it("classifies ECONNREFUSED (no proxy) as FIGMA_NETWORK_UNREACHABLE", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })),
    );
    const port = createDefaultFigmaHttpPort(undefined, fetchImpl);

    await expect(port(REQ)).rejects.toMatchObject({ code: "FIGMA_NETWORK_UNREACHABLE" });
  });

  it("classifies TypeError('fetch failed') as FIGMA_NETWORK_UNREACHABLE", async () => {
    // Node/undici wraps network errors as TypeError("fetch failed"); matches connectivity regex.
    const fetchImpl = vi.fn(() => Promise.reject(new TypeError("fetch failed")));
    const port = createDefaultFigmaHttpPort(undefined, fetchImpl);

    await expect(port(REQ)).rejects.toMatchObject({ code: "FIGMA_NETWORK_UNREACHABLE" });
  });

  it("classifies a truly unrecognised error as FIGMA_EGRESS_FAILED", async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error("weird egress glitch")));
    const port = createDefaultFigmaHttpPort(undefined, fetchImpl);

    await expect(port(REQ)).rejects.toMatchObject({ code: "FIGMA_EGRESS_FAILED" });
  });

  it("re-throws a FigmaConnectorError from inside the body read unchanged", async () => {
    // Simulate a FigmaConnectorError already thrown (e.g. by a future body-parsing layer).
    const inner = new FigmaConnectorError("FIGMA_RATE_LIMITED");
    const fetchImpl = vi.fn(() => Promise.reject(inner));
    const port = createDefaultFigmaHttpPort(undefined, fetchImpl);

    await expect(port(REQ)).rejects.toBe(inner);
  });
});
