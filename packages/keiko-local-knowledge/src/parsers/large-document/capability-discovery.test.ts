import { describe, expect, it } from "vitest";

import type { OcrAdapter, OcrPageResult } from "../ocr/types.js";
import { nullOcrAdapter } from "../ocr/null-ocr-adapter.js";
import {
  discoverExtractionCapabilities,
  nullMultimodalAdapter,
  probeMultimodalCapability,
  probeOcrCapability,
} from "./index.js";
import type { MultimodalAdapter, MultimodalResult } from "./index.js";

function ocrReturning(result: OcrPageResult): OcrAdapter {
  return { kind: "ocr", ocrPage: (): Promise<OcrPageResult> => Promise.resolve(result) };
}

function multimodalReturning(result: MultimodalResult): MultimodalAdapter {
  return {
    kind: "multimodal",
    describeImage: (): Promise<MultimodalResult> => Promise.resolve(result),
  };
}

describe("probeOcrCapability", () => {
  it("reports unavailable with no adapter or the null adapter", async () => {
    expect(await probeOcrCapability(undefined, 1_000)).toBe("unavailable");
    expect(await probeOcrCapability(nullOcrAdapter, 1_000)).toBe("unavailable");
  });

  it("reports available when the adapter returns text", async () => {
    const adapter = ocrReturning({ ok: true, text: "hello", confidence: 0.9 });
    expect(await probeOcrCapability(adapter, 1_000)).toBe("available");
  });

  it("reports available when the engine rejects the empty probe input", async () => {
    const adapter = ocrReturning({ ok: false, reason: "unsupported-input" });
    expect(await probeOcrCapability(adapter, 1_000)).toBe("available");
  });

  it("reports degraded on an engine timeout result", async () => {
    const adapter = ocrReturning({ ok: false, reason: "timeout" });
    expect(await probeOcrCapability(adapter, 1_000)).toBe("degraded");
  });

  it("reports failing when the adapter throws", async () => {
    const adapter: OcrAdapter = {
      kind: "ocr",
      ocrPage: (): Promise<OcrPageResult> => Promise.reject(new Error("boom")),
    };
    expect(await probeOcrCapability(adapter, 1_000)).toBe("failing");
  });

  it("reports degraded when the probe exceeds the timeout", async () => {
    const adapter: OcrAdapter = {
      kind: "ocr",
      ocrPage: (): Promise<OcrPageResult> =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({ ok: true, text: "late", confidence: 1 });
          }, 50);
        }),
    };
    expect(await probeOcrCapability(adapter, 5)).toBe("degraded");
  });
});

describe("probeMultimodalCapability", () => {
  it("reports unavailable with no adapter or the null adapter", async () => {
    expect(await probeMultimodalCapability(undefined, 1_000)).toBe("unavailable");
    expect(await probeMultimodalCapability(nullMultimodalAdapter, 1_000)).toBe("unavailable");
  });

  it("reports available, degraded, and failing for each outcome", async () => {
    expect(
      await probeMultimodalCapability(multimodalReturning({ ok: true, text: "x" }), 1_000),
    ).toBe("available");
    expect(
      await probeMultimodalCapability(multimodalReturning({ ok: false, reason: "timeout" }), 1_000),
    ).toBe("degraded");
    const throwing: MultimodalAdapter = {
      kind: "multimodal",
      describeImage: (): Promise<MultimodalResult> => Promise.reject(new Error("boom")),
    };
    expect(await probeMultimodalCapability(throwing, 1_000)).toBe("failing");
  });
});

describe("discoverExtractionCapabilities", () => {
  it("defaults to unavailable for both modalities when nothing is injected", async () => {
    expect(await discoverExtractionCapabilities()).toEqual({
      ocr: "unavailable",
      multimodal: "unavailable",
    });
  });

  it("reports each modality independently", async () => {
    const result = await discoverExtractionCapabilities({
      ocr: ocrReturning({ ok: true, text: "ok", confidence: 1 }),
      multimodal: nullMultimodalAdapter,
    });
    expect(result).toEqual({ ocr: "available", multimodal: "unavailable" });
  });
});
