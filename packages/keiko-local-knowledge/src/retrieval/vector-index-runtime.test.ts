import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ChunkId,
  DocumentId,
  EmbeddingModelIdentity,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  VectorId,
} from "@oscharko-dev/keiko-contracts";
import { afterEach, describe, expect, it } from "vitest";

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

import { seedCapsuleWithVectors } from "./_support.js";
import { clearUsearchAnnCacheForTests } from "./usearch-ann-index.js";
import { USEARCH_RUNTIME_MANIFEST, usearchRuntimeTargetKey } from "./usearch-runtime-manifest.js";
import {
  resolveVectorIndexOptions,
  searchVectorIndex,
  type VectorIndexOptions,
} from "./vector-index.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const DIMENSIONS = 4;
const CORPUS_ROWS = 20_001;
const TOP_K = 10;
const QUERY_VECTOR = new Float32Array([1, 0, 0, 0]);
const IDENTITY: EmbeddingModelIdentity = {
  provider: "openai",
  modelId: "usearch-runtime-test",
  vectorDimensions: DIMENSIONS,
  vectorMetric: "cosine",
  normalization: "l2",
  instructionVersion: "keiko-embedding-input-v1",
  embeddingSpaceFingerprint: "keiko-usearch-runtime-test-v1",
};

interface ManagedStore {
  readonly directory: string;
  readonly store: KnowledgeStore;
  readonly cleanup: () => void;
}

interface SeededCorpus {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly documentId: DocumentId;
  readonly chunkIds: readonly ChunkId[];
}

interface VectorIndexStateRow {
  readonly provider: string;
  readonly status: string;
  readonly vector_count: number;
}

function runtimePath(): string | undefined {
  const target = usearchRuntimeTargetKey(process.platform, process.arch);
  if (target === undefined) return undefined;
  const configured = process.env.KEIKO_USEARCH_BINARY_PATH;
  const path =
    configured ??
    join(REPO_ROOT, ".usearch", USEARCH_RUNTIME_MANIFEST.version, target, "usearch.node");
  return existsSync(path) ? path : undefined;
}

function encryptedProtection(): KnowledgeStoreProtectionOptions {
  return {
    mode: "encrypted-key-provider",
    keyProvider: {
      providerId: "usearch-runtime-test-key",
      resolveKey: (): Uint8Array => new Uint8Array(32).fill(17),
    },
  };
}

function managedStore(protection?: KnowledgeStoreProtectionOptions): ManagedStore {
  const directory = mkdtempSync(join(tmpdir(), "keiko-usearch-runtime-"));
  const store = openKnowledgeStore({
    dbPath: join(directory, "capsules.db"),
    ...(protection === undefined ? {} : { protection }),
  });
  return {
    directory,
    store,
    cleanup: (): void => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function float32Bytes(vector: Float32Array): Uint8Array {
  return new Uint8Array(
    vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength),
  );
}

function corpusVector(ordinal: number): Float32Array {
  const x = 1 - ordinal / (CORPUS_ROWS * 2);
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
      embedding: float32Bytes(corpusVector(ordinal)),
      identity: IDENTITY,
      storageReference: `synthetic-vector-${String(ordinal)}`,
      createdAt: 1_700_000_000_000 + ordinal,
    },
    { invalidateIndexState },
  );
}

async function seedLargeCorpus(store: KnowledgeStore): Promise<SeededCorpus> {
  const seeded = await seedCapsuleWithVectors(store, {
    capsuleId: "cap-usearch-runtime",
    sourceId: "src-usearch-runtime",
    documentId: "doc-usearch-runtime",
    identity: IDENTITY,
    text: "alpha",
  });
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
      insertCorpusVector(store, seeded, chunkId, ordinal, false);
      chunkIds.push(chunkId);
    }
    invalidateVectorIndexStateForCapsules(store._internal.db, [seeded.capsuleId]);
    store._internal.db.exec("COMMIT");
  } catch (cause) {
    store._internal.db.exec("ROLLBACK");
    throw cause;
  }
  return {
    capsuleId: seeded.capsuleId,
    sourceId: seeded.sourceId,
    documentId: seeded.documentId,
    chunkIds,
  };
}

function search(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  options: VectorIndexOptions,
): ReturnType<typeof searchVectorIndex> {
  const capsule = getCapsule(store, capsuleId);
  if (capsule === undefined) throw new Error("expected seeded capsule");
  return searchVectorIndex(
    { store, capsule, queryVector: QUERY_VECTOR, candidateLimit: TOP_K },
    options,
  );
}

function stateFor(store: KnowledgeStore, capsuleId: KnowledgeCapsuleId): VectorIndexStateRow {
  const row = store._internal.db
    .prepare(
      [
        "SELECT provider, status, vector_count",
        "FROM vector_index_state WHERE capsule_id = :capsule_id",
      ].join(" "),
    )
    .get({ capsule_id: String(capsuleId) }) as unknown as VectorIndexStateRow | undefined;
  if (row === undefined) throw new Error("expected vector-index state");
  return row;
}

function storedEmbedding(store: KnowledgeStore): Uint8Array {
  const row = store._internal.db.prepare("SELECT embedding FROM vectors LIMIT 1").get() as
    { readonly embedding: Uint8Array } | undefined;
  if (row === undefined) throw new Error("expected persisted embedding");
  return row.embedding;
}

afterEach((): void => {
  clearUsearchAnnCacheForTests();
});

