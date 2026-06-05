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
import { createCapsule } from "./capsule-lifecycle.js";
import { insertDocumentRow, insertParsedUnitRow } from "./discovery/persist.js";
import { embedChunkBatch } from "./indexing/embedding-batcher.js";
import type { ChunkToEmbed } from "./indexing/types.js";
import { addSourceToCapsule } from "./source-lifecycle.js";
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
        ...(identity.modelRevision !== undefined
          ? { modelRevision: identity.modelRevision }
          : {}),
      },
    }));
  return {
    endpoint: options.endpoint ?? "https://example.test/v1",
    apiKey: options.apiKey ?? "sk-test",
    request: async (request): Promise<OpenAIEmbeddingOutcome> => Promise.resolve(responder(request)),
  };
}

function sampleCapsuleInput(
  overrides: Readonly<{
    id: KnowledgeCapsuleId;
    embeddingModelIdentity: EmbeddingModelIdentity;
  }>,
) {
  return {
    id: overrides.id,
    displayName: "Engineering Capsule",
    tags: ["alpha", "beta"],
    retrievalEffort: "default" as const,
    outputMode: "answers" as const,
    answerGroundingPolicy: "require-citations" as const,
    embeddingModelIdentity: overrides.embeddingModelIdentity,
    lifecycleState: "draft" as const,
    storageReference: "engineering/capsule-1",
  };
}

function sampleSourceInput(id: KnowledgeSourceId) {
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

export async function seedCapsuleWithVectors(
  store: KnowledgeStore,
  options: SeedVectorsOptions = {},
): Promise<SeededVectors> {
  const capsuleId = (options.capsuleId ?? "cap-1") as KnowledgeCapsuleId;
  const sourceId = (options.sourceId ?? "src-1") as KnowledgeSourceId;
  const documentId = (options.documentId ?? "doc-1") as DocumentId;
  const identity = options.identity ?? DEFAULT_EMBEDDING;
  const baseText =
    options.text ?? "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi";
  const requiredEnd =
    options.unit !== undefined && options.unit.kind !== "unsupported-media"
      ? options.unit.characterEnd
      : 0;
  const text = baseText.length >= requiredEnd ? baseText : baseText.padEnd(requiredEnd, " x");

  createCapsule(store, sampleCapsuleInput({ id: capsuleId, embeddingModelIdentity: identity }));
  addSourceToCapsule(store, capsuleId, sampleSourceInput(sourceId));
  insertDocumentRow(store._internal.db, {
    id: documentId,
    capsuleId,
    sourceId: String(sourceId),
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
    capsuleId,
    `unit-${String(capsuleId)}`,
    composeUnit(options.unit, documentId, text.length),
  );

  const chunkResult = chunkDocument(
    store,
    {
      capsuleId,
      sourceId,
      documentId,
      sourceText: text,
    },
    options.chunkingOptions ?? { maxTokens: 2, minTokens: 0, overlapTokens: 0 },
  );
  const chunks: ChunkToEmbed[] = chunkResult.chunkIds.map((id, index) => ({
    id,
    capsuleId,
    sourceId,
    documentId,
    text: `chunk-${String(index)}-${String(capsuleId)}`,
  }));
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
  return {
    capsuleId,
    sourceId,
    documentId,
    chunkIds: chunkResult.chunkIds,
    vectorTexts: chunks.map((chunk) => chunk.text),
  };
}
