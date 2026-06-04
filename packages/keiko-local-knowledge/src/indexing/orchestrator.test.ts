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
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";

import { createCapsule, getCapsule } from "../capsule-lifecycle.js";
import { createDefaultParserRegistry } from "../parsers/index.js";
import { PDF_TEXT_LAYER } from "../parsers/parser-test-fixtures.js";
import { addSourceToCapsule } from "../source-lifecycle.js";
import { DEFAULT_EMBEDDING, freshStore, sampleCapsuleInput } from "../_support.js";
import { folderScope, memoryFs } from "../discovery/test-support.js";

import { runIndexingJob } from "./orchestrator.js";
import { selectJobById, rowToIndexingJobRecord } from "./job-persist.js";
import { countVectorsForCapsule } from "./vector-persist.js";
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

    const events = await drain(runIndexingJob(buildOptions(fixture, { embeddingAdapter: adapter })));
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
      request: async (req: Parameters<typeof adapter.request>[0]): Promise<Awaited<ReturnType<typeof adapter.request>>> => {
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
});
