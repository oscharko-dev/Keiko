import { describe, expect, it, vi } from "vitest";
import { FigmaConnectorError } from "../figmaConnectorErrors.js";
import { createDefaultFigmaRenderPort } from "../figmaRenderPort.js";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const stubFetch = (status: number, body: ArrayBuffer): typeof fetch => {
  return vi.fn(() => Promise.resolve(new Response(body, { status })));
};

describe("createDefaultFigmaRenderPort", () => {
  it("downloads the raw bytes from an ephemeral render url", async () => {
    const port = createDefaultFigmaRenderPort(undefined, stubFetch(200, PNG_BYTES.buffer));

    const result = await port({ url: "https://ephemeral.figma/render.png", headers: {} });

    expect(result.status).toBe(200);
    expect(Array.from(result.bytes)).toEqual(Array.from(PNG_BYTES));
  });

  it("forwards caller headers verbatim and never names a body parser of its own", async () => {
    const fetchSpy = vi.fn((..._args: Parameters<typeof fetch>): Promise<Response> => {
      return Promise.resolve(new Response(PNG_BYTES.buffer, { status: 200 }));
    });
    const port = createDefaultFigmaRenderPort(undefined, fetchSpy);

    await port({ url: "https://ephemeral.figma/render.png", headers: { "X-Trace": "abc" } });

    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.method).toBe("GET");
    expect((init?.headers as Record<string, string>)["X-Trace"]).toBe("abc");
  });

  it("surfaces a non-2xx status with empty bytes rather than throwing", async () => {
    const port = createDefaultFigmaRenderPort(undefined, stubFetch(429, new ArrayBuffer(0)));

    const result = await port({ url: "https://ephemeral.figma/render.png", headers: {} });

    expect(result.status).toBe(429);
    expect(result.bytes.length).toBe(0);
  });
});

describe("createDefaultFigmaRenderPort — transport error classification", () => {
  const RENDER_REQ = { url: "https://ephemeral.figma/render.png", headers: {} };

  it("classifies a TLS error (UNABLE_TO_VERIFY_LEAF_SIGNATURE) as FIGMA_TLS_CA_FAILURE", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.reject(
        Object.assign(new Error("unable to verify the first certificate"), {
          code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        }),
      ),
    );
    const port = createDefaultFigmaRenderPort(undefined, fetchImpl);

    await expect(port(RENDER_REQ)).rejects.toMatchObject({ code: "FIGMA_TLS_CA_FAILURE" });
    await expect(port(RENDER_REQ)).rejects.toBeInstanceOf(FigmaConnectorError);
  });

  it("classifies ECONNREFUSED as FIGMA_PROXY_UNREACHABLE", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })),
    );
    const port = createDefaultFigmaRenderPort(undefined, fetchImpl);

    await expect(port(RENDER_REQ)).rejects.toMatchObject({ code: "FIGMA_PROXY_UNREACHABLE" });
  });

  it("classifies TypeError('fetch failed') as FIGMA_PROXY_UNREACHABLE (message matches connectivity regex)", async () => {
    // Node/undici wraps network errors as TypeError("fetch failed"); the message matches
    // the connectivity regex so it resolves to FIGMA_PROXY_UNREACHABLE, not the generic fallback.
    const fetchImpl = vi.fn(() => Promise.reject(new TypeError("fetch failed")));
    const port = createDefaultFigmaRenderPort(undefined, fetchImpl);

    await expect(port(RENDER_REQ)).rejects.toMatchObject({ code: "FIGMA_PROXY_UNREACHABLE" });
  });

  it("classifies a truly unrecognised error as FIGMA_PROXY_EGRESS_FAILED", async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error("weird egress glitch")));
    const port = createDefaultFigmaRenderPort(undefined, fetchImpl);

    await expect(port(RENDER_REQ)).rejects.toMatchObject({ code: "FIGMA_PROXY_EGRESS_FAILED" });
  });

  it("re-throws a FigmaConnectorError from inside the body read unchanged", async () => {
    const inner = new FigmaConnectorError("FIGMA_RENDER_FAILED");
    const fetchImpl = vi.fn(() => Promise.reject(inner));
    const port = createDefaultFigmaRenderPort(undefined, fetchImpl);

    await expect(port(RENDER_REQ)).rejects.toBe(inner);
  });
});
