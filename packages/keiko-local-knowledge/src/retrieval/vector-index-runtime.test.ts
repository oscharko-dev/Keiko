import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ChunkId,
  DocumentId,
  EmbeddingModelIdentity,
  KnowledgeCapsuleId,
  VectorId,
} from "@oscharko-dev/keiko-contracts";
import {
  verifyEmbeddingCapability,
  type OpenAIEmbeddingAdapter,
  type OpenAIEmbeddingOutcome,
  type OpenAIEmbeddingRequest,
} from "@oscharko-dev/keiko-model-gateway";
import { describe, expect, it } from "vitest";

import { getCapsule } from "../capsule-lifecycle.js";
import {
  deleteVectorsForCapsule,
  insertVectorRow,
  invalidateVectorIndexStateForCapsules,
} from "../indexing/vector-persist.js";
import {
  openKnowledgeStore,
  type KnowledgeStore,
  type KnowledgeStoreProtectionOptions,
} from "../store.js";

import { deterministicVector, scriptedAdapter, seedCapsuleWithVectors } from "./_support.js";
import { runLocalKnowledgeRetrieval } from "./retrieval-runner.js";
import {
  resolveVectorIndexOptions,
  searchVectorIndex,
  type VectorIndexOptions,
} from "./vector-index.js";

const DIMENSIONS = 4;
const CORPUS_ROWS = 20_001;
const TOP_K = 10;
const QUERY_VECTOR = new Float32Array([1, 0, 0, 0]);
const MODEL_ID = "sqlite-vec-real-binary-test";
const SUPPORTED_RUNTIME =
  (process.platform === "darwin" && (process.arch === "arm64" || process.arch === "x64")) ||
  (process.platform === "linux" && (process.arch === "arm64" || process.arch === "x64")) ||
  (process.platform === "win32" && process.arch === "x64");

interface ManagedStore {
  readonly store: KnowledgeStore;
  readonly cleanup: () => void;
}

interface VectorIndexStateRow {
  readonly status: string;
  readonly vector_count: number;
}

function isProbeInput(input: string): boolean {
  return input === "ping" || input.startsWith("Keiko embedding space probe:");
}

function realBinaryAdapter(): OpenAIEmbeddingAdapter {
  return scriptedAdapter({
    responder: (request: OpenAIEmbeddingRequest): OpenAIEmbeddingOutcome => ({
      ok: true,
      value: {
        vector: isProbeInput(request.input)
          ? deterministicVector(request.input, DIMENSIONS)
          : QUERY_VECTOR,
        modelId: MODEL_ID,
      },
    }),
  });
}

async function verifiedIdentity(adapter: OpenAIEmbeddingAdapter): Promise<EmbeddingModelIdentity> {
  const result = await verifyEmbeddingCapability(adapter, {
    modelId: MODEL_ID,
    provider: "openai",
    vectorMetric: "cosine",
    expectedDimensions: DIMENSIONS,
    normalization: "l2",
    instructionVersion: "keiko-embedding-input-v1",
    includeSpaceFingerprint: true,
  });
  if (!result.ok) throw new Error(`test embedding identity verification failed: ${result.reason}`);
  return result.identity;
}

function encryptedProtection(): KnowledgeStoreProtectionOptions {
  return {
    mode: "encrypted-key-provider",
    keyProvider: {
      providerId: "sqlite-vec-test-key",
      resolveKey: (): Uint8Array => new Uint8Array(32).fill(17),
    },
  };
}

