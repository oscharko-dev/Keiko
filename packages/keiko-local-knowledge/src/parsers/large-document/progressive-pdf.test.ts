import { DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY } from "@oscharko-dev/keiko-contracts";
import type { DocumentId, LargeDocumentResourcePolicy } from "@oscharko-dev/keiko-contracts";
import { describe, expect, it } from "vitest";

import type { PdfDocumentLike } from "../pdf-parser.js";
import type { OcrPageResult } from "../ocr/types.js";
import { createProgressivePdfExtractor, runProgressiveExtraction } from "./index.js";
import type {
  OcrPageFn,
  ProgressiveExtractionOptions,
  ProgressiveExtractionSource,
  ProgressiveExtractionWindow,
} from "./index.js";

const DOC = "pdf-1" as DocumentId;

function fakePdf(
  pageTexts: readonly string[],
  labels?: readonly (string | null)[],
): PdfDocumentLike {
  return {
    numPages: pageTexts.length,
    getPage: (pageNumber: number) =>
      Promise.resolve({
        streamTextContent: () =>
          new ReadableStream({
            start(controller): void {
              const text = pageTexts[pageNumber - 1] ?? "";
              if (text.length > 0) {
                controller.enqueue({ items: text.split(" ").map((str) => ({ str })) });
              }
              controller.close();
            },
          }),
      }),
    ...(labels === undefined ? {} : { getPageLabels: () => Promise.resolve(labels) }),
  };
}

const SOURCE: ProgressiveExtractionSource = {
  totalBytes: 1024,
  loadFullBuffer: () => Promise.resolve(new Uint8Array([0x25, 0x50, 0x44, 0x46])),
};

function policy(windowPages: number): LargeDocumentResourcePolicy {
  return { ...DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY, extractionWindowPages: windowPages };
}

function options(
  windowPages: number,
  overrides: Partial<ProgressiveExtractionOptions> = {},
): ProgressiveExtractionOptions {
  return {
    documentId: DOC,
    extension: "pdf",
    mediaType: "application/pdf",
    policy: policy(windowPages),
    now: () => 0,
    ...overrides,
  };
}

function collectingSink(): {
  windows: ProgressiveExtractionWindow[];
  text: () => string;
  onWindow: (w: ProgressiveExtractionWindow) => void;
} {
  const windows: ProgressiveExtractionWindow[] = [];
  return {
    windows,
    text: () => windows.map((w) => w.text).join(""),
    onWindow: (w): void => {
      windows.push(w);
    },
  };
}

