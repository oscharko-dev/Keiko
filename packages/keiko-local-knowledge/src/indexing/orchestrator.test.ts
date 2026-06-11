// Integration tests for `runIndexingJob` (Epic #189, Issue #196). Each test composes the
// real #194 discovery + #195 chunking + the orchestrator's embedding step against a
// scripted OpenAIEmbeddingAdapter — never the real network.
//
// The orchestrator publishes a discriminated AsyncIterable of IndexingEvent; these tests
// drain the stream into an array and assert on the sequence/structure of events as the
// contract surface, with side-effect assertions on `vectors` / `indexing_jobs` rows.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  EmbeddingModelIdentity,
  KnowledgeCapsuleId,
  KnowledgeSource,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import type { OpenAIEmbeddingOutcome } from "@oscharko-dev/keiko-model-gateway";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";

import { createCapsule, getCapsule } from "../capsule-lifecycle.js";
import {
  createDefaultParserRegistry,
  createParserRegistry,
  registerParser,
  type ParserAdapter,
  type ParserOptions,
  type ParserSelectionInput,
} from "../parsers/index.js";
import { PDF_TEXT_LAYER } from "../parsers/parser-test-fixtures.js";
import { readExistingDocumentRow } from "../discovery/persist.js";
import { addSourceToCapsule } from "../source-lifecycle.js";
import { DEFAULT_EMBEDDING, freshStore, sampleCapsuleInput } from "../_support.js";
import { folderScope, memoryFs } from "../discovery/test-support.js";
import { documentIdFor } from "../discovery/types.js";

import { runIndexingJob } from "./orchestrator.js";
import { selectJobById, rowToIndexingJobRecord } from "./job-persist.js";
import {
  countVectorsForCapsule,
  countVectorsForDocument,
  selectChunksForDocument,
} from "./vector-persist.js";
import { deterministicVector, happyAdapter, scriptedAdapter } from "./_support.js";
import type { IndexingEvent, IndexingOptions } from "./types.js";
import type { KnowledgeStore } from "../store.js";

const ROOT = "/srv/orchestrator";

type FixtureFiles = Record<string, string | Uint8Array>;

interface Fixture {
  readonly store: KnowledgeStore;
  readonly cleanup: () => void;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly source: KnowledgeSource;
  readonly fs: WorkspaceFs;
}

function buildFixture(
  files: FixtureFiles,
  identity: EmbeddingModelIdentity = DEFAULT_EMBEDDING,
): Fixture {
  const { store, cleanup } = freshStore();
  const capsuleId = "cap-orch" as KnowledgeCapsuleId;
  const sourceId = "src-orch" as KnowledgeSourceId;
  createCapsule(store, sampleCapsuleInput({ id: capsuleId, embeddingModelIdentity: identity }));
  const source = addSourceToCapsule(store, capsuleId, {
    id: sourceId,
    displayName: "orch",
    tags: [],
    scope: folderScope(ROOT, { recursive: true }),
  });
  const fs = memoryFs(
    ROOT,
    Object.entries(files).map(([relativePath, content]) => ({ relativePath, content })),
  );
  return { store, cleanup, capsuleId, sourceId, source, fs };
}

function buildTwoSourceFixture(): Fixture & { readonly otherSourceId: KnowledgeSourceId } {
  const { store, cleanup } = freshStore();
  const capsuleId = "cap-orch" as KnowledgeCapsuleId;
  const sourceId = "src-orch" as KnowledgeSourceId;
  createCapsule(store, sampleCapsuleInput({ id: capsuleId }));
  const source = addSourceToCapsule(store, capsuleId, {
    id: sourceId,
    displayName: "alpha",
    tags: [],
    scope: { kind: "files", rootPath: ROOT, files: ["alpha.txt"] },
  });
  const otherSourceId = "src-other" as KnowledgeSourceId;
  addSourceToCapsule(store, capsuleId, {
    id: otherSourceId,
    displayName: "beta",
    tags: [],
    scope: { kind: "files", rootPath: ROOT, files: ["beta.txt"] },
  });
  const fs = memoryFs(ROOT, [
    { relativePath: "alpha.txt", content: "Alpha source text. ".repeat(64) },
    { relativePath: "beta.txt", content: "Beta source text. ".repeat(64) },
  ]);
  return { store, cleanup, capsuleId, sourceId, source, fs, otherSourceId };
}

async function drain(stream: AsyncIterable<IndexingEvent>): Promise<readonly IndexingEvent[]> {
  const out: IndexingEvent[] = [];
  for await (const evt of stream) out.push(evt);
  return out;
}

function buildOptions(fixture: Fixture, overrides: Partial<IndexingOptions> = {}): IndexingOptions {
  const base: IndexingOptions = {
    capsuleId: fixture.capsuleId,
    parserRegistry: createDefaultParserRegistry(),
    workspaceFs: fixture.fs,
    embeddingAdapter: happyAdapter(),
    store: fixture.store,
  };
  return { ...base, ...overrides };
}

function countVectorsForSource(fixture: Fixture, sourceId: KnowledgeSourceId): number {
  const row = fixture.store._internal.db
    .prepare("SELECT COUNT(*) AS n FROM vectors WHERE capsule_id = :c AND source_id = :s")
    .get({ c: fixture.capsuleId, s: sourceId }) as { readonly n: number };
  return row.n;
}

