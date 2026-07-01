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

import { chunkDocument } from "./chunking/chunker-runner.js";
import type { ChunkingOptions } from "./chunking/types.js";
import { createCapsule, type CreateCapsuleInput } from "./capsule-lifecycle.js";
import { insertDocumentRow, insertDocumentTextRow, insertParsedUnitRow } from "./discovery/persist.js";
import { embedChunkBatch } from "./indexing/embedding-batcher.js";
import { replaceLexicalRowsForDocument } from "./indexing/lexical-index-persist.js";
import type { ChunkToEmbed } from "./indexing/types.js";
import { addSourceToCapsule, type AddCapsuleSourceInput } from "./source-lifecycle.js";
import type { KnowledgeStore } from "./store.js";

const DEFAULT_EMBEDDING: EmbeddingModelIdentity = {
  provider: "openai",
  modelId: "text-embedding-3-small",
  vectorDimensions: 1536,
  vectorMetric: "cosine",
};

type ParsedUnitWithoutDocId =
  | Omit<Extract<ParsedUnit, { kind: "page" }>, "documentId">
  | Omit<Extract<ParsedUnit, { kind: "section" }>, "documentId">
  | Omit<Extract<ParsedUnit, { kind: "json-path" }>, "documentId">
  | Omit<Extract<ParsedUnit, { kind: "csv-row" }>, "documentId">
  | Omit<Extract<ParsedUnit, { kind: "html-block" }>, "documentId">
  | Omit<Extract<ParsedUnit, { kind: "unsupported-media" }>, "documentId">;

export interface SeedVectorsOptions {
  readonly capsuleId?: string;
  readonly displayName?: string;
  readonly sourceId?: string;
  readonly documentId?: string;
  readonly text?: string;
  readonly unit?: ParsedUnitWithoutDocId;
  readonly identity?: EmbeddingModelIdentity;
  readonly contentHash?: string;
  readonly safeDisplayName?: string;
  readonly chunkingOptions?: ChunkingOptions;
}

export interface SeededVectors {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly documentId: DocumentId;
  readonly chunkIds: readonly ChunkId[];
  readonly vectorTexts: readonly string[];
}

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
    ((request: OpenAIEmbeddingRequest): OpenAIEmbeddingOutcome => ({
      ok: true,
      value: {
        vector: deterministicVector(request.input, identity.vectorDimensions),
        modelId: identity.modelId,
        ...(identity.modelRevision !== undefined ? { modelRevision: identity.modelRevision } : {}),
      },
    }));
  return {
    endpoint: options.endpoint ?? "https://example.test/v1",
    apiKey: options.apiKey ?? ["sk-", "test"].join(""),
    request: async (request): Promise<OpenAIEmbeddingOutcome> =>
      Promise.resolve(responder(request)),
  };
}

function sampleCapsuleInput(
  overrides: Readonly<{
    id: KnowledgeCapsuleId;
    displayName?: string;
    embeddingModelIdentity: EmbeddingModelIdentity;
  }>,
): CreateCapsuleInput {
  return {
    id: overrides.id,
    displayName: overrides.displayName ?? "Engineering Capsule",
    tags: ["alpha", "beta"],
    retrievalEffort: "default" as const,
    outputMode: "answers" as const,
    answerGroundingPolicy: "require-citations" as const,
    embeddingModelIdentity: overrides.embeddingModelIdentity,
    lifecycleState: "draft" as const,
    storageReference: "engineering/capsule-1",
  };
}

function sampleSourceInput(id: KnowledgeSourceId): AddCapsuleSourceInput {
  return {
    id,
    displayName: `Source ${String(id)}`,
    tags: [],
    scope: {
      kind: "folder" as const,
      rootPath: "/srv/docs",
      recursive: true,
    },
  };
}

interface ResolvedSeedOptions {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly displayName: string;
  readonly sourceId: KnowledgeSourceId;
  readonly documentId: DocumentId;
  readonly identity: EmbeddingModelIdentity;
  readonly text: string;
  readonly contentHash: string;
  readonly safeDisplayName: string;
  readonly unit: ParsedUnit;
  readonly chunkingOptions: ChunkingOptions;
}

function composeUnit(
  unit: ParsedUnitWithoutDocId | undefined,
  documentId: DocumentId,
  textLength: number,
): ParsedUnit {
  if (unit !== undefined) {
    return { ...unit, documentId };
  }
  return {
    kind: "page",
    documentId,
    pageNumber: 7,
    pageLabel: "vii",
    characterStart: 0,
    characterEnd: textLength,
  };
}

function normalizeSeedText(
  unit: ParsedUnitWithoutDocId | undefined,
  text: string | undefined,
): string {
  const baseText =
    text ?? "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi";
  const requiredEnd =
    unit !== undefined && unit.kind !== "unsupported-media" ? unit.characterEnd : 0;
  return baseText.length >= requiredEnd ? baseText : baseText.padEnd(requiredEnd, " x");
}

