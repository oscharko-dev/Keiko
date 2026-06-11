// Type contracts for the chunking layer (Epic #189, Issue #195). Chunks are the unit of
// retrieval — each row in the `chunks` table references exactly one parsed_unit (the
// citation hop entrypoint) and carries `safeExcerptHash` (SHA-256 hex) instead of raw
// text so the row is safe to copy across the trust boundary. Raw text is reconstructable
// at retrieval time via parsed_unit → document → bytes.
//
// `tokenEstimator` is injected so future tokenizer upgrades (#196, #199) can swap in a
// real tokenizer (e.g. tiktoken) without rewiring callers. The default estimator in
// `token-estimator.ts` is intentionally crude (~4 chars per token) — see that file's
// header for the documented limitation.

import type {
  ChunkId,
  DocumentId,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";

import { KnowledgeStoreError } from "../errors.js";

// Pure, deterministic function: same text → same number. No async, no IO.
export type TokenEstimator = (text: string) => number;

export interface ChunkingOptions {
  readonly maxTokens?: number;
  readonly minTokens?: number;
  readonly overlapTokens?: number;
  readonly maxChunks?: number;
  readonly tokenEstimator?: TokenEstimator;
}

// Defaults documented inline so a caller passing `{}` gets predictable behaviour.
export const DEFAULT_MAX_TOKENS = 400;
export const DEFAULT_MIN_TOKENS = 64;
export const DEFAULT_OVERLAP_TOKENS = 32;
export const DEFAULT_MAX_CHUNKS = 50_000;
export const MAX_CHUNK_TOKENS = 2_048;
export const MAX_OVERLAP_TOKENS = 1_024;
export const CHUNKING_STRATEGY_VERSION = "issue-195-v2" as const;
export const DEFAULT_CHUNKING_STRATEGY_KEY =
  `${CHUNKING_STRATEGY_VERSION}|max=${String(DEFAULT_MAX_TOKENS)}|min=${String(DEFAULT_MIN_TOKENS)}|overlap=${String(DEFAULT_OVERLAP_TOKENS)}|limit=${String(DEFAULT_MAX_CHUNKS)}|estimator=default` as const;

export interface ResolvedChunkingOptions {
  readonly maxTokens: number;
  readonly minTokens: number;
  readonly overlapTokens: number;
  readonly maxChunks: number;
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