describe("runIndexingJob — source preconditions", () => {
  it("rejects capsules without attached sources before creating an indexing job", async () => {
    const { store, cleanup } = freshStore();
    const capsuleId = "cap-empty" as KnowledgeCapsuleId;
    createCapsule(store, sampleCapsuleInput({ id: capsuleId }));

    try {
      await expect(
        drain(
          runIndexingJob({
            capsuleId,
            parserRegistry: createDefaultParserRegistry(),
            workspaceFs: memoryFs(ROOT, []),
            embeddingAdapter: happyAdapter(),
            store,
          }),
        ),
      ).rejects.toMatchObject({ code: "INVALID_OPTIONS" });

      const jobs = store._internal.db
        .prepare("SELECT COUNT(*) AS n FROM indexing_jobs WHERE capsule_id = :c")
        .get({ c: capsuleId }) as { readonly n: number };
      expect(jobs.n).toBe(0);
      expect(getCapsule(store, capsuleId)?.lifecycleState).toBe("draft");
    } finally {
      cleanup();
    }
  });

  it("rejects a sourceIds filter that does not match attached capsule sources", async () => {
    const fixture = buildFixture({ "alpha.txt": "alpha" });

    try {
      await expect(
        drain(
          runIndexingJob(
            buildOptions(fixture, { sourceIds: ["src-missing" as KnowledgeSourceId] }),
          ),
        ),
      ).rejects.toMatchObject({ code: "INVALID_OPTIONS" });

      const jobs = fixture.store._internal.db
        .prepare("SELECT COUNT(*) AS n FROM indexing_jobs WHERE capsule_id = :c")
        .get({ c: fixture.capsuleId }) as { readonly n: number };
      expect(jobs.n).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });
});

// ─── Epic #189 audit: per-chunk embedding spans ──────────────────────────────
// A plain-text file emits a single section parsed unit spanning the whole document, which the
// chunker then splits into multiple chunks. Each chunk must embed its OWN character sub-span,
// not the full parsed-unit span. Before schema v8 persisted per-chunk offsets the orchestrator
// re-derived the unit span for every chunk, so each chunk of a multi-chunk unit embedded an
// identical, duplicate vector and an unbounded embedding input (a dense PDF/manual page). This
// guard pins the chunk-level projection.
describe("runIndexingJob — per-chunk embedding spans (Epic #189 audit)", () => {
  it("embeds each chunk's own sub-span, not the duplicated full parsed-unit text", async () => {
    const sourceText = Array.from(
      { length: 300 },
      (_unused, i) =>
        `Sentence number ${String(i)} documents the unique topic ${String(i)} in depth.`,
    ).join(" ");
    const fixture = buildFixture({ "manual.txt": sourceText });
    try {
      const inputs: string[] = [];
      const adapter = scriptedAdapter({
        responder: (req) => {
          inputs.push(req.input);
          return {
            ok: true,
            value: {
              vector: deterministicVector(req.input, DEFAULT_EMBEDDING.vectorDimensions),
              modelId: DEFAULT_EMBEDDING.modelId,
            },
          };
        },
      });

      const events = await drain(
        runIndexingJob(buildOptions(fixture, { embeddingAdapter: adapter })),
      );
      expect(events.some((event) => event.kind === "document-embedded")).toBe(true);
      expect(events.some((event) => event.kind === "job-failed")).toBe(false);

      // The single large unit must have split into multiple chunks.
      expect(inputs.length).toBeGreaterThan(1);
      // Each chunk embeds a distinct sub-span; pre-fix every input was the identical full text.
      expect(new Set(inputs).size).toBe(inputs.length);
      // No chunk embeds the whole document — each input is a bounded slice strictly shorter.
      for (const input of inputs) {
        expect(input.length).toBeLessThan(sourceText.length);
      }
    } finally {
      fixture.cleanup();
    }
  });
});

// ─── Test 1: full happy path ─────────────────────────────────────────────────
describe("runIndexingJob — happy path", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = buildFixture({
      "alpha.txt": "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(8),
      "beta.txt": "Pack my box with five dozen liquor jugs. ".repeat(8),
      "gamma.txt": "The quick brown fox jumps over the lazy dog. ".repeat(8),
    });
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("emits the full event sequence and produces vectors for every chunk", async () => {
    const events = await drain(runIndexingJob(buildOptions(fixture)));

    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe("job-started");
    expect(kinds.at(-1)).toBe("job-completed");
    expect(kinds.filter((k) => k === "document-discovered").length).toBe(3);
    expect(kinds.filter((k) => k === "document-extracted").length).toBe(3);
    expect(kinds.filter((k) => k === "document-chunked").length).toBe(3);
    expect(kinds.filter((k) => k === "document-embedded").length).toBe(3);
    expect(kinds.includes("document-failed")).toBe(false);
    expect(kinds.includes("job-failed")).toBe(false);

    const vectorCount = countVectorsForCapsule(fixture.store._internal.db, fixture.capsuleId);
    expect(vectorCount).toBeGreaterThan(0);

    const completed = events.find((e) => e.kind === "job-completed");
    expect(completed).toBeDefined();
    if (completed?.kind === "job-completed") {
      expect(completed.result.status).toBe("succeeded");
      expect(completed.result.processedDocuments).toBe(3);
      expect(completed.result.vectorsPersisted).toBe(vectorCount);
    }
  });

  it("persists an indexing_jobs row in `succeeded` state", async () => {
    const events = await drain(runIndexingJob(buildOptions(fixture)));
    const started = events.find((e) => e.kind === "job-started");
    if (started?.kind !== "job-started") throw new Error("missing job-started");
    const row = selectJobById(fixture.store._internal.db, started.jobId);
    expect(row).toBeDefined();
    if (row === undefined) throw new Error("row missing");
    const record = rowToIndexingJobRecord(row);
    expect(record.status).toBe("succeeded");
    expect(record.processedDocuments).toBe(3);
    expect(record.finishedAt).toBeDefined();
  });

  it("embeds text documents from persisted extraction text without a second raw file read", async () => {
    const inputs: string[] = [];
    const fsNoUtf8: WorkspaceFs = {
      ...fixture.fs,
      readFileUtf8: (absolutePath: string): string => {
        throw new Error(`unexpected raw text reread: ${absolutePath}`);
      },
    };
    const adapter = scriptedAdapter({
      responder: (req) => {
        inputs.push(req.input);
        return {
          ok: true,
          value: {
            vector: deterministicVector(req.input, DEFAULT_EMBEDDING.vectorDimensions),
            modelId: DEFAULT_EMBEDDING.modelId,
          },
        };
      },
    });

    const events = await drain(
      runIndexingJob(buildOptions(fixture, { workspaceFs: fsNoUtf8, embeddingAdapter: adapter })),
    );

    expect(events.some((event) => event.kind === "document-embedded")).toBe(true);
    expect(inputs.join("\n")).toContain("Lorem ipsum");
  });

  it("persists a fixed safe message when fallback source-text reads fail", async () => {
    const single = buildFixture({ "alpha.custom": "alpha beta gamma" });
    const privatePath = "/Users/victim/private/alpha.custom";
    const parser: ParserAdapter = Object.freeze({
      capability: Object.freeze({
        parserId: "custom-section",
        parserVersion: "1",
        matches: (input: ParserSelectionInput) => input.extension === "custom",
      }),
      parse: (input: ParserSelectionInput, options: ParserOptions) => {
        const sectionPath: readonly string[] = [];
        return {
          documentId: input.documentId,
          parser: { parserId: "custom-section", parserVersion: "1" },
          pages: [],
          sections: [
            {
              documentId: input.documentId,
              sectionPath,
              characterStart: 0,
              characterEnd: input.bytes.byteLength,
            },
          ],
          units: [
            {
              kind: "section" as const,
              documentId: input.documentId,
              sectionPath,
              characterStart: 0,
              characterEnd: input.bytes.byteLength,
            },
          ],
          diagnostics: [],
          extractedAt: options.now(),
        };
      },
    });
    let registry = createParserRegistry();
    registry = registerParser(registry, parser);
    const failingFs: WorkspaceFs = {
      ...single.fs,
      readFileUtf8: (absolutePath: string): string => {
        throw new Error(`EACCES: ${privatePath} while reading ${absolutePath}`);
      },
    };

    try {
      const events = await drain(
        runIndexingJob(
          buildOptions(single, {
            workspaceFs: failingFs,
            parserRegistry: registry,
            idSource: () => "job-source-read",
          }),
        ),
      );

      const failed = events.find((event) => event.kind === "document-failed");
      expect(failed?.kind).toBe("document-failed");
      if (failed?.kind === "document-failed") {
        expect(failed.error).toStrictEqual({
          code: "CHUNKING_FAILED",
          message: "document chunking failed",
        });
      }
      const row = selectJobById(single.store._internal.db, "job-source-read");
      expect(row?.last_error_message).toBe("document chunking failed");
      expect(row?.last_error_message).not.toContain(privatePath);
      expect(row?.last_error_message).not.toContain(ROOT);
    } finally {
      single.cleanup();
    }
  });

  it("persists live job counters while discovery and embedding are still in progress", async () => {
    const single = buildFixture({
      "alpha.txt": "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(8),
    });
    const snapshots: {
      readonly kind: string;
      readonly total: number;
      readonly processed: number;
      readonly skipped: number;
      readonly failed: number;
    }[] = [];
    let jobId: string | undefined;

    try {
      await drain(
        runIndexingJob(
          buildOptions(single, {
            progress: (event) => {
              if (event.kind === "job-started") {
                jobId = event.jobId;
                return;
              }
              if (
                jobId === undefined ||
                (event.kind !== "document-discovered" && event.kind !== "document-embedded")
              ) {
                return;
              }
              const row = selectJobById(single.store._internal.db, jobId);
              if (row === undefined) {
                throw new Error("missing indexing job row");
              }
              snapshots.push({
                kind: event.kind,
                total: row.total_documents,
                processed: row.processed_documents,
                skipped: row.skipped_documents,
                failed: row.failed_documents,
              });
            },
          }),
        ),
      );
    } finally {
      single.cleanup();
    }

    expect(
      snapshots.some(
        (snapshot) =>
          snapshot.kind === "document-discovered" &&
          snapshot.total === 1 &&
          snapshot.processed === 0 &&
          snapshot.failed === 0 &&
          snapshot.skipped === 0,
      ),
    ).toBe(true);
    expect(
      snapshots.some(
        (snapshot) =>
          snapshot.kind === "document-embedded" &&
          snapshot.total === 1 &&
          snapshot.processed === 1 &&
          snapshot.failed === 0 &&
          snapshot.skipped === 0,
      ),
    ).toBe(true);
  });

  it("emits extraction and chunking progress before the first real embedding request", async () => {
    const single = buildFixture({
      "alpha.txt": "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(80),
    });
    const seen: string[] = [];
    let kindsBeforeFirstChunkEmbedding: readonly string[] | undefined;
    const adapter = scriptedAdapter({
      responder: (req) => {
        if (req.input !== "ping" && kindsBeforeFirstChunkEmbedding === undefined) {
          kindsBeforeFirstChunkEmbedding = [...seen];
        }
        return {
          ok: true,
          value: {
            vector: deterministicVector(req.input, DEFAULT_EMBEDDING.vectorDimensions),
            modelId: DEFAULT_EMBEDDING.modelId,
          },
        };
      },
    });

    try {
      await drain(
        runIndexingJob(
          buildOptions(single, {
            embeddingAdapter: adapter,
            progress: (event) => {
              seen.push(event.kind);
            },
          }),
        ),
      );
    } finally {
      single.cleanup();
    }

    expect(kindsBeforeFirstChunkEmbedding).toContain("document-extracted");
    expect(kindsBeforeFirstChunkEmbedding).toContain("document-chunked");
    expect(kindsBeforeFirstChunkEmbedding).not.toContain("document-embedded");
  });
});

