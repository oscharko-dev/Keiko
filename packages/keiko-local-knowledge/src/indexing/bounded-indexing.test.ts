// Integration tests for the bounded large-document chunk/embed path (Epic #1160, Issue #1286).
// Drives the real runIndexingJob with the synthetic streaming extractor injected, so the document
// takes the progressive page-windowed extraction + bounded chunk/embed pipeline end to end.

import { DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY } from "@oscharko-dev/keiko-contracts";
import type {
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  LargeDocumentResourcePolicy,
} from "@oscharko-dev/keiko-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCapsule } from "../capsule-lifecycle.js";
import { addSourceToCapsule } from "../source-lifecycle.js";
import { DEFAULT_EMBEDDING, freshStore, sampleCapsuleInput } from "../_support.js";
import { createDefaultParserRegistry, syntheticProgressiveExtractor } from "../parsers/index.js";
import { folderScope, memoryFs } from "../discovery/test-support.js";
import { documentIdFor } from "../discovery/types.js";
import type { KnowledgeStore } from "../store.js";

import { runIndexingJob } from "./orchestrator.js";
import { countVectorsForDocument } from "./vector-persist.js";
import { selectExtractionCheckpoint } from "./checkpoint-persist.js";
import { happyAdapter } from "./_support.js";
import type { IndexingEvent, IndexingOptions } from "./types.js";

const ROOT = "/srv/bounded";

function syntheticDoc(totalPages: number, pageChars: number): string {
  const pages: string[] = [];
  for (let p = 1; p <= totalPages; p += 1) {
    let s = "";
    for (let k = 0; k < pageChars; k += 1) s += String.fromCharCode(0x41 + ((p + k) % 26));
    pages.push(s);
  }
  return pages.join("\n\n");
}

async function drain(stream: AsyncIterable<IndexingEvent>): Promise<readonly IndexingEvent[]> {
  const out: IndexingEvent[] = [];
  for await (const evt of stream) out.push(evt);
  return out;
}

let store: KnowledgeStore;
let cleanup: () => void;
const capsuleId = "cap-bounded" as KnowledgeCapsuleId;
const REL = "big.synthetic";

beforeEach(() => {
  const fresh = freshStore();
  store = fresh.store;
  cleanup = fresh.cleanup;
  createCapsule(store, sampleCapsuleInput({ id: capsuleId }));
  addSourceToCapsule(store, capsuleId, {
    id: "src-bounded" as KnowledgeSourceId,
    displayName: "docs",
    tags: [],
    scope: folderScope(ROOT),
  });
});

afterEach(() => {
  cleanup();
});

function policy(): LargeDocumentResourcePolicy {
  return {
    ...DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY,
    largeFileThresholdBytes: 16,
    extractionWindowPages: 2,
  };
}

function options(content: string, overrides: Partial<IndexingOptions> = {}): IndexingOptions {
  return {
    capsuleId,
    parserRegistry: createDefaultParserRegistry(),
    workspaceFs: memoryFs(ROOT, [{ relativePath: REL, content }]),
    embeddingAdapter: happyAdapter(),
    store,
    largeDocumentPolicy: policy(),
    progressiveExtractors: [
      syntheticProgressiveExtractor({ totalPages: 6, pageChars: 12, pagesPerWindow: 2 }),
    ],
    batchSize: 4,
    ...overrides,
  };
}

const documentId = documentIdFor({
  capsuleId,
  sourceId: "src-bounded" as KnowledgeSourceId,
  relativePath: REL,
});

