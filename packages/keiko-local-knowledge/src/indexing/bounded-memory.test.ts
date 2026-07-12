// Performance / memory profile for the bounded large-document pipeline (Epic #1160, Issue #1286).
//
// Drives the fully-streamed path — synthetic streaming source → progressive extraction → bounded
// chunk → bounded embed — where the source generates bytes per window and is NEVER held whole (this
// is the path the issue's "deterministic synthetic streaming fixture" allows in place of a 1 GiB
// binary). The proof is deterministic rather than GC-timing dependent: it instruments the largest
// byte window read and the largest text row held, and asserts both stay bounded by the window
// configuration (independent of document size) while persisted storage grows linearly.

import type {
  DocumentId,
  EmbeddingModelIdentity,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCapsule } from "../capsule-lifecycle.js";
import { addSourceToCapsule } from "../source-lifecycle.js";
import { freshStore, sampleCapsuleInput } from "../_support.js";
import {
  runProgressiveExtraction,
  syntheticProgressiveExtractor,
  syntheticStreamingSource,
  type ProgressiveExtractionSource,
  type SyntheticStreamingConfig,
} from "../parsers/index.js";
import {
  insertDocumentRow,
  insertDocumentTextWindowRow,
  insertPageRow,
  insertParsedUnitRow,
} from "../discovery/persist.js";
import { documentIdFor } from "../discovery/types.js";
import type { KnowledgeStore } from "../store.js";

import { chunkDocumentBounded, embedDocumentChunksBounded } from "./bounded-indexing.js";
import { happyAdapter } from "./_support.js";

const PERF_IDENTITY: EmbeddingModelIdentity = {
  provider: "perf",
  modelId: "perf-embed",
  vectorDimensions: 8,
  vectorMetric: "cosine",
};

let store: KnowledgeStore;
let cleanup: () => void;
const capsuleId = "cap-perf" as KnowledgeCapsuleId;
const sourceId = "src-perf" as KnowledgeSourceId;

beforeEach(() => {
  const fresh = freshStore();
  store = fresh.store;
  cleanup = fresh.cleanup;
  createCapsule(
    store,
    sampleCapsuleInput({ id: capsuleId, embeddingModelIdentity: PERF_IDENTITY }),
  );
  addSourceToCapsule(store, capsuleId, {
    id: sourceId,
    displayName: "perf",
    tags: [],
    scope: { kind: "folder", rootPath: "/srv/perf", recursive: true },
  });
});

afterEach(() => {
  cleanup();
});

function documentId(relativePath: string): DocumentId {
  return documentIdFor({ capsuleId, sourceId, relativePath });
}

// Wraps the streaming source to record the largest single byte window it is ever asked to read —
// the peak raw-byte working set of extraction.
function instrumentedSource(config: SyntheticStreamingConfig): {
  readonly source: ProgressiveExtractionSource;
  maxReadBytes: () => number;
} {
  const inner = syntheticStreamingSource(config);
  let peak = 0;
  return {
    source: {
      totalBytes: inner.totalBytes,
      readWindow: (start, len): Promise<Uint8Array> => {
        peak = Math.max(peak, len);
        return inner.readWindow?.(start, len) ?? Promise.resolve(new Uint8Array(0));
      },
    },
    maxReadBytes: () => peak,
  };
}

interface BoundedRun {
  readonly docId: DocumentId;
  readonly maxReadBytes: number;
  readonly maxWindowChars: number;
}

