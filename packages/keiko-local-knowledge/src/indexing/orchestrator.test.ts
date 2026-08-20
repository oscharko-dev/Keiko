// Integration tests for `runIndexingJob` (Epic #189, Issue #196). Each test composes the
// real #194 discovery + #195 chunking + the orchestrator's embedding step against a
// scripted OpenAIEmbeddingAdapter — never the real network.
//
// The orchestrator publishes a discriminated AsyncIterable of IndexingEvent; these tests
// drain the stream into an array and assert on the sequence/structure of events as the
// contract surface, with side-effect assertions on `vectors` / `indexing_jobs` rows.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  CitationReference,
  EmbeddingModelIdentity,
  GatewayRequest,
  KnowledgeCapsuleId,
  KnowledgeSource,
  KnowledgeSourceId,
  NormalizedResponse,
} from "@oscharko-dev/keiko-contracts";
import {
  KNOWLEDGE_POD_MODEL_USE_POLICY_SCHEMA_VERSION,
  sealedLocalPodModelUsePolicy,
  standardPodModelUsePolicy,
  type KnowledgePodModelUsePolicy,
} from "@oscharko-dev/keiko-contracts";
import type { OpenAIEmbeddingOutcome } from "@oscharko-dev/keiko-model-gateway";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";

import {
  createCapsule,
  getCapsule,
  updateCapsuleDetails,
  updateCapsuleEmbeddingModelIdentity,
  updateCapsuleState,
} from "../capsule-lifecycle.js";
import {
  createDefaultParserRegistry,
  createParserRegistry,
  registerParser,
  type ParserAdapter,
  type ParserOptions,
  type ParserSelectionInput,
} from "../parsers/index.js";
import { PDF_NO_TEXT_LAYER, PDF_TEXT_LAYER } from "../parsers/parser-test-fixtures.js";
import { readExistingDocumentRow } from "../discovery/persist.js";
import { readCitationExcerpt } from "../conversation/citation-excerpts.js";
import { addSourceToCapsule } from "../source-lifecycle.js";
import { DEFAULT_EMBEDDING, freshStore, sampleCapsuleInput } from "../_support.js";
import { folderScope, memoryFs } from "../discovery/test-support.js";
import { documentIdFor } from "../discovery/types.js";
import { LEXICAL_ANALYZER_KEY } from "../retrieval/lexical-normalization.js";

import {
  CONSECUTIVE_TRANSIENT_FAILURE_LIMIT,
  EMBEDDING_GATEWAY_UNAVAILABLE_CODE,
  runIndexingJob,
} from "./orchestrator.js";
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

function isEmbeddingCapabilityProbe(input: string): boolean {
  return input === "ping" || input.startsWith("Keiko embedding space probe:");
}

function contextualRawReleaseDeniedPolicy(): KnowledgePodModelUsePolicy {
  return {
    schemaVersion: KNOWLEDGE_POD_MODEL_USE_POLICY_SCHEMA_VERSION,
    mode: "custom",
    operations: {
      ...standardPodModelUsePolicy().operations,
      rawContentRelease: "deny",
    },
  };
}

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
  createCapsule(
    store,
    sampleCapsuleInput({
      id: capsuleId,
      embeddingModelIdentity: identity,
      modelUsePolicy: standardPodModelUsePolicy(),
    }),
  );
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
  createCapsule(
    store,
    sampleCapsuleInput({ id: capsuleId, modelUsePolicy: standardPodModelUsePolicy() }),
  );
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

function provisionalDefaultEmbedding(): EmbeddingModelIdentity {
  return {
    provider: DEFAULT_EMBEDDING.provider,
    modelId: DEFAULT_EMBEDDING.modelId,
    vectorDimensions: DEFAULT_EMBEDDING.vectorDimensions,
    vectorMetric: DEFAULT_EMBEDDING.vectorMetric,
    normalization: "l2",
    instructionVersion: "keiko-embedding-input-v1",
  };
}

function normalizedContextResponse(modelId: string, content: string): NormalizedResponse {
  return {
    modelId,
    content,
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "ctx-test",
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 1,
      costClass: "low",
    },
  };
}