// ─── Test 2: cancellation mid-pipeline ───────────────────────────────────────
describe("runIndexingJob — cancellation", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = buildFixture({
      "a.txt": "A".repeat(2_000),
      "b.txt": "B".repeat(2_000),
      "c.txt": "C".repeat(2_000),
    });
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("emits job-cancelled and marks the job row as cancelled when aborted mid-pipeline", async () => {
    const controller = new AbortController();
    const adapter = scriptedAdapter({
      responder: (req) => {
        // Trip the abort on the first embedding call so subsequent batches see signal.aborted.
        controller.abort();
        return {
          ok: true,
          value: {
            vector: deterministicVector(req.input, DEFAULT_EMBEDDING.vectorDimensions),
            modelId: DEFAULT_EMBEDDING.modelId,
          },
        };
      },
    });

    const events = await drain(
      runIndexingJob(
        buildOptions(fixture, { embeddingAdapter: adapter, signal: controller.signal }),
      ),
    );

    const terminal = events.at(-1);
    expect(terminal?.kind).toBe("job-cancelled");
    if (terminal?.kind === "job-cancelled") {
      expect(terminal.result.status).toBe("cancelled");
    }
    expect(events.some((event) => event.kind === "document-embedded")).toBe(false);
    const started = events.find((e) => e.kind === "job-started");
    if (started?.kind !== "job-started") throw new Error("missing job-started");
    const row = selectJobById(fixture.store._internal.db, started.jobId);
    if (row === undefined) throw new Error("row missing");
    expect(rowToIndexingJobRecord(row).status).toBe("cancelled");
  });
});

