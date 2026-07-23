import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

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

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

const DIMENSIONS = 4;
const CORPUS_ROWS = 20_001;
const TOP_K = 10;
const QUERY_VECTOR = new Float32Array([1, 0, 0, 0]);
const MODEL_ID = "sqlite-vec-real-binary-test";
// The extension is not an npm dependency (its upstream SPDX string is invalid and the repository's
// supply-chain policy rejects it), so the real binary is provisioned out-of-band and verified
// against a pinned SHA-256 by `npm run provision:sqlite-vec`. Reading it from disk here keeps this
// test hermetic — no network, no install-time side effect. When it has not been provisioned the
// journey below asserts the fail-closed fallback instead of skipping, so the suite still proves
// something on every host.
// SQLite memoises its temp-directory choice on the FIRST temp file it creates in a process
// (`unixTempFileDir` caches the getenv results in a static), so SQLITE_TMPDIR has to be in place
// before anything in this worker touches TEMP storage. Setting it at module scope also keeps the
// spill proof free of mid-test environment mutation: the directory is fixed for the whole file, and
// the proof snapshots it immediately before the run it is measuring.
const SQLITE_TEMP_DIR = mkdtempSync(join(tmpdir(), "keiko-sqlite-tmpdir-"));
process.env.SQLITE_TMPDIR = SQLITE_TEMP_DIR;

const PROVISIONED_EXTENSION_PATH = provisionedSqliteVecPath();
const SUPPORTED_RUNTIME = PROVISIONED_EXTENSION_PATH !== undefined;

function provisionedSqliteVecPath(): string | undefined {
  const configured = process.env.KEIKO_LOCAL_KNOWLEDGE_SQLITE_VEC_EXTENSION_PATH;
  if (configured !== undefined && configured.length > 0 && existsSync(configured))
    return configured;
  const suffix =
    process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so";
  const candidate = join(REPO_ROOT, ".sqlite-vec", "0.1.9", `vec0.${suffix}`);
  return existsSync(candidate) ? candidate : undefined;
}

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

// SQLite's `temp_store` enumeration; 2 is MEMORY. Read from the live connection so the assertions
// below test the pragma actually in force, not that the code intended to set it.
const SQLITE_TEMP_STORE_MEMORY = 2;

function readTempStore(db: DatabaseSync): number | undefined {
  const row = db.prepare("PRAGMA temp_store").get() as unknown as
    { readonly temp_store: number } | undefined;
  return row?.temp_store;
}

function tempStoreValue(store: KnowledgeStore): number | undefined {
  return readTempStore(store._internal.db);
}