function contextGateway(
  responder: (request: GatewayRequest) => string | Promise<string>,
  calls: GatewayRequest[] = [],
): {
  readonly chat: (request: GatewayRequest) => Promise<NormalizedResponse>;
  readonly calls: GatewayRequest[];
} {
  return {
    calls,
    chat: async (request): Promise<NormalizedResponse> => {
      calls.push(request);
      return normalizedContextResponse(request.modelId, await responder(request));
    },
  };
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
    createCapsule(
      store,
      sampleCapsuleInput({ id: capsuleId, modelUsePolicy: standardPodModelUsePolicy() }),
    );

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

  it("fails closed before embedding preflight when pod policy denies external embeddings", async () => {
    const fixture = buildFixture({ "sealed.txt": "Sealed text. ".repeat(64) });
    const calls: string[] = [];
    updateCapsuleDetails(fixture.store, fixture.capsuleId, {
      modelUsePolicy: sealedLocalPodModelUsePolicy(),
    });
    const adapter = scriptedAdapter({
      responder: (req): OpenAIEmbeddingOutcome => {
        calls.push(req.input);
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
      const events = await drain(
        runIndexingJob(buildOptions(fixture, { embeddingAdapter: adapter })),
      );

      expect(events.map((event) => event.kind)).toStrictEqual(["job-started", "job-failed"]);
      expect(events[1]).toMatchObject({
        kind: "job-failed",
        error: {
          code: "POLICY_DENIED",
          message: "Knowledge Pod policy denies external embeddings for indexing.",
        },
      });
      expect(calls).toStrictEqual([]);
      expect(countVectorsForCapsule(fixture.store._internal.db, fixture.capsuleId)).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });

  it("fails closed before contextual retrieval when raw content release is denied", async () => {
    const fixture = buildFixture({ "raw-denied.txt": "Raw confidential text. ".repeat(64) });
    const embeddingCalls: string[] = [];
    const contextCalls: GatewayRequest[] = [];
    updateCapsuleDetails(fixture.store, fixture.capsuleId, {
      modelUsePolicy: contextualRawReleaseDeniedPolicy(),
    });
    const adapter = scriptedAdapter({
      responder: (req): OpenAIEmbeddingOutcome => {
        embeddingCalls.push(req.input);
        return {
          ok: true,
          value: {
            vector: deterministicVector(req.input, DEFAULT_EMBEDDING.vectorDimensions),
            modelId: DEFAULT_EMBEDDING.modelId,
          },
        };
      },
    });
    const gateway = contextGateway(() => "context must not be generated", contextCalls);

    try {
      const events = await drain(
        runIndexingJob(
          buildOptions(fixture, {
            embeddingAdapter: adapter,
            contextualRetrieval: { enabled: true, chatGateway: gateway, modelId: "context-model" },
          }),
        ),
      );

      expect(events.map((event) => event.kind)).toStrictEqual(["job-started", "job-failed"]);
      expect(events[1]).toMatchObject({
        kind: "job-failed",
        error: {
          code: "POLICY_DENIED",
          message: "Knowledge Pod policy denies raw content release for contextual indexing.",
        },
      });
      expect(contextCalls).toEqual([]);
      expect(embeddingCalls).toEqual([]);
      expect(countVectorsForCapsule(fixture.store._internal.db, fixture.capsuleId)).toBe(0);
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

describe("runIndexingJob — contextual retrieval indexing", () => {
  it("prepends generated context before document embedding and FTS indexing", async () => {
    const sourceText =
      "Release TS-999 changes the connector rollout. BillingService handles retries. ".repeat(24);
    const fixture = buildFixture({ "context.txt": sourceText });
    const inputs: string[] = [];
    const contextCalls: GatewayRequest[] = [];
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
    const gateway = contextGateway(
      () => "Context: TS-999 rollout and retry handling.",
      contextCalls,
    );

    try {
      const events = await drain(
        runIndexingJob(
          buildOptions(fixture, {
            embeddingAdapter: adapter,
            contextualRetrieval: {
              enabled: true,
              chatGateway: gateway,
              modelId: "context-model",
            },
          }),
        ),
      );

      expect(events.some((event) => event.kind === "document-embedded")).toBe(true);
      expect(contextCalls.length).toBeGreaterThan(0);
      expect(contextCalls[0]?.messages[1]?.content).toContain("<document>");
      const chunkInputs = inputs.filter((input) => !isEmbeddingCapabilityProbe(input));
      expect(chunkInputs.length).toBeGreaterThan(0);
      expect(chunkInputs.every((input) => input.startsWith("Context: TS-999"))).toBe(true);
      expect(inputs.some((input) => input.startsWith("Instruct:"))).toBe(false);

      const lexical = fixture.store._internal.db
        .prepare("SELECT text FROM chunk_lexical_index WHERE capsule_id = :c LIMIT 1")
        .get({ c: fixture.capsuleId }) as { readonly text: string } | undefined;
      expect(lexical?.text.startsWith("Context: TS-999")).toBe(true);

      const chunkRow = fixture.store._internal.db
        .prepare(
          "SELECT id, source_id, document_id, character_start, character_end FROM chunks WHERE capsule_id = :c ORDER BY order_index ASC LIMIT 1",
        )
        .get({ c: fixture.capsuleId }) as
        | {
            readonly id: string;
            readonly source_id: string;
            readonly document_id: string;
            readonly character_start: number;
            readonly character_end: number;
          }
        | undefined;
      if (chunkRow === undefined) throw new Error("missing chunk row");
      const citation: CitationReference = {
        capsuleId: fixture.capsuleId,
        sourceId: chunkRow.source_id as KnowledgeSourceId,
        documentId: chunkRow.document_id as CitationReference["documentId"],
        chunkId: chunkRow.id as CitationReference["chunkId"],
        characterStart: chunkRow.character_start,
        characterEnd: chunkRow.character_end,
        safeDisplayName: "context.txt",
      };
      expect(readCitationExcerpt(fixture.store, fixture.capsuleId, citation)).not.toContain(
        "Context: TS-999",
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps document embeddings raw when contextual retrieval is disabled", async () => {
    const sourceText = "Raw indexing sentence without generated context. ".repeat(16);
    const fixture = buildFixture({ "raw.txt": sourceText });
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

    try {
      await drain(runIndexingJob(buildOptions(fixture, { embeddingAdapter: adapter })));
      expect(inputs.length).toBeGreaterThan(0);
      expect(inputs.some((input) => input.startsWith("Context:"))).toBe(false);
      expect(inputs.some((input) => input.startsWith("Instruct:"))).toBe(false);
      const row = fixture.store._internal.db
        .prepare(
          "SELECT context_status, augmented_text FROM chunks WHERE capsule_id = :c ORDER BY order_index ASC LIMIT 1",
        )
        .get({ c: fixture.capsuleId }) as
        | { readonly context_status: string | null; readonly augmented_text: string | null }
        | undefined;
      expect(row?.context_status).toBe("disabled");
      expect(row?.augmented_text).toBeTypeOf("string");
    } finally {
      fixture.cleanup();
    }
  });

  it("degrades to raw chunk text when the context model fails", async () => {
    const sourceText = "Failure-tolerant contextual retrieval sentence. ".repeat(20);
    const fixture = buildFixture({ "degraded.txt": sourceText });
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

    try {
      const events = await drain(
        runIndexingJob(
          buildOptions(fixture, {
            embeddingAdapter: adapter,
            contextualRetrieval: {
              enabled: true,
              modelId: "context-model",
              chatGateway: {
                chat: () => Promise.reject(new Error("context unavailable")),
              },
            },
          }),
        ),
      );
      expect(events.some((event) => event.kind === "job-failed")).toBe(false);
      expect(events.some((event) => event.kind === "document-embedded")).toBe(true);
      expect(inputs.length).toBeGreaterThan(0);
      expect(inputs.some((input) => input.startsWith("Context:"))).toBe(false);

      const row = fixture.store._internal.db
        .prepare(
          "SELECT context_status FROM chunks WHERE capsule_id = :c ORDER BY order_index ASC LIMIT 1",
        )
        .get({ c: fixture.capsuleId }) as { readonly context_status: string | null } | undefined;
      expect(row?.context_status).toBe("degraded");
      const diag = fixture.store._internal.db
        .prepare(
          "SELECT COUNT(*) AS n FROM parser_diagnostics WHERE capsule_id = :c AND code = 'CONTEXTUAL_RETRIEVAL_DEGRADED'",
        )
        .get({ c: fixture.capsuleId }) as { readonly n: number };
      expect(diag.n).toBeGreaterThan(0);
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
    expect(kinds.filter((k) => k === "document-discovered")).toHaveLength(3);
    expect(kinds.filter((k) => k === "document-extracted")).toHaveLength(3);
    expect(kinds.filter((k) => k === "document-chunked")).toHaveLength(3);
    expect(kinds.filter((k) => k === "document-embedded")).toHaveLength(3);
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

  it("persists the lexical analyzer key in the chunking strategy key", async () => {
    await drain(runIndexingJob(buildOptions(fixture)));
    const row = fixture.store._internal.db
      .prepare(
        "SELECT chunking_strategy_version FROM chunks WHERE capsule_id = :capsule_id LIMIT 1",
      )
      .get({ capsule_id: String(fixture.capsuleId) }) as
      { readonly chunking_strategy_version: string | null } | undefined;
    expect(row?.chunking_strategy_version).toContain(`lexical-analyzer=${LEXICAL_ANALYZER_KEY}`);
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
        if (
          !isEmbeddingCapabilityProbe(req.input) &&
          kindsBeforeFirstChunkEmbedding === undefined
        ) {
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
    expect(secondEvents.filter((e) => e.kind === "document-skipped")).toHaveLength(2);
  });

  it("re-embeds unchanged files when existing chunks are marked stale by strategy version", async () => {
    await drain(runIndexingJob(buildOptions(fixture)));
    fixture.store._internal.db
      .prepare("UPDATE chunks SET chunking_strategy_version = NULL WHERE capsule_id = :c")
      .run({ c: fixture.capsuleId });

    const secondEvents = await drain(runIndexingJob(buildOptions(fixture)));
    expect(secondEvents.filter((e) => e.kind === "document-embedded")).toHaveLength(2);
    expect(
      secondEvents.some((e) => e.kind === "document-skipped" && e.reason === "already-embedded"),
    ).toBe(false);
  });

  it("re-embeds unchanged files when the contextual retrieval model identity changes", async () => {
    const single = buildFixture({
      "contextual.txt": "Context model identity should affect the reindex key. ".repeat(20),
    });
    try {
      await drain(
        runIndexingJob(
          buildOptions(single, {
            contextualRetrieval: {
              enabled: true,
              modelId: "context-model-a",
              chatGateway: contextGateway(() => "Context A"),
            },
          }),
        ),
      );

      const secondEvents = await drain(
        runIndexingJob(
          buildOptions(single, {
            contextualRetrieval: {
              enabled: true,
              modelId: "context-model-b",
              chatGateway: contextGateway(() => "Context B"),
            },
          }),
        ),
      );

      expect(secondEvents.some((event) => event.kind === "document-embedded")).toBe(true);
      expect(
        secondEvents.some(
          (event) => event.kind === "document-skipped" && event.reason === "already-embedded",
        ),
      ).toBe(false);
    } finally {
      single.cleanup();
    }
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

    expect(secondEvents.filter((e) => e.kind === "document-discovered")).toHaveLength(1);
    expect(secondEvents.filter((e) => e.kind === "document-skipped")).toHaveLength(1);
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

  it("does not prune a deleted file's document when another file in the same run fails to re-embed", async () => {
    // Regression: pruneDeletedSourceDocuments previously ran unconditionally once discovery
    // completed, even when a document elsewhere in the same run failed to (re-)embed — so a
    // legitimately-deleted file's document was removed in the same run a failure was reported,
    // even though the run's discoveredPaths set (and therefore the prune decision) is not a fully
    // trustworthy picture of a run that did not fully succeed. Mirrors the existing maxFiles guard,
    // which already refuses to prune on an incomplete discovered-path set for the same reason.
    await drain(runIndexingJob(buildOptions(fixture)));
    const deletedDocumentId = documentIdFor({
      capsuleId: fixture.capsuleId,
      sourceId: fixture.sourceId,
      relativePath: "beta.txt",
    });
    expect(
      readExistingDocumentRow(fixture.store._internal.db, fixture.capsuleId, deletedDocumentId),
    ).toBeDefined();

    const failingAdapter = scriptedAdapter({
      responder: (req) =>
        req.input.includes("MARKERFAIL")
          ? { ok: false, kind: "unsupported-model" }
          : {
              ok: true,
              value: {
                vector: deterministicVector(req.input, DEFAULT_EMBEDDING.vectorDimensions),
                modelId: DEFAULT_EMBEDDING.modelId,
              },
            },
    });
    const secondEvents = await drain(
      runIndexingJob(
        buildOptions(fixture, {
          embeddingAdapter: failingAdapter,
          workspaceFs: memoryFs(ROOT, [
            { relativePath: "alpha.txt", content: "MARKERFAIL alpha changed. ".repeat(32) },
          ]),
        }),
      ),
    );

    expect(secondEvents.some((e) => e.kind === "document-failed")).toBe(true);
    expect(
      readExistingDocumentRow(fixture.store._internal.db, fixture.capsuleId, deletedDocumentId),
    ).toBeDefined();
  });

  it("prunes a genuinely deleted document in one source while a failing document in another source blocks that source's own prune", async () => {
    // Regression: finalizeSourceRun's failedDocumentsThisSource guard is computed from a
    // per-source snapshot (state.failedDocuments before/after that source's own stream), not
    // the job-wide counter. A future refactor that widened the snapshot to job-wide scope would
    // make a failure in ANY source block pruning in EVERY source — this proves source isolation
    // across a genuine multi-source job, not just within a single source's own run.
    const multi = buildTwoSourceFixture();
    try {
      await drain(runIndexingJob(buildOptions(multi)));

      const failingDocumentId = documentIdFor({
        capsuleId: multi.capsuleId,
        sourceId: multi.sourceId,
        relativePath: "alpha.txt",
      });
      const deletedDocumentId = documentIdFor({
        capsuleId: multi.capsuleId,
        sourceId: multi.otherSourceId,
        relativePath: "beta.txt",
      });
      expect(
        readExistingDocumentRow(multi.store._internal.db, multi.capsuleId, failingDocumentId),
      ).toBeDefined();
      expect(
        readExistingDocumentRow(multi.store._internal.db, multi.capsuleId, deletedDocumentId),
      ).toBeDefined();

      const failingAdapter = scriptedAdapter({
        responder: (req) =>
          req.input.includes("MARKERFAIL")
            ? { ok: false, kind: "unsupported-model" }
            : {
                ok: true,
                value: {
                  vector: deterministicVector(req.input, DEFAULT_EMBEDDING.vectorDimensions),
                  modelId: DEFAULT_EMBEDDING.modelId,
                },
              },
      });

      // Source A (multi.sourceId): alpha.txt changes to content that fails re-embedding.
      // Source B (multi.otherSourceId): beta.txt is genuinely removed this run — its scope's
      // only file is now missing from the workspace, so a clean discovery pass should prune it.
      const events = await drain(
        runIndexingJob(
          buildOptions(multi, {
            embeddingAdapter: failingAdapter,
            workspaceFs: memoryFs(ROOT, [
              { relativePath: "alpha.txt", content: "MARKERFAIL alpha changed. ".repeat(32) },
            ]),
          }),
        ),
      );

      expect(events.some((e) => e.kind === "document-failed")).toBe(true);
      // Source A's failing document is retained — its own prune is blocked by the failure.
      expect(
        readExistingDocumentRow(multi.store._internal.db, multi.capsuleId, failingDocumentId),
      ).toBeDefined();
      // Source B's genuinely deleted document is still pruned despite source A's failure.
      expect(
        readExistingDocumentRow(multi.store._internal.db, multi.capsuleId, deletedDocumentId),
      ).toBeUndefined();
    } finally {
      multi.cleanup();
    }
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

    expect(secondEvents.filter((e) => e.kind === "document-discovered")).toHaveLength(1);
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

  it("invalidates ready vector-index state when force=true replaces vectors", async () => {
    await drain(runIndexingJob(buildOptions(fixture)));
    fixture.store._internal.db
      .prepare(
        [
          "INSERT INTO vector_index_state (",
          "  capsule_id, provider, index_name, vector_dimensions, vector_metric,",
          "  embedding_identity_key, vector_count, vector_max_created_at, status, updated_at",
          ") VALUES (",
          "  :capsule_id, 'usearch', 'keiko_lk_vec_1536_cosine', 1536, 'cosine',",
          "  'obsolete-v1-identity-test-key', 1, 1000,",
          "  'ready', 1000",
          ")",
        ].join(" "),
      )
      .run({ capsule_id: String(fixture.capsuleId) });
    const before = fixture.store._internal.db
      .prepare("SELECT COUNT(*) AS n FROM vector_index_state WHERE capsule_id = :capsule_id")
      .get({ capsule_id: String(fixture.capsuleId) }) as { readonly n: number };
    expect(before.n).toBe(1);

    await drain(runIndexingJob(buildOptions(fixture, { force: true })));

    const after = fixture.store._internal.db
      .prepare("SELECT status FROM vector_index_state WHERE capsule_id = :capsule_id")
      .get({ capsule_id: String(fixture.capsuleId) }) as { readonly status: string };
    expect(after.status).toBe("dirty");
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

      expect(events.filter((event) => event.kind === "document-embedded")).toHaveLength(1);
      expect(countVectorsForSource(multi, multi.sourceId)).toBe(firstSourceVectors);
      expect(countVectorsForSource(multi, multi.otherSourceId)).toBe(otherSourceVectors);
    } finally {
      multi.cleanup();
    }
  });
  it("re-chunks from new source text when force=true after content change", async () => {
    const v1Fs = memoryFs(ROOT, [
      { relativePath: "alpha.txt", content: "Version one content sentence. ".repeat(8) },
    ]);
    const v2Fs = memoryFs(ROOT, [
      {
        relativePath: "alpha.txt",
        content: "Entirely different version two text here. ".repeat(8),
      },
    ]);

    await drain(runIndexingJob(buildOptions(fixture, { workspaceFs: v1Fs })));

    const documentId = documentIdFor({
      capsuleId: fixture.capsuleId,
      sourceId: fixture.sourceId,
      relativePath: "alpha.txt",
    });
    const v1Chunks = selectChunksForDocument(
      fixture.store._internal.db,
      fixture.capsuleId,
      documentId,
    );
    expect(v1Chunks.length).toBeGreaterThan(0);
    const v1Hashes = new Set(v1Chunks.map((c) => c.safe_excerpt_hash));

    // Force re-index with changed content. Without the fix, chunkDocument receives
    // force=undefined and skips re-chunking (shouldReuseExistingChunks returns true),
    // leaving v1 chunk rows in place. With the fix, force=true deletes old chunks and
    // re-chunks from the new parsed units, producing different safe_excerpt_hash values.
    const events = await drain(
      runIndexingJob(buildOptions(fixture, { force: true, workspaceFs: v2Fs })),
    );
    expect(events.some((e) => e.kind === "document-embedded")).toBe(true);

    const v2Chunks = selectChunksForDocument(
      fixture.store._internal.db,
      fixture.capsuleId,
      documentId,
    );
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

  it("marks scanned PDFs without OCR as unsupported and skips grounding work", async () => {
    const imageFixture = buildFixture({ "scan.pdf": PDF_NO_TEXT_LAYER });
    try {
      const events = await drain(runIndexingJob(buildOptions(imageFixture)));
      const documentId = documentIdFor({
        capsuleId: imageFixture.capsuleId,
        sourceId: imageFixture.sourceId,
        relativePath: "scan.pdf",
      });
      const row = readExistingDocumentRow(
        imageFixture.store._internal.db,
        imageFixture.capsuleId,
        documentId,
      );
      const pageCount = imageFixture.store._internal.db
        .prepare("SELECT COUNT(*) AS n FROM pages WHERE capsule_id = :c AND document_id = :d")
        .get({ c: imageFixture.capsuleId, d: String(documentId) }) as { readonly n: number };

      expect(row?.status).toBe("unsupported");
      expect(pageCount.n).toBe(1);
      expect(
        events.some((event) => event.kind === "document-skipped" && event.reason === "unsupported"),
      ).toBe(true);
      expect(events.some((event) => event.kind === "document-failed")).toBe(false);
      expect(events.some((event) => event.kind === "document-embedded")).toBe(false);
    } finally {
      imageFixture.cleanup();
    }
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
  }, 15_000);
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

  it("fails before discovery when the gateway reports different embedding dimensions", async () => {
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
            vector: deterministicVector(req.input, DEFAULT_EMBEDDING.vectorDimensions + 1),
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
        "embedding vector dimensions do not match the expected value",
      );
      expect(terminal.result.processedDocuments).toBe(0);
      expect(terminal.result.vectorsPersisted).toBe(0);
    }
  });

  it("continues indexing when only a hardened embedding-space fingerprint drifts", async () => {
    fixture.cleanup();
    const hardenedIdentity: EmbeddingModelIdentity = {
      ...DEFAULT_EMBEDDING,
      normalization: "l2",
      instructionVersion: "keiko-embedding-input-v1",
      embeddingSpaceFingerprint: "keiko-embedding-space-fingerprint-v1:aaaaaaaaaaaaaaaaaaaaaaaa",
    };
    fixture = buildFixture(
      {
        "alpha.txt": "Lorem ipsum dolor sit amet. ".repeat(8),
      },
      hardenedIdentity,
    );

    let requestCount = 0;
    const adapter = scriptedAdapter({
      responder: (req) => {
        requestCount += 1;
        return {
          ok: true,
          value: {
            vector: deterministicVector(req.input, hardenedIdentity.vectorDimensions),
            modelId: hardenedIdentity.modelId,
          },
        };
      },
    });

    const events = await drain(
      runIndexingJob(buildOptions(fixture, { embeddingAdapter: adapter, force: true })),
    );

    expect(requestCount).toBeGreaterThan(4);
    expect(countVectorsForCapsule(fixture.store._internal.db, fixture.capsuleId)).toBeGreaterThan(
      0,
    );
    expect(events.some((event) => event.kind === "document-discovered")).toBe(true);
    expect(events.some((event) => event.kind === "document-embedded")).toBe(true);
    const terminal = events.at(-1);
    expect(terminal?.kind).toBe("job-completed");
    if (terminal?.kind === "job-completed") {
      expect(terminal.result.status).toBe("succeeded");
      expect(terminal.result.processedDocuments).toBe(1);
      expect(terminal.result.vectorsPersisted).toBeGreaterThan(0);
    }
  });

  it("reuses a recent preflight until the injected clock expires its cache entry", async () => {
    let requestCount = 0;
    let now = 1_000;
    const embeddingPreflightCacheScope = {};
    const adapter = scriptedAdapter({
      responder: (request) => {
        requestCount += 1;
        return {
          ok: true,
          value: {
            vector: deterministicVector(request.input, DEFAULT_EMBEDDING.vectorDimensions),
            modelId: DEFAULT_EMBEDDING.modelId,
          },
        };
      },
    });

    const options = {
      embeddingAdapter: adapter,
      embeddingPreflightCacheScope,
      now: (): number => now,
    };
    const first = await drain(runIndexingJob(buildOptions(fixture, options)));
    const requestsAfterFirstRun = requestCount;
    const second = await drain(runIndexingJob(buildOptions(fixture, options)));

    expect(first.at(-1)?.kind).toBe("job-completed");
    expect(second.at(-1)?.kind).toBe("job-completed");
    expect(requestsAfterFirstRun).toBeGreaterThan(0);
    expect(requestCount).toBe(requestsAfterFirstRun);

    now += 10 * 60 * 1_000 + 1;
    const third = await drain(runIndexingJob(buildOptions(fixture, options)));
    expect(third.at(-1)?.kind).toBe("job-completed");
    expect(requestCount).toBeGreaterThan(requestsAfterFirstRun);
  });

  it("does not reuse an unconstrained preflight for a different expected dimension", async () => {
    fixture.cleanup();
    fixture = buildFixture(
      { "alpha.txt": "Provisional source text. ".repeat(8) },
      provisionalDefaultEmbedding(),
    );
    let requestCount = 0;
    const adapter = scriptedAdapter({
      responder: (request) => {
        requestCount += 1;
        return {
          ok: true,
          value: {
            vector: deterministicVector(request.input, DEFAULT_EMBEDDING.vectorDimensions),
            modelId: DEFAULT_EMBEDDING.modelId,
          },
        };
      },
    });
    const embeddingPreflightCacheScope = {};

    await drain(
      runIndexingJob(
        buildOptions(fixture, { embeddingAdapter: adapter, embeddingPreflightCacheScope }),
      ),
    );
    const requestsAfterUnconstrainedRun = requestCount;
    updateCapsuleEmbeddingModelIdentity(fixture.store, fixture.capsuleId, {
      ...DEFAULT_EMBEDDING,
      vectorDimensions: DEFAULT_EMBEDDING.vectorDimensions + 1,
    });
    const constrained = await drain(
      runIndexingJob(
        buildOptions(fixture, {
          embeddingAdapter: adapter,
          embeddingPreflightCacheScope,
        }),
      ),
    );

    expect(requestCount).toBeGreaterThan(requestsAfterUnconstrainedRun);
    expect(constrained.at(-1)?.kind).toBe("job-failed");
  });

  it("does not reuse a constrained preflight for a later unconstrained lane", async () => {
    const provisionalFixture = buildFixture(
      { "beta.txt": "Provisional source text. ".repeat(8) },
      provisionalDefaultEmbedding(),
    );
    let requestCount = 0;
    const adapter = scriptedAdapter({
      responder: (request) => {
        requestCount += 1;
        return {
          ok: true,
          value: {
            vector: deterministicVector(request.input, DEFAULT_EMBEDDING.vectorDimensions),
            modelId: DEFAULT_EMBEDDING.modelId,
          },
        };
      },
    });
    const embeddingPreflightCacheScope = {};

    try {
      await drain(
        runIndexingJob(
          buildOptions(fixture, { embeddingAdapter: adapter, embeddingPreflightCacheScope }),
        ),
      );
      const requestsAfterConstrainedRun = requestCount;
      await drain(
        runIndexingJob(
          buildOptions(provisionalFixture, {
            embeddingAdapter: adapter,
            embeddingPreflightCacheScope,
          }),
        ),
      );
      expect(requestCount).toBeGreaterThan(requestsAfterConstrainedRun);
    } finally {
      provisionalFixture.cleanup();
    }
  });

  it("re-verifies an unverified identity after a failed first run instead of freezing the guess", async () => {
    fixture.cleanup();
    fixture = buildFixture(
      { "alpha.txt": "Provisional source text. ".repeat(8) },
      {
        ...provisionalDefaultEmbedding(),
        // Creation-time dimension GUESS (derived from the model name, never verified).
        vectorDimensions: DEFAULT_EMBEDDING.vectorDimensions + 1,
      },
    );
    const unreachable = scriptedAdapter({
      responder: () => ({ ok: false, kind: "transport" }),
    });
    const first = await drain(
      runIndexingJob(buildOptions(fixture, { embeddingAdapter: unreachable })),
    );
    expect(first.at(-1)?.kind).toBe("job-failed");
    expect(getCapsule(fixture.store, fixture.capsuleId)?.lifecycleState).toBe("error");

    // Gateway repaired: the next plain run must adopt the VERIFIED identity (real dimensions
    // plus fingerprint) instead of failing INCOMPATIBLE_EMBEDDING_IDENTITY on the stale guess.
    const second = await drain(runIndexingJob(buildOptions(fixture)));
    expect(second.at(-1)?.kind).toBe("job-completed");
    const identity = getCapsule(fixture.store, fixture.capsuleId)?.embeddingModelIdentity;
    expect(identity?.vectorDimensions).toBe(DEFAULT_EMBEDDING.vectorDimensions);
    expect(identity?.embeddingSpaceFingerprint).toBeDefined();
  });

  it("indexes an HTML-manual folder end to end after the gateway recovers", async () => {
    // The full customer flow in one pin: a fresh pod bound to a non-OpenAI embedding model
    // (creation-time dimension guess WRONG), a folder source of .htm manual pages, a first run
    // against an unreachable gateway, then a repaired gateway. The pod must recover on its own
    // and index the complete corpus — no delete/recreate, no force re-embed.
    fixture.cleanup();
    fixture = buildFixture(
      {
        "manual/index.htm":
          "<!doctype html><html><head><title>Manual</title></head><body><nav>Navigation</nav>" +
          "<main><h1>Securities Deposit</h1><p>Functional description of the READ_DEPOSIT function." +
          " ".repeat(4) +
          "</p></main><footer>Imprint</footer></body></html>",
        "manual/READ_DEPOSIT_functional.htm":
          "<html><body><script>var ignored = 1;</script>" +
          "<p>READ_DEPOSIT reads a deposit and returns its master data.</p></body></html>",
        "manual/READ_DEPOSIT_parameters.htm":
          "<html><body><style>.x{color:red}</style>" +
          "<table><tr><td>Parameter</td><td>depositId</td></tr></table></body></html>",
      },
      {
        ...provisionalDefaultEmbedding(),
        vectorDimensions: DEFAULT_EMBEDDING.vectorDimensions + 1,
      },
    );
    const unreachable = scriptedAdapter({
      responder: () => ({ ok: false, kind: "transport" }),
    });
    const first = await drain(
      runIndexingJob(buildOptions(fixture, { embeddingAdapter: unreachable })),
    );
    expect(first.at(-1)?.kind).toBe("job-failed");

    const second = await drain(runIndexingJob(buildOptions(fixture)));
    const terminal = second.at(-1);
    expect(terminal?.kind).toBe("job-completed");
    if (terminal?.kind === "job-completed") {
      expect(terminal.result.processedDocuments).toBe(3);
      expect(terminal.result.failedDocuments).toBe(0);
      expect(terminal.result.vectorsPersisted).toBeGreaterThan(0);
    }
    const capsule = getCapsule(fixture.store, fixture.capsuleId);
    expect(capsule?.lifecycleState).toBe("ready");
    expect(capsule?.embeddingModelIdentity.vectorDimensions).toBe(
      DEFAULT_EMBEDDING.vectorDimensions,
    );
  });

  it("never rebinds an unverified identity while vectors exist, even in draft lifecycle", async () => {
    // The vector guard must be unconditional: a fingerprint-less capsule that somehow owns
    // vectors keeps the strict incompatibility gate regardless of lifecycle state — a draft
    // shortcut bypassing it would silently mix embedding spaces.
    fixture.cleanup();
    fixture = buildFixture(
      { "alpha.txt": "Provisional source text. ".repeat(8) },
      provisionalDefaultEmbedding(),
    );
    const first = await drain(runIndexingJob(buildOptions(fixture)));
    expect(first.at(-1)?.kind).toBe("job-completed");
    expect(countVectorsForCapsule(fixture.store._internal.db, fixture.capsuleId)).toBeGreaterThan(
      0,
    );

    const staleDims = DEFAULT_EMBEDDING.vectorDimensions + 1;
    updateCapsuleEmbeddingModelIdentity(fixture.store, fixture.capsuleId, {
      ...provisionalDefaultEmbedding(),
      vectorDimensions: staleDims,
    });
    updateCapsuleState(fixture.store, fixture.capsuleId, "draft");

    const second = await drain(runIndexingJob(buildOptions(fixture)));
    const terminal = second.at(-1);
    expect(terminal?.kind).toBe("job-failed");
    if (terminal?.kind === "job-failed") {
      expect(terminal.error.code).toBe("INCOMPATIBLE_EMBEDDING_IDENTITY");
    }
    expect(
      getCapsule(fixture.store, fixture.capsuleId)?.embeddingModelIdentity.vectorDimensions,
    ).toBe(staleDims);
  });

  it("keeps enforcing an unverified identity once the capsule owns vectors", async () => {
    fixture.cleanup();
    fixture = buildFixture(
      { "alpha.txt": "Provisional source text. ".repeat(8) },
      provisionalDefaultEmbedding(),
    );
    const first = await drain(runIndexingJob(buildOptions(fixture)));
    expect(first.at(-1)?.kind).toBe("job-completed");
    expect(countVectorsForCapsule(fixture.store._internal.db, fixture.capsuleId)).toBeGreaterThan(
      0,
    );

    // A legacy capsule: vectors exist, the identity carries no fingerprint, and the stored
    // dimensions no longer match the live model. Adopting the live identity here would
    // silently mix embedding spaces — the run must fail incompatible instead.
    const staleDims = DEFAULT_EMBEDDING.vectorDimensions + 1;
    updateCapsuleEmbeddingModelIdentity(fixture.store, fixture.capsuleId, {
      ...provisionalDefaultEmbedding(),
      vectorDimensions: staleDims,
    });
    const second = await drain(runIndexingJob(buildOptions(fixture)));
    const terminal = second.at(-1);
    expect(terminal?.kind).toBe("job-failed");
    if (terminal?.kind === "job-failed") {
      expect(terminal.error.code).toBe("INCOMPATIBLE_EMBEDDING_IDENTITY");
    }
    expect(
      getCapsule(fixture.store, fixture.capsuleId)?.embeddingModelIdentity.vectorDimensions,
    ).toBe(staleDims);
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
          return { ok: false, kind: "invalid-response" };
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
    expect(embedded).toHaveLength(2);
    // Job-level outcome: completed (because at least one doc succeeded).
    expect(events.at(-1)?.kind).toBe("job-completed");
  });
});

// ─── Gateway-outage circuit breaker + honest terminal status (2026-08 field review) ─────────
// A dead gateway used to grind EVERY remaining document through the full transient-retry
// ladder — days of nothing on a large corpus — and a run with most documents failed still
// reported "succeeded" and flipped the capsule to "ready" while the corpus was absent from
// retrieval. The breaker aborts on consecutive transient failures; the status rule refuses
// "succeeded" when failures outnumber processed documents.

const INSTANT_RETRY = {
  maxRetries: 0,
  baseDelayMs: 0,
  sleep: (): Promise<void> => Promise.resolve(),
};

function isProbeInput(input: string): boolean {
  return input === "ping" || input.startsWith("Keiko embedding space probe");
}

function okVector(input: string): OpenAIEmbeddingOutcome {
  return {
    ok: true,
    value: {
      vector: deterministicVector(input, DEFAULT_EMBEDDING.vectorDimensions),
      modelId: DEFAULT_EMBEDDING.modelId,
    },
  };
}

describe("runIndexingJob — gateway-outage circuit breaker", () => {
  const corpus = Object.fromEntries(
    ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta"].map((name) => [
      `${name}.txt`,
      `Document ${name} content. `.repeat(8),
    ]),
  );

  it("aborts after consecutive transient failures instead of grinding every document", async () => {
    const fixture = buildFixture(corpus);
    try {
      // Preflight passes (the gateway was healthy at job start), then the gateway dies:
      // every chunk embedding times out — the transient shape a dead or saturated
      // gateway produces.
      const adapter = scriptedAdapter({
        responder: (req) =>
          isProbeInput(req.input) ? okVector(req.input) : { ok: false, kind: "timeout" },
      });
      const events = await drain(
        runIndexingJob(
          buildOptions(fixture, { embeddingAdapter: adapter, embedRetry: INSTANT_RETRY }),
        ),
      );

      const terminal = events.at(-1);
      expect(terminal?.kind).toBe("job-failed");
      if (terminal?.kind === "job-failed") {
        expect(terminal.error.code).toBe(EMBEDDING_GATEWAY_UNAVAILABLE_CODE);
      }
      // The run stopped at the breaker limit — the remaining documents were NOT ground
      // through the retry ladder against a dead gateway.
      const failed = events.filter((e) => e.kind === "document-failed");
      expect(failed).toHaveLength(CONSECUTIVE_TRANSIENT_FAILURE_LIMIT);
      expect(Object.keys(corpus).length).toBeGreaterThan(CONSECUTIVE_TRANSIENT_FAILURE_LIMIT);
      const capsule = getCapsule(fixture.store, fixture.capsuleId);
      expect(capsule?.lifecycleState).toBe("error");
    } finally {
      fixture.cleanup();
    }
  });

  it("does not trip on sub-threshold transient failures or deterministic ones", async () => {
    const fixture = buildFixture({
      "alpha.txt": "Lorem ipsum dolor. ".repeat(8),
      "beta.txt": "Pack my box. ".repeat(8),
      "gamma.txt": "Sphinx of black quartz. ".repeat(8),
    });
    try {
      // One transient failure (alpha), two successes: far below the limit, and a success
      // resets the streak — the job completes with a per-document failure, exactly as before.
      const adapter = scriptedAdapter({
        responder: (req) =>
          !isProbeInput(req.input) && req.input.startsWith("Lorem")
            ? { ok: false, kind: "timeout" }
            : okVector(req.input),
      });
      const events = await drain(
        runIndexingJob(
          buildOptions(fixture, { embeddingAdapter: adapter, embedRetry: INSTANT_RETRY }),
        ),
      );
      expect(events.at(-1)?.kind).toBe("job-completed");
      expect(events.filter((e) => e.kind === "document-failed")).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });

  it("counts only transient adapter failures — deterministic rejections never open the breaker", async () => {
    const fixture = buildFixture(corpus);
    try {
      // Every document fails DETERMINISTICALLY (malformed response). That is not gateway-outage
      // evidence: the breaker must stay closed and every document must be attempted, ending in
      // the all-failed terminal state — not the gateway-unavailable abort.
      const adapter = scriptedAdapter({
        responder: (req) =>
          isProbeInput(req.input) ? okVector(req.input) : { ok: false, kind: "invalid-response" },
      });
      const events = await drain(
        runIndexingJob(
          buildOptions(fixture, { embeddingAdapter: adapter, embedRetry: INSTANT_RETRY }),
        ),
      );
      const terminal = events.at(-1);
      expect(terminal?.kind).toBe("job-failed");
      if (terminal?.kind === "job-failed") {
        expect(terminal.error.code).not.toBe(EMBEDDING_GATEWAY_UNAVAILABLE_CODE);
      }
      expect(events.filter((e) => e.kind === "document-failed")).toHaveLength(
        Object.keys(corpus).length,
      );
    } finally {
      fixture.cleanup();
    }
  });
});

describe("runIndexingJob — honest terminal status on overwhelming failure", () => {
  it("reports failed but keeps the usable index retrievable when failures outnumber processed documents", async () => {
    const fixture = buildFixture({
      "alpha.txt": "Lorem ipsum dolor. ".repeat(8),
      "beta.txt": "Pack my box. ".repeat(8),
      "gamma.txt": "Sphinx of black quartz. ".repeat(8),
    });
    try {
      // Two of three documents fail deterministically; one succeeds. The old rule reported
      // SUCCEEDED (processedDocuments > 0) while most of the corpus was silently absent from
      // retrieval. The JOB must fail loudly — but the capsule keeps its usable partial index
      // (grounded surfaces hard-refuse "error" capsules, so demoting it would also take the
      // successfully indexed documents offline).
      const adapter = scriptedAdapter({
        responder: (req) =>
          !isProbeInput(req.input) && req.input.startsWith("Pack")
            ? okVector(req.input)
            : isProbeInput(req.input)
              ? okVector(req.input)
              : { ok: false, kind: "invalid-response" },
      });
      const events = await drain(
        runIndexingJob(
          buildOptions(fixture, { embeddingAdapter: adapter, embedRetry: INSTANT_RETRY }),
        ),
      );
      const terminal = events.at(-1);
      expect(terminal?.kind).toBe("job-failed");
      if (terminal?.kind === "job-failed") {
        expect(terminal.error.code).toBe("MAJORITY_DOCUMENTS_FAILED");
        expect(terminal.result.processedDocuments).toBe(1);
        expect(terminal.result.failedDocuments).toBe(2);
      }
      const capsule = getCapsule(fixture.store, fixture.capsuleId);
      expect(capsule?.lifecycleState).toBe("ready");
    } finally {
      fixture.cleanup();
    }
  });

  it("fails a run whose only outcomes are discovery failures — zero progress is never a success", async () => {
    // Review finding on #3221 proposed excluding discovery failures from the zero-progress rule
    // for symmetry with the majority ratio. The two rules answer different questions: the ratio
    // scores the corpus the run SAW, while this rule guards a run that saw NOTHING succeed.
    // With zero processed and zero skipped documents, a discovery-only failure run covered none
    // of its corpus — reporting it "succeeded" would be a lie. The raw count stays authoritative.
    const { store, cleanup } = freshStore();
    const capsuleId = "cap-orch" as KnowledgeCapsuleId;
    createCapsule(
      store,
      sampleCapsuleInput({ id: capsuleId, modelUsePolicy: standardPodModelUsePolicy() }),
    );
    const source = addSourceToCapsule(store, capsuleId, {
      id: "src-orch" as KnowledgeSourceId,
      displayName: "orch",
      tags: [],
      scope: folderScope(ROOT, { recursive: true }),
    });
    // An unreadable walk root — the shape a torn mount or revoked permission produces in the
    // field: the whole run yields exactly one READ_FAILED scope-error and no document work.
    const unreadableFs: WorkspaceFs = {
      ...memoryFs(ROOT, []),
      readDir: (): never => {
        throw new Error("EACCES: permission denied");
      },
    };
    const fixture: Fixture = {
      store,
      cleanup,
      capsuleId,
      sourceId: source.id,
      source,
      fs: unreadableFs,
    };
    try {
      const events = await drain(runIndexingJob(buildOptions(fixture)));
      const terminal = events.at(-1);
      expect(terminal?.kind).toBe("job-failed");
      if (terminal?.kind === "job-failed") {
        expect(terminal.result.processedDocuments).toBe(0);
        expect(terminal.result.failedDocuments).toBeGreaterThan(0);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps a repair-style delta run succeeded when the healthy corpus is skipped alongside it", async () => {
    // Adversarial-review finding: a run-scoped ratio measured only the delta, so a repair run
    // fixing 1 of 3 stragglers on an otherwise healthy corpus reported MAJORITY_DOCUMENTS_FAILED
    // and (old semantics) blacked out the whole pod. Skipped (verified-unchanged) documents are
    // healthy-corpus evidence and belong in the denominator.
    const fixture = buildFixture({
      "good-one.txt": "Healthy document one. ".repeat(8),
      "good-two.txt": "Healthy document two. ".repeat(8),
      "good-three.txt": "Healthy document three. ".repeat(8),
      "bad-one.txt": "Broken document one. ".repeat(8),
      "bad-two.txt": "Broken document two. ".repeat(8),
    });
    try {
      const failBroken = scriptedAdapter({
        responder: (req) =>
          !isProbeInput(req.input) && req.input.startsWith("Broken")
            ? { ok: false, kind: "invalid-response" }
            : okVector(req.input),
      });
      // First run: 3 healthy documents index, 2 fail — minority failure, job completes.
      const first = await drain(
        runIndexingJob(
          buildOptions(fixture, { embeddingAdapter: failBroken, embedRetry: INSTANT_RETRY }),
        ),
      );
      expect(first.at(-1)?.kind).toBe("job-completed");

      // Delta run: the 3 healthy documents are skipped as unchanged; the 2 broken ones fail
      // again. Run-scoped ratio would say 2 failed > 0 processed... but the corpus is fine.
      const second = await drain(
        runIndexingJob(
          buildOptions(fixture, { embeddingAdapter: failBroken, embedRetry: INSTANT_RETRY }),
        ),
      );
      const terminal = second.at(-1);
      expect(terminal?.kind).toBe("job-completed");
      if (terminal?.kind === "job-completed") {
        expect(terminal.result.skippedDocuments).toBe(3);
        expect(terminal.result.failedDocuments).toBe(2);
      }
      expect(getCapsule(fixture.store, fixture.capsuleId)?.lifecycleState).toBe("ready");
    } finally {
      fixture.cleanup();
    }
  });

  it("never counts walk-level discovery diagnostics as failed attempts in the ratio", async () => {
    // Adversarial-review finding: LIMIT_REACHED can surface once per ancestor frame, so a
    // truncated deep tree could out-count the processed documents and flip an otherwise
    // healthy truncated run to failed. Walk diagnostics are not attempted documents.
    const fixture = buildFixture({
      "top.txt": "Top level document. ".repeat(8),
      "a/nested-one.txt": "Nested document one. ".repeat(8),
      "a/b/nested-two.txt": "Nested document two. ".repeat(8),
      "a/b/c/nested-three.txt": "Nested document three. ".repeat(8),
    });
    try {
      const events = await drain(
        runIndexingJob(
          buildOptions(fixture, {
            embedRetry: INSTANT_RETRY,
            discoveryOptions: { maxFiles: 1, maxDepth: 12 },
          }),
        ),
      );
      const terminal = events.at(-1);
      // One document indexed; every other document-failed is a LIMIT_REACHED walk frame.
      expect(terminal?.kind).toBe("job-completed");
      if (terminal?.kind === "job-completed") {
        expect(terminal.result.processedDocuments).toBe(1);
      }
    } finally {
      fixture.cleanup();
    }
  });
});

describe("runIndexingJob — breaker gateway evidence (adversarial re-verification)", () => {
  it("never trips on a live-but-flaky gateway where every document keeps some answered chunks", async () => {
    // Each document large enough to chunk multiple times: the FIRST chunk of each document
    // times out, the rest answer. Documents fail — but every one of them carries persisted
    // vectors, which is proof the gateway is alive. The breaker must stay closed and every
    // document must be attempted.
    // The poison sentence rides at the END of a multi-chunk document, so the earlier chunks
    // answer and persist vectors before the final chunk times out — a genuinely flaky (not
    // dead) gateway, robust to chunk-boundary placement.
    const flakyCorpus = Object.fromEntries(
      ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta"].map((name) => [
        `${name}.txt`,
        `Follow-up ${name} content sentence. `.repeat(400) + `POISON ${name} tail.`,
      ]),
    );
    const fixture = buildFixture(flakyCorpus);
    try {
      const adapter = scriptedAdapter({
        responder: (req) =>
          !isProbeInput(req.input) && req.input.includes("POISON")
            ? { ok: false, kind: "timeout" }
            : okVector(req.input),
      });
      const events = await drain(
        runIndexingJob(
          buildOptions(fixture, { embeddingAdapter: adapter, embedRetry: INSTANT_RETRY }),
        ),
      );
      // Every document legitimately fails (its poison chunk), so an honest job-failed is
      // expected — but it must be the MAJORITY classification, never the gateway-outage
      // abort, and every document must have been ATTEMPTED instead of abandoned early.
      const terminal = events.at(-1);
      expect(terminal?.kind).toBe("job-failed");
      if (terminal?.kind === "job-failed") {
        expect(terminal.error.code).not.toBe(EMBEDDING_GATEWAY_UNAVAILABLE_CODE);
      }
      const failed = events.filter((e) => e.kind === "document-failed");
      expect(failed.length + events.filter((e) => e.kind === "document-embedded").length).toBe(
        Object.keys(flakyCorpus).length,
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("does not let zero-chunk documents reset the outage streak they never observed", async () => {
    // Empty documents contact no gateway. Interleaved between transient failures they must
    // not launder the streak — the breaker still trips at the limit.
    // Walk order is lexicographic: empties genuinely INTERLEAVE with the transient failures.
    const fixture = buildFixture({
      "a-fail.txt": "Content one. ".repeat(8),
      "b-empty.html": "<html><body>   </body></html>",
      "c-fail.txt": "Content two. ".repeat(8),
      "d-empty.html": "<html><body> </body></html>",
      "e-fail.txt": "Content three. ".repeat(8),
      "f-fail.txt": "Content four. ".repeat(8),
      "g-fail.txt": "Content five. ".repeat(8),
      "h-fail.txt": "Content six. ".repeat(8),
    });
    try {
      const adapter = scriptedAdapter({
        responder: (req) =>
          isProbeInput(req.input) ? okVector(req.input) : { ok: false, kind: "timeout" },
      });
      const events = await drain(
        runIndexingJob(
          buildOptions(fixture, { embeddingAdapter: adapter, embedRetry: INSTANT_RETRY }),
        ),
      );
      const terminal = events.at(-1);
      expect(terminal?.kind).toBe("job-failed");
      if (terminal?.kind === "job-failed") {
        expect(terminal.error.code).toBe(EMBEDDING_GATEWAY_UNAVAILABLE_CODE);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("resets the streak on an answered deterministic rejection — the gateway is alive", async () => {
    // A gateway that ANSWERS (even with a deterministic 4xx-shaped rejection) is not down.
    // Four transient failures, one answered rejection, four more transient failures: the
    // streak never reaches the limit and every document is attempted.
    // Walk order is lexicographic: exactly four timeouts, then the answered rejection, then
    // four more timeouts — the streak peaks at four on either side of the reset.
    const names = ["a1", "a2", "a3", "a4", "m-answered", "z1", "z2", "z3", "z4"];
    const fixture = buildFixture(
      Object.fromEntries(names.map((name) => [`${name}.txt`, `Doc ${name} content. `.repeat(8)])),
    );
    try {
      const adapter = scriptedAdapter({
        responder: (req) => {
          if (isProbeInput(req.input)) return okVector(req.input);
          if (req.input.startsWith("Doc m-answered"))
            return { ok: false, kind: "invalid-response" };
          return { ok: false, kind: "timeout" };
        },
      });
      const events = await drain(
        runIndexingJob(
          buildOptions(fixture, { embeddingAdapter: adapter, embedRetry: INSTANT_RETRY }),
        ),
      );
      const terminal = events.at(-1);
      if (terminal?.kind === "job-failed") {
        expect(terminal.error.code).not.toBe(EMBEDDING_GATEWAY_UNAVAILABLE_CODE);
      }
      expect(events.filter((e) => e.kind === "document-failed")).toHaveLength(names.length);
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps a previously indexed capsule retrievable when the breaker aborts a delta refresh", async () => {
    // Adversarial-review finding: the breaker abort used to flip the capsule to "error",
    // taking thousands of intact, already-indexed documents out of grounded retrieval over a
    // five-document gateway blip. The index survived — the capsule must stay ready; the failed
    // job carries the outage in its history.
    const healthy = Object.fromEntries(
      ["one", "two", "three"].map((name) => [
        `${name}.txt`,
        `Established document ${name}. `.repeat(8),
      ]),
    );
    const fixture = buildFixture(healthy);
    try {
      const first = await drain(
        runIndexingJob(buildOptions(fixture, { embedRetry: INSTANT_RETRY })),
      );
      expect(first.at(-1)?.kind).toBe("job-completed");

      // The gateway dies; a delta of new documents arrives (memoryFs is immutable, so run 2
      // injects a widened filesystem over the same store and capsule).
      const widenedFs = memoryFs(ROOT, [
        ...Object.entries(healthy).map(([relativePath, content]) => ({ relativePath, content })),
        ...["n1", "n2", "n3", "n4", "n5", "n6"].map((name) => ({
          relativePath: `${name}.txt`,
          content: `Late delta document ${name}. `.repeat(8),
        })),
      ]);
      const dead = scriptedAdapter({
        responder: (req) =>
          isProbeInput(req.input) ? okVector(req.input) : { ok: false, kind: "timeout" },
      });
      const second = await drain(
        runIndexingJob(
          buildOptions(fixture, {
            embeddingAdapter: dead,
            embedRetry: INSTANT_RETRY,
            workspaceFs: widenedFs,
          }),
        ),
      );
      const terminal = second.at(-1);
      expect(terminal?.kind).toBe("job-failed");
      if (terminal?.kind === "job-failed") {
        expect(terminal.error.code).toBe(EMBEDDING_GATEWAY_UNAVAILABLE_CODE);
      }
      expect(getCapsule(fixture.store, fixture.capsuleId)?.lifecycleState).toBe("ready");
    } finally {
      fixture.cleanup();
    }
  });
});

describe("runIndexingJob — document snapshot restore atomicity", () => {
  it("rolls back every restored row when reinsertion fails mid-snapshot", async () => {
    const fixture = buildFixture({
      "large.txt": "Known-good indexed content with many distinct sections. ".repeat(400),
    });
    const documentId = documentIdFor({
      capsuleId: fixture.capsuleId,
      sourceId: fixture.sourceId,
      relativePath: "large.txt",
    });
    const db = fixture.store._internal.db;
    const originalPrepare = db.prepare.bind(db);
    const tables = [
      "parsed_units",
      "chunks",
      "chunk_lexical_index",
      "repository_chunk_line_ranges",
      "vectors",
    ] as const;
    const persistenceState = (): unknown => ({
      tables: Object.fromEntries(
        tables.map((table) => [
          table,
          originalPrepare(
            `SELECT * FROM ${table} WHERE capsule_id = :c AND document_id = :d ORDER BY rowid`,
          ).all({ c: fixture.capsuleId, d: documentId }),
        ]),
      ),
      document: originalPrepare("SELECT * FROM documents WHERE capsule_id = :c AND id = :d").get({
        c: fixture.capsuleId,
        d: documentId,
      }),
    });

    try {
      await drain(runIndexingJob(buildOptions(fixture)));
      expect(countVectorsForDocument(db, fixture.capsuleId, documentId)).toBeGreaterThan(1);

      let restoreExpected = false;
      let restoredChunkInserts = 0;
      let beforeRestore: unknown;
      db.prepare = (sql: string): ReturnType<typeof originalPrepare> => {
        if (restoreExpected && sql.startsWith("DELETE FROM parsed_units")) {
          beforeRestore = persistenceState();
        }
        if (restoreExpected && sql.startsWith("INSERT INTO chunks")) {
          restoredChunkInserts += 1;
          if (restoredChunkInserts === 2) throw new Error("injected restore insert failure");
        }
        return originalPrepare(sql);
      };
      const failingAdapter = scriptedAdapter({
        responder: (request) => {
          if (!isEmbeddingCapabilityProbe(request.input)) {
            restoreExpected = true;
            return { ok: false, kind: "invalid-response" };
          }
          return {
            ok: true,
            value: {
              vector: deterministicVector(request.input, DEFAULT_EMBEDDING.vectorDimensions),
              modelId: DEFAULT_EMBEDDING.modelId,
            },
          };
        },
      });
      const changedFs = memoryFs(ROOT, [
        {
          relativePath: "large.txt",
          content: "Changed content that must remain intact when restoration itself fails. ".repeat(
            400,
          ),
        },
      ]);

      await expect(
        drain(
          runIndexingJob(
            buildOptions(fixture, { embeddingAdapter: failingAdapter, workspaceFs: changedFs }),
          ),
        ),
      ).rejects.toBeDefined();
      expect(beforeRestore).toBeDefined();
      expect(persistenceState()).toStrictEqual(beforeRestore);
    } finally {
      db.prepare = originalPrepare;
      fixture.cleanup();
    }
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
      expect(events.filter((e) => e.kind === "document-embedded")).toHaveLength(9);
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

  // Relocated pin (2026-08 field review): the DEFAULT used to double as a hard ceiling —
  // Math.min(default, value) — so an operator could lower the walk bounds but never raise
  // them, and a corpus above the default was silently truncated forever. The runaway
  // invariant the old clamp provided lives on in the explicit CEILING.
  it("lets a caller raise discovery bounds up to the runaway ceiling — never beyond", async () => {
    const withinRaisedDepth = `${Array.from({ length: 13 }, (_unused, i) => `d${String(i)}`).join("/")}/deep.txt`;
    const beyondCeiling = `${Array.from({ length: 65 }, (_unused, i) => `e${String(i)}`).join("/")}/too-deep.txt`;
    const single = buildFixture({
      "root.txt": "root document",
      [withinRaisedDepth]: "deep document",
      [beyondCeiling]: "unreachably deep document",
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
      // Raising past the old default now works…
      expect(discovered).toContain(withinRaisedDepth);
      // …but an absurd caller value still cannot demand an unbounded walk.
      expect(discovered).not.toContain(beyondCeiling);
    } finally {
      single.cleanup();
    }
  });

  it("keeps the built-in defaults when the caller passes no discovery options", async () => {
    const deepPath = `${Array.from({ length: 13 }, (_unused, i) => `d${String(i)}`).join("/")}/deep.txt`;
    const single = buildFixture({
      "root.txt": "root document",
      [deepPath]: "deep document",
    });

    try {
      const events = await drain(runIndexingJob(buildOptions(single)));
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

// ─── Loud truncation surfacing (2026-08 field review) ────────────────────────
// LIMIT_REACHED used to be one buried document-failed entry in job history while the capsule
// finished "ready" — a corpus silently missing part of its files. A truncated walk must leave
// a capsule-level quality warning that the health surface shows, and a later run that covers
// the corpus must clear it again.
describe("runIndexingJob — discovery truncation warning", () => {
  const corpus = {
    "a.txt": "Document a. ".repeat(8),
    "b.txt": "Document b. ".repeat(8),
    "c.txt": "Document c. ".repeat(8),
    "d.txt": "Document d. ".repeat(8),
  };

  function truncationWarnings(fixture: Fixture): readonly { readonly message: string }[] {
    return fixture.store._internal.db
      .prepare(
        "SELECT message FROM parser_diagnostics WHERE capsule_id = :c AND document_id IS NULL AND code = 'DISCOVERY_LIMIT_REACHED' AND severity = 'warning'",
      )
      .all({ c: fixture.capsuleId }) as unknown as readonly { readonly message: string }[];
  }

  it("persists ONE capsule-level warning when the walk truncates, and clears it once a later run covers the corpus", async () => {
    const fixture = buildFixture(corpus);
    try {
      const truncated = await drain(
        runIndexingJob(buildOptions(fixture, { discoveryOptions: { maxFiles: 2, maxDepth: 12 } })),
      );
      expect(
        truncated.some(
          (event) =>
            event.kind === "document-failed" &&
            event.error.code === "DISCOVERY_FAILED:LIMIT_REACHED",
        ),
      ).toBe(true);
      const warnings = truncationWarnings(fixture);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toContain("KEIKO_LOCAL_KNOWLEDGE_MAX_DISCOVERY_FILES");

      // The warning describes the LAST walk: a run without the limit covers the corpus and
      // must clear it instead of shouting forever.
      await drain(runIndexingJob(buildOptions(fixture)));
      expect(truncationWarnings(fixture)).toHaveLength(0);
    } finally {
      fixture.cleanup();
    }
  });
});
