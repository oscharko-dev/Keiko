import { describe, expect, it } from "vitest";

import { buildParserOptions } from "./registry.js";
import { PDF_MAGIC, PDF_TEXT_LAYER, selectionFromBytes } from "./parser-test-fixtures.js";
import {
  extractPages,
  pdfParser,
  type PdfDocumentLike,
  type PdfTextContentChunk,
} from "./pdf-parser.js";

const PDF_TEXT_LAYER_PARSE_TIMEOUT_MS = 15_000;

function textPage(text: string, onCancel?: () => void): ReturnType<PdfDocumentLike["getPage"]> {
  return Promise.resolve({
    streamTextContent: () =>
      new ReadableStream<PdfTextContentChunk>({
        start: (controller): void => {
          if (text.length > 0) {
            controller.enqueue({
              items: text.split(" ").map((str) => ({ str })),
            });
          }
          controller.close();
        },
        ...(onCancel !== undefined ? { cancel: onCancel } : {}),
      }),
  });
}

function positionedPage(
  items: readonly PdfTextContentChunk["items"][number][],
): ReturnType<PdfDocumentLike["getPage"]> {
  return Promise.resolve({
    streamTextContent: () =>
      new ReadableStream<PdfTextContentChunk>({
        start: (controller): void => {
          controller.enqueue({ items });
          controller.close();
        },
      }),
  });
}

function fakePdf(
  pageTexts: readonly string[],
  labels?: readonly (string | null)[],
): PdfDocumentLike {
  return {
    numPages: pageTexts.length,
    getPage: (pageNumber) => textPage(pageTexts[pageNumber - 1] ?? ""),
    ...(labels === undefined ? {} : { getPageLabels: () => Promise.resolve(labels) }),
  };
}

describe("pdfParser", () => {
  it("matches PDF extension and magic bytes", () => {
    expect(pdfParser.capability.matches(selectionFromBytes(PDF_MAGIC, { extension: "pdf" }))).toBe(
      true,
    );
  });

  it(
    "extracts page text from a text-layer PDF",
    async () => {
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
    },
    PDF_TEXT_LAYER_PARSE_TIMEOUT_MS,
  );

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

  it("emits provenance for empty pages and preserves PDF page labels", async () => {
    const input = selectionFromBytes(PDF_MAGIC, {
      extension: "pdf",
      mediaType: "application/pdf",
    });
    const result = await extractPages(
      fakePdf(["front", "", "body", "tail"], ["i", "ii", "1", "2"]),
      input,
      buildParserOptions({ now: () => 0 }),
      0,
    );

    expect(result.pages.map((page) => [page.pageNumber, page.pageLabel])).toEqual([
      [1, "i"],
      [2, "ii"],
      [3, "1"],
      [4, "2"],
    ]);
    expect(result.pages[1]).toMatchObject({ characterStart: 5, characterEnd: 5 });
    expect(result.normalizedText).toBe("front\n\nbody\n\ntail");
  });

  it("keeps page provenance when an individual page fails to load", async () => {
    const input = selectionFromBytes(PDF_MAGIC, {
      extension: "pdf",
      mediaType: "application/pdf",
    });
    const doc: PdfDocumentLike = {
      numPages: 3,
      getPage: (pageNumber) =>
        pageNumber === 2
          ? Promise.reject(new Error("bad page"))
          : textPage(`page ${String(pageNumber)}`),
    };

    const result = await extractPages(doc, input, buildParserOptions({ now: () => 0 }), 0);

    expect(result.pages.map((page) => page.pageNumber)).toEqual([1, 2, 3]);
    expect(result.pages[1]).toMatchObject({ characterStart: 6, characterEnd: 6 });
    expect(result.normalizedText).toBe("page 1\n\npage 3");
    expect(result.diagnostics[0]).toMatchObject({
      code: "PAGE_PARSE_FAILED",
      pageNumber: 2,
      severity: "warning",
    });
  });

  it("stops streamed text extraction at maxObjectsPerDocument without cancelling pdfjs streams", async () => {
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

    expect(result.pages).toHaveLength(1);
    expect(result.units).toHaveLength(1);
    expect(result.normalizedText).toBe("one");
    expect(result.diagnostics[0]).toMatchObject({
      code: "OBJECT_LIMIT_REACHED",
      severity: "error",
    });
    expect(cancelled).toBe(false);
  });

  it("orders simple two-column positioned text by column and normalizes ligatures", async () => {
    const input = selectionFromBytes(PDF_MAGIC, {
      extension: "pdf",
      mediaType: "application/pdf",
    });
    const doc: PdfDocumentLike = {
      numPages: 1,
      getPage: () =>
        positionedPage([
          { str: "Left 1", transform: [1, 0, 0, 1, 50, 700] },
          { str: "Right 1", transform: [1, 0, 0, 1, 350, 700] },
          { str: "Left \ufb01le", transform: [1, 0, 0, 1, 50, 680] },
          { str: "Right 2", transform: [1, 0, 0, 1, 350, 680] },
        ]),
    };

    const result = await extractPages(doc, input, buildParserOptions({ now: () => 0 }), 0);

    expect(result.normalizedText).toBe("Left 1\nLeft file\nRight 1\nRight 2");
  });
});
