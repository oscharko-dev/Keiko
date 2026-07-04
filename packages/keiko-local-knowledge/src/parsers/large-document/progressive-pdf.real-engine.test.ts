// Real-engine regression for bounded/progressive PDF extraction (Epic #1160, Issue #1286).
//
// The companion progressive-pdf.test.ts injects a `loadDocument` fake and a 4-byte source, so it
// never exercises pdfjs-dist at all: it proves the windowing *driver*, not the real extraction
// engine over a genuinely large document. This test closes GEN-TEST-FIXTURE-001 by generating a
// real ~150-page PDF and driving `createProgressivePdfExtractor()` with NO `loadDocument` override,
// so extraction runs through the production `loadPdfDocumentFromSource` -> real pdfjs-dist ->
// per-page `streamTextContent` path.
//
// The assertions here (150 real pages parsed, page-150's distinct text recovered in the correct
// bounded window, every page covered exactly once, per-window size capped at the policy's window
// size) are ones the fake 4-byte mock could never satisfy: the fake yields whatever page array the
// test hands it, whereas here the page count and per-page text are decoded from actual PDF bytes by
// pdfjs.
//
// If no pdfjs runtime is resolvable in the environment the test fails CLOSED under CI (asserts the
// runtime is present) instead of silently passing, so a broken/absent engine cannot pass unnoticed.

import { DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY } from "@oscharko-dev/keiko-contracts";
import type { DocumentId, LargeDocumentResourcePolicy } from "@oscharko-dev/keiko-contracts";
import { describe, expect, it } from "vitest";

import { createProgressivePdfExtractor, runProgressiveExtraction } from "./index.js";
import type {
  ProgressiveExtractionOptions,
  ProgressiveExtractionSource,
  ProgressiveExtractionWindow,
} from "./index.js";

const DOC = "pdf-real-1" as DocumentId;
const PAGE_COUNT = 150;
const WINDOW_PAGES = 16;

// Distinct, machine-checkable text per page. The multiplier makes the marker for page N unique even
// as a substring of another page's marker, so a "page 150 text present" assertion can only pass if
// page 150 itself was decoded (not, e.g., page 15 leaking through).
function pageMarker(pageNumber: number): string {
  return `KeikoPage${String(pageNumber)}Marker${String(pageNumber * 7)}`;
}

