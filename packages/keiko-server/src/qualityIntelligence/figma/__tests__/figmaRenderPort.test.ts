import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultFigmaRenderPort } from "../figmaRenderPort.js";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

afterEach(() => {
  vi.restoreAllMocks();
});

const stubFetch = (status: number, body: ArrayBuffer): void => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(body, { status }))),
  );
};

describe("createDefaultFigmaRenderPort", () => {
  it("downloads the raw bytes from an ephemeral render url", async () => {
    stubFetch(200, PNG_BYTES.buffer);
    const port = createDefaultFigmaRenderPort();

    const result = await port({ url: "https://ephemeral.figma/render.png", headers: {} });

    expect(result.status).toBe(200);
    expect(Array.from(result.bytes)).toEqual(Array.from(PNG_BYTES));
  });

  it("forwards caller headers verbatim and never names a body parser of its own", async () => {
    const fetchSpy = vi.fn(
      (_url: string, _init?: RequestInit): Promise<Response> =>
        Promise.resolve(new Response(PNG_BYTES.buffer, { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const port = createDefaultFigmaRenderPort();

    await port({ url: "https://ephemeral.figma/render.png", headers: { "X-Trace": "abc" } });

    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.method).toBe("GET");
    expect((init?.headers as Record<string, string>)["X-Trace"]).toBe("abc");
  });

  it("surfaces a non-2xx status with empty bytes rather than throwing", async () => {
    stubFetch(429, new ArrayBuffer(0));
    const port = createDefaultFigmaRenderPort();

    const result = await port({ url: "https://ephemeral.figma/render.png", headers: {} });

    expect(result.status).toBe(429);
    expect(result.bytes.length).toBe(0);
  });
});