describe("createProgressivePdfExtractor", () => {
  it("matches PDF inputs by extension or media type", () => {
    const extractor = createProgressivePdfExtractor();
    expect(extractor.matches({ extension: "pdf", mediaType: "" })).toBe(true);
    expect(extractor.matches({ extension: "", mediaType: "application/pdf" })).toBe(true);
    expect(extractor.matches({ extension: "txt", mediaType: "text/plain" })).toBe(false);
    expect(extractor.strategyId).toBe("progressive-pdf");
  });

  it("extracts a multi-page PDF in bounded windows that concatenate to the full text", async () => {
    const pages = [
      "page one text",
      "page two text",
      "page three text",
      "page four text",
      "page five",
    ];
    const extractor = createProgressivePdfExtractor({
      loadDocument: () => Promise.resolve(fakePdf(pages)),
    });
    const sink = collectingSink();
    const summary = await runProgressiveExtraction(extractor, SOURCE, options(2), sink);

    expect(summary.pageCount).toBe(5);
    expect(summary.windowCount).toBe(3);
    expect(summary.coverage).toBe("complete");
    expect(sink.text()).toBe(pages.join("\n\n"));
    for (const w of sink.windows) {
      expect(w.pages.length).toBeLessThanOrEqual(2);
    }
  });

  it("indexes a no-text-layer page through an injected OCR capability with page provenance", async () => {
    const pages = ["first page", "", "third page"];
    const ocrPage: OcrPageFn = ({ pageNumber }): Promise<OcrPageResult> =>
      Promise.resolve({ ok: true, text: `ocr page ${String(pageNumber)}`, confidence: 0.8 });
    const extractor = createProgressivePdfExtractor({
      loadDocument: () => Promise.resolve(fakePdf(pages)),
      ocr: { status: "available", ocrPage },
    });
    const sink = collectingSink();
    const summary = await runProgressiveExtraction(extractor, SOURCE, options(3), sink);

    expect(summary.pageCount).toBe(3);
    expect(sink.text()).toContain("ocr page 2");
    // Provenance: the OCR'd page keeps its page number.
    const ocrPageRecord = sink.windows.flatMap((w) => w.pages).find((p) => p.pageNumber === 2);
    expect(ocrPageRecord).toBeDefined();
  });

  it("degrades a no-text-layer page to a partial-coverage warning when OCR is unavailable", async () => {
    const pages = ["first page", "", "third page"];
    const extractor = createProgressivePdfExtractor({
      loadDocument: () => Promise.resolve(fakePdf(pages)),
    });
    const sink = collectingSink();
    const summary = await runProgressiveExtraction(extractor, SOURCE, options(3), sink);

    // The job still completes; the empty page is kept as provenance with a quality warning.
    expect(summary.pageCount).toBe(3);
    expect(summary.coverage).toBe("partial");
    expect(summary.diagnostics.some((d) => d.code === "OCR_CAPABILITY_UNAVAILABLE")).toBe(true);
    expect(summary.diagnostics.every((d) => d.severity !== "error")).toBe(true);
    const emptyPage = sink.windows.flatMap((w) => w.pages).find((p) => p.pageNumber === 2);
    expect(emptyPage).toMatchObject({ characterStart: 10, characterEnd: 10 });
  });

  it("preserves PDF page labels across windows", async () => {
    const extractor = createProgressivePdfExtractor({
      loadDocument: () => Promise.resolve(fakePdf(["front", "body"], ["i", "1"])),
    });
    const sink = collectingSink();

    await runProgressiveExtraction(extractor, SOURCE, options(1), sink);

    expect(sink.windows.flatMap((w) => w.pages).map((page) => page.pageLabel)).toEqual(["i", "1"]);
  });

  it("resumes extraction from a page cursor", async () => {
    const pages = ["alpha page", "bravo page", "charlie page", "delta page"] as const;
    const extractor = createProgressivePdfExtractor({
      loadDocument: () => Promise.resolve(fakePdf([...pages])),
    });
    // Simulate having already extracted pages 1-2; resume from the end of page 2.
    const endOfPage2 = pages[0].length + 2 + pages[1].length;
    const sink = collectingSink();
    const summary = await runProgressiveExtraction(
      extractor,
      SOURCE,
      options(2, { resumeFromPage: 2, resumeCharacterStart: endOfPage2 }),
      sink,
    );
    expect(summary.pageCount).toBe(4);
    const fullText = pages.join("\n\n");
    for (const w of sink.windows) {
      for (const page of w.pages) {
        expect(fullText.slice(page.characterStart, page.characterEnd)).toBe(
          pages[page.pageNumber - 1],
        );
      }
    }
  });

  it("opens range-only sources without requiring a full buffer", async () => {
    let sawRangeRead = false;
    const extractor = createProgressivePdfExtractor({
      loadDocument: async (source) => {
        expect(source.loadFullBuffer).toBeUndefined();
        const bytes = await source.readWindow?.(0, 4);
        sawRangeRead = bytes?.byteLength === 4;
        return fakePdf(["x"]);
      },
    });
    const streamingOnly: ProgressiveExtractionSource = {
      totalBytes: 4,
      readWindow: (_start, length) => Promise.resolve(new Uint8Array(length)),
    };
    const summary = await runProgressiveExtraction(
      extractor,
      streamingOnly,
      options(2),
      collectingSink(),
    );
    expect(summary.pageCount).toBe(1);
    expect(sawRangeRead).toBe(true);
  });
});
