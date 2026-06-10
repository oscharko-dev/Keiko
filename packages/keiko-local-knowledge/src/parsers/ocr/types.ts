// OCR adapter port contract (Epic #189, Issue #202). Pure interface — no IO, no clock, no
// FS. A real OCR implementation (Tesseract, cloud API, etc.) implements `OcrAdapter` and is
// injected into `createOcrPipelineParser` without changing the parser registry.

// ─── Result union ─────────────────────────────────────────────────────────────

export type OcrPageResult =
  | {
      readonly ok: true;
      // Extracted text for this page. May be empty string for blank pages — callers must
      // tolerate that without treating it as a failure.
      readonly text: string;
      // Recognition confidence in [0, 1]. Implementations SHOULD set this to 0 when unknown
      // rather than omitting it so callers can apply consistent quality thresholds.
      readonly confidence: number;
    }
  | {
      readonly ok: false;
      // "ocr-not-configured"  — no OCR adapter has been installed (the NullOcrAdapter case).
      // "timeout"             — the OCR engine did not finish within its deadline.
      // "unsupported-input"   — the input bytes cannot be decoded by this engine (corrupt
      //                         image, unsupported codec, etc.).
      readonly reason: "ocr-not-configured" | "timeout" | "unsupported-input";
    };

// ─── Adapter port ─────────────────────────────────────────────────────────────

export interface OcrAdapter {
  // Stable kind discriminant so a registry can test `adapter.kind === "ocr"` without
  // reaching for instanceof checks.
  readonly kind: "ocr";
  // Extract text from a single page's raw bytes. MUST NOT throw — failures are surfaced via
  // `OcrPageResult { ok: false }`. Called once per detected page; the pipeline parser handles
  // multi-page splitting above this layer.
  readonly ocrPage: (input: {
    readonly bytes: Uint8Array;
    readonly pageNumber: number;
  }) => Promise<OcrPageResult>;
}