// ─── Test 3: incremental (second pass) ───────────────────────────────────────
describe("runIndexingJob — incremental", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = buildFixture({
      "alpha.txt": "Lorem ipsum dolor sit amet. ".repeat(8),
      "beta.txt": "Pack my box. ".repeat(8),
    });
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("does not re-embed on the second pass when files are unchanged", async () => {
    const firstEvents = await drain(runIndexingJob(buildOptions(fixture)));
    const firstVectors = countVectorsForCapsule(fixture.store._internal.db, fixture.capsuleId);
    expect(firstVectors).toBeGreaterThan(0);
    const embeddedFirstPass = firstEvents.filter((e) => e.kind === "document-embedded").length;
    expect(embeddedFirstPass).toBe(2);

    const secondEvents = await drain(runIndexingJob(buildOptions(fixture)));
    const secondVectors = countVectorsForCapsule(fixture.store._internal.db, fixture.capsuleId);
    expect(secondVectors).toBe(firstVectors);
    // The discovery layer's content-hash compare fires `skipped/unchanged`, OR — when the
    // documents row already has chunks+vectors — the orchestrator's own already-embedded
    // fast path fires. Either way: no new document-embedded events.
    const embeddedSecondPass = secondEvents.filter((e) => e.kind === "document-embedded").length;
    expect(embeddedSecondPass).toBe(0);
    expect(secondEvents.filter((e) => e.kind === "document-skipped").length).toBe(2);
  });

  it("re-embeds unchanged files when existing chunks are marked stale by strategy version", async () => {
    await drain(runIndexingJob(buildOptions(fixture)));
    fixture.store._internal.db
      .prepare("UPDATE chunks SET chunking_strategy_version = NULL WHERE capsule_id = :c")
      .run({ c: fixture.capsuleId });

    const secondEvents = await drain(runIndexingJob(buildOptions(fixture)));
    expect(secondEvents.filter((e) => e.kind === "document-embedded").length).toBe(2);
    expect(
      secondEvents.some((e) => e.kind === "document-skipped" && e.reason === "already-embedded"),
    ).toBe(false);
  });

  it("removes persisted rows for files deleted from the source on the next clean pass", async () => {
    await drain(runIndexingJob(buildOptions(fixture)));
    const deletedDocumentId = documentIdFor({
      capsuleId: fixture.capsuleId,
      sourceId: fixture.sourceId,
      relativePath: "beta.txt",
    });

    const secondEvents = await drain(
      runIndexingJob(
        buildOptions(fixture, {
          workspaceFs: memoryFs(ROOT, [
            { relativePath: "alpha.txt", content: fixture.fs.readFileUtf8(`${ROOT}/alpha.txt`) },
          ]),
        }),
      ),
    );

    expect(secondEvents.filter((e) => e.kind === "document-discovered").length).toBe(1);
    expect(secondEvents.filter((e) => e.kind === "document-skipped").length).toBe(1);
    expect(
      readExistingDocumentRow(fixture.store._internal.db, fixture.capsuleId, deletedDocumentId),
    ).toBeUndefined();
    expect(countVectorsForCapsule(fixture.store._internal.db, fixture.capsuleId)).toBeGreaterThan(
      0,
    );
    const remainingDocuments = fixture.store._internal.db
      .prepare("SELECT COUNT(*) AS n FROM documents WHERE capsule_id = :c")
      .get({ c: fixture.capsuleId }) as { readonly n: number };
    expect(remainingDocuments.n).toBe(1);
  });

  it("keeps persisted rows when a bounded discovery pass reaches the file cap", async () => {
    await drain(runIndexingJob(buildOptions(fixture)));
    const cappedOutDocumentId = documentIdFor({
      capsuleId: fixture.capsuleId,
      sourceId: fixture.sourceId,
      relativePath: "beta.txt",
    });

    const secondEvents = await drain(
      runIndexingJob(
        buildOptions(fixture, {
          discoveryOptions: { maxDepth: 12, maxFiles: 1 },
        }),
      ),
    );

    expect(secondEvents.filter((e) => e.kind === "document-discovered").length).toBe(1);
    expect(
      readExistingDocumentRow(fixture.store._internal.db, fixture.capsuleId, cappedOutDocumentId),
    ).toBeDefined();
    const remainingDocuments = fixture.store._internal.db
      .prepare("SELECT COUNT(*) AS n FROM documents WHERE capsule_id = :c")
      .get({ c: fixture.capsuleId }) as { readonly n: number };
    expect(remainingDocuments.n).toBe(2);
  });

  it("re-embeds unchanged documents when persisted vector coverage is partial", async () => {
    const single = buildFixture({
      "alpha.txt": "Partial vector recovery sentence. ".repeat(240),
    });
    const documentId = documentIdFor({
      capsuleId: single.capsuleId,
      sourceId: single.sourceId,
      relativePath: "alpha.txt",
    });
    const chunkingOptions = { maxTokens: 10, minTokens: 0, overlapTokens: 0 };

    try {
      await drain(runIndexingJob(buildOptions(single, { chunkingOptions })));
      const chunks = selectChunksForDocument(
        single.store._internal.db,
        single.capsuleId,
        documentId,
      );
      expect(chunks.length).toBeGreaterThan(1);
      const removedChunk = chunks[0];
      if (removedChunk === undefined) throw new Error("missing chunk");
      single.store._internal.db
        .prepare("DELETE FROM vectors WHERE capsule_id = :c AND chunk_id = :chunk_id")
        .run({ c: single.capsuleId, chunk_id: removedChunk.id });
      expect(countVectorsForDocument(single.store._internal.db, single.capsuleId, documentId)).toBe(
        chunks.length - 1,
      );

      const secondEvents = await drain(runIndexingJob(buildOptions(single, { chunkingOptions })));

      expect(secondEvents.some((event) => event.kind === "document-embedded")).toBe(true);
      expect(countVectorsForDocument(single.store._internal.db, single.capsuleId, documentId)).toBe(
        chunks.length,
      );
    } finally {
      single.cleanup();
    }
  });
});

