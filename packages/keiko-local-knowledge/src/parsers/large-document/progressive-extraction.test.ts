import { DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY } from "@oscharko-dev/keiko-contracts";
import type { DocumentId, LargeDocumentResourcePolicy } from "@oscharko-dev/keiko-contracts";
import { describe, expect, it } from "vitest";

import {
  runProgressiveExtraction,
  syntheticProgressiveExtractor,
  syntheticStreamingSource,
} from "./index.js";
import type { ProgressiveExtractionOptions, ProgressiveExtractionWindow } from "./index.js";

const DOC = "doc-1" as DocumentId;

function expectedPageText(pageNumber: number, pageChars: number): string {
  let out = "";
  for (let k = 0; k < pageChars; k += 1) {
    out += String.fromCharCode(0x41 + ((pageNumber + k) % 26));
  }
  return out;
}

function expectedDocText(totalPages: number, pageChars: number): string {
  const pages: string[] = [];
  for (let p = 1; p <= totalPages; p += 1) pages.push(expectedPageText(p, pageChars));
  return pages.join("\n\n");
}

function options(
  overrides: Partial<ProgressiveExtractionOptions> = {},
  policy: LargeDocumentResourcePolicy = DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY,
): ProgressiveExtractionOptions {
  return {
    documentId: DOC,
    extension: "synthetic",
    mediaType: "application/octet-stream",
    policy,
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

describe("runProgressiveExtraction", () => {
  it("extracts a document in bounded windows whose texts concatenate to the full document", async () => {
    const config = { totalPages: 5, pageChars: 10, pagesPerWindow: 2 };
    const sink = collectingSink();
    const summary = await runProgressiveExtraction(
      syntheticProgressiveExtractor(config),
      syntheticStreamingSource(config),
      options(),
      sink,
    );

    expect(summary.pageCount).toBe(5);
    expect(summary.windowCount).toBe(3);
    expect(summary.coverage).toBe("complete");
    expect(summary.stopReason).toBe("completed");
    // No window holds more than one window's worth of pages.
    for (const w of sink.windows) {
      expect(w.pages.length).toBeLessThanOrEqual(config.pagesPerWindow);
    }
    expect(sink.text()).toBe(expectedDocText(5, 10));
  });

  it("aligns page character offsets with the concatenated persisted text", async () => {
    const config = { totalPages: 4, pageChars: 8, pagesPerWindow: 2 };
    const sink = collectingSink();
    await runProgressiveExtraction(
      syntheticProgressiveExtractor(config),
      syntheticStreamingSource(config),
      options(),
      sink,
    );
    const fullText = sink.text();
    for (const w of sink.windows) {
      for (const page of w.pages) {
        expect(fullText.slice(page.characterStart, page.characterEnd)).toBe(
          expectedPageText(page.pageNumber, config.pageChars),
        );
      }
    }
  });

  it("stops at the extracted-text byte limit with partial coverage and a policy diagnostic", async () => {
    const config = { totalPages: 100, pageChars: 100, pagesPerWindow: 1 };
    const sink = collectingSink();
    const policy: LargeDocumentResourcePolicy = {
      ...DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY,
      maxExtractedTextBytes: 250,
    };
    const summary = await runProgressiveExtraction(
      syntheticProgressiveExtractor(config),
      syntheticStreamingSource(config),
      options({}, policy),
      sink,
    );
    expect(summary.coverage).toBe("partial");
    expect(summary.stopReason).toBe("extracted-text-limit");
    expect(summary.diagnostics.some((d) => d.code === "RESOURCE_POLICY_EXCEEDED")).toBe(true);
    // The over-limit window was not persisted.
    expect(summary.extractedTextBytes).toBeLessThanOrEqual(250);
  });

  it("stops at the parser-unit limit", async () => {
    const config = { totalPages: 50, pageChars: 5, pagesPerWindow: 1 };
    const policy: LargeDocumentResourcePolicy = {
      ...DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY,
      maxParserUnits: 3,
    };
    const summary = await runProgressiveExtraction(
      syntheticProgressiveExtractor(config),
      syntheticStreamingSource(config),
      options({}, policy),
      collectingSink(),
    );
    expect(summary.stopReason).toBe("unit-limit");
    expect(summary.pageCount).toBeLessThanOrEqual(3);
  });

  it("cancels deterministically with partial coverage when the signal is aborted", async () => {
    const config = { totalPages: 20, pageChars: 10, pagesPerWindow: 2 };
    const controller = new AbortController();
    const sink = {
      count: 0,
      onWindow: (): void => {
        sink.count += 1;
        if (sink.count === 2) controller.abort();
      },
    };
    const summary = await runProgressiveExtraction(
      syntheticProgressiveExtractor(config),
      syntheticStreamingSource(config),
      options({ signal: controller.signal }),
      sink,
    );
    expect(summary.stopReason).toBe("cancelled");
    expect(summary.coverage).toBe("partial");
    expect(summary.pageCount).toBeLessThan(40);
  });

  it("resumes from a page cursor and keeps offsets aligned with a full run", async () => {
    const config = { totalPages: 6, pageChars: 7, pagesPerWindow: 2 };
    // Page boundaries: page p ends at characterEnd. After pages 1..2 (each 7 chars + one "\n\n"):
    const endOfPage2 = config.pageChars + 2 + config.pageChars; // 7 + 2 + 7 = 16
    const sink = collectingSink();
    const summary = await runProgressiveExtraction(
      syntheticProgressiveExtractor(config),
      syntheticStreamingSource(config),
      options({ resumeFromPage: 2, resumeCharacterStart: endOfPage2 }),
      sink,
    );
    expect(summary.pageCount).toBe(4); // pages 3..6
    const fullText = expectedDocText(6, config.pageChars);
    for (const w of sink.windows) {
      for (const page of w.pages) {
        expect(fullText.slice(page.characterStart, page.characterEnd)).toBe(
          expectedPageText(page.pageNumber, config.pageChars),
        );
      }
    }
  });

  it("reports no coverage for an empty document", async () => {
    const config = { totalPages: 0, pageChars: 10, pagesPerWindow: 2 };
    const summary = await runProgressiveExtraction(
      syntheticProgressiveExtractor(config),
      syntheticStreamingSource(config),
      options(),
      collectingSink(),
    );
    expect(summary.pageCount).toBe(0);
    expect(summary.coverage).toBe("none");
  });
});

describe("syntheticStreamingSource", () => {
  it("generates deterministic windowed bytes without materializing the whole document", async () => {
    const config = { totalPages: 1024, pageChars: 1024, pagesPerWindow: 8 };
    const source = syntheticStreamingSource(config);
    expect(source.totalBytes).toBe(1024 * (1024 + 2) - 2);
    const a = await source.readWindow?.(0, 16);
    const b = await source.readWindow?.(0, 16);
    expect(a).toEqual(b);
    expect(a?.length).toBe(16);
  });
});