function tableCount(table: "document_text_windows" | "extraction_checkpoints"): number {
  const row = store._internal.db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE capsule_id = :c AND document_id = :d`)
    .get({ c: capsuleId, d: String(documentId) }) as { readonly n: number };
  return row.n;
}

describe("bounded large-document indexing", () => {
  it("extracts, chunks, embeds, and checkpoints a large document end-to-end", async () => {
    const content = syntheticDoc(6, 12);
    const events = await drain(runIndexingJob(options(content)));

    expect(events.some((e) => e.kind === "document-embedded")).toBe(true);
    expect(events.some((e) => e.kind === "job-failed")).toBe(false);
    expect(countVectorsForDocument(store._internal.db, capsuleId, documentId)).toBeGreaterThan(0);

    const checkpoint = selectExtractionCheckpoint(store._internal.db, capsuleId, documentId);
    expect(checkpoint?.phase).toBe("complete");
    expect(checkpoint?.embeddedChunkCursor).toBeGreaterThan(0);
    // Bounded path stores text in windows, never a single document_texts row.
    const docTexts = store._internal.db
      .prepare(
        "SELECT COUNT(*) AS n FROM document_texts WHERE capsule_id = :c AND document_id = :d",
      )
      .get({ c: capsuleId, d: String(documentId) }) as { n: number };
    expect(docTexts.n).toBe(0);
  });

  it("self-heals on a re-run after a vector is removed (resume)", async () => {
    const content = syntheticDoc(6, 12);
    await drain(runIndexingJob(options(content)));
    const before = countVectorsForDocument(store._internal.db, capsuleId, documentId);
    expect(before).toBeGreaterThan(1);

    // Simulate an interrupted embed: drop one vector.
    store._internal.db
      .prepare(
        "DELETE FROM vectors WHERE rowid IN (SELECT rowid FROM vectors WHERE capsule_id = :c AND document_id = :d LIMIT 1)",
      )
      .run({ c: capsuleId, d: String(documentId) });
    expect(countVectorsForDocument(store._internal.db, capsuleId, documentId)).toBe(before - 1);

    const events = await drain(runIndexingJob(options(content)));
    expect(events.some((e) => e.kind === "job-failed")).toBe(false);
    expect(countVectorsForDocument(store._internal.db, capsuleId, documentId)).toBe(before);
  });

  it("restarts an incompatible checkpoint with a CHECKPOINT_INCOMPATIBLE diagnostic", async () => {
    const content = syntheticDoc(6, 12);
    await drain(runIndexingJob(options(content)));

    // Re-run with a different chunking strategy → the persisted checkpoint is incompatible.
    await drain(runIndexingJob(options(content, { chunkingOptions: { maxTokens: 40 } })));

    const diag = store._internal.db
      .prepare(
        "SELECT COUNT(*) AS n FROM parser_diagnostics WHERE capsule_id = :c AND document_id = :d AND code = 'CHECKPOINT_INCOMPATIBLE'",
      )
      .get({ c: capsuleId, d: String(documentId) }) as { n: number };
    expect(diag.n).toBeGreaterThan(0);
    expect(countVectorsForDocument(store._internal.db, capsuleId, documentId)).toBeGreaterThan(0);
  });

  it("uses the configured embedding identity for the bounded vectors", async () => {
    const content = syntheticDoc(4, 12);
    await drain(runIndexingJob(options(content)));
    const row = store._internal.db
      .prepare(
        "SELECT embedding_model_id AS m, vector_dimensions AS d FROM vectors WHERE capsule_id = :c AND document_id = :d LIMIT 1",
      )
      .get({ c: capsuleId, d: String(documentId) }) as { m: string; d: number } | undefined;
    expect(row?.m).toBe(DEFAULT_EMBEDDING.modelId);
    expect(row?.d).toBe(DEFAULT_EMBEDDING.vectorDimensions);
  });

  it("prunes large-document windows and checkpoints when the source file is removed", async () => {
    const content = syntheticDoc(4, 12);
    await drain(runIndexingJob(options(content)));
    expect(tableCount("document_text_windows")).toBeGreaterThan(0);
    expect(tableCount("extraction_checkpoints")).toBe(1);

    await drain(runIndexingJob({ ...options(content), workspaceFs: memoryFs(ROOT, []) }));

    expect(tableCount("document_text_windows")).toBe(0);
    expect(tableCount("extraction_checkpoints")).toBe(0);
  });

  it("fails with a controlled checkpoint when the chunk count policy is exceeded", async () => {
    const content = syntheticDoc(6, 12);
    const events = await drain(
      runIndexingJob(options(content, { largeDocumentPolicy: { ...policy(), maxChunkCount: 1 } })),
    );

    const failure = events.find((event) => event.kind === "document-failed");
    expect(failure).toMatchObject({
      kind: "document-failed",
      error: { code: "RESOURCE_POLICY_EXCEEDED" },
    });
    const checkpoint = selectExtractionCheckpoint(store._internal.db, capsuleId, documentId);
    expect(checkpoint?.phase).toBe("failed");
    expect(checkpoint?.terminalDiagnostics[0]?.code).toBe("RESOURCE_POLICY_EXCEEDED");
  });

  it("fails with a controlled checkpoint when the embedding batch policy is exceeded", async () => {
    const content = syntheticDoc(6, 12);
    const events = await drain(
      runIndexingJob(
        options(content, {
          batchSize: 1,
          largeDocumentPolicy: { ...policy(), maxEmbeddingBatchCount: 1 },
        }),
      ),
    );

    const failure = events.find((event) => event.kind === "document-failed");
    expect(failure).toMatchObject({
      kind: "document-failed",
      error: { code: "RESOURCE_POLICY_EXCEEDED" },
    });
    const checkpoint = selectExtractionCheckpoint(store._internal.db, capsuleId, documentId);
    expect(checkpoint?.phase).toBe("failed");
    expect(checkpoint?.embeddedChunkCursor).toBe(1);
    expect(checkpoint?.terminalDiagnostics[0]?.code).toBe("RESOURCE_POLICY_EXCEEDED");
  });
});
