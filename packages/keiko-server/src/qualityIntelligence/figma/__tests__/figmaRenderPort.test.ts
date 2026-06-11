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

  it("forwards caller headers verbatim", async () => {
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

  it("sends redirect: manual so auth headers cannot follow a cross-origin redirect", async () => {
    const fetchSpy = vi.fn((..._args: Parameters<typeof fetch>): Promise<Response> => {
      return Promise.resolve(new Response(PNG_BYTES.buffer, { status: 200 }));
    });
    const port = createDefaultFigmaRenderPort(undefined, fetchSpy);

    await port({ url: "https://ephemeral.figma/render.png", headers: {} });

    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.redirect).toBe("manual");
  });

  it("throws FIGMA_RESPONSE_TOO_LARGE when render body exceeds maxResponseBytes", async () => {
    const bigBody = new Uint8Array(200).buffer;
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(bigBody, { status: 200 })));
    // Set a tiny cap (10 bytes) to trigger the oversize guard.
    const port = createDefaultFigmaRenderPort(undefined, fetchImpl, { maxResponseBytes: 10 });

    await expect(
      port({ url: "https://ephemeral.figma/render.png", headers: {} }),
    ).rejects.toMatchObject({ code: "FIGMA_RESPONSE_TOO_LARGE" });
    await expect(
      port({ url: "https://ephemeral.figma/render.png", headers: {} }),
    ).rejects.toBeInstanceOf(FigmaConnectorError);
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

  it("classifies ECONNREFUSED (no proxy) as FIGMA_NETWORK_UNREACHABLE", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })),
    );
    const port = createDefaultFigmaRenderPort(undefined, fetchImpl);

    await expect(port(RENDER_REQ)).rejects.toMatchObject({ code: "FIGMA_NETWORK_UNREACHABLE" });
  });

  it("classifies TypeError('fetch failed') as FIGMA_NETWORK_UNREACHABLE", async () => {
    // Node/undici wraps network errors as TypeError("fetch failed"); matches connectivity regex.
    const fetchImpl = vi.fn(() => Promise.reject(new TypeError("fetch failed")));
    const port = createDefaultFigmaRenderPort(undefined, fetchImpl);

    await expect(port(RENDER_REQ)).rejects.toMatchObject({ code: "FIGMA_NETWORK_UNREACHABLE" });
  });

  it("classifies a truly unrecognised error as FIGMA_EGRESS_FAILED", async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error("weird egress glitch")));
    const port = createDefaultFigmaRenderPort(undefined, fetchImpl);

    await expect(port(RENDER_REQ)).rejects.toMatchObject({ code: "FIGMA_EGRESS_FAILED" });
  });

  it("re-throws a FigmaConnectorError from inside the body read unchanged", async () => {
    const inner = new FigmaConnectorError("FIGMA_RENDER_FAILED");
    const fetchImpl = vi.fn(() => Promise.reject(inner));
    const port = createDefaultFigmaRenderPort(undefined, fetchImpl);

    await expect(port(RENDER_REQ)).rejects.toBe(inner);
  });
});