// ─── Test 4: force ────────────────────────────────────────────────────────────
describe("runIndexingJob — force", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = buildFixture({
      "alpha.txt": "Lorem ipsum dolor sit amet. ".repeat(8),
    });
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("deletes existing vectors and re-embeds when force=true", async () => {
    await drain(runIndexingJob(buildOptions(fixture)));
    const firstVectorCount = countVectorsForCapsule(fixture.store._internal.db, fixture.capsuleId);
    expect(firstVectorCount).toBeGreaterThan(0);

    const events = await drain(runIndexingJob(buildOptions(fixture, { force: true })));
    const embedded = events.filter((e) => e.kind === "document-embedded").length;
    expect(embedded).toBe(1);
    // Force should NOT leave stale rows from the first pass.
    const secondVectorCount = countVectorsForCapsule(fixture.store._internal.db, fixture.capsuleId);
    expect(secondVectorCount).toBe(firstVectorCount);
  });

  it("preserves other source vectors when force=true is scoped to one source", async () => {
    const multi = buildTwoSourceFixture();

    try {
      await drain(runIndexingJob(buildOptions(multi)));
      const firstSourceVectors = countVectorsForSource(multi, multi.sourceId);
      const otherSourceVectors = countVectorsForSource(multi, multi.otherSourceId);
      expect(firstSourceVectors).toBeGreaterThan(0);
      expect(otherSourceVectors).toBeGreaterThan(0);

      const events = await drain(
        runIndexingJob(
          buildOptions(multi, {
            force: true,
            sourceIds: [multi.sourceId],
          }),
        ),
      );

      expect(events.filter((event) => event.kind === "document-embedded").length).toBe(1);
      expect(countVectorsForSource(multi, multi.sourceId)).toBe(firstSourceVectors);
      expect(countVectorsForSource(multi, multi.otherSourceId)).toBe(otherSourceVectors);
    } finally {
      multi.cleanup();
    }
  });
  it("re-chunks from new source text when force=true after content change", async () => {
    const v1Fs = memoryFs(ROOT, [{ relativePath: "alpha.txt", content: "Version one content sentence. ".repeat(8) }]);
    const v2Fs = memoryFs(ROOT, [{ relativePath: "alpha.txt", content: "Entirely different version two text here. ".repeat(8) }]);

    await drain(runIndexingJob(buildOptions(fixture, { workspaceFs: v1Fs })));

    const documentId = documentIdFor({
      capsuleId: fixture.capsuleId,
      sourceId: fixture.sourceId,
      relativePath: "alpha.txt",
    });
    const v1Chunks = selectChunksForDocument(fixture.store._internal.db, fixture.capsuleId, documentId);
    expect(v1Chunks.length).toBeGreaterThan(0);
    const v1Hashes = new Set(v1Chunks.map((c) => c.safe_excerpt_hash));

    // Force re-index with changed content. Without the fix, chunkDocument receives
    // force=undefined and skips re-chunking (shouldReuseExistingChunks returns true),
    // leaving v1 chunk rows in place. With the fix, force=true deletes old chunks and
    // re-chunks from the new parsed units, producing different safe_excerpt_hash values.
    const events = await drain(runIndexingJob(buildOptions(fixture, { force: true, workspaceFs: v2Fs })));
    expect(events.some((e) => e.kind === "document-embedded")).toBe(true);

    const v2Chunks = selectChunksForDocument(fixture.store._internal.db, fixture.capsuleId, documentId);
    expect(v2Chunks.length).toBeGreaterThan(0);
    const v2Hashes = new Set(v2Chunks.map((c) => c.safe_excerpt_hash));
    // All chunk hashes must differ from v1 — re-chunking from new source text is required.
    expect([...v2Hashes].every((h) => !v1Hashes.has(h))).toBe(true);
  });
});