async function streamBounded(
  relativePath: string,
  config: SyntheticStreamingConfig,
): Promise<BoundedRun> {
  const docId = documentId(relativePath);
  const db = store._internal.db;
  insertDocumentRow(db, {
    id: docId,
    capsuleId,
    sourceId: String(sourceId),
    documentPath: relativePath,
    sizeBytes: config.totalPages * config.pageChars,
    mediaType: "application/octet-stream",
    contentHash: "perf",
    parserId: "progressive-pdf",
    parserVersion: "synthetic@1",
    lastExtractedAt: 1,
    status: "pending",
    safeDisplayName: relativePath,
  });
  const probe = instrumentedSource(config);
  let unitIndex = 0;
  let maxWindowChars = 0;
  await runProgressiveExtraction(
    syntheticProgressiveExtractor(config),
    probe.source,
    {
      documentId: docId,
      extension: "synthetic",
      mediaType: "application/octet-stream",
      policy: {
        maxRawFileBytes: 2 ** 40,
        maxExtractedTextBytes: 2 ** 40,
        maxParserUnits: 10_000_000,
        maxParserObjects: 2 ** 40,
        maxChunkCount: 10_000_000,
        maxEmbeddingBatchCount: 10_000_000,
        maxWallClockMs: 600_000,
        cancellationDeadlineMs: 15_000,
        maxRetryCount: 3,
        maxPersistedStorageGrowthBytes: 2 ** 40,
        largeFileThresholdBytes: 1,
        extractionWindowPages: config.pagesPerWindow,
      },
      now: () => 0,
    },
    {
      onWindow: (window): void => {
        maxWindowChars = Math.max(maxWindowChars, window.text.length);
        db.exec("BEGIN");
        try {
          for (const page of window.pages) insertPageRow(db, capsuleId, page);
          for (const unit of window.units) {
            insertParsedUnitRow(
              db,
              store._internal.contentCipher,
              capsuleId,
              `${String(docId)}#u${String(unitIndex)}`,
              unit,
            );
            unitIndex += 1;
          }
          insertDocumentTextWindowRow(db, store._internal.contentCipher, {
            capsuleId,
            documentId: docId,
            windowIndex: window.windowIndex,
            characterStart: window.characterStart,
            characterEnd: window.characterStart + window.text.length,
            normalizedText: window.text,
          });
          db.exec("COMMIT");
        } catch (cause) {
          db.exec("ROLLBACK");
          throw cause;
        }
      },
    },
  );
  chunkDocumentBounded(
    store,
    { capsuleId, sourceId, documentId: docId },
    { maxTokens: 4000 },
    undefined,
  );
  let n = 0;
  await embedDocumentChunksBounded({
    store,
    capsuleId,
    documentId: docId,
    adapter: happyAdapter(PERF_IDENTITY),
    identity: PERF_IDENTITY,
    batchSize: 64,
    concurrency: 4,
    now: () => 0,
    idSource: () => `vec-${String((n += 1))}`,
  });
  return { docId, maxReadBytes: probe.maxReadBytes(), maxWindowChars };
}

function windowCount(docId: DocumentId): number {
  const row = store._internal.db
    .prepare(
      "SELECT COUNT(*) AS n FROM document_text_windows WHERE capsule_id = :c AND document_id = :d",
    )
    .get({ c: capsuleId, d: String(docId) }) as { n: number };
  return row.n;
}

function vectorCount(docId: DocumentId): number {
  const row = store._internal.db
    .prepare("SELECT COUNT(*) AS n FROM vectors WHERE capsule_id = :c AND document_id = :d")
    .get({ c: capsuleId, d: String(docId) }) as { n: number };
  return row.n;
}

describe("bounded large-document memory + storage profile", () => {
  it("bounds the working set to one window regardless of document size", async () => {
    const small = await streamBounded("small.synthetic", {
      totalPages: 128,
      pageChars: 1024,
      pagesPerWindow: 16,
    });
    const large = await streamBounded("large.synthetic", {
      totalPages: 1024,
      pageChars: 1024,
      pagesPerWindow: 16,
    });

    // The document is fully indexed in both cases.
    expect(vectorCount(small.docId)).toBeGreaterThan(0);
    expect(vectorCount(large.docId)).toBeGreaterThan(0);

    // Peak raw-byte read and peak text row are identical across an 8x size difference: the working
    // set is O(window), not O(document).
    const windowTextCeiling = 16 * 1024 + 64; // pagesPerWindow * pageChars + separators
    expect(small.maxReadBytes).toBe(large.maxReadBytes);
    expect(large.maxReadBytes).toBeLessThanOrEqual(1024);
    expect(small.maxWindowChars).toBe(large.maxWindowChars);
    expect(large.maxWindowChars).toBeLessThan(windowTextCeiling);
  }, 60_000);

  it("stores text as bounded per-window rows that grow linearly, never one giant column", async () => {
    const a = await streamBounded("a.synthetic", {
      totalPages: 256,
      pageChars: 1024,
      pagesPerWindow: 16,
    });
    const b = await streamBounded("b.synthetic", {
      totalPages: 512,
      pageChars: 1024,
      pagesPerWindow: 16,
    });

    // 256/16 = 16 windows; 512/16 = 32 windows → linear in document size.
    expect(windowCount(a.docId)).toBe(16);
    expect(windowCount(b.docId)).toBe(32);

    // No single document_texts row was written for the large documents.
    const docTexts = store._internal.db
      .prepare("SELECT COUNT(*) AS n FROM document_texts WHERE capsule_id = :c")
      .get({ c: capsuleId }) as { n: number };
    expect(docTexts.n).toBe(0);
  });
});
