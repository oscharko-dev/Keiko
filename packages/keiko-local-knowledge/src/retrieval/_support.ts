// Test-only fixtures for retrieval/*.test.ts (Epic #189, Issue #199). Mirrors the
// `indexing/_support.ts` shape so the two test suites read the same way. The filename
// underscore + trust-8 dep-cruise rule keep production source from importing this module.
//
// Seeding flow:
//   1. createCapsule + addSourceToCapsule (existing #193 helpers).
//   2. insertDocumentRow + insertParsedUnitRow (existing #194 helpers).
//   3. chunkDocument (existing #195 chunker, populates chunks via the deterministic id
//      derivation already used by indexing tests).
//   4. embedChunkBatch (existing #196 batcher) with a deterministic scripted adapter so
//      every chunk gets a stable vector and the `vectors` table has well-formed rows
//      keyed to real chunk + parsed_unit + document rows. We do NOT bypass the batcher
//      by writing rows directly — that would let a test pass with a schema-invalid blob
//      shape and silently mask the real production write path.

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
import type { ChunkingOptions } from "../chunking/types.js";
import { createCapsule } from "../capsule-lifecycle.js";
import { addSourceToCapsule } from "../source-lifecycle.js";
import { insertDocumentRow, insertParsedUnitRow } from "../discovery/persist.js";
import { embedChunkBatch } from "../indexing/embedding-batcher.js";
import type { ChunkToEmbed } from "../indexing/types.js";
import { DEFAULT_EMBEDDING, sampleCapsuleInput, sampleSourceInput } from "../_support.js";
import type { KnowledgeStore } from "../store.js";

export interface SeededVectors {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly documentId: DocumentId;
  readonly chunkIds: readonly ChunkId[];
  readonly vectorTexts: readonly string[];
}

// `unit` accepts a ParsedUnit *without* its `documentId` field: the helper substitutes the
// helper-resolved documentId so a test can't accidentally write a unit row pointing at
// the wrong document. `chunkingOptions` is passed straight through so a test can force
// multiple small chunks from a short input — the production default (minTokens: 64,
// maxTokens: 400) collapses a sentence into a single chunk which is not enough material
// for the topK / minScore / order assertions.
export type ParsedUnitWithoutDocId =
  | Omit<Extract<ParsedUnit, { kind: "page" }>, "documentId">
  | Omit<Extract<ParsedUnit, { kind: "section" }>, "documentId">
  | Omit<Extract<ParsedUnit, { kind: "json-path" }>, "documentId">
  | Omit<Extract<ParsedUnit, { kind: "csv-row" }>, "documentId">
  | Omit<Extract<ParsedUnit, { kind: "html-block" }>, "documentId">
  | Omit<Extract<ParsedUnit, { kind: "unsupported-media" }>, "documentId">;

export interface SeedVectorsOptions {
  readonly capsuleId?: string;
  readonly sourceId?: string;
  readonly documentId?: string;
  readonly text?: string;
  readonly unit?: ParsedUnitWithoutDocId;
  readonly identity?: EmbeddingModelIdentity;
  readonly skipCapsule?: boolean;
  readonly skipSource?: boolean;
  readonly contentHash?: string;
  readonly safeDisplayName?: string;
  readonly chunkingOptions?: ChunkingOptions;
}

// ─── Scripted adapter (deterministic vectors keyed to text input) ─────────────
// Same shape as `indexing/_support.ts:scriptedAdapter`. We don't re-export it because the
// retrieval suite needs a slightly different responder default (vectors derived from the
// request `input`, identical across calls with the same input so the cosine of a chunk
// vs itself is exactly 1).
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

export interface ScriptedAdapterOptions {
  readonly responder?: (request: OpenAIEmbeddingRequest) => OpenAIEmbeddingOutcome;
  readonly identity?: EmbeddingModelIdentity;
  readonly endpoint?: string;
  readonly apiKey?: string;
}

export function scriptedAdapter(options: ScriptedAdapterOptions = {}): OpenAIEmbeddingAdapter {
  const identity = options.identity ?? DEFAULT_EMBEDDING;
  const responder =
    options.responder ??
    ((req: OpenAIEmbeddingRequest): OpenAIEmbeddingOutcome => ({
      ok: true,
      value: {
        vector: deterministicVector(req.input, identity.vectorDimensions),
        modelId: identity.modelId,
        ...(identity.modelRevision !== undefined ? { modelRevision: identity.modelRevision } : {}),
      },
    }));
  return {
    endpoint: options.endpoint ?? "https://example.test/v1",
    apiKey: options.apiKey ?? ["sk-", "test"].join(""),
    request: async (req): Promise<OpenAIEmbeddingOutcome> => Promise.resolve(responder(req)),
  };
}

// ─── Capsule + source + document + chunks + vectors ──────────────────────────
interface ResolvedSeed {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly documentId: DocumentId;
  readonly identity: EmbeddingModelIdentity;
  readonly text: string;
}