describe("runIndexingJob — unsupported documents", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = buildFixture({
      "keiko-logo.svg":
        '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>',
    });
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("counts unsupported documents as skipped instead of processed", async () => {
    const events = await drain(runIndexingJob(buildOptions(fixture)));
    const terminal = events.at(-1);

    expect(
      events.some((event) => event.kind === "document-skipped" && event.reason === "unsupported"),
    ).toBe(true);
    expect(events.some((event) => event.kind === "document-embedded")).toBe(false);
    expect(terminal?.kind).toBe("job-completed");
    if (terminal?.kind === "job-completed") {
      expect(terminal.result.processedDocuments).toBe(0);
      expect(terminal.result.skippedDocuments).toBe(1);
    }

    const started = events.find((event) => event.kind === "job-started");
    if (started?.kind !== "job-started") {
      throw new Error("missing job-started");
    }
    const row = selectJobById(fixture.store._internal.db, started.jobId);
    expect(row?.processed_documents).toBe(0);
    expect(row?.skipped_documents).toBe(1);
  });
});

describe("runIndexingJob — binary parser text projection", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = buildFixture({
      "policy.pdf": PDF_TEXT_LAYER,
    });
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("embeds normalized extracted text instead of raw PDF bytes", async () => {
    const inputs: string[] = [];
    const adapter = scriptedAdapter({
      responder: (req) => {
        inputs.push(req.input);
        return {
          ok: true,
          value: {
            vector: deterministicVector(req.input, DEFAULT_EMBEDDING.vectorDimensions),
            modelId: DEFAULT_EMBEDDING.modelId,
          },
        };
      },
    });

    const events = await drain(
      runIndexingJob(buildOptions(fixture, { embeddingAdapter: adapter })),
    );
    expect(events.some((event) => event.kind === "document-embedded")).toBe(true);
    expect(inputs.join("\n")).toContain("Hello PDF");
    expect(inputs.join("\n")).not.toContain("%PDF-1.4");
  });
});

