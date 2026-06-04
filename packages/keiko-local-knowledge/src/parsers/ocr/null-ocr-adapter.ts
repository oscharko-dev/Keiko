// NullOcrAdapter (Epic #189, Issue #202). The default adapter used when no real OCR engine
// has been configured. Always returns `ok: false, reason: "ocr-not-configured"` so the
// pipeline parser can fire the standard unsupported-media diagnostic rather than silently
// skipping the document.
//
// Never throws — the contract in OcrAdapter.ocrPage forbids throwing.

import type { OcrAdapter, OcrPageResult } from "./types.js";

const NOT_CONFIGURED: OcrPageResult = Object.freeze({
  ok: false as const,
  reason: "ocr-not-configured" as const,
});

export const nullOcrAdapter: OcrAdapter = Object.freeze({
  kind: "ocr" as const,
  ocrPage: (_input: { readonly bytes: Uint8Array; readonly pageNumber: number }): Promise<OcrPageResult> =>
    Promise.resolve(NOT_CONFIGURED),
});
