import { DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY } from "@oscharko-dev/keiko-contracts";
import type {
  DocumentId,
  KnowledgeCapsuleId,
  KnowledgeSource,
  KnowledgeSourceId,
  LargeDocumentResourcePolicy,
} from "@oscharko-dev/keiko-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCapsule } from "../capsule-lifecycle.js";
import { addSourceToCapsule } from "../source-lifecycle.js";
import { freshStore, sampleCapsuleInput } from "../_support.js";
import {
  buildParserOptions,
  createDefaultParserRegistry,
  syntheticProgressiveExtractor,
  type ProgressiveExtractionOptions,
  type ProgressiveExtractionWindow,
  type ProgressiveExtractor,
} from "../parsers/index.js";
import { readDocumentTextSpan } from "./persist.js";
import type { KnowledgeStore } from "../store.js";
import { extractDocument } from "./extract.js";
import { folderScope, memoryFs } from "./test-support.js";
import { documentIdFor } from "./types.js";

const ROOT = "/srv/docs";

interface CountRow {
  readonly n: number;
}

function count(store: KnowledgeStore, table: string, documentId: DocumentId): number {
  const row = store._internal.db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE capsule_id = :c AND document_id = :d`)
    .get({ c: "cap-prog", d: String(documentId) }) as CountRow;
  return row.n;
}

// Synthetic document laid out as `pageChars` ASCII letters per page, separated by "\n\n", matching
// the synthetic extractor's page-byte stride so window byte offsets align with the persisted text.
function syntheticDoc(totalPages: number, pageChars: number): string {
  const pages: string[] = [];
  for (let p = 1; p <= totalPages; p += 1) {
    let s = "";
    for (let k = 0; k < pageChars; k += 1) s += String.fromCharCode(0x41 + ((p + k) % 26));
    pages.push(s);
  }
  return pages.join("\n\n");
}

let store: KnowledgeStore;
let cleanup: () => void;
let source: KnowledgeSource;
const capsuleId = "cap-prog" as KnowledgeCapsuleId;

beforeEach(() => {
  const fresh = freshStore();
  store = fresh.store;
  cleanup = fresh.cleanup;
  createCapsule(store, sampleCapsuleInput({ id: capsuleId }));
  source = addSourceToCapsule(store, capsuleId, {
    id: "src-prog" as KnowledgeSourceId,
    displayName: "docs",
    tags: [],
    scope: folderScope(ROOT),
  });
});

afterEach(() => {
  cleanup();
});

function policy(overrides: Partial<LargeDocumentResourcePolicy> = {}): LargeDocumentResourcePolicy {
  return { ...DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY, largeFileThresholdBytes: 16, ...overrides };
}

describe("extractDocument — progressive large-document path", () => {
  it("extracts a large document in bounded windows with checkpoints and windowed text", async () => {
    const totalPages = 6;
    const pageChars = 8;
    const content = syntheticDoc(totalPages, pageChars);
    const fs = memoryFs(ROOT, [{ relativePath: "big.synthetic", content }]);
    const result = await extractDocument(
      {
        fs,
        store,
        parserRegistry: createDefaultParserRegistry(),
        largeDocumentPolicy: policy(),
        progressiveExtractors: [
          syntheticProgressiveExtractor({ totalPages, pageChars, pagesPerWindow: 2 }),
        ],
        largeDocumentJobId: "job-1",
      },
      { capsuleId, source, file: { relativePath: "big.synthetic", sizeBytes: content.length } },
    );

    expect(result.outcome.kind).toBe("persisted");
    if (result.outcome.kind !== "persisted") return;
    expect(result.outcome.document.status).toBe("extracted");
    expect(result.outcome.document.parser.parserId).toBe("progressive-pdf");

    const documentId = result.outcome.document.id;
    // 6 pages / 2 per window = 3 windows; one parsed_unit per page.
    expect(count(store, "document_text_windows", documentId)).toBe(3);
    expect(count(store, "parsed_units", documentId)).toBe(totalPages);
    expect(count(store, "pages", documentId)).toBe(totalPages);
    // No single document_texts row — the text lives in bounded windows.
    expect(count(store, "document_texts", documentId)).toBe(0);

    const checkpoint = store._internal.db
      .prepare(
        "SELECT phase, coverage, source_content_hash FROM extraction_checkpoints WHERE capsule_id = :c AND document_id = :d",
      )
      .get({ c: capsuleId, d: String(documentId) }) as
      | { phase: string; coverage: string; source_content_hash: string }
      | undefined;
    expect(checkpoint?.phase).toBe("extracted");
    expect(checkpoint?.coverage).toBe("complete");
    expect(checkpoint?.source_content_hash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("reads a page span back through the unified windowed reader", async () => {
    const content = syntheticDoc(4, 8);
    const fs = memoryFs(ROOT, [{ relativePath: "big.synthetic", content }]);
    const result = await extractDocument(
      {
        fs,
        store,
        parserRegistry: createDefaultParserRegistry(),
        largeDocumentPolicy: policy(),
        progressiveExtractors: [
          syntheticProgressiveExtractor({ totalPages: 4, pageChars: 8, pagesPerWindow: 2 }),
        ],
      },
      { capsuleId, source, file: { relativePath: "big.synthetic", sizeBytes: content.length } },
    );
    if (result.outcome.kind !== "persisted") throw new Error("expected persisted");
    const documentId = result.outcome.document.id;
    // page 3 starts at (3-1)*(8+2) = 20, spans 8 chars.
    expect(readDocumentTextSpan(store._internal.db, capsuleId, documentId, 20, 28)).toBe(
      content.slice(20, 28),
    );
  });

  it("re-running an extracted large document hits the unchanged fast-path", async () => {
    const content = syntheticDoc(4, 8);
    const fs = memoryFs(ROOT, [{ relativePath: "big.synthetic", content }]);
    const deps = {
      fs,
      store,
      parserRegistry: createDefaultParserRegistry(),
      largeDocumentPolicy: policy(),
      progressiveExtractors: [
        syntheticProgressiveExtractor({ totalPages: 4, pageChars: 8, pagesPerWindow: 2 }),
      ],
    };
    const params = {
      capsuleId,
      source,
      file: { relativePath: "big.synthetic", sizeBytes: content.length },
    };
    await extractDocument(deps, params);
    const second = await extractDocument(deps, params);
    expect(second.outcome.kind).toBe("skipped");
  });

  it("rejects an oversized file before reading bytes", async () => {
    const content = syntheticDoc(4, 8);
    const fs = memoryFs(ROOT, [{ relativePath: "big.synthetic", content }]);
    const result = await extractDocument(
      {
        fs,
        store,
        parserRegistry: createDefaultParserRegistry(),
        largeDocumentPolicy: policy(),
        progressiveExtractors: [
          syntheticProgressiveExtractor({ totalPages: 4, pageChars: 8, pagesPerWindow: 2 }),
        ],
      },
      {
        capsuleId,
        source,
        file: { relativePath: "big.synthetic", sizeBytes: content.length },
        parserOptions: buildParserOptions({ maxBytes: 4 }),
      },
    );
    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind === "failed") {
      expect(result.outcome.error.code).toBe("OVERSIZED_FILE");
    }
  });

  it("emits a stable CONVERTER_UNAVAILABLE diagnostic for legacy .doc files", async () => {
    const fs = memoryFs(ROOT, [{ relativePath: "old.doc", content: "legacy binary bytes" }]);
    const result = await extractDocument(
      { fs, store, parserRegistry: createDefaultParserRegistry() },
      { capsuleId, source, file: { relativePath: "old.doc", sizeBytes: 19 } },
    );
    expect(result.diagnostics.some((d) => d.code === "CONVERTER_UNAVAILABLE")).toBe(true);
    const documentId = documentIdFor({ capsuleId, sourceId: source.id, relativePath: "old.doc" });
    const row = store._internal.db
      .prepare(
        "SELECT COUNT(*) AS n FROM parser_diagnostics WHERE capsule_id = :c AND document_id = :d AND code = 'CONVERTER_UNAVAILABLE'",
      )
      .get({ c: capsuleId, d: String(documentId) }) as CountRow;
    expect(row.n).toBe(1);
  });
});

// A self-contained extractor that aborts the controller before the second window so the driver
// reports a deterministic cancellation with the first window already persisted.
function makeWindow(
  documentId: DocumentId,
  index: number,
  page: number,
  text: string,
): ProgressiveExtractionWindow {
  const start = index * (text.length + 2);
  return {
    windowIndex: index,
    pages: [
      {
        documentId,
        pageNumber: page,
        pageLabel: String(page),
        characterStart: start,
        characterEnd: start + text.length,
      },
    ],
    units: [
      {
        kind: "page",
        documentId,
        pageNumber: page,
        pageLabel: String(page),
        characterStart: start,
        characterEnd: start + text.length,
      },
    ],
    text: index === 0 ? text : `\n\n${text}`,
    characterStart: start,
    objectCursor: page,
    lastPageNumber: page,
    diagnostics: [],
  };
}

function cancellingExtractor(controller: AbortController): ProgressiveExtractor {
  return {
    strategyId: "progressive-pdf",
    parserVersion: "cancel-test@1",
    matches: (input) => input.extension === "synthetic",
    extractWindows: async function* (
      _source,
      options: ProgressiveExtractionOptions,
    ): AsyncIterable<ProgressiveExtractionWindow> {
      await Promise.resolve();
      yield makeWindow(options.documentId, 0, 1, "AAAAAAAA");
      controller.abort();
      yield makeWindow(options.documentId, 1, 2, "BBBBBBBB");
    },
  };
}

describe("extractDocument — progressive cancellation", () => {
  it("persists partial progress and records a cancelled checkpoint", async () => {
    const content = syntheticDoc(2, 8);
    const fs = memoryFs(ROOT, [{ relativePath: "big.synthetic", content }]);
    const controller = new AbortController();
    const result = await extractDocument(
      {
        fs,
        store,
        parserRegistry: createDefaultParserRegistry(),
        largeDocumentPolicy: policy(),
        progressiveExtractors: [cancellingExtractor(controller)],
      },
      {
        capsuleId,
        source,
        file: { relativePath: "big.synthetic", sizeBytes: content.length },
        parserOptions: buildParserOptions({ signal: controller.signal }),
      },
    );
    expect(result.outcome.kind).toBe("failed");
    const documentId = documentIdFor({
      capsuleId,
      sourceId: source.id,
      relativePath: "big.synthetic",
    });
    // First window persisted before cancellation.
    expect(count(store, "document_text_windows", documentId)).toBe(1);
    const checkpoint = store._internal.db
      .prepare(
        "SELECT phase FROM extraction_checkpoints WHERE capsule_id = :c AND document_id = :d",
      )
      .get({ c: capsuleId, d: String(documentId) }) as { phase: string } | undefined;
    expect(checkpoint?.phase).toBe("cancelled");
  });
});