function resolveSeedOptions(options: SeedVectorsOptions): ResolvedSeedOptions {
  const capsuleId = (options.capsuleId ?? "cap-1") as KnowledgeCapsuleId;
  const sourceId = (options.sourceId ?? "src-1") as KnowledgeSourceId;
  const documentId = (options.documentId ?? "doc-1") as DocumentId;
  const identity = options.identity ?? DEFAULT_EMBEDDING;
  const text = normalizeSeedText(options.unit, options.text);
  return {
    capsuleId,
    displayName: options.displayName ?? "Engineering Capsule",
    sourceId,
    documentId,
    identity,
    text,
    contentHash: options.contentHash ?? "a".repeat(64),
    safeDisplayName: options.safeDisplayName ?? "sample.txt",
    unit: composeUnit(options.unit, documentId, text.length),
    chunkingOptions: options.chunkingOptions ?? { maxTokens: 2, minTokens: 0, overlapTokens: 0 },
  };
}

function insertSeedRows(store: KnowledgeStore, options: ResolvedSeedOptions): void {
  createCapsule(
    store,
    sampleCapsuleInput({
      id: options.capsuleId,
      displayName: options.displayName,
      embeddingModelIdentity: options.identity,
    }),
  );
  addSourceToCapsule(store, options.capsuleId, sampleSourceInput(options.sourceId));
  insertDocumentRow(store._internal.db, {
    id: options.documentId,
    capsuleId: options.capsuleId,
    sourceId: String(options.sourceId),
    documentPath: "docs/sample.txt",
    sizeBytes: 1024,
    mediaType: "text/plain",
    contentHash: options.contentHash,
    parserId: "text",
    parserVersion: "1",
    lastExtractedAt: 1_700_000_000_000,
    status: "extracted",
    safeDisplayName: options.safeDisplayName,
  });
  insertDocumentTextRow(
    store._internal.db,
    store._internal.contentCipher,
    options.capsuleId,
    options.documentId,
    options.text,
  );
  insertParsedUnitRow(
    store._internal.db,
    store._internal.contentCipher,
    options.capsuleId,
    `unit-${String(options.capsuleId)}`,
    options.unit,
  );
}

function buildSeedChunks(
  store: KnowledgeStore,
  options: ResolvedSeedOptions,
): Readonly<{
  chunkIds: readonly ChunkId[];
  chunks: readonly ChunkToEmbed[];
}> {
  const chunkResult = chunkDocument(
    store,
    {
      capsuleId: options.capsuleId,
      sourceId: options.sourceId,
      documentId: options.documentId,
      sourceText: options.text,
    },
    options.chunkingOptions,
  );
  return {
    chunkIds: chunkResult.chunkIds,
    chunks: chunkResult.chunkIds.map((id, index) => ({
      id,
      capsuleId: options.capsuleId,
      sourceId: options.sourceId,
      documentId: options.documentId,
      text: `chunk-${String(index)}-${String(options.capsuleId)}`,
    })),
  };
}

async function embedSeedChunks(
  store: KnowledgeStore,
  identity: EmbeddingModelIdentity,
  chunks: readonly ChunkToEmbed[],
): Promise<void> {
  let counter = 0;
  await embedChunkBatch(chunks, {
    adapter: scriptedAdapter({ identity }),
    store,
    pinnedIdentity: identity,
    concurrency: 2,
    now: (): number => 1_700_000_000_000,
    idSource: (): string => {
      counter += 1;
      return `storage-${String(counter)}`;
    },
  });
}

interface SeedChunkSpanRow {
  readonly id: string;
  readonly source_id: string;
  readonly character_start: number | null;
  readonly character_end: number | null;
}

function indexSeedLexicalRows(
  store: KnowledgeStore,
  options: ResolvedSeedOptions,
  chunkIds: readonly ChunkId[],
): void {
  if (chunkIds.length === 0) {
    replaceLexicalRowsForDocument(store._internal.db, options.capsuleId, options.documentId, []);
    return;
  }
  const rows = store._internal.db
    .prepare(
      [
        "SELECT id, source_id, character_start, character_end",
        "FROM chunks",
        "WHERE capsule_id = :c AND document_id = :d",
        "ORDER BY order_index ASC",
      ].join(" "),
    )
    .all({ c: String(options.capsuleId), d: String(options.documentId) }) as unknown as
    readonly SeedChunkSpanRow[];
  replaceLexicalRowsForDocument(
    store._internal.db,
    options.capsuleId,
    options.documentId,
    rows.map((row) => {
      const start = row.character_start ?? 0;
      const end = row.character_end ?? options.text.length;
      const text = options.text.slice(start, end);
      return {
        capsuleId: options.capsuleId,
        sourceId: row.source_id as KnowledgeSourceId,
        documentId: options.documentId,
        chunkId: row.id as ChunkId,
        text,
        exactText: text,
        updatedAt: 1_700_000_000_000,
      };
    }),
  );
}

export async function seedCapsuleWithVectors(
  store: KnowledgeStore,
  options: SeedVectorsOptions = {},
): Promise<SeededVectors> {
  const resolved = resolveSeedOptions(options);
  insertSeedRows(store, resolved);
  const { chunkIds, chunks } = buildSeedChunks(store, resolved);
  indexSeedLexicalRows(store, resolved, chunkIds);
  await embedSeedChunks(store, resolved.identity, chunks);
  return {
    capsuleId: resolved.capsuleId,
    sourceId: resolved.sourceId,
    documentId: resolved.documentId,
    chunkIds,
    vectorTexts: chunks.map((chunk) => chunk.text),
  };
}