describe("USearch runtime resolution", () => {
  it("defaults to auto, honours opt-out, and carries only the verified runtime path", () => {
    expect(resolveVectorIndexOptions(undefined, {})).toMatchObject({ mode: "auto" });
    expect(
      resolveVectorIndexOptions(undefined, {
        KEIKO_LOCAL_KNOWLEDGE_VECTOR_INDEX: "disabled",
      }),
    ).toMatchObject({ mode: "disabled" });
    expect(
      resolveVectorIndexOptions(undefined, {
        KEIKO_LOCAL_KNOWLEDGE_VECTOR_INDEX: "usearch",
        KEIKO_USEARCH_BINARY_PATH: "/opt/keiko/usearch.node",
      }),
    ).toMatchObject({
      mode: "usearch",
      usearchBinaryPath: "/opt/keiko/usearch.node",
    });
  });

  it("keeps SQLite extension loading denied in every vector-index mode", () => {
    for (const mode of ["auto", "usearch", "disabled"] as const) {
      const fixture = managedStore();
      try {
        expect(resolveVectorIndexOptions({ mode }, {}).mode).toBe(mode);
        expect(() => {
          fixture.store._internal.db.enableLoadExtension(true);
        }).toThrow();
      } finally {
        fixture.cleanup();
      }
    }
  });
});

describe("USearch real-binary encrypted retrieval journey", () => {
  it("uses HNSW above the exact cap without an index sidecar and rebuilds dirty state", async () => {
    const binaryPath = runtimePath();
    if (binaryPath === undefined) {
      throw new Error("USearch runtime is not provisioned; run npm run provision:usearch");
    }
    const fixture = managedStore(encryptedProtection());
    try {
      const corpus = await seedLargeCorpus(fixture.store);
      const filesBefore = readdirSync(fixture.directory).sort();
      const encrypted = storedEmbedding(fixture.store);
      expect(encrypted).not.toEqual(float32Bytes(corpusVector(0)));

      const result = search(fixture.store, corpus.capsuleId, {
        mode: "usearch",
        usearchBinaryPath: binaryPath,
      });
      expect(result.ok).toBe(true);
      expect(result.diagnostics).toMatchObject({
        provider: "usearch",
        status: "available",
        searchMode: "ann",
      });
      expect(result.diagnostics.examinedCandidateCount).toBeLessThan(CORPUS_ROWS);
      const expected = new Set(corpus.chunkIds.slice(0, TOP_K).map(String));
      const recalled = result.candidates.filter((candidate) =>
        expected.has(candidate.chunkId),
      ).length;
      expect(recalled / TOP_K).toBeGreaterThanOrEqual(0.95);
      expect(filesBefore).toEqual(readdirSync(fixture.directory).sort());
      expect(stateFor(fixture.store, corpus.capsuleId)).toEqual({
        provider: "usearch",
        status: "ready",
        vector_count: CORPUS_ROWS,
      });

      const extraId = "ann-chunk-extra" as ChunkId;
      cloneChunkStatement(fixture.store).run({
        id: String(extraId),
        order_index: CORPUS_ROWS + 1,
        template_id: String(corpus.chunkIds[0]),
      });
      insertCorpusVector(
        fixture.store,
        {
          capsuleId: corpus.capsuleId,
          sourceId: corpus.sourceId,
          documentId: corpus.documentId,
          chunkIds: [],
          vectorTexts: [],
        },
        extraId,
        CORPUS_ROWS,
        true,
      );
      expect(stateFor(fixture.store, corpus.capsuleId).status).toBe("dirty");
      expect(
        search(fixture.store, corpus.capsuleId, {
          mode: "usearch",
          usearchBinaryPath: binaryPath,
        }).ok,
      ).toBe(true);
      expect(stateFor(fixture.store, corpus.capsuleId).vector_count).toBe(CORPUS_ROWS + 1);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  it("fails closed for missing or tampered runtime bytes and an exceeded memory bound", async () => {
    const fixture = managedStore();
    try {
      const corpus = await seedLargeCorpus(fixture.store);
      expect(
        search(fixture.store, corpus.capsuleId, {
          mode: "usearch",
          usearchBinaryPath: join(fixture.directory, "missing.node"),
        }),
      ).toMatchObject({
        ok: false,
        diagnostics: { reason: "runtime-unavailable" },
      });

      const binaryPath = runtimePath();
      if (binaryPath === undefined) {
        throw new Error("USearch runtime is not provisioned; run npm run provision:usearch");
      }
      const tamperedPath = join(fixture.directory, "tampered.node");
      const tampered = readFileSync(binaryPath);
      tampered[0] = (tampered[0] ?? 0) ^ 0xff;
      writeFileSync(tamperedPath, tampered);
      expect(
        search(fixture.store, corpus.capsuleId, {
          mode: "usearch",
          usearchBinaryPath: tamperedPath,
        }),
      ).toMatchObject({
        ok: false,
        diagnostics: { reason: "runtime-integrity-failed" },
      });
      expect(
        search(fixture.store, corpus.capsuleId, {
          mode: "usearch",
          usearchBinaryPath: binaryPath,
          maxIndexedVectorBytes: 1,
        }),
      ).toMatchObject({
        ok: false,
        diagnostics: {
          status: "fallback-index-too-large",
          reason: "index-bytes-over-bound",
        },
      });
    } finally {
      fixture.cleanup();
    }
  }, 60_000);
});
