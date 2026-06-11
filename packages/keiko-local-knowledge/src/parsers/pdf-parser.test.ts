import { describe, expect, it } from "vitest";

import { buildParserOptions } from "./registry.js";
import { PDF_MAGIC, PDF_TEXT_LAYER, selectionFromBytes } from "./parser-test-fixtures.js";
import {
  extractPages,
  pdfParser,
  type PdfDocumentLike,
  type PdfTextContentChunk,
} from "./pdf-parser.js";

describe("pdfParser", () => {
  it("matches PDF extension and magic bytes", () => {
    expect(pdfParser.capability.matches(selectionFromBytes(PDF_MAGIC, { extension: "pdf" }))).toBe(
      true,
    );
  });

  it("extracts page text from a text-layer PDF", async () => {
    const result = await pdfParser.parseAsync(
      selectionFromBytes(PDF_TEXT_LAYER, { extension: "pdf", mediaType: "application/pdf" }),
      buildParserOptions(),
    );
    expect(result.parser.parserId).toBe("pdf");
    expect(result.parser.dependencyVersions).toEqual([
      { packageName: "pdfjs-dist", version: "6.0.227" },
      { packageName: "@napi-rs/canvas", version: "1.0.0" },
    ]);
    expect(result.pages).toHaveLength(1);
    expect(result.units[0]).toMatchObject({ kind: "page", pageNumber: 1 });
    expect("normalizedText" in result ? result.normalizedText : undefined).toContain("Hello PDF");
    expect(result.diagnostics).toEqual([]);
  });

  it("reports malformed PDF bytes safely", async () => {
    const result = await pdfParser.parseAsync(
      selectionFromBytes(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00]), {
        extension: "pdf",
        mediaType: "application/pdf",
      }),
      buildParserOptions(),
    );
    expect(result.diagnostics[0]?.code).toBe("MALFORMED_INPUT");
    expect(result.diagnostics[0]?.message).toBe(
      "pdf parser rejected malformed or unsupported document",
    );
  });

  it("stops streamed text extraction at maxObjectsPerDocument", async () => {
    const input = selectionFromBytes(PDF_MAGIC, {
      extension: "pdf",
      mediaType: "application/pdf",
    });
    let cancelled = false;
    const doc: PdfDocumentLike = {
      numPages: 1,
      getPage: () =>
        Promise.resolve({
          streamTextContent: () =>
            new ReadableStream<PdfTextContentChunk>({
              start: (controller): void => {
                controller.enqueue({ items: [{ str: "one" }, { str: "two" }] });
              },
              cancel: (): void => {
                cancelled = true;
              },
            }),
        }),
    };

    const result = await extractPages(
      doc,
      input,
      buildParserOptions({ maxObjectsPerDocument: 1, now: () => 0 }),
      0,
    );

    expect(result.pages).toEqual([]);
    expect(result.units).toEqual([]);
    expect(result.diagnostics[0]).toMatchObject({
      code: "OBJECT_LIMIT_REACHED",
      severity: "error",
    });
    expect(cancelled).toBe(true);
  });
});