// ─── Test 5: embedding-identity mismatch ─────────────────────────────────────
describe("runIndexingJob — identity gate", () => {
  let fixture: Fixture;

  beforeEach(() => {
    // Capsule pinned to dim=1536 (the DEFAULT). Adapter returns dim=768 → INCOMPATIBLE.
    fixture = buildFixture({
      "alpha.txt": "Lorem ipsum dolor sit amet. ".repeat(8),
    });
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("emits job-failed with INCOMPATIBLE_EMBEDDING_IDENTITY and writes no vector rows", async () => {
    const adapter = scriptedAdapter({
      responder: (req) => ({
        ok: true,
        value: {
          vector: deterministicVector(req.input, 768),
          modelId: DEFAULT_EMBEDDING.modelId,
        },
      }),
    });

    const events = await drain(
      runIndexingJob(buildOptions(fixture, { embeddingAdapter: adapter })),
    );

    const terminal = events.at(-1);
    expect(terminal?.kind).toBe("job-failed");
    if (terminal?.kind === "job-failed") {
      expect(terminal.error.code).toBe("INCOMPATIBLE_EMBEDDING_IDENTITY");
      expect(terminal.result.status).toBe("failed");
    }
    expect(countVectorsForCapsule(fixture.store._internal.db, fixture.capsuleId)).toBe(0);
  });

  it("flips the capsule lifecycleState to `error` after an identity-failure run", async () => {
    const adapter = scriptedAdapter({
      responder: (req) => ({
        ok: true,
        value: {
          vector: deterministicVector(req.input, 768),
          modelId: DEFAULT_EMBEDDING.modelId,
        },
      }),
    });
    await drain(runIndexingJob(buildOptions(fixture, { embeddingAdapter: adapter })));
    const capsule = getCapsule(fixture.store, fixture.capsuleId);
    expect(capsule?.lifecycleState).toBe("error");
  });
});

describe("runIndexingJob — embedding capability preflight", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = buildFixture({
      "alpha.txt": "Lorem ipsum dolor sit amet. ".repeat(8),
    });
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("fails before discovery when the embedding model is not verified", async () => {
    let requestCount = 0;
    const adapter = scriptedAdapter({
      responder: () => {
        requestCount += 1;
        return { ok: false, kind: "wrong-header" };
      },
    });

    const events = await drain(
      runIndexingJob(buildOptions(fixture, { embeddingAdapter: adapter })),
    );

    expect(requestCount).toBe(1);
    expect(events[0]?.kind).toBe("job-started");
    expect(events[1]?.kind).toBe("job-failed");
    expect(events.some((event) => event.kind === "document-discovered")).toBe(false);
    const terminal = events.at(-1);
    expect(terminal?.kind).toBe("job-failed");
    if (terminal?.kind === "job-failed") {
      expect(terminal.error.code).toBe("EMBEDDING_ADAPTER_FAILED");
      expect(terminal.error.message).toBe(
        "model gateway rejected the request — check API key configuration",
      );
      expect(terminal.result.processedDocuments).toBe(0);
      expect(terminal.result.vectorsPersisted).toBe(0);
    }
    expect(countVectorsForCapsule(fixture.store._internal.db, fixture.capsuleId)).toBe(0);
  });

  it("preserves existing vectors on force=true when preflight fails", async () => {
    await drain(runIndexingJob(buildOptions(fixture)));
    const before = countVectorsForCapsule(fixture.store._internal.db, fixture.capsuleId);
    expect(before).toBeGreaterThan(0);

    const adapter = scriptedAdapter({
      responder: () => ({ ok: false, kind: "unsupported-model" }),
    });
    const events = await drain(
      runIndexingJob(buildOptions(fixture, { embeddingAdapter: adapter, force: true })),
    );

    const after = countVectorsForCapsule(fixture.store._internal.db, fixture.capsuleId);
    expect(after).toBe(before);
    expect(events.some((event) => event.kind === "document-discovered")).toBe(false);
    const terminal = events.at(-1);
    expect(terminal?.kind).toBe("job-failed");
    if (terminal?.kind === "job-failed") {
      expect(terminal.error.message).toBe(
        "embedding model is not available on the configured gateway",
      );
    }
  });

  it("fails before discovery when the gateway reports a different embedding model identity", async () => {
    await drain(runIndexingJob(buildOptions(fixture)));
    const before = countVectorsForCapsule(fixture.store._internal.db, fixture.capsuleId);
    expect(before).toBeGreaterThan(0);

    let requestCount = 0;
    const adapter = scriptedAdapter({
      responder: (req) => {
        requestCount += 1;
        return {
          ok: true,
          value: {
            vector: deterministicVector(req.input, DEFAULT_EMBEDDING.vectorDimensions),
            modelId: "canonical-embedding-model",
          },
        };
      },
    });

    const events = await drain(
      runIndexingJob(buildOptions(fixture, { embeddingAdapter: adapter, force: true })),
    );

    expect(requestCount).toBe(1);
    expect(countVectorsForCapsule(fixture.store._internal.db, fixture.capsuleId)).toBe(before);
    expect(events.some((event) => event.kind === "document-discovered")).toBe(false);
    const terminal = events.at(-1);
    expect(terminal?.kind).toBe("job-failed");
    if (terminal?.kind === "job-failed") {
      expect(terminal.error.code).toBe("INCOMPATIBLE_EMBEDDING_IDENTITY");
      expect(terminal.error.message).toBe(
        "embedding model identity changed — existing capsules are no longer compatible",
      );
      expect(terminal.result.processedDocuments).toBe(0);
      expect(terminal.result.vectorsPersisted).toBe(0);
    }
  });

  it("persists a fixed safe message when embedding preflight throws", async () => {
    const adapter = {
      endpoint: "https://private-gateway.internal/v1",
      apiKey: ["sk-", "test"].join(""),
      request: (): Promise<OpenAIEmbeddingOutcome> =>
        Promise.reject(
          new Error("dial https://private-gateway.internal/v1 from /Users/victim/.config/key"),
        ),
    };

    const events = await drain(
      runIndexingJob(
        buildOptions(fixture, { embeddingAdapter: adapter, idSource: () => "job-preflight" }),
      ),
    );
    const terminal = events.at(-1);
    expect(terminal?.kind).toBe("job-failed");
    if (terminal?.kind === "job-failed") {
      expect(terminal.error.code).toBe("EMBEDDING_ADAPTER_FAILED");
      expect(terminal.error.message).toBe(
        "embedding capability preflight failed before indexing started",
      );
    }
    const row = selectJobById(fixture.store._internal.db, "job-preflight");
    expect(row?.last_error_message).toBe(
      "embedding capability preflight failed before indexing started",
    );
    expect(row?.last_error_message).not.toContain("private-gateway");
    expect(row?.last_error_message).not.toContain("/Users/victim");
  });
});

// ─── Test 6: adapter throws on one batch, job continues for the rest ─────────
describe("runIndexingJob — partial adapter failure", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = buildFixture({
      "alpha.txt": "Lorem ipsum dolor. ".repeat(8),
      "beta.txt": "Pack my box. ".repeat(8),
      "gamma.txt": "Sphinx of black quartz. ".repeat(8),
    });
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("marks one document failed but completes the rest", async () => {
    // Fail every request whose input is from "alpha.txt" (we project chunk text from the
    // sliced source so we recognise the doc by a prefix). The remaining docs embed fine.
    const adapter = scriptedAdapter({
      responder: (req) => {
        if (req.input.startsWith("Lorem")) {
          return { ok: false, kind: "transport" };
        }
        return {
          ok: true,
          value: {
            vector: deterministicVector(req.input, DEFAULT_EMBEDDING.vectorDimensions),
            modelId: DEFAULT_EMBEDDING.modelId,
          },
        };
      },
    });

    const events = await drain(
      runIndexingJob(buildOptions(fixture, { embeddingAdapter: adapter })),
    );

    const failed = events.filter((e) => e.kind === "document-failed");
    expect(failed.length).toBeGreaterThanOrEqual(1);
    const embedded = events.filter((e) => e.kind === "document-embedded");
    // 2 successful docs (beta + gamma) — alpha is the failing doc.
    expect(embedded.length).toBe(2);
    // Job-level outcome: completed (because at least one doc succeeded).
    expect(events.at(-1)?.kind).toBe("job-completed");
  });
});

