import { DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY } from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-large-document";
import type { DocumentId, LargeDocumentResourcePolicy } from "@oscharko-dev/keiko-contracts";
import { describe, expect, it } from "vitest";

import type { KnowledgeLogEvent } from "../../knowledge-log.js";
import { buildParserOptions } from "../registry.js";
import { extractPages, type PdfDocumentLike, type PdfTextContentChunk } from "../pdf-parser.js";
import type { OcrPageResult } from "../ocr/types.js";
import { createProgressivePdfExtractor, runProgressiveExtraction } from "./index.js";
import type {
  OcrPageFn,
  ProgressiveExtractionLog,
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

  it("produces identical text on resume after an all-textless prefix vs a continuous run (KEIKO-0172)", async () => {
    // KEIKO-0172 regression pin. The bug: PdfDriveState seeded `anyPageEmitted` from the
    // proxy `resumeFromPage > 0`, which is correct only when at least one pre-resume page
    // had non-empty text. If the pre-resume prefix is entirely textless (scanned front-
    // matter, cover pages), a resumed run inserts a spurious leading "\n\n" before the
    // first real page's text that a continuous single-pass run would not emit. The fix
    // seeds from `options.resumeAnyPageEmitted` (with the proxy as compatibility fallback);
    // callers in extract-progressive.ts derive that flag from the already-persisted
    // extracted_text_bytes cursor (0 iff no text was ever emitted).
    const pages = ["", "", "charlie page", "delta page"] as const;
    const buildExtractor = (): ReturnType<typeof createProgressivePdfExtractor> =>
      createProgressivePdfExtractor({
        loadDocument: () => Promise.resolve(fakePdf([...pages])),
      });

    const continuousSink = collectingSink();
    await runProgressiveExtraction(buildExtractor(), SOURCE, options(2), continuousSink);
    const continuousText = continuousSink.text();

    const resumedSink = collectingSink();
    // Simulate a checkpoint at end of page 2 with the true prior state: no text ever
    // emitted (both leading pages were textless), so cursor is 0 and extractedTextBytes 0.
    await runProgressiveExtraction(
      buildExtractor(),
      SOURCE,
      options(2, {
        resumeFromPage: 2,
        resumeCharacterStart: 0,
        resumeExtractedTextBytes: 0,
        resumeAnyPageEmitted: false,
      }),
      resumedSink,
    );
    const resumedText = resumedSink.text();

    expect(resumedText).toBe(continuousText);
    expect(resumedText.startsWith("\n\n")).toBe(false);
    // Verify a run without the flag (legacy proxy) would insert the spurious leading
    // separator; this documents WHY the flag matters and pins the regression against the
    // proxy path being silently reintroduced elsewhere.
    const legacyProxySink = collectingSink();
    await runProgressiveExtraction(
      buildExtractor(),
      SOURCE,
      options(2, {
        resumeFromPage: 2,
        resumeCharacterStart: 0,
        resumeExtractedTextBytes: 0,
      }),
      legacyProxySink,
    );
    expect(legacyProxySink.text().startsWith("\n\n")).toBe(true);
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

function positionedItem(str: string, y: number): PdfTextContentChunk["items"][number] {
  return { str, transform: [10, 0, 0, 10, 50, y], width: str.length * 5, height: 10 };
}

function positionedPdf(pageCount: number, headerFrom: number): PdfDocumentLike {
  return {
    numPages: pageCount,
    getPage: (pageNumber: number) =>
      Promise.resolve({
        streamTextContent: () =>
          new ReadableStream<PdfTextContentChunk>({
            start(controller): void {
              const body = [700, 688, 676].map((y) =>
                positionedItem(`Seite ${String(pageNumber)} Zeile ${String(y)}`, y),
              );
              const header =
                pageNumber >= headerFrom ? [positionedItem("Kopf Nur Hinten", 780)] : [];
              controller.enqueue({ items: [...header, ...body] });
              controller.close();
            },
          }),
      }),
  };
}

/** Every page's last line reaches the margin and its sentence goes on on the next page. */
function runningTextPdf(pageCount: number): PdfDocumentLike {
  const fullLine = `Die Bank prüft auf Seite `.padEnd(90, "x");
  return {
    numPages: pageCount,
    getPage: (pageNumber: number) =>
      Promise.resolve({
        streamTextContent: () =>
          new ReadableStream<PdfTextContentChunk>({
            start(controller): void {
              controller.enqueue({
                items: [
                  positionedItem(`daher weiter ${String(pageNumber)}.`, 700),
                  positionedItem(fullLine, 680),
                ],
              });
              controller.close();
            },
          }),
      }),
  };
}

function resumeCharacterStartOf(windows: readonly ProgressiveExtractionWindow[]): number {
  const last = windows.at(-1);
  return last === undefined ? 0 : last.characterStart + last.text.length;
}

/** What the checkpoint behind these windows hands to the next run. */
function resumeBehind(
  windows: readonly ProgressiveExtractionWindow[],
): Partial<ProgressiveExtractionOptions> {
  const last = windows.at(-1);
  return {
    resumeFromPage: last?.lastPageNumber ?? 0,
    resumeCharacterStart: resumeCharacterStartOf(windows),
    resumeWindowIndex: windows.length,
    resumeObjectCursor: last?.objectCursor ?? 0,
    resumeExtractedTextBytes: windows.reduce(
      (sum, window) => sum + Buffer.byteLength(window.text, "utf8"),
      0,
    ),
    resumeAnyPageEmitted: true,
    resumeLearnedFurniture: last?.learnedFurniture ?? [],
  };
}

describe("progressive and full-buffer extraction of one document", () => {
  it("carry a paragraph over a page and a window the same way (#4235)", async () => {
    const doc = runningTextPdf(20);
    const input = {
      documentId: DOC,
      bytes: new Uint8Array(0),
      extension: "pdf",
      mediaType: "application/pdf",
    };
    const full = await extractPages(doc, input, buildParserOptions({ now: () => 0 }), 0);
    const extractor = createProgressivePdfExtractor({ loadDocument: () => Promise.resolve(doc) });
    const sink = collectingSink();
    await runProgressiveExtraction(extractor, SOURCE, options(16), sink);
    expect(full.normalizedText).toContain("xxx daher weiter 2.");
    expect(full.normalizedText).toContain("xxx daher weiter 17.");
    expect(full.normalizedText).not.toContain("\n\n");
    expect(sink.text()).toBe(full.normalizedText);
    expect(sink.windows.flatMap((w) => w.pages)).toEqual(full.pages);
    for (const page of full.pages) {
      expect(full.normalizedText?.slice(page.characterStart, page.characterEnd)).toContain(
        `daher weiter ${String(page.pageNumber)}.`,
      );
    }
  });

  it("goes on with the paragraph after a resume (#4235)", async () => {
    const doc = runningTextPdf(6);
    const run = async (
      overrides: Partial<ProgressiveExtractionOptions>,
    ): Promise<ReturnType<typeof collectingSink>> => {
      const extractor = createProgressivePdfExtractor({ loadDocument: () => Promise.resolve(doc) });
      const sink = collectingSink();
      await runProgressiveExtraction(extractor, SOURCE, options(2, overrides), sink);
      return sink;
    };
    const continuous = await run({});
    const cut =
      continuous.windows.flatMap((w) => w.pages).find((page) => page.pageNumber === 4)
        ?.characterEnd ?? 0;
    const resumed = await run({
      resumeFromPage: 4,
      resumeCharacterStart: cut,
      resumeAnyPageEmitted: true,
    });
    expect(resumed.text()).toBe(continuous.text().slice(cut));
    expect(resumed.text().startsWith(" daher")).toBe(true);
  });

  it("read the same text when the document is longer than one window (review #4235)", async () => {
    const doc = positionedPdf(20, 17);
    const input = {
      documentId: DOC,
      bytes: new Uint8Array(0),
      extension: "pdf",
      mediaType: "application/pdf",
    };
    const full = await extractPages(doc, input, buildParserOptions({ now: () => 0 }), 0);
    const extractor = createProgressivePdfExtractor({ loadDocument: () => Promise.resolve(doc) });
    const sink = collectingSink();
    await runProgressiveExtraction(extractor, SOURCE, options(16), sink);
    expect(sink.text()).toBe(full.normalizedText);
    expect(sink.windows.flatMap((w) => w.pages)).toEqual(full.pages);
  });

  it("removes the furniture a resumed run already knew from its short last window (review #4235)", async () => {
    const doc = positionedPdf(20, 1);
    const run = async (
      overrides: Partial<ProgressiveExtractionOptions>,
    ): Promise<ReturnType<typeof collectingSink>> => {
      const extractor = createProgressivePdfExtractor({ loadDocument: () => Promise.resolve(doc) });
      const sink = collectingSink();
      await runProgressiveExtraction(extractor, SOURCE, options(3, overrides), sink);
      return sink;
    };
    const continuous = await run({});
    const before = continuous.windows.filter((window) => window.lastPageNumber <= 18);
    const resumed = await run(resumeBehind(before));
    expect(continuous.text()).not.toContain("Kopf Nur Hinten");
    expect(resumed.text()).toBe(continuous.text().slice(resumeCharacterStartOf(before)));
    expect(resumed.windows).toEqual(continuous.windows.slice(before.length));
  });

  it("keeps extracting after a page whose text cannot be read (review #4235)", async () => {
    const good = positionedPdf(3, 99);
    const doc: PdfDocumentLike = {
      numPages: 3,
      getPage: (pageNumber: number) =>
        pageNumber === 2
          ? Promise.resolve({
              streamTextContent: () =>
                new ReadableStream<PdfTextContentChunk>({
                  start(controller): void {
                    controller.error(new Error("broken content stream"));
                  },
                }),
            })
          : good.getPage(pageNumber),
    };
    const extractor = createProgressivePdfExtractor({ loadDocument: () => Promise.resolve(doc) });
    const sink = collectingSink();
    const summary = await runProgressiveExtraction(extractor, SOURCE, options(3), sink);
    expect(summary.pageCount).toBe(3);
    expect(summary.coverage).toBe("partial");
    expect(sink.text()).toContain("Seite 3 Zeile 700");
    const unreadable = summary.diagnostics.find((d) => d.pageNumber === 2);
    expect(unreadable?.severity).toBe("warning");
  });
});

/** `Manual header` on pages 1 to 3 and 7, four body lines on every page (review of #4238). */
function returningHeaderPdf(): PdfDocumentLike {
  return {
    numPages: 7,
    getPage: (pageNumber: number) =>
      Promise.resolve({
        streamTextContent: () =>
          new ReadableStream<PdfTextContentChunk>({
            start(controller): void {
              const body = [700, 685, 670, 655].map((y) =>
                positionedItem(`Page ${String(pageNumber)} line ${String(y)}`, y),
              );
              const shown = pageNumber <= 3 || pageNumber === 7;
              const header = shown ? [positionedItem("Manual header", 780)] : [];
              controller.enqueue({ items: [...header, ...body] });
              controller.close();
            },
          }),
      }),
  };
}

async function windowsOf(
  doc: PdfDocumentLike,
  overrides: Partial<ProgressiveExtractionOptions> = {},
  limits: Partial<LargeDocumentResourcePolicy> = {},
): Promise<readonly ProgressiveExtractionWindow[]> {
  const extractor = createProgressivePdfExtractor({ loadDocument: () => Promise.resolve(doc) });
  const windows: ProgressiveExtractionWindow[] = [];
  const run = { ...options(3, overrides), policy: { ...policy(3), ...limits } };
  for await (const window of extractor.extractWindows(SOURCE, run)) windows.push(window);
  return windows;
}

describe("a resumed progressive extraction", () => {
  it("removes a header only the earlier windows proved, byte for byte", async () => {
    const doc = returningHeaderPdf();
    const continuous = await windowsOf(doc);
    const resumed = await windowsOf(doc, resumeBehind(continuous.slice(0, 2)));

    expect(continuous.map((window) => window.text).join("")).not.toContain("Manual header");
    expect(resumed).toEqual(continuous.slice(2));
  });

  it("ends in the same state as a continuous run", async () => {
    const doc = returningHeaderPdf();
    const extractor = createProgressivePdfExtractor({ loadDocument: () => Promise.resolve(doc) });
    const collected = collectingSink();
    const whole = await runProgressiveExtraction(extractor, SOURCE, options(3), collected);
    const resumed = await runProgressiveExtraction(
      extractor,
      SOURCE,
      options(3, resumeBehind(collected.windows.slice(0, 2))),
      collectingSink(),
    );

    const { diagnostics: wholeDiagnostics, ...wholeState } = whole;
    const { diagnostics: resumedDiagnostics, ...resumedState } = resumed;
    expect(resumedState).toEqual(wholeState);
    expect(resumedDiagnostics).toEqual(collected.windows[2]?.diagnostics);
    expect(wholeDiagnostics).toEqual(collected.windows.flatMap((window) => window.diagnostics));
  });

  it("counts the pages before the resume point against the unit limit", async () => {
    const doc = returningHeaderPdf();
    const limits = { maxParserUnits: 6 };
    const continuous = await windowsOf(doc, {}, limits);
    const resumed = await windowsOf(doc, resumeBehind(continuous.slice(0, 2)), limits);

    expect(resumed).toEqual(continuous.slice(2));
  });

  it("reports what it learned as digests, never as the repeated text", async () => {
    const [first] = await windowsOf(returningHeaderPdf());

    expect(first?.learnedFurniture?.length).toBeGreaterThan(0);
    expect(JSON.stringify(first?.learnedFurniture)).not.toContain("Manual");
    for (const digest of first?.learnedFurniture ?? []) {
      expect(digest).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    }
  });
});

describe("a page that cannot be read", () => {
  const DIGEST = "0123456789abcdef";
  const JOB = "page-read-proof-job";

  function capture(): {
    readonly events: KnowledgeLogEvent[];
    readonly log: ProgressiveExtractionLog;
  } {
    const events: KnowledgeLogEvent[] = [];
    return {
      events,
      log: {
        sink: { write: (event): void => void events.push(event) },
        context: { jobId: JOB, capsuleIdDigest: DIGEST, documentIdDigest: DIGEST },
      },
    };
  }

  function brokenAt(page: number): PdfDocumentLike {
    const good = returningHeaderPdf();
    const broken = Object.assign(new Error("secret page text"), { code: "PDF_BROKEN" });
    return {
      numPages: good.numPages,
      getPage: (pageNumber: number) =>
        pageNumber === page ? Promise.reject(broken) : good.getPage(pageNumber),
    };
  }

  it("leaves evidence when it breaks in a window", async () => {
    const { events, log } = capture();
    const windows = await windowsOf(brokenAt(2), { log });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      op: "indexing.document.page-read-failed",
      level: "warn",
      correlationId: JOB,
      extra: { stage: "window", pageNumber: 2, failureKind: "PDF_BROKEN" },
    });
    expect(JSON.stringify(events)).not.toContain("secret");
    const reported = windows.flatMap((window) => window.diagnostics);
    expect(reported.find((diagnostic) => diagnostic.pageNumber === 2)?.severity).toBe("warning");
  });

  it("leaves evidence when it breaks while read again before a resume", async () => {
    const { events, log } = capture();
    const doc = brokenAt(2);
    const continuous = await windowsOf(doc);
    const [next] = await windowsOf(doc, { ...resumeBehind(continuous.slice(0, 1)), log });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      op: "indexing.document.page-read-failed",
      correlationId: JOB,
      extra: { stage: "resume", pageNumber: 2, failureKind: "PDF_BROKEN" },
    });
    expect(JSON.stringify(events)).not.toContain("secret");
    const notice = next?.diagnostics.find((diagnostic) => diagnostic.pageNumber === 2);
    expect(notice?.severity).toBe("info");
    expect(next?.text).toBe(continuous[1]?.text);
  });

  it("does not stop a run when no log is wired", async () => {
    const windows = await windowsOf(brokenAt(2));

    expect(windows.map((window) => window.lastPageNumber)).toEqual([3, 6, 7]);
  });
});