function resolveSeed(options: SeedVectorsOptions): ResolvedSeed {
  const capsuleId = (options.capsuleId ?? "cap-1") as KnowledgeCapsuleId;
  const sourceId = (options.sourceId ?? "src-1") as KnowledgeSourceId;
  const documentId = (options.documentId ?? "doc-1") as DocumentId;
  const identity = options.identity ?? DEFAULT_EMBEDDING;
  const baseText =
    options.text ?? "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi";
  // If the caller passes a `unit` with a `characterEnd` beyond the baseText length, pad the
  // text so the chunker's span resolution does not collapse to an empty range. Without this
  // a citation test asserting `characterEnd: 500` on a 60-character text would produce
  // zero chunks (and zero vectors → no references to assert against).
  const requiredEnd =
    options.unit !== undefined && options.unit.kind !== "unsupported-media"
      ? options.unit.characterEnd
      : 0;
  const text = baseText.length >= requiredEnd ? baseText : baseText.padEnd(requiredEnd, " x");
  return { capsuleId, sourceId, documentId, identity, text };
}

function seedRows(store: KnowledgeStore, options: SeedVectorsOptions, seed: ResolvedSeed): void {
  if (options.skipCapsule !== true) {
    createCapsule(
      store,
      sampleCapsuleInput({ id: seed.capsuleId, embeddingModelIdentity: seed.identity }),
    );
  }
  if (options.skipSource !== true) {
    addSourceToCapsule(store, seed.capsuleId, sampleSourceInput(String(seed.sourceId)));
  }
  insertDocumentRow(store._internal.db, {
    id: seed.documentId,
    capsuleId: seed.capsuleId,
    sourceId: String(seed.sourceId),
    documentPath: "docs/sample.txt",
    sizeBytes: 1024,
    mediaType: "text/plain",
    contentHash: options.contentHash ?? "a".repeat(64),
    parserId: "text",
    parserVersion: "1",
    lastExtractedAt: 1_700_000_000_000,
    status: "extracted",
    safeDisplayName: options.safeDisplayName ?? "sample.txt",
  });
  insertParsedUnitRow(
    store._internal.db,
    seed.capsuleId,
    // Unit ids must be globally unique (parsed_units.id is the PK; the composite
    // UNIQUE (capsule_id, id) is a *secondary* constraint), so we namespace by capsule id.
    `unit-${String(seed.capsuleId)}`,
    composeUnit(options.unit, seed),
  );
}

function composeUnit(unit: ParsedUnitWithoutDocId | undefined, seed: ResolvedSeed): ParsedUnit {
  if (unit === undefined) {
    return {
      kind: "page",
      documentId: seed.documentId,
      pageNumber: 7,
      pageLabel: "vii",
      characterStart: 0,
      characterEnd: seed.text.length,
    };
  }
  return { ...unit, documentId: seed.documentId };
}

async function embedSeedChunks(
  store: KnowledgeStore,
  seed: ResolvedSeed,
  chunkIds: readonly ChunkId[],
): Promise<readonly ChunkToEmbed[]> {
  const chunks: ChunkToEmbed[] = chunkIds.map((id, i) => ({
    id,
    capsuleId: seed.capsuleId,
    sourceId: seed.sourceId,
    documentId: seed.documentId,
    text: `chunk-${String(i)}-${seed.capsuleId}`,
  }));
  let counter = 0;
  const idSource = (): string => {
    counter += 1;
    return `storage-${String(counter)}`;
  };
  await embedChunkBatch(chunks, {
    adapter: scriptedAdapter({ identity: seed.identity }),
    store,
    pinnedIdentity: seed.identity,
    concurrency: 2,
    now: (): number => 1_700_000_000_000,
    idSource,
  });
  return chunks;
}

export async function seedCapsuleWithVectors(
  store: KnowledgeStore,
  options: SeedVectorsOptions = {},
): Promise<SeededVectors> {
  const seed = resolveSeed(options);
  seedRows(store, options, seed);
  const chunkResult = chunkDocument(
    store,
    {
      capsuleId: seed.capsuleId,
      sourceId: seed.sourceId,
      documentId: seed.documentId,
      sourceText: seed.text,
    },
    // Default to many small chunks so tests of topK / minScore / order have material to
    // discriminate. A caller can pass an explicit `chunkingOptions` to override.
    options.chunkingOptions ?? { maxTokens: 2, minTokens: 0, overlapTokens: 0 },
  );
  const chunks = await embedSeedChunks(store, seed, chunkResult.chunkIds);
  return {
    capsuleId: seed.capsuleId,
    sourceId: seed.sourceId,
    documentId: seed.documentId,
    chunkIds: chunkResult.chunkIds,
    vectorTexts: chunks.map((c) => c.text),
  };
}
