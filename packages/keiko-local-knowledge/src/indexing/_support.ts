// Test-only seeding + scripted adapters for indexing/*.test.ts. The filename underscore
// + trust-8 dep-cruise rule keep production source from importing this module. Direct
// INSERTs into parsed_units / documents reuse #194's prepared-statement wrappers so
// schema knowledge stays in one place.

import type {
  ChunkId,
  DocumentId,
  EmbeddingModelIdentity,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  ParsedUnit,
} from "@oscharko-dev/keiko-contracts";
import type {
  OpenAIEmbeddingAdapter,
  OpenAIEmbeddingOutcome,
  OpenAIEmbeddingRequest,
} from "@oscharko-dev/keiko-model-gateway";

import { chunkDocument } from "../chunking/chunker-runner.js";
import { addSourceToCapsule } from "../source-lifecycle.js";
import { createCapsule } from "../capsule-lifecycle.js";
import { insertDocumentRow, insertParsedUnitRow } from "../discovery/persist.js";
import { sampleCapsuleInput, sampleSourceInput, DEFAULT_EMBEDDING } from "../_support.js";
import type { KnowledgeStore } from "../store.js";

export interface SeededFixture {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly documentId: DocumentId;
}

export interface SeedDocOptions {
  readonly capsuleId?: string;
  readonly sourceId?: string;
  readonly documentId?: string;
  readonly contentHash?: string;
  readonly documentPath?: string;
  readonly skipCapsule?: boolean;
  readonly skipSource?: boolean;
  readonly embeddingModelIdentity?: EmbeddingModelIdentity;
}

export function seedCapsuleSourceAndDocument(
  store: KnowledgeStore,
  options: SeedDocOptions = {},
): SeededFixture {
  const capsuleIdRaw = options.capsuleId ?? "cap-1";
  const sourceIdRaw = options.sourceId ?? "src-1";
  const documentIdRaw = options.documentId ?? "doc-1";

  if (options.skipCapsule !== true) {
    createCapsule(
      store,
      sampleCapsuleInput({
        id: capsuleIdRaw as KnowledgeCapsuleId,
        ...(options.embeddingModelIdentity !== undefined
          ? { embeddingModelIdentity: options.embeddingModelIdentity }
          : {}),
      }),
    );
  }
  if (options.skipSource !== true) {
    addSourceToCapsule(store, capsuleIdRaw as KnowledgeCapsuleId, sampleSourceInput(sourceIdRaw));
  }

  insertDocumentRow(store._internal.db, {
    id: documentIdRaw as DocumentId,
    capsuleId: capsuleIdRaw as KnowledgeCapsuleId,
    sourceId: sourceIdRaw,
    documentPath: options.documentPath ?? "docs/sample.txt",
    sizeBytes: 1024,
    mediaType: "text/plain",
    contentHash: options.contentHash ?? "a".repeat(64),
    parserId: "text",
    parserVersion: "1",
    lastExtractedAt: 1_700_000_000_000,
    status: "extracted",
    safeDisplayName: "sample.txt",
  });

  return {
    capsuleId: capsuleIdRaw as KnowledgeCapsuleId,
    sourceId: sourceIdRaw as KnowledgeSourceId,
    documentId: documentIdRaw as DocumentId,
  };
}

export function seedParsedUnit(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  unitId: string,
  unit: ParsedUnit,
): void {
  insertParsedUnitRow(store._internal.db, capsuleId, unitId, unit);
}

// Seeds one page parsed unit covering the whole document then runs the real chunker so
// the chunks table is populated with deterministic ids. Returns the chunk ids in
// persistence order.
export function seedDocumentWithChunks(
  store: KnowledgeStore,
  fixture: SeededFixture,
  text: string,
  unitId = "unit-1",
): readonly ChunkId[] {
  seedParsedUnit(store, fixture.capsuleId, unitId, {
    kind: "page",
    documentId: fixture.documentId,
    pageNumber: 1,
    characterStart: 0,
    characterEnd: text.length,
  });
  const result = chunkDocument(store, {
    capsuleId: fixture.capsuleId,
    sourceId: fixture.sourceId,
    documentId: fixture.documentId,
    sourceText: text,
  });
  return result.chunkIds;
}

// ─── Scripted OpenAIEmbeddingAdapter ──────────────────────────────────────────
// Deterministic, no fetch. Built from a `responder` callback so tests can shape failure
// paths (transport error on a specific input, wrong-dim, rate-limit, etc.) without
// recreating the boilerplate.
export interface ScriptedAdapterOptions {
  readonly responder: (request: OpenAIEmbeddingRequest) => OpenAIEmbeddingOutcome;
  readonly endpoint?: string;
  readonly apiKey?: string;
  readonly apiKeyHeaderName?: string;
}

export function scriptedAdapter(options: ScriptedAdapterOptions): OpenAIEmbeddingAdapter {
  const apiKeyHeaderName = options.apiKeyHeaderName;
  const adapter: OpenAIEmbeddingAdapter = {
    endpoint: options.endpoint ?? "https://example.test/v1",
    apiKey: options.apiKey ?? ["sk-", "test"].join(""),
    ...(apiKeyHeaderName !== undefined ? { apiKeyHeaderName } : {}),
    request: async (req): Promise<OpenAIEmbeddingOutcome> =>
      Promise.resolve(options.responder(req)),
  };
  return adapter;
}

// Helper: a fixed-dim Float32Array seeded from a string so each chunk gets a stable but
// distinct vector. The first lane carries the byte length of the input as a sanity-check
// dimension (used by the assertion in the happy path).
export function deterministicVector(input: string, dimensions: number): Float32Array {
  const vec = new Float32Array(dimensions);
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  vec[0] = input.length;
  for (let i = 1; i < dimensions; i += 1) {
    vec[i] = ((hash + i * 7) & 0xffff) / 0xffff;
  }
  return vec;
}

export function happyAdapter(
  identity: EmbeddingModelIdentity = DEFAULT_EMBEDDING,
): OpenAIEmbeddingAdapter {
  return scriptedAdapter({
    responder: (req) => ({
      ok: true,
      value: {
        vector: deterministicVector(req.input, identity.vectorDimensions),
        modelId: identity.modelId,
        ...(identity.modelRevision !== undefined ? { modelRevision: identity.modelRevision } : {}),
      },
    }),
  });
}