function managedStore(
  vectorIndex?: VectorIndexOptions,
  protection?: KnowledgeStoreProtectionOptions,
): ManagedStore {
  const dir = mkdtempSync(join(tmpdir(), "keiko-sqlite-vec-"));
  const dbPath = join(dir, "capsules.db");
  const store = openKnowledgeStore({
    dbPath,
    ...(vectorIndex !== undefined ? { vectorIndex } : {}),
    ...(protection !== undefined ? { protection } : {}),
  });
  return {
    store,
    cleanup: (): void => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function float32Bytes(vector: Float32Array): Uint8Array {
  return new Uint8Array(
    vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength),
  );
}

function corpusVector(ordinal: number, rows: number): Float32Array {
  const x = 1 - ordinal / rows;
  return new Float32Array([x, Math.sqrt(1 - x * x), 0, 0]);
}

function cloneChunkStatement(
  store: KnowledgeStore,
): ReturnType<KnowledgeStore["_internal"]["db"]["prepare"]> {
  return store._internal.db.prepare(
    [
      "INSERT INTO chunks (",
      "  id, capsule_id, source_id, document_id, parsed_unit_id, order_index, token_count,",
      "  safe_excerpt_hash, chunking_strategy_version, character_start, character_end,",
      "  contextual_retrieval_key, context_prefix, augmented_text, context_status, context_updated_at",
      ") SELECT :id, capsule_id, source_id, document_id, parsed_unit_id, :order_index, token_count,",
      "  safe_excerpt_hash, chunking_strategy_version, character_start, character_end,",
      "  contextual_retrieval_key, context_prefix, augmented_text, context_status, context_updated_at",
      "FROM chunks WHERE id = :template_id",
    ].join(" "),
  );
}

function insertCorpusVector(
  store: KnowledgeStore,
  seeded: Awaited<ReturnType<typeof seedCapsuleWithVectors>>,
  chunkId: ChunkId,
  ordinal: number,
  identity: EmbeddingModelIdentity,
  invalidateIndexState: boolean,
): void {
  insertVectorRow(
    store._internal.db,
    store._internal.contentCipher,
    {
      id: `vec:${String(chunkId)}` as VectorId,
      capsuleId: seeded.capsuleId,
      sourceId: seeded.sourceId,
      documentId: seeded.documentId,
      chunkId,
      embedding: float32Bytes(corpusVector(ordinal, CORPUS_ROWS + 1)),
      identity,
      storageReference: `synthetic-vector-${String(ordinal)}`,
      createdAt: 1_700_000_000_000 + ordinal,
    },
    { invalidateIndexState },
  );
}

function seedLargeCorpus(
  store: KnowledgeStore,
  seeded: Awaited<ReturnType<typeof seedCapsuleWithVectors>>,
  identity: EmbeddingModelIdentity,
): readonly ChunkId[] {
  const templateId = seeded.chunkIds[0];
  if (templateId === undefined) throw new Error("expected a template chunk");
  deleteVectorsForCapsule(store._internal.db, seeded.capsuleId);
  const clone = cloneChunkStatement(store);
  const chunkIds: ChunkId[] = [];
  store._internal.db.exec("BEGIN IMMEDIATE");
  try {
    for (let ordinal = 0; ordinal < CORPUS_ROWS; ordinal += 1) {
      const chunkId = `ann-chunk-${String(ordinal).padStart(5, "0")}` as ChunkId;
      clone.run({ id: String(chunkId), order_index: ordinal + 1, template_id: String(templateId) });
      insertCorpusVector(store, seeded, chunkId, ordinal, identity, false);
      chunkIds.push(chunkId);
    }
    invalidateVectorIndexStateForCapsules(store._internal.db, [seeded.capsuleId]);
    store._internal.db.exec("COMMIT");
  } catch (cause) {
    store._internal.db.exec("ROLLBACK");
    throw cause;
  }
  return chunkIds;
}

function vectorIndexState(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
): VectorIndexStateRow {
  const row = store._internal.db
    .prepare("SELECT status, vector_count FROM vector_index_state WHERE capsule_id = :capsule_id")
    .get({ capsule_id: String(capsuleId) }) as unknown as VectorIndexStateRow | undefined;
  if (row === undefined) throw new Error("expected vector-index state");
  return row;
}

async function runPipeline(
  store: KnowledgeStore,
  adapter: OpenAIEmbeddingAdapter,
  capsuleId: KnowledgeCapsuleId,
  vectorIndex?: VectorIndexOptions,
  topK: number = TOP_K,
): ReturnType<typeof runLocalKnowledgeRetrieval> {
  return runLocalKnowledgeRetrieval(
    {
      store,
      embeddingAdapter: adapter,
      ...(vectorIndex !== undefined ? { vectorIndex } : {}),
    },
    { text: "ann-query", capsuleId, topK },
  );
}

async function assertCandidateScoreContract(
  store: KnowledgeStore,
  adapter: OpenAIEmbeddingAdapter,
  capsuleId: KnowledgeCapsuleId,
  chunkIds: readonly ChunkId[],
  vectorIndex: VectorIndexOptions,
): Promise<void> {
  const capsule = getCapsule(store, capsuleId);
  if (capsule === undefined) throw new Error("expected ANN capsule");
  for (const candidateLimit of [5, 10]) {
    const result = searchVectorIndex(
      { store, capsule, queryVector: QUERY_VECTOR, candidateLimit },
      vectorIndex,
    );
    expect(result.ok).toBe(true);
    expect(result.candidates.map((candidate) => candidate.chunkId)).toEqual(
      chunkIds.slice(0, candidateLimit),
    );
    const exact = await runPipeline(
      store,
      adapter,
      capsuleId,
      { mode: "disabled" },
      candidateLimit,
    );
    const exactChunkIds = exact.references.map((reference) => reference.chunkId);
    const recalled = result.candidates.filter((candidate) =>
      exactChunkIds.includes(candidate.chunkId as ChunkId),
    ).length;
    expect(recalled / candidateLimit).toBeGreaterThanOrEqual(0.95);
    result.candidates.forEach((candidate, ordinal) => {
      expect(candidate.score).toBeCloseTo(corpusVector(ordinal, CORPUS_ROWS + 1)[0] ?? 0, 5);
    });
  }
}

async function assertAnnJourney(
  fixture: ManagedStore,
  adapter: OpenAIEmbeddingAdapter,
  identity: EmbeddingModelIdentity,
  vectorIndex: VectorIndexOptions,
): Promise<{ readonly capsuleId: KnowledgeCapsuleId; readonly chunkIds: readonly ChunkId[] }> {
  const seeded = await seedCapsuleWithVectors(fixture.store, {
    capsuleId: "cap-ann-real",
    sourceId: "src-ann-real",
    documentId: "doc-ann-real",
    identity,
    text: "alpha",
  });
  const chunkIds = seedLargeCorpus(fixture.store, seeded, identity);
  const exact = await runPipeline(fixture.store, adapter, seeded.capsuleId, { mode: "disabled" });
  const result = await runPipeline(fixture.store, adapter, seeded.capsuleId, vectorIndex);
  expect(result.diagnostics?.vectorIndex).toMatchObject({
    provider: "sqlite-vec",
    status: "available",
    indexName: "keiko_lk_vec_4_cosine",
  });
  expect(result.references.map((reference) => reference.chunkId)).toEqual(
    exact.references.map((reference) => reference.chunkId),
  );
  expect(
    fixture.store._internal.db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_temp_master WHERE type = 'table' AND name = :name")
      .get({ name: "keiko_lk_vec_4_cosine" }),
  ).toEqual({ n: 1 });
  expect(fixture.store._internal.db.prepare("SELECT vec_version() AS version").get()).toEqual({
    version: "v0.1.9",
  });
  expect(() => {
    fixture.store._internal.db.loadExtension("/missing/keiko/should-stay-disabled");
  }).toThrow(/extension loading is not allowed/i);
  const topFive = await runPipeline(
    fixture.store,
    realBinaryAdapter(),
    seeded.capsuleId,
    vectorIndex,
    5,
  );
  expect(topFive.references.map((reference) => reference.chunkId)).toEqual(chunkIds.slice(0, 5));
  await assertCandidateScoreContract(
    fixture.store,
    adapter,
    seeded.capsuleId,
    chunkIds,
    vectorIndex,
  );
  expect(vectorIndexState(fixture.store, seeded.capsuleId)).toEqual({
    status: "ready",
    vector_count: CORPUS_ROWS,
  });
  return { capsuleId: seeded.capsuleId, chunkIds };
}

async function assertStalenessRebuild(
  fixture: ManagedStore,
  adapter: OpenAIEmbeddingAdapter,
  identity: EmbeddingModelIdentity,
  vectorIndex: VectorIndexOptions,
  capsuleId: KnowledgeCapsuleId,
  templateId: ChunkId,
): Promise<void> {
  const capsule = getCapsule(fixture.store, capsuleId);
  if (capsule === undefined) throw new Error("expected ANN capsule");
  const sourceId = capsule.sourceIds[0];
  if (sourceId === undefined) throw new Error("expected ANN source");
  const seeded = {
    capsuleId,
    sourceId,
    documentId: fixture.store._internal.db
      .prepare("SELECT id FROM documents WHERE capsule_id = :capsule_id LIMIT 1")
      .get({ capsule_id: String(capsuleId) }) as unknown as { readonly id: DocumentId },
  };
  const extraId = "ann-chunk-extra" as ChunkId;
  cloneChunkStatement(fixture.store).run({
    id: String(extraId),
    order_index: CORPUS_ROWS + 1,
    template_id: String(templateId),
  });
  insertCorpusVector(
    fixture.store,
    { ...seeded, documentId: seeded.documentId.id, chunkIds: [], vectorTexts: [] },
    extraId,
    CORPUS_ROWS,
    identity,
    true,
  );
  expect(vectorIndexState(fixture.store, capsuleId).status).toBe("dirty");
  await runPipeline(fixture.store, adapter, capsuleId, vectorIndex);
  expect(vectorIndexState(fixture.store, capsuleId)).toEqual({
    status: "ready",
    vector_count: CORPUS_ROWS + 1,
  });
}

function assertDimensionMismatch(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  vectorIndex: VectorIndexOptions,
): void {
  const capsule = getCapsule(store, capsuleId);
  if (capsule === undefined) throw new Error("expected ANN capsule");
  const result = searchVectorIndex(
    { store, capsule, queryVector: new Float32Array(3), candidateLimit: TOP_K },
    vectorIndex,
  );
  expect(result.diagnostics).toMatchObject({
    status: "fallback-incompatible-identity",
    reason: "query-dimension-mismatch",
  });
}

async function assertStoredIdentityFallback(
  fixture: ManagedStore,
  adapter: OpenAIEmbeddingAdapter,
  vectorIndex: VectorIndexOptions,
  capsuleId: KnowledgeCapsuleId,
  chunkId: ChunkId,
): Promise<void> {
  fixture.store._internal.db
    .prepare(
      [
        "UPDATE vectors SET embedding_model_id = 'incompatible-model',",
        "  created_at = created_at + 1000000",
        "WHERE capsule_id = :capsule_id AND chunk_id = :chunk_id",
      ].join(" "),
    )
    .run({ capsule_id: String(capsuleId), chunk_id: String(chunkId) });
  const result = await runPipeline(fixture.store, adapter, capsuleId, vectorIndex);
  expect(result.diagnostics?.vectorIndex).toMatchObject({
    status: "fallback-incompatible-identity",
    reason: "stored-vector-identity-mismatch",
  });
  expect(result.references.length).toBeGreaterThan(0);
}

async function assertEncryptedFallback(
  adapter: OpenAIEmbeddingAdapter,
  identity: EmbeddingModelIdentity,
  vectorIndex: VectorIndexOptions,
): Promise<void> {
  const fixture = managedStore(vectorIndex, encryptedProtection());
  try {
    const seeded = await seedCapsuleWithVectors(fixture.store, {
      capsuleId: "cap-ann-encrypted",
      identity,
      text: "alpha beta gamma delta",
    });
    const result = await runPipeline(fixture.store, adapter, seeded.capsuleId, vectorIndex);
    expect(result.diagnostics?.vectorIndex).toMatchObject({
      status: "fallback-encrypted-store",
      reason: "encrypted-store",
    });
    expect(result.references.length).toBeGreaterThan(0);
  } finally {
    fixture.cleanup();
  }
}

async function assertCorruptPathAndDisabledPin(identity: EmbeddingModelIdentity): Promise<void> {
  const corrupt = resolveVectorIndexOptions(
    { mode: "auto", sqliteVecExtensionPath: "/missing/keiko/vec0" },
    {},
  );
  const fixture = managedStore(corrupt);
  try {
    const seeded = await seedCapsuleWithVectors(fixture.store, {
      capsuleId: "cap-ann-corrupt-path",
      identity,
      text: "alpha beta gamma delta",
    });
    const failed = await runPipeline(fixture.store, realBinaryAdapter(), seeded.capsuleId, corrupt);
    expect(failed.diagnostics?.vectorIndex).toMatchObject({
      status: "fallback-unavailable",
      reason: "sqlite-vec-extension-load-failed",
    });
    expect(failed.references.length).toBeGreaterThan(0);
    const unset = await runPipeline(fixture.store, realBinaryAdapter(), seeded.capsuleId);
    const disabled = await runPipeline(fixture.store, realBinaryAdapter(), seeded.capsuleId, {
      mode: "disabled",
    });
    expect(JSON.stringify(unset)).toBe(JSON.stringify(disabled));
  } finally {
    fixture.cleanup();
  }
}

async function assertUnsupportedPlatformFallback(
  adapter: OpenAIEmbeddingAdapter,
  identity: EmbeddingModelIdentity,
  vectorIndex: VectorIndexOptions,
): Promise<void> {
  const fixture = managedStore(vectorIndex);
  try {
    const seeded = await seedCapsuleWithVectors(fixture.store, { identity, text: "alpha beta" });
    const result = await runPipeline(fixture.store, adapter, seeded.capsuleId, vectorIndex);
    expect(result.diagnostics?.vectorIndex).toMatchObject({
      status: "fallback-unavailable",
      reason: "sqlite-vec-module-load-failed",
    });
    expect(result.references.length).toBeGreaterThan(0);
  } finally {
    fixture.cleanup();
  }
}

describe("sqlite-vec runtime resolution", () => {
  it("keeps the default disabled and selects the bundled runtime only for an active mode", () => {
    const disabled = resolveVectorIndexOptions(undefined, {});
    const active = resolveVectorIndexOptions(undefined, {
      KEIKO_LOCAL_KNOWLEDGE_VECTOR_INDEX: "auto",
    });
    expect(disabled).toMatchObject({ mode: "disabled" });
    expect(disabled.sqliteVec).toBeUndefined();
    expect(active).toMatchObject({ mode: "auto" });
    expect(active.sqliteVec?.load).toBeTypeOf("function");
  });

  it("gives an explicit extension path priority over the bundled module", () => {
    const resolved = resolveVectorIndexOptions(undefined, {
      KEIKO_LOCAL_KNOWLEDGE_VECTOR_INDEX: "sqlite-vec",
      KEIKO_LOCAL_KNOWLEDGE_SQLITE_VEC_EXTENSION_PATH: "/configured/vec0",
    });
    expect(resolved).toMatchObject({
      mode: "sqlite-vec",
      sqliteVecExtensionPath: "/configured/vec0",
    });
    expect(resolved.sqliteVec).toBeUndefined();
  });

  it("leaves extension authority unavailable on an unconfigured store", () => {
    const fixture = managedStore();
    try {
      expect(() => {
        fixture.store._internal.db.enableLoadExtension(true);
      }).toThrow();
    } finally {
      fixture.cleanup();
    }
  });
});

describe("sqlite-vec real binary retrieval journey", () => {
  it("uses ANN above the exact cap and preserves every fail-closed fallback", async () => {
    const adapter = realBinaryAdapter();
    const identity = await verifiedIdentity(adapter);
    const vectorIndex = resolveVectorIndexOptions(undefined, {
      KEIKO_LOCAL_KNOWLEDGE_VECTOR_INDEX: "auto",
    });
    if (!SUPPORTED_RUNTIME) {
      await assertUnsupportedPlatformFallback(adapter, identity, vectorIndex);
      return;
    }
    const fixture = managedStore(vectorIndex);
    try {
      const seeded = await assertAnnJourney(fixture, adapter, identity, vectorIndex);
      const firstChunk = seeded.chunkIds[0];
      if (firstChunk === undefined) throw new Error("expected ANN chunk");
      await assertStalenessRebuild(
        fixture,
        adapter,
        identity,
        vectorIndex,
        seeded.capsuleId,
        firstChunk,
      );
      assertDimensionMismatch(fixture.store, seeded.capsuleId, vectorIndex);
      await assertStoredIdentityFallback(
        fixture,
        adapter,
        vectorIndex,
        seeded.capsuleId,
        firstChunk,
      );
    } finally {
      fixture.cleanup();
    }
    await assertEncryptedFallback(realBinaryAdapter(), identity, vectorIndex);
    await assertCorruptPathAndDisabledPin(identity);
  }, 60_000);
});
