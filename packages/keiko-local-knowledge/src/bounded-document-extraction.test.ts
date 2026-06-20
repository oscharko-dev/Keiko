import { describe, expect, it } from "vitest";

import {
  extractBoundedDocumentText,
  type BoundedDocumentExtractionOptions,
} from "./bounded-document-extraction.js";
import {
  DOCX_SIMPLE,
  PDF_TEXT_LAYER,
  PDF_NO_TEXT_LAYER,
  XLSX_SIMPLE,
  encode,
} from "./parsers/parser-test-fixtures.js";

const PDF_PARSE_TIMEOUT_MS = 15_000;

function options(
  overrides: Partial<BoundedDocumentExtractionOptions> = {},
): BoundedDocumentExtractionOptions {
  return {
    maxInputBytes: 2 * 1024 * 1024,
    maxOutputBytes: 32 * 1024,
    maxUnits: 5_000,
    timeoutMs: 5_000,
    now: () => 0,
    ...overrides,
  };
}

// A Compound File Binary (OLE2) header — the container shape of a password-protected OOXML file.
const CFB_HEADER = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]);

describe("extractBoundedDocumentText", () => {
  it("extracts DOCX text", async () => {
    const result = await extractBoundedDocumentText(
      { bytes: DOCX_SIMPLE, extension: "docx" },
      options(),
    );
    expect(result.outcome).toBe("extracted");
    expect(result.format).toBe("docx");
    expect(result.text).toContain("Policy");
    expect(result.extractedBytes).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);
  });

  it("extracts XLSX sheet text", async () => {
    const result = await extractBoundedDocumentText(
      { bytes: XLSX_SIMPLE, extension: "xlsx" },
      options(),
    );
    expect(result.outcome).toBe("extracted");
    expect(result.format).toBe("xlsx");
    expect(result.text).toContain("Controls");
    expect(result.text).toContain("Control-17");
  });

  it(
    "extracts text-layer PDF text",
    async () => {
      const result = await extractBoundedDocumentText(
        { bytes: PDF_TEXT_LAYER, extension: "pdf", mediaType: "application/pdf" },
        options({ timeoutMs: PDF_PARSE_TIMEOUT_MS }),
      );
      expect(result.outcome).toBe("extracted");
      expect(result.format).toBe("pdf");
      expect(result.text).toContain("Hello PDF");
    },
    PDF_PARSE_TIMEOUT_MS + 5_000,
  );

  it(
    "reports no-text-layer for a scanned (image-only) PDF",
    async () => {
      const result = await extractBoundedDocumentText(
        { bytes: PDF_NO_TEXT_LAYER, extension: "pdf", mediaType: "application/pdf" },
        options({ timeoutMs: PDF_PARSE_TIMEOUT_MS }),
      );
      expect(result.outcome).toBe("no-text-layer");
      expect(result.format).toBe("pdf");
      expect(result.text).toBe("");
    },
    PDF_PARSE_TIMEOUT_MS + 5_000,
  );

  it("resolves format from media type when the extension is unknown", async () => {
    const result = await extractBoundedDocumentText(
      {
        bytes: DOCX_SIMPLE,
        extension: "",
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      options(),
    );
    expect(result.outcome).toBe("extracted");
    expect(result.format).toBe("docx");
  });

  it("normalizes an extension that carries a leading dot", async () => {
    const result = await extractBoundedDocumentText(
      { bytes: DOCX_SIMPLE, extension: ".DOCX" },
      options(),
    );
    expect(result.outcome).toBe("extracted");
    expect(result.format).toBe("docx");
  });

  it("reports unsupported-format for legacy .doc", async () => {
    const result = await extractBoundedDocumentText(
      { bytes: encode("legacy binary word doc"), extension: "doc" },
      options(),
    );
    expect(result.outcome).toBe("unsupported-format");
    expect(result.format).toBeUndefined();
    expect(result.text).toBe("");
  });

  it("reports unsupported-format for an unknown extension and media type", async () => {
    const result = await extractBoundedDocumentText(
      { bytes: encode("plain"), extension: "png", mediaType: "image/png" },
      options(),
    );
    expect(result.outcome).toBe("unsupported-format");
    expect(result.format).toBeUndefined();
  });

  it("reports oversized before invoking the parser", async () => {
    const result = await extractBoundedDocumentText(
      { bytes: DOCX_SIMPLE, extension: "docx" },
      options({ maxInputBytes: 4 }),
    );
    expect(result.outcome).toBe("oversized");
    expect(result.format).toBe("docx");
    expect(result.text).toBe("");
  });

  it("reports encrypted for a CFB-wrapped (password-protected) DOCX", async () => {
    const result = await extractBoundedDocumentText(
      { bytes: CFB_HEADER, extension: "docx" },
      options(),
    );
    expect(result.outcome).toBe("encrypted");
    expect(result.format).toBe("docx");
  });

  it("reports encrypted for a CFB-wrapped (password-protected) XLSX", async () => {
    const result = await extractBoundedDocumentText(
      { bytes: CFB_HEADER, extension: "xlsx" },
      options(),
    );
    expect(result.outcome).toBe("encrypted");
    expect(result.format).toBe("xlsx");
  });

  it("does not apply CFB encryption detection to PDFs", async () => {
    // A CFB header with a .pdf extension is not a valid PDF; it must degrade to malformed, never
    // be misreported as encrypted (the encryption pre-check is OOXML-only).
    const result = await extractBoundedDocumentText(
      { bytes: CFB_HEADER, extension: "pdf", mediaType: "application/pdf" },
      options(),
    );
    expect(result.outcome).toBe("malformed");
    expect(result.format).toBe("pdf");
  });

  it("reports malformed for corrupt DOCX bytes", async () => {
    const result = await extractBoundedDocumentText(
      { bytes: encode("this is definitely not a zip container"), extension: "docx" },
      options(),
    );
    expect(result.outcome).toBe("malformed");
    expect(result.format).toBe("docx");
  });

  it("reports timed-out when the caller signal is already aborted", async () => {
    const result = await extractBoundedDocumentText(
      { bytes: DOCX_SIMPLE, extension: "docx" },
      options({ signal: AbortSignal.abort() }),
    );
    expect(result.outcome).toBe("timed-out");
    expect(result.format).toBe("docx");
  });

  it("reports empty when the output cap admits no text", async () => {
    const result = await extractBoundedDocumentText(
      { bytes: DOCX_SIMPLE, extension: "docx" },
      options({ maxOutputBytes: 0 }),
    );
    expect(result.outcome).toBe("empty");
    expect(result.format).toBe("docx");
    expect(result.text).toBe("");
  });

  it("truncates extracted text to the output byte cap", async () => {
    const result = await extractBoundedDocumentText(
      { bytes: DOCX_SIMPLE, extension: "docx" },
      options({ maxOutputBytes: 8 }),
    );
    expect(result.outcome).toBe("extracted");
    expect(result.truncated).toBe(true);
    expect(result.extractedBytes).toBeLessThanOrEqual(8);
    expect(result.extractedBytes).toBeGreaterThan(0);
  });

  it("keeps diagnostics free of absolute filesystem paths", async () => {
    const result = await extractBoundedDocumentText(
      { bytes: encode("corrupt"), extension: "docx" },
      options(),
    );
    const serialized = JSON.stringify(result.diagnostics);
    expect(serialized).not.toMatch(/\/(Users|home|var|tmp)\//);
  });
});
