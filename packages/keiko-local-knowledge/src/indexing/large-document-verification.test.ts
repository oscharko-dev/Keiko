// Integration + redaction verification for bounded large-document ingestion (Epic #1160,
// Issue #1286). Drives the real runIndexingJob over a mixed source (small text file + large
// progressive document + unsupported file) and asserts the routing, plus that no absolute path or
// secret leaks into the persisted checkpoint or diagnostics.

import { DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY } from "@oscharko-dev/keiko-contracts";
import type {
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  LargeDocumentResourcePolicy,
} from "@oscharko-dev/keiko-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCapsule } from "../capsule-lifecycle.js";
import { addSourceToCapsule } from "../source-lifecycle.js";
import { freshStore, sampleCapsuleInput } from "../_support.js";
import { createDefaultParserRegistry, syntheticProgressiveExtractor } from "../parsers/index.js";
import { folderScope, memoryFs } from "../discovery/test-support.js";
import { documentIdFor } from "../discovery/types.js";
import type { IndexingEvent } from "./types.js";
import type { KnowledgeStore } from "../store.js";

import { runIndexingJob } from "./orchestrator.js";
import { happyAdapter } from "./_support.js";

const ROOT = "/srv/mixed";

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
const capsuleId = "cap-mixed" as KnowledgeCapsuleId;
const sourceId = "src-mixed" as KnowledgeSourceId;

beforeEach(() => {
  const fresh = freshStore();
  store = fresh.store;
  cleanup = fresh.cleanup;
  createCapsule(store, sampleCapsuleInput({ id: capsuleId }));
  addSourceToCapsule(store, capsuleId, {
    id: sourceId,
    displayName: "mixed",
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
    largeFileThresholdBytes: 64,
    extractionWindowPages: 4,
  };
}

function tableCount(table: string, documentId: string): number {
  const row = store._internal.db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE capsule_id = :c AND document_id = :d`)
    .get({ c: capsuleId, d: documentId }) as { n: number };
  return row.n;
}

describe("mixed-source large-document indexing", () => {
  it("routes small files to the standard path and large files to the bounded path, skipping unsupported", async () => {
    const big = syntheticDoc(12, 24);
    const fs = memoryFs(ROOT, [
      { relativePath: "notes.txt", content: "# Notes\n\nshort document body that stays small." },
      { relativePath: "report.synthetic", content: big },
      { relativePath: "photo.png", content: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]) },
    ]);

    const events = await drain(
      runIndexingJob({
        capsuleId,
        parserRegistry: createDefaultParserRegistry(),
        workspaceFs: fs,
        embeddingAdapter: happyAdapter(),
        store,
        largeDocumentPolicy: policy(),
        progressiveExtractors: [
          syntheticProgressiveExtractor({ totalPages: 12, pageChars: 24, pagesPerWindow: 4 }),
        ],
      }),
    );
    expect(events.some((e) => e.kind === "job-failed")).toBe(false);
    expect(events.some((e) => e.kind === "job-completed")).toBe(true);

    const smallDoc = String(documentIdFor({ capsuleId, sourceId, relativePath: "notes.txt" }));
    const bigDoc = String(documentIdFor({ capsuleId, sourceId, relativePath: "report.synthetic" }));

    // Small file: standard path → single document_texts row, no windows.
    expect(tableCount("document_texts", smallDoc)).toBe(1);
    expect(tableCount("document_text_windows", smallDoc)).toBe(0);
    // Large file: bounded path → windows, no single document_texts row.
    expect(tableCount("document_text_windows", bigDoc)).toBe(3); // 12 pages / 4 per window
    expect(tableCount("document_texts", bigDoc)).toBe(0);
    expect(tableCount("vectors", bigDoc)).toBeGreaterThan(0);
    // Unsupported PNG is skipped, never failing the job.
    expect(events.some((e) => e.kind === "document-skipped")).toBe(true);
  });
});

describe("large-document redaction", () => {
  it("never leaks absolute paths or secrets into checkpoints or diagnostics", async () => {
    const big = syntheticDoc(8, 24);
    const fs = memoryFs(ROOT, [{ relativePath: "secret-report.synthetic", content: big }]);
    await drain(
      runIndexingJob({
        capsuleId,
        parserRegistry: createDefaultParserRegistry(),
        workspaceFs: fs,
        embeddingAdapter: happyAdapter(),
        store,
        largeDocumentPolicy: policy(),
        progressiveExtractors: [
          syntheticProgressiveExtractor({ totalPages: 8, pageChars: 24, pagesPerWindow: 4 }),
        ],
      }),
    );

    const checkpointJson = store._internal.db
      .prepare(
        "SELECT terminal_diagnostics_json AS j, source_content_hash AS h FROM extraction_checkpoints WHERE capsule_id = :c",
      )
      .all({ c: capsuleId }) as unknown as readonly { j: string; h: string }[];
    for (const row of checkpointJson) {
      expect(row.j).not.toContain(ROOT);
      expect(row.j).not.toContain("/srv");
      // The fingerprint stores a content hash, never raw extracted text.
      expect(row.h).toMatch(/^[0-9a-f]+$/u);
    }

    const diagnostics = store._internal.db
      .prepare("SELECT message FROM parser_diagnostics WHERE capsule_id = :c")
      .all({ c: capsuleId }) as unknown as readonly { message: string }[];
    for (const diag of diagnostics) {
      expect(diag.message).not.toContain(ROOT);
      expect(diag.message).not.toContain("/srv");
    }
  });
});