// ─── F2: cached capsule sources (no N+1 listCapsuleSources) ──────────────────
describe("runIndexingJob — capsule-sources query budget", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = buildFixture({
      "alpha.txt": "Lorem ipsum dolor sit amet. ".repeat(8),
      "beta.txt": "Pack my box with five dozen liquor jugs. ".repeat(8),
      "gamma.txt": "The quick brown fox jumps over the lazy dog. ".repeat(8),
    });
    addSourceToCapsule(fixture.store, fixture.capsuleId, {
      id: "src-orch-2" as KnowledgeSourceId,
      displayName: "orch-2",
      tags: [],
      scope: folderScope(ROOT, { recursive: true }),
    });
    addSourceToCapsule(fixture.store, fixture.capsuleId, {
      id: "src-orch-3" as KnowledgeSourceId,
      displayName: "orch-3",
      tags: [],
      scope: folderScope(ROOT, { recursive: true }),
    });
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("issues ≤ 2 listCapsuleSources SELECTs per job regardless of document count", async () => {
    // `listCapsuleSources` emits `SELECT * FROM capsule_sources WHERE capsule_id = :c ORDER BY …`,
    // which is the only call path that hydrates full source rows. Other capsule_sources reads
    // (listSourceIdsFor inside getCapsule) issue `SELECT id FROM capsule_sources` and are
    // unrelated to F2 — we filter to the `SELECT *` shape so a regression in sourceForResult
    // is the only thing this test can catch.
    const db = fixture.store._internal.db;
    const originalPrepare = db.prepare.bind(db);
    let listCapsuleSourcesCalls = 0;
    db.prepare = (sql: string): ReturnType<typeof originalPrepare> => {
      const stmt = originalPrepare(sql);
      if (/SELECT\s+\*\s+FROM\s+capsule_sources/i.test(sql)) {
        const originalAll = stmt.all.bind(stmt);
        stmt.all = ((...args: Parameters<typeof originalAll>): ReturnType<typeof originalAll> => {
          listCapsuleSourcesCalls += 1;
          return originalAll(...args);
        }) as typeof stmt.all;
      }
      return stmt;
    };

    try {
      const events = await drain(runIndexingJob(buildOptions(fixture)));
      expect(events.filter((e) => e.kind === "document-embedded").length).toBe(9);
    } finally {
      db.prepare = originalPrepare;
    }

    // Without F2, sourceForResult issued one listCapsuleSources per persisted document
    // (9 docs × 2 call-sites = 18 + 1 from resolveSources = 19+). With F2, only the
    // resolveSources call at job start hits the DB.
    expect(listCapsuleSourcesCalls).toBeLessThanOrEqual(2);
  });
});

// ─── Concurrency cap honoured ─────────────────────────────────────────────────
describe("runIndexingJob — concurrency clamp", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = buildFixture({
      "alpha.txt": "abcdefghij ".repeat(64),
    });
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("clamps concurrency to ≤4 even when the caller asks for 99", async () => {
    let peak = 0;
    let live = 0;
    const adapter = happyAdapter();
    const wrapped = {
      ...adapter,
      request: async (
        req: Parameters<typeof adapter.request>[0],
      ): Promise<Awaited<ReturnType<typeof adapter.request>>> => {
        live += 1;
        if (live > peak) peak = live;
        await new Promise((r) => setImmediate(r));
        const out = await adapter.request(req);
        live -= 1;
        return out;
      },
    };
    await drain(
      runIndexingJob(buildOptions(fixture, { embeddingAdapter: wrapped, concurrency: 99 })),
    );
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("clamps oversized discovery maxDepth to the default bound", async () => {
    const deepPath = `${Array.from({ length: 13 }, (_unused, i) => `d${String(i)}`).join("/")}/deep.txt`;
    const single = buildFixture({
      "root.txt": "root document",
      [deepPath]: "deep document",
    });

    try {
      const events = await drain(
        runIndexingJob(
          buildOptions(single, {
            discoveryOptions: { maxDepth: 999, maxFiles: 999_999 },
          }),
        ),
      );
      const discovered = events
        .filter((event) => event.kind === "document-discovered")
        .map((event) => event.relativePath);

      expect(discovered).toContain("root.txt");
      expect(discovered).not.toContain(deepPath);
    } finally {
      single.cleanup();
    }
  });
});
