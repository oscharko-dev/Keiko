// Type contracts for the chunking layer (Epic #189, Issue #195). Chunks are the unit of
// retrieval — each row in the `chunks` table references exactly one parsed_unit (the
// citation hop entrypoint) and carries `safeExcerptHash` (SHA-256 hex) instead of raw
// text so the row is safe to copy across the trust boundary. Raw text is reconstructable
// at retrieval time via parsed_unit → document → bytes.
//
// `tokenEstimator` is retained as the narrow test/fallback seam, while `tokenizer` carries
// the production identity needed for stale-index detection. The default tokenizer in
// `token-estimator.ts` is a calibrated deterministic estimate, not a real Qwen3 tokenizer.

import type {
  ChunkId,
  DocumentId,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";

import { KnowledgeStoreError } from "../errors.js";

// Pure, deterministic function: same text -> same number. No async, no IO.
export type TokenEstimator = (text: string) => number;

export type LocalKnowledgeTokenizerKind = "tokenizer" | "estimator";

export interface LocalKnowledgeTokenizer {
  // Stable, non-sensitive key. This participates in chunkingStrategyKey, so changing it is
  // reindex-relevant by design.
  readonly identity: string;
  readonly kind: LocalKnowledgeTokenizerKind;
  readonly countTokens: TokenEstimator;
}

export interface ChunkingOptions {
  readonly maxTokens?: number;
  readonly minTokens?: number;
  readonly overlapTokens?: number;
  readonly maxChunks?: number;
  readonly tokenizer?: LocalKnowledgeTokenizer;
  readonly tokenEstimator?: TokenEstimator;
  // Internal stale-index salt threaded by the indexing orchestrator. Contextual retrieval
  // changes the text sent to embeddings/FTS without changing original citation offsets, so
  // its prompt/model/version key must still participate in the chunk/vector freshness key.
  readonly indexingTextStrategyKey?: string;
}

// Defaults documented inline so a caller passing `{}` gets predictable behaviour.
export const DEFAULT_MAX_TOKENS = 512;
export const DEFAULT_MIN_TOKENS = 64;
export const DEFAULT_OVERLAP_TOKENS = 50;
export const DEFAULT_MAX_CHUNKS = 50_000;
export const MAX_CHUNK_TOKENS = 2_048;
export const MAX_OVERLAP_TOKENS = 1_024;
export const CHUNKING_STRATEGY_VERSION = "boundary-v3" as const;
export const DEFAULT_INDEXING_TEXT_STRATEGY_KEY = "indexed-text=raw-v1" as const;
export const CONSERVATIVE_TOKENIZER_ID = "keiko-conservative-estimator-v2" as const;
export const CUSTOM_TOKEN_ESTIMATOR_ID = "custom-token-estimator-v1" as const;
export const QWEN3_SENTENCEPIECE_TOKENIZER_ID = "qwen3-sentencepiece-tokenizer-v1" as const;
export const DEFAULT_CHUNKING_STRATEGY_KEY =
  `${CHUNKING_STRATEGY_VERSION}|max=${String(DEFAULT_MAX_TOKENS)}|min=${String(DEFAULT_MIN_TOKENS)}|overlap=${String(DEFAULT_OVERLAP_TOKENS)}|limit=${String(DEFAULT_MAX_CHUNKS)}|tokenizer=${CONSERVATIVE_TOKENIZER_ID}|${DEFAULT_INDEXING_TEXT_STRATEGY_KEY}` as const;

export interface ResolvedChunkingOptions {
  readonly maxTokens: number;
  readonly minTokens: number;
  readonly overlapTokens: number;
  readonly maxChunks: number;
  readonly tokenizer: LocalKnowledgeTokenizer;
  readonly tokenEstimator: TokenEstimator;
}

// Per-document orchestration parameters. `parsedUnitId` is stored in `chunks.parsed_unit_id`
// so the citation hop chain (chunk → parsed_unit → page/section) survives across processes.
export interface ChunkDocumentParams {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly documentId: DocumentId;
  // Full source text for the document, indexable by `parsed_unit.character_start/end`.
  // The runner reads parsed_units from the store and slices this text by their character
  // offsets — never persists it.
  readonly sourceText: string;
  readonly force?: boolean;
  readonly signal?: AbortSignal;
}

export interface ChunkDocumentResult {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly documentId: DocumentId;
  readonly chunkIds: readonly ChunkId[];
  // `skippedExisting` is true when force=false and existing chunks were left in place.
  readonly skippedExisting: boolean;
}

// Distinct from KnowledgeStoreError so a test asserting "chunking guard fail-closed" cannot
// accidentally accept any other error class. Extends KnowledgeStoreError so callers that
// only catch the parent class still see the failure.
export class ChunkingError extends KnowledgeStoreError {
  public override readonly name: string = "ChunkingError";
}

// Internal chunk representation produced by `chunkParsedUnit`. The runner stamps the
// per-document `orderIndex` and converts to the persisted shape; consumers outside this
// package see `ChunkRecord` from the contracts package.
export interface ChunkingResult {
  readonly characterStart: number;
  readonly characterEnd: number;
  readonly tokenCount: number;
  readonly safeExcerptHash: string;
}