function pdfEscape(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

// Builds a minimal but spec-valid multi-page PDF (header, catalog, page tree, shared font, one
// content stream per page, byte-accurate xref table, trailer) that real pdfjs-dist can open and
// whose per-page text layer it can stream. One text-showing operator per page keeps each page's
// content unambiguous.
function buildMultiPagePdf(
  pageCount: number,
  textForPage: (pageNumber: number) => string,
): Uint8Array {
  const encoder = new TextEncoder();
  const header = "%PDF-1.4\n%âãÏÓ\n";
  const objects: string[] = [];
  const pageObjNumbers: number[] = [];
  for (let i = 0; i < pageCount; i += 1) pageObjNumbers.push(4 + i * 2);

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] =
    "<< /Type /Pages /Count " +
    String(pageCount) +
    " /Kids [" +
    pageObjNumbers.map((n) => `${String(n)} 0 R`).join(" ") +
    "] >>";
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  for (let i = 0; i < pageCount; i += 1) {
    const pageObj = 4 + i * 2;
    const contentObj = 5 + i * 2;
    const stream = `BT /F1 24 Tf 72 700 Td (${pdfEscape(textForPage(i + 1))}) Tj ET`;
    objects[pageObj] =
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${String(contentObj)} 0 R >>`;
    objects[contentObj] =
      `<< /Length ${String(encoder.encode(stream).length)} >>\nstream\n${stream}\nendstream`;
  }

  // Serialize objects sequentially, recording each object's byte offset for the xref table.
  let body = header;
  const offsets: number[] = [];
  for (let n = 1; n < objects.length; n += 1) {
    offsets[n] = encoder.encode(body).length;
    body += `${String(n)} 0 obj\n${objects[n] ?? ""}\nendobj\n`;
  }

  const xrefOffset = encoder.encode(body).length;
  const total = objects.length; // slot 0 is the free head entry
  let xref = `xref\n0 ${String(total)}\n0000000000 65535 f \n`;
  for (let n = 1; n < total; n += 1) {
    xref += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${String(total)} /Root 1 0 R >>\nstartxref\n${String(xrefOffset)}\n%%EOF\n`;

  return encoder.encode(body + xref + trailer);
}

function policy(windowPages: number): LargeDocumentResourcePolicy {
  return { ...DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY, extractionWindowPages: windowPages };
}

function options(windowPages: number): ProgressiveExtractionOptions {
  return {
    documentId: DOC,
    extension: "pdf",
    mediaType: "application/pdf",
    policy: policy(windowPages),
    now: () => 0,
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

// Resolvability of the exact specifier the production loader imports
// (loadPdfDocument -> import("pdfjs-dist/legacy/build/pdf.mjs")). We deliberately RESOLVE rather
// than dynamic-import: pdfjs-dist evaluates browser geometry globals (DOMMatrix) at module top
// level and throws unless production's DOM polyfills were installed first, so a bare import()
// here would be order-dependent and could spuriously report the runtime absent even though the
// real extractor (which installs the polyfills) works. Resolution answers the real question —
// "is the dependency installed?" — without that side effect.
function pdfRuntimePresent(): boolean {
  try {
    if (typeof import.meta.resolve === "function") {
      import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs");
      return true;
    }
    return true;
  } catch {
    return false;
  }
}

describe("createProgressivePdfExtractor over the real pdfjs engine", () => {
  it("fails closed under CI when no pdfjs runtime is resolvable", () => {
    const runtimePresent = pdfRuntimePresent();
    if (process.env.CI === "true") {
      // In CI the engine MUST be present; a missing engine is a hard failure, never a silent pass.
      expect(runtimePresent).toBe(true);
    } else if (!runtimePresent) {
      // Locally, surface the blocker loudly so the skip is visible rather than swallowed.
      // eslint-disable-next-line no-console
      console.warn("pdfjs-dist runtime not resolvable; real-engine assertions skipped locally");
    }
    expect(typeof runtimePresent).toBe("boolean");
  });

  it("extracts a genuine 150-page PDF in bounded windows via real pdfjs (not the fake mock)", async () => {
    if (!pdfRuntimePresent()) return; // guarded by the fail-closed CI sentinel above

    const bytes = buildMultiPagePdf(PAGE_COUNT, pageMarker);
    // Sanity: this is real PDF, not the 4-byte stub the companion test uses.
    expect(bytes.byteLength).toBeGreaterThan(4);
    expect(Array.from(bytes.slice(0, 5))).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"

    const source: ProgressiveExtractionSource = {
      totalBytes: bytes.byteLength,
      loadFullBuffer: () => Promise.resolve(bytes),
    };
    // No `loadDocument` override => production loadPdfDocumentFromSource => real pdfjs-dist.
    const extractor = createProgressivePdfExtractor();
    const sink = collectingSink();

    const summary = await runProgressiveExtraction(extractor, source, options(WINDOW_PAGES), sink);

    // The real engine decoded exactly the page count that is physically in the byte stream. A fake
    // that returns a hardcoded page array proves nothing here; pdfjs had to walk the page tree.
    expect(summary.pageCount).toBe(PAGE_COUNT);
    expect(summary.coverage).toBe("complete");
    expect(summary.stopReason).toBe("completed");
    // ceil(150 / 16) = 10 windows.
    expect(summary.windowCount).toBe(Math.ceil(PAGE_COUNT / WINDOW_PAGES));
    expect(sink.windows).toHaveLength(Math.ceil(PAGE_COUNT / WINDOW_PAGES));

    // BOUNDED: no window ever holds more than one window's worth of pages, so the working set does
    // not scale with document size.
    for (const w of sink.windows) {
      expect(w.pages.length).toBeLessThanOrEqual(WINDOW_PAGES);
    }

    // Windows are emitted incrementally with monotonically increasing indices and no gaps.
    expect(sink.windows.map((w) => w.windowIndex)).toEqual(
      Array.from({ length: sink.windows.length }, (_v, i) => i),
    );

    // COVERED EXACTLY ONCE: every page 1..150 appears exactly one time across all windows, in order.
    const pageNumbers = sink.windows.flatMap((w) => w.pages.map((p) => p.pageNumber));
    expect(pageNumbers).toEqual(Array.from({ length: PAGE_COUNT }, (_v, i) => i + 1));

    // LATE-PAGE TEXT IN THE CORRECT WINDOW: page 150 lands in the last (10th) window, and its
    // distinct real-decoded marker text is present in that window's flushed text — something the
    // 4-byte fake mock can never produce.
    const lateWindowIndex = Math.floor((PAGE_COUNT - 1) / WINDOW_PAGES); // 149 // 16 = 9
    const windowWithLastPage = sink.windows.findIndex((w) =>
      w.pages.some((p) => p.pageNumber === PAGE_COUNT),
    );
    expect(windowWithLastPage).toBe(lateWindowIndex);
    expect(sink.windows[lateWindowIndex]?.text).toContain(pageMarker(PAGE_COUNT));

    // Page 150's marker must NOT appear in any earlier window (proves per-window text is bounded to
    // its own pages, not the whole document).
    for (let i = 0; i < lateWindowIndex; i += 1) {
      expect(sink.windows[i]?.text).not.toContain(pageMarker(PAGE_COUNT));
    }

    // The first page's distinct text is recovered too, and the persisted concatenation carries both
    // the earliest and latest page markers — end-to-end real extraction, not a stub.
    const persisted = sink.text();
    expect(persisted).toContain(pageMarker(1));
    expect(persisted).toContain(pageMarker(PAGE_COUNT));
  }, 60000);

  it("aligns each real page's character offsets with the persisted concatenated text", async () => {
    if (!pdfRuntimePresent()) return; // guarded by the fail-closed CI sentinel above

    const bytes = buildMultiPagePdf(PAGE_COUNT, pageMarker);
    const source: ProgressiveExtractionSource = {
      totalBytes: bytes.byteLength,
      loadFullBuffer: () => Promise.resolve(bytes),
    };
    const sink = collectingSink();
    await runProgressiveExtraction(
      createProgressivePdfExtractor(),
      source,
      options(WINDOW_PAGES),
      sink,
    );

    const fullText = sink.text();
    // Spot-check a late page: its document-relative [characterStart, characterEnd) slice of the
    // persisted text equals that page's real decoded marker. Offsets are document-relative and must
    // survive window boundaries, so a late page is the meaningful case.
    const lastPage = sink.windows.flatMap((w) => w.pages).find((p) => p.pageNumber === PAGE_COUNT);
    expect(lastPage).toBeDefined();
    if (lastPage !== undefined) {
      expect(fullText.slice(lastPage.characterStart, lastPage.characterEnd)).toBe(
        pageMarker(PAGE_COUNT),
      );
    }
  }, 60000);
});
