// Tests for createOcrPipelineParser (Epic #189, Issue #202). Covers the async `parseAsync`
// path (the real OCR path) and the sync `parse` path (unsupported-media fallback).

import { describe, expect, it } from "vitest";

import { buildParserOptions } from "../registry.js";
import {
  GZIP_MAGIC,
  PDF_MAGIC,
  PNG_MAGIC,
  ZIP_MAGIC,
  selectionFromBytes,
  selectionFromText,
} from "../parser-test-fixtures.js";
import { nullOcrAdapter } from "./null-ocr-adapter.js";
import { createOcrPipelineParser } from "./ocr-pipeline-parser.js";
import type { OcrAdapter, OcrPageResult } from "./types.js";

// Helper: creates a scripted OcrAdapter that returns the given result for every ocrPage call.
function scriptedAdapter(result: OcrPageResult): OcrAdapter {
  return {
    kind: "ocr",
    ocrPage: (_input) => Promise.resolve(result),
  };
}

function baseOptions(): ReturnType<typeof buildParserOptions> {
  return buildParserOptions({ now: () => 1_000 });
}

describe("createOcrPipelineParser — capability.matches", () => {
  const parser = createOcrPipelineParser(nullOcrAdapter);

  it("matches PDF by extension", () => {
    expect(
      parser.capability.matches(selectionFromText("x", { extension: "pdf", mediaType: "application/pdf" })),
    ).toBe(true);
  });

  it("matches common image extensions", () => {
    for (const ext of ["png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "webp"]) {
      expect(
        parser.capability.matches(selectionFromText("x", { extension: ext })),
        `expected matches for .${ext}`,
      ).toBe(true);
    }
  });

  it("matches image/* media types", () => {
    expect(
      parser.capability.matches(
        selectionFromText("x", { extension: "", mediaType: "image/png" }),
      ),
    ).toBe(true);
  });

  it("matches application/pdf media type", () => {
    expect(
      parser.capability.matches(
        selectionFromText("x", { extension: "", mediaType: "application/pdf" }),
      ),
    ).toBe(true);
  });

  it("matches PDF magic bytes even without a known extension", () => {
    expect(
      parser.capability.matches(selectionFromBytes(PDF_MAGIC, { extension: "" })),
    ).toBe(true);
  });

  it("matches PNG magic bytes", () => {
    expect(parser.capability.matches(selectionFromBytes(PNG_MAGIC, { extension: "" }))).toBe(true);
  });

  it("does NOT match plain text", () => {
    expect(parser.capability.matches(selectionFromText("hello", { extension: "txt" }))).toBe(false);
  });

  it("does NOT match zip archives", () => {
    expect(
      parser.capability.matches(selectionFromBytes(ZIP_MAGIC, { extension: "zip" })),
    ).toBe(false);
  });

  it("does NOT match gzip", () => {
    expect(
      parser.capability.matches(selectionFromBytes(GZIP_MAGIC, { extension: "gz" })),
    ).toBe(false);
  });
});

describe("createOcrPipelineParser — capability metadata", () => {
  it("reports parserId ocr-pipeline", () => {
    const parser = createOcrPipelineParser(nullOcrAdapter);
    expect(parser.capability.parserId).toBe("ocr-pipeline");
  });

  it("reports parserVersion 1", () => {
    const parser = createOcrPipelineParser(nullOcrAdapter);
    expect(parser.capability.parserVersion).toBe("1");
  });
});

describe("createOcrPipelineParser — sync parse fallback", () => {
  it("returns unsupported-media unit for PDF input (sync path)", () => {
    const parser = createOcrPipelineParser(nullOcrAdapter);
    const result = parser.parse(
      selectionFromBytes(PDF_MAGIC, { extension: "pdf", mediaType: "application/pdf" }),
      baseOptions(),
    );
    expect(result.units).toHaveLength(1);
    const unit = result.units[0];
    expect(unit?.kind).toBe("unsupported-media");
    expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_FORMAT");
    expect(result.diagnostics[0]?.severity).toBe("info");
  });

  it("returns unsupported-media unit for image input (sync path)", () => {
    const parser = createOcrPipelineParser(nullOcrAdapter);
    const result = parser.parse(
      selectionFromBytes(PNG_MAGIC, { extension: "png" }),
      baseOptions(),
    );
    expect(result.units[0]?.kind).toBe("unsupported-media");
  });

  it("respects maxBytes and returns OVERSIZED_FILE diagnostic (sync)", () => {
    const parser = createOcrPipelineParser(nullOcrAdapter);
    const bigBytes = new Uint8Array(200);
    bigBytes[0] = 0x89; bigBytes[1] = 0x50; bigBytes[2] = 0x4e; bigBytes[3] = 0x47; // PNG magic
    const result = parser.parse(
      selectionFromBytes(bigBytes, { extension: "png" }),
      buildParserOptions({ now: () => 0, maxBytes: 10 }),
    );
    expect(result.units).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe("OVERSIZED_FILE");
  });

  it("respects a pre-aborted signal (sync)", () => {
    const parser = createOcrPipelineParser(nullOcrAdapter);
    const ac = new AbortController();
    ac.abort();
    const result = parser.parse(
      selectionFromBytes(PDF_MAGIC, { extension: "pdf" }),
      buildParserOptions({ now: () => 0, signal: ac.signal }),
    );
    expect(result.diagnostics[0]?.code).toBe("PARSER_CANCELLED");
  });
});

describe("createOcrPipelineParser — parseAsync (NullOcrAdapter)", () => {
  it("returns unsupported-media unit when OCR is not configured", async () => {
    const parser = createOcrPipelineParser(nullOcrAdapter);
    const result = await parser.parseAsync(
      selectionFromBytes(PDF_MAGIC, { extension: "pdf", mediaType: "application/pdf" }),
      baseOptions(),
    );
    expect(result.units).toHaveLength(1);
    const unit = result.units[0];
    expect(unit?.kind).toBe("unsupported-media");
    expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_FORMAT");
    expect(result.diagnostics[0]?.severity).toBe("info");
  });

  it("uses pdf-not-implemented reason for PDF input", async () => {
    const parser = createOcrPipelineParser(nullOcrAdapter);
    const result = await parser.parseAsync(
      selectionFromBytes(PDF_MAGIC, { extension: "pdf" }),
      baseOptions(),
    );
    const unit = result.units[0];
    if (unit?.kind !== "unsupported-media") throw new Error("expected unsupported-media");
    expect(unit.reason).toBe("pdf-not-implemented");
  });

  it("uses image-not-supported reason for image input", async () => {
    const parser = createOcrPipelineParser(nullOcrAdapter);
    const result = await parser.parseAsync(
      selectionFromBytes(PNG_MAGIC, { extension: "png" }),
      baseOptions(),
    );
    const unit = result.units[0];
    if (unit?.kind !== "unsupported-media") throw new Error("expected unsupported-media");
    expect(unit.reason).toBe("image-not-supported");
  });

  it("returns OVERSIZED_FILE diagnostic when input exceeds maxBytes (async)", async () => {
    const parser = createOcrPipelineParser(nullOcrAdapter);
    const bigBytes = new Uint8Array(200);
    bigBytes[0] = 0x89; bigBytes[1] = 0x50; bigBytes[2] = 0x4e; bigBytes[3] = 0x47;
    const result = await parser.parseAsync(
      selectionFromBytes(bigBytes, { extension: "png" }),
      buildParserOptions({ now: () => 0, maxBytes: 10 }),
    );
    expect(result.units).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe("OVERSIZED_FILE");
  });

  it("respects a pre-aborted signal (async)", async () => {
    const parser = createOcrPipelineParser(nullOcrAdapter);
    const ac = new AbortController();
    ac.abort();
    const result = await parser.parseAsync(
      selectionFromBytes(PDF_MAGIC, { extension: "pdf" }),
      buildParserOptions({ now: () => 0, signal: ac.signal }),
    );
    expect(result.diagnostics[0]?.code).toBe("PARSER_CANCELLED");
  });

  it("respects a deadline exceeded before the OCR call (async)", async () => {
    const parser = createOcrPipelineParser(nullOcrAdapter);
    // Simulate a deadline already blown: startedAt=0, now() returns 1_000, timeoutMs=1.
    // shouldStop computes 1_000 - 0 = 1_000 > 1 => true.
    let tick = 0;
    const result = await parser.parseAsync(
      selectionFromBytes(PDF_MAGIC, { extension: "pdf" }),
      buildParserOptions({
        now: () => {
          tick += 1_000;
          return tick;
        },
        timeoutMs: 1,
      }),
    );
    expect(result.diagnostics[0]?.code).toBe("PARSER_TIMEOUT");
  });
});

describe("createOcrPipelineParser — parseAsync (scripted adapter — success)", () => {
  it("emits a page unit with correct bounds on OCR success", async () => {
    const text = "Hello, extracted page!";
    const parser = createOcrPipelineParser(
      scriptedAdapter({ ok: true, text, confidence: 0.98 }),
    );
    const result = await parser.parseAsync(
      selectionFromBytes(PDF_MAGIC, { extension: "pdf" }),
      baseOptions(),
    );
    expect(result.units).toHaveLength(1);
    const unit = result.units[0];
    if (unit?.kind !== "page") throw new Error("expected page unit, got " + String(unit?.kind));
    expect(unit.pageNumber).toBe(1);
    expect(unit.characterStart).toBe(0);
    expect(unit.characterEnd).toBe(text.length);
    expect(result.diagnostics).toEqual([]);
  });

  it("emits a page unit with characterEnd=0 for blank page text", async () => {
    const parser = createOcrPipelineParser(
      scriptedAdapter({ ok: true, text: "", confidence: 0 }),
    );
    const result = await parser.parseAsync(
      selectionFromBytes(PNG_MAGIC, { extension: "png" }),
      baseOptions(),
    );
    expect(result.units).toHaveLength(1);
    const unit = result.units[0];
    if (unit?.kind !== "page") throw new Error(`expected page unit`);
    expect(unit.characterEnd).toBe(0);
  });

  it("records the correct documentId on the page unit", async () => {
    const parser = createOcrPipelineParser(
      scriptedAdapter({ ok: true, text: "content", confidence: 0.9 }),
    );
    const input = selectionFromBytes(PDF_MAGIC, { extension: "pdf" });
    const result = await parser.parseAsync(input, baseOptions());
    const unit = result.units[0];
    if (unit?.kind !== "page") throw new Error("expected page");
    expect(unit.documentId).toBe(input.documentId);
  });
});

describe("createOcrPipelineParser — parseAsync (scripted adapter — failure reasons)", () => {
  it("fires unsupported-media with ocr-failed:timeout for timeout reason", async () => {
    const parser = createOcrPipelineParser(
      scriptedAdapter({ ok: false, reason: "timeout" }),
    );
    const result = await parser.parseAsync(
      selectionFromBytes(PDF_MAGIC, { extension: "pdf" }),
      baseOptions(),
    );
    const unit = result.units[0];
    if (unit?.kind !== "unsupported-media") throw new Error("expected unsupported-media");
    expect(unit.reason).toBe("ocr-failed:timeout");
  });

  it("fires unsupported-media with ocr-failed:unsupported-input for unsupported-input reason", async () => {
    const parser = createOcrPipelineParser(
      scriptedAdapter({ ok: false, reason: "unsupported-input" }),
    );
    const result = await parser.parseAsync(
      selectionFromBytes(PNG_MAGIC, { extension: "png" }),
      baseOptions(),
    );
    const unit = result.units[0];
    if (unit?.kind !== "unsupported-media") throw new Error("expected unsupported-media");
    expect(unit.reason).toBe("ocr-failed:unsupported-input");
  });
});

describe("createOcrPipelineParser — returned adapter is frozen", () => {
  it("is frozen", () => {
    const parser = createOcrPipelineParser(nullOcrAdapter);
    expect(Object.isFrozen(parser)).toBe(true);
  });
});