function storeDbPath(store: KnowledgeStore): string {
  const row = store._internal.db.prepare("PRAGMA database_list").get() as unknown as
    { readonly file: string } | undefined;
  if (row === undefined || row.file.length === 0) throw new Error("expected a file-backed store");
  return row.file;
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

interface AnnCorpus {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly chunkIds: readonly ChunkId[];
}

async function seedAnnCorpus(
  fixture: ManagedStore,
  identity: EmbeddingModelIdentity,
  capsuleId = "cap-ann-real",
): Promise<AnnCorpus> {
  const seeded = await seedCapsuleWithVectors(fixture.store, {
    capsuleId,
    sourceId: `src-${capsuleId}`,
    documentId: `doc-${capsuleId}`,
    identity,
    text: "alpha",
  });
  return {
    capsuleId: seeded.capsuleId,
    chunkIds: seedLargeCorpus(fixture.store, seeded, identity),
  };
}

async function assertAnnJourney(
  fixture: ManagedStore,
  adapter: OpenAIEmbeddingAdapter,
  identity: EmbeddingModelIdentity,
  vectorIndex: VectorIndexOptions,
  corpus: AnnCorpus,
): Promise<{ readonly capsuleId: KnowledgeCapsuleId; readonly chunkIds: readonly ChunkId[] }> {
  const seeded = { capsuleId: corpus.capsuleId };
  const chunkIds = corpus.chunkIds;
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

// An encrypted store whose connection cannot prove TEMP pages stay in memory keeps the pre-existing
// fail-closed outcome. Opening WITHOUT the vector runtime is exactly that store: `openKnowledgeStore`
// only pins `temp_store` for a store that enables the index, so supplying a runtime at search time
// alone leaves the ADR-0153 D1 condition unmet.
async function assertEncryptedUnpinnedFallback(
  adapter: OpenAIEmbeddingAdapter,
  identity: EmbeddingModelIdentity,
  vectorIndex: VectorIndexOptions,
): Promise<void> {
  const fixture = managedStore(undefined, encryptedProtection());
  try {
    // Opening without the runtime is what leaves the store unpinned; FILE is then set explicitly so
    // the refused condition is constructed rather than inherited from the SQLite build's default,
    // which is MEMORY on a build compiled with SQLITE_TEMP_STORE=3.
    fixture.store._internal.db.exec("PRAGMA temp_store = FILE");
    expect(tempStoreValue(fixture.store)).not.toBe(SQLITE_TEMP_STORE_MEMORY);
    const seeded = await seedCapsuleWithVectors(fixture.store, {
      capsuleId: "cap-ann-encrypted-unpinned",
      identity,
      text: "alpha beta gamma delta",
    });
    const result = await runPipeline(fixture.store, adapter, seeded.capsuleId, vectorIndex);
    expect(result.diagnostics?.vectorIndex).toMatchObject({
      status: "fallback-encrypted-store",
      reason: "encrypted-store-temp-store-unpinned",
    });
    expect(result.references.length).toBeGreaterThan(0);
  } finally {
    fixture.cleanup();
  }
}

// The negative control for the spill proof below, and the reason that proof is not vacuous. It
// drives the SAME vec0 column layout and the SAME corpus size through a connection that has not
// pinned `temp_store`, and asserts SQLite did materialise its TEMP database into a file.
//
// The observable is the temp DIRECTORY's mtime, not a directory listing: on POSIX hosts SQLite
// unlinks a temp file immediately after opening it, so the file is never visible to a reader and
// only the two directory mutations it causes survive. If a future change shrinks the corpus below
// the TEMP page-cache threshold this control fails, which is the point — it pins the proof to a
// corpus that would actually spill.
function assertUnpinnedControlSpills(tempDir: string, extensionPath: string): void {
  const dir = mkdtempSync(join(tmpdir(), "keiko-spill-control-"));
  const db = new DatabaseSync(join(dir, "control.db"), { allowExtension: true });
  try {
    db.exec("PRAGMA journal_mode = WAL");
    // The control must spill, so it pins the OPPOSITE way explicitly instead of relying on the
    // build default being FILE.
    db.exec("PRAGMA temp_store = FILE");
    expect(readTempStore(db)).not.toBe(SQLITE_TEMP_STORE_MEMORY);
    db.enableLoadExtension(true);
    db.loadExtension(extensionPath);
    db.enableLoadExtension(false);
    db.exec(
      [
        "CREATE VIRTUAL TABLE IF NOT EXISTS temp.keiko_lk_vec_control USING vec0(",
        "  capsule_id TEXT partition key, source_id TEXT, identity_key TEXT, chunk_id TEXT,",
        `  embedding float[${String(DIMENSIONS)}] distance_metric=cosine);`,
      ].join("\n"),
    );
    const before = statSync(tempDir).mtimeMs;
    const insert = db.prepare(
      [
        "INSERT INTO temp.keiko_lk_vec_control",
        "  (capsule_id, source_id, identity_key, chunk_id, embedding)",
        "VALUES (:capsule_id, :source_id, :identity_key, :chunk_id, :embedding)",
      ].join(" "),
    );
    db.exec("BEGIN IMMEDIATE");
    for (let ordinal = 0; ordinal < CORPUS_ROWS; ordinal += 1) {
      insert.run({
        capsule_id: "cap-ann-control",
        source_id: "src-ann-control",
        identity_key: "control-identity-key",
        chunk_id: `ann-chunk-${String(ordinal).padStart(5, "0")}`,
        embedding: float32Bytes(corpusVector(ordinal, CORPUS_ROWS + 1)),
      });
    }
    db.exec("COMMIT");
    expect(statSync(tempDir).mtimeMs).not.toBe(before);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ADR-0153 D4. Builds a real ANN index over an ENCRYPTED store and proves two things at once: the
// retrieval-quality floors hold exactly as they do on the plaintext store (`assertAnnJourney`), and
// no plaintext vector reached disk while they did — neither into SQLite's temp directory nor into
// the store directory. Written to fail if the `temp_store` pin is reverted: the control above proves
// this corpus spills without it.
async function assertEncryptedAnnJourneyWithoutSpill(
  adapter: OpenAIEmbeddingAdapter,
  identity: EmbeddingModelIdentity,
  vectorIndex: VectorIndexOptions,
  extensionPath: string,
): Promise<void> {
  assertUnpinnedControlSpills(SQLITE_TEMP_DIR, extensionPath);
  const fixture = managedStore(vectorIndex, encryptedProtection());
  try {
    expect(fixture.store._internal.contentCipher.isEncrypted).toBe(true);
    expect(tempStoreValue(fixture.store)).toBe(SQLITE_TEMP_STORE_MEMORY);
    const corpus = await seedAnnCorpus(fixture, identity, "cap-ann-encrypted");
    const storeDir = dirname(storeDbPath(fixture.store));
    const filesBefore = readdirSync(storeDir).sort();
    const tempMtimeBefore = statSync(SQLITE_TEMP_DIR).mtimeMs;

    await assertAnnJourney(fixture, adapter, identity, vectorIndex, corpus);

    expect(statSync(SQLITE_TEMP_DIR).mtimeMs).toBe(tempMtimeBefore);
    expect(readdirSync(SQLITE_TEMP_DIR)).toEqual([]);
    expect(readdirSync(storeDir).sort()).toEqual(filesBefore);
  } finally {
    fixture.cleanup();
  }
}

// ADR-0153 D3. The index is RAM-resident, so it is bounded; a capsule over the bound falls back to
// brute force rather than growing without limit, and says so in counts only.
async function assertOverBoundFallsBackToBruteForce(
  adapter: OpenAIEmbeddingAdapter,
  identity: EmbeddingModelIdentity,
  vectorIndex: VectorIndexOptions,
): Promise<void> {
  const bounded: VectorIndexOptions = { ...vectorIndex, maxIndexedVectorBytes: 1_024 };
  const fixture = managedStore(bounded, encryptedProtection());
  try {
    const corpus = await seedAnnCorpus(fixture, identity, "cap-ann-bounded");
    const result = await runPipeline(fixture.store, adapter, corpus.capsuleId, bounded);
    expect(result.diagnostics?.vectorIndex).toEqual({
      provider: "sqlite-vec",
      status: "fallback-index-too-large",
      reason: "index-bytes-over-bound",
      indexName: "keiko_lk_vec_4_cosine",
      vectorCount: CORPUS_ROWS,
    });
    expect(result.references.length).toBeGreaterThan(0);
    expect(vectorIndexState(fixture.store, corpus.capsuleId)).toEqual({
      status: "unavailable",
      vector_count: CORPUS_ROWS,
    });
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
    // Issue #2631: `unset` now resolves to the default `mode: "auto"` and, absent a runtime, falls
    // through to the brute-force fallback with a `sqlite-vec-runtime-not-configured` diagnostic.
    // `disabled` still skips the vector-index probe entirely with `vector-index-disabled`. The
    // operational outcome — the references returned to the user — must remain the same across both
    // (the retrieval user sees identical answers); only the vector-index diagnostic differs.
    const unset = await runPipeline(fixture.store, realBinaryAdapter(), seeded.capsuleId);
    const disabled = await runPipeline(fixture.store, realBinaryAdapter(), seeded.capsuleId, {
      mode: "disabled",
    });
    expect(JSON.stringify(unset.references)).toBe(JSON.stringify(disabled.references));
    expect(unset.diagnostics?.vectorIndex).toMatchObject({
      provider: "sqlite-vec",
      status: "fallback-unavailable",
      reason: "sqlite-vec-runtime-not-configured",
    });
    expect(disabled.diagnostics?.vectorIndex).toMatchObject({
      provider: "brute-force",
      status: "disabled",
      reason: "vector-index-disabled",
    });
  } finally {
    fixture.cleanup();
  }
}

// Reached when no extension has been provisioned for this host — either the platform has no
// published asset, or `npm run provision:sqlite-vec` has not been run. Either way the point is that
// retrieval still ANSWERS: the vector index reports a redacted fail-closed diagnostic and the
// brute-force path returns references, so the suite proves something on every host rather than
// skipping itself into vacuous green.
async function assertUnprovisionedRuntimeFallback(
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
      reason: "sqlite-vec-runtime-not-configured",
    });
    expect(result.references.length).toBeGreaterThan(0);
  } finally {
    fixture.cleanup();
  }
}

// Cleanup is deferred to process exit rather than `afterAll`. SQLite memoises the temp-directory
// choice for the process, and Vitest reuses a worker across test files, so removing the directory —
// or restoring the environment variable, which can invalidate the very string SQLite memoised —
// while the worker is still alive would leave a later test file pointed at a directory that no
// longer exists. At exit no further SQLite call can observe it. The directory is asserted empty by
// the proof itself, so nothing accumulates in it in the meantime.
process.once("exit", () => {
  rmSync(SQLITE_TEMP_DIR, { recursive: true, force: true });
});

describe("sqlite-vec runtime resolution", () => {
  // Issue #2631: the shipped default resolves to auto — the vector-index knob is not a discovery
  // burden a user has to find. The runtime bytes still gate ACTIVATION (ADR-0152 D2): the mode alone
  // resolves to no module, so a store opened with only the default keeps extension loading disabled
  // and retrieval keeps using brute force until an operator-provisioned extension path or an injected
  // module arrives. "disabled" is preserved as the explicit opt-out for the same knob.
  it("defaults to auto without any config, leaving activation gated on runtime bytes", () => {
    const shipped = resolveVectorIndexOptions(undefined, {});
    const active = resolveVectorIndexOptions(undefined, {
      KEIKO_LOCAL_KNOWLEDGE_VECTOR_INDEX: "auto",
    });
    expect(shipped).toMatchObject({ mode: "auto" });
    expect(shipped.sqliteVec).toBeUndefined();
    expect(shipped.sqliteVecExtensionPath).toBeUndefined();
    expect(active).toMatchObject({ mode: "auto" });
    expect(active.sqliteVec).toBeUndefined();
    expect(active.sqliteVecExtensionPath).toBeUndefined();
  });

  it("honours an explicit disabled opt-out that overrides the default", () => {
    const disabled = resolveVectorIndexOptions(undefined, {
      KEIKO_LOCAL_KNOWLEDGE_VECTOR_INDEX: "disabled",
    });
    expect(disabled).toMatchObject({ mode: "disabled" });
    expect(disabled.sqliteVec).toBeUndefined();
    expect(disabled.sqliteVecExtensionPath).toBeUndefined();
  });

  it("carries an operator-provisioned extension path through as the activation route", () => {
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

  // Issue #2631 acceptance: the shipped default resolves by CAPABILITY end-to-end. With the same
  // resolved options ({ mode: "auto" }) but no runtime bytes, the store opens without extension
  // support and search reports the fail-closed diagnostic (brute-force fallback engages). Provisioning
  // a runtime — module or extension path — flips the same default to ANN without any env var change.
  it("resolves to brute force by capability when no runtime is provisioned", async () => {
    const identity = await verifiedIdentity(realBinaryAdapter());
    const shipped = resolveVectorIndexOptions(undefined, {});
    expect(shipped.mode).toBe("auto");
    const fixture = managedStore(shipped);
    try {
      const seeded = await seedCapsuleWithVectors(fixture.store, {
        capsuleId: "cap-default-no-runtime",
        sourceId: "src-default-no-runtime",
        documentId: "doc-default-no-runtime",
        identity,
        text: "alpha",
      });
      const capsule = getCapsule(fixture.store, seeded.capsuleId);
      if (capsule === undefined) throw new Error("expected default-no-runtime capsule");
      const result = searchVectorIndex(
        { store: fixture.store, capsule, queryVector: QUERY_VECTOR, candidateLimit: TOP_K },
        shipped,
      );
      expect(result).toMatchObject({
        ok: false,
        diagnostics: {
          provider: "sqlite-vec",
          status: "fallback-unavailable",
          reason: "sqlite-vec-runtime-not-configured",
        },
      });
      // The gate that permits extension loading (store.ts:277) must still refuse an unconfigured
      // store — the default-on switch cannot widen the ADR-0152 D2 activation obligation.
      expect(() => {
        fixture.store._internal.db.enableLoadExtension(true);
      }).toThrow();
    } finally {
      fixture.cleanup();
    }
  });

  it("resolves to ANN by capability when a runtime is provisioned", async () => {
    if (!SUPPORTED_RUNTIME) return;
    const adapter = realBinaryAdapter();
    const identity = await verifiedIdentity(adapter);
    // The env carries only the extension path — no `KEIKO_LOCAL_KNOWLEDGE_VECTOR_INDEX` set. The
    // default (auto) plus the provisioned runtime is the entire activation route; a user who never
    // discovers the mode env var still gets ANN when the operator has provisioned the binary.
    const shipped = resolveVectorIndexOptions(undefined, {
      KEIKO_LOCAL_KNOWLEDGE_SQLITE_VEC_EXTENSION_PATH: PROVISIONED_EXTENSION_PATH,
    });
    expect(shipped).toMatchObject({
      mode: "auto",
      sqliteVecExtensionPath: PROVISIONED_EXTENSION_PATH,
    });
    const fixture = managedStore(shipped);
    try {
      const corpus = await seedAnnCorpus(fixture, identity, "cap-default-with-runtime");
      const capsule = getCapsule(fixture.store, corpus.capsuleId);
      if (capsule === undefined) throw new Error("expected default-with-runtime capsule");
      const result = searchVectorIndex(
        { store: fixture.store, capsule, queryVector: QUERY_VECTOR, candidateLimit: TOP_K },
        shipped,
      );
      expect(result.ok).toBe(true);
      expect(result.diagnostics).toMatchObject({
        provider: "sqlite-vec",
        status: "available",
        indexName: "keiko_lk_vec_4_cosine",
      });
    } finally {
      fixture.cleanup();
    }
  }, 60_000);
});

describe("sqlite-vec real binary retrieval journey", () => {
  it("uses ANN above the exact cap and preserves every fail-closed fallback", async () => {
    const adapter = realBinaryAdapter();
    const identity = await verifiedIdentity(adapter);
    const vectorIndex = resolveVectorIndexOptions(undefined, {
      KEIKO_LOCAL_KNOWLEDGE_VECTOR_INDEX: "auto",
      ...(PROVISIONED_EXTENSION_PATH === undefined
        ? {}
        : { KEIKO_LOCAL_KNOWLEDGE_SQLITE_VEC_EXTENSION_PATH: PROVISIONED_EXTENSION_PATH }),
    });
    if (!SUPPORTED_RUNTIME) {
      await assertUnprovisionedRuntimeFallback(adapter, identity, vectorIndex);
      return;
    }
    const fixture = managedStore(vectorIndex);
    try {
      const corpus = await seedAnnCorpus(fixture, identity);
      const seeded = await assertAnnJourney(fixture, adapter, identity, vectorIndex, corpus);
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
    await assertEncryptedUnpinnedFallback(realBinaryAdapter(), identity, vectorIndex);
    await assertCorruptPathAndDisabledPin(identity);
  }, 60_000);

  // ADR-0153: encrypted-store ANN, the temp-store guarantee, and the spill proof. This is the
  // decision's executable half — quality parity with the plaintext baseline, no plaintext vector on
  // disk while achieving it, and a bound that falls closed instead of growing without limit.
  it("runs ANN on an encrypted store without spilling plaintext vectors to disk", async () => {
    const adapter = realBinaryAdapter();
    const identity = await verifiedIdentity(adapter);
    const extensionPath = PROVISIONED_EXTENSION_PATH;
    const vectorIndex = resolveVectorIndexOptions(undefined, {
      KEIKO_LOCAL_KNOWLEDGE_VECTOR_INDEX: "auto",
      ...(extensionPath === undefined
        ? {}
        : { KEIKO_LOCAL_KNOWLEDGE_SQLITE_VEC_EXTENSION_PATH: extensionPath }),
    });
    if (extensionPath === undefined) {
      await assertUnprovisionedRuntimeFallback(adapter, identity, vectorIndex);
      return;
    }
    await assertEncryptedAnnJourneyWithoutSpill(adapter, identity, vectorIndex, extensionPath);
    await assertOverBoundFallsBackToBruteForce(realBinaryAdapter(), identity, vectorIndex);
  }, 120_000);
});
