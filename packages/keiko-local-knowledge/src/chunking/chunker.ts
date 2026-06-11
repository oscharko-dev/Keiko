// Pure chunking function (Epic #189, Issue #195).
//
// Given a parsed unit + the document's full source text + chunking options, produce one
// or more `ChunkingResult` slices. The function is deliberately pure (no IO, no clock, no
// hashing of external state) so it can be unit-tested without a SQLite store.
//
// Algorithm:
//   1. Resolve the unit's character span. For unit kinds that carry `characterStart/end`
//      (page/section/json-path/csv-row/html-block), slice the source text by those
//      offsets. For unsupported-media units (no offsets), emit nothing — these units
//      are tracked for diagnostics, not for retrieval.
//   2. If the slice's estimated tokens < minTokens, emit a single chunk over the entire
//      slice — never drop content.
//   3. Otherwise walk forward by `maxChars - overlapChars` per step, emitting chunks of
//      length `maxChars`. The last chunk includes whatever trailing text remains, even
//      if it is shorter than minTokens — never drop content.
//   4. Hostile fallback: when no whitespace appears inside the maxChars window (single
//      very long line), the algorithm still produces chunks because slicing is purely
//      character-bounded. Token boundaries become advisory, not authoritative; that
//      tradeoff is intentional and documented.

import { createHash } from "node:crypto";

import type { ParsedUnit } from "@oscharko-dev/keiko-contracts";

import { charsForTokenBudget } from "./token-estimator.js";
import type {
  ChunkingOptions,
  ChunkingResult,
  ResolvedChunkingOptions,
  TokenEstimator,
} from "./types.js";
import {
  ChunkingError,
  DEFAULT_CHUNKING_STRATEGY_KEY,
  DEFAULT_MAX_CHUNKS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MIN_TOKENS,
  DEFAULT_OVERLAP_TOKENS,
  MAX_CHUNK_TOKENS,
  MAX_OVERLAP_TOKENS,
  CHUNKING_STRATEGY_VERSION,
} from "./types.js";
import { defaultTokenEstimator } from "./token-estimator.js";

const WHITESPACE_PATTERN = /\s+/gu;
const INFORMATIVE_CHARACTER_PATTERN = /[\p{L}\p{N}]/u;

function positiveInteger(raw: number | undefined, fallback: number, field: string): number {
  const value = raw ?? fallback;
  if (!Number.isFinite(value) || value < 1) {
    throw new ChunkingError(`${field} must be a positive finite integer`);
  }
  return Math.floor(value);
}

function nonNegativeInteger(raw: number | undefined, fallback: number, field: string): number {
  const value = raw ?? fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new ChunkingError(`${field} must be a non-negative finite integer`);
  }
  return Math.floor(value);
}

export function resolveChunkingOptions(
  options: ChunkingOptions | undefined,
): ResolvedChunkingOptions {
  const maxTokens = Math.min(
    positiveInteger(options?.maxTokens, DEFAULT_MAX_TOKENS, "maxTokens"),
    MAX_CHUNK_TOKENS,
  );
  const minTokens = nonNegativeInteger(options?.minTokens, DEFAULT_MIN_TOKENS, "minTokens");
  const overlapTokens = Math.min(
    nonNegativeInteger(options?.overlapTokens, DEFAULT_OVERLAP_TOKENS, "overlapTokens"),
    MAX_OVERLAP_TOKENS,
  );
  const maxChunks = Math.min(
    positiveInteger(options?.maxChunks, DEFAULT_MAX_CHUNKS, "maxChunks"),
    DEFAULT_MAX_CHUNKS,
  );
  const tokenEstimator: TokenEstimator = options?.tokenEstimator ?? defaultTokenEstimator;
  return { maxTokens, minTokens, overlapTokens, maxChunks, tokenEstimator };
}

export function chunkingStrategyKey(options: ChunkingOptions | undefined): string {
  if (options === undefined) return DEFAULT_CHUNKING_STRATEGY_KEY;
  const resolved = resolveChunkingOptions(options);
  return [
    CHUNKING_STRATEGY_VERSION,
    `max=${String(resolved.maxTokens)}`,
    `min=${String(resolved.minTokens)}`,
    `overlap=${String(resolved.overlapTokens)}`,
    `limit=${String(resolved.maxChunks)}`,
    options.tokenEstimator === undefined ? "estimator=default" : "estimator=custom",
  ].join("|");
}

interface UnitSpan {
  readonly start: number;
  readonly end: number;
}

function spanForUnit(unit: ParsedUnit, sourceLength: number): UnitSpan | undefined {
  if (unit.kind === "unsupported-media") return undefined;
  const start = Math.max(0, Math.min(unit.characterStart, sourceLength));
  const end = Math.max(start, Math.min(unit.characterEnd, sourceLength));
  if (end <= start) return undefined;
  return { start, end };
}

function hashExcerpt(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function normaliseChunkText(text: string): string {
  return text.normalize("NFKC").replace(WHITESPACE_PATTERN, " ").trim();
}

export function chunkDedupeKey(text: string): string | undefined {
  const normalised = normaliseChunkText(text);
  if (normalised.length === 0) return undefined;
  if (!INFORMATIVE_CHARACTER_PATTERN.test(normalised)) return undefined;
  return hashExcerpt(normalised);
}

function buildChunk(
  sourceText: string,
  start: number,
  end: number,
  estimator: TokenEstimator,
): ChunkingResult | undefined {
  const excerpt = sourceText.slice(start, end);
  if (chunkDedupeKey(excerpt) === undefined) return undefined;
  return {
    characterStart: start,
    characterEnd: end,
    tokenCount: estimator(excerpt),
    safeExcerptHash: hashExcerpt(excerpt),
  };
}

interface StepSizes {
  readonly maxChars: number;
  readonly overlapChars: number;
  readonly stride: number;
}

function computeStepSizes(resolved: ResolvedChunkingOptions): StepSizes {
  const maxChars = Math.max(1, charsForTokenBudget(resolved.maxTokens));
  // Clamp overlap to [0, maxChars-1] so stride is always at least 1 — otherwise an
  // overlap >= maxChars would produce an infinite loop.
  const overlapChars = Math.max(
    0,
    Math.min(charsForTokenBudget(resolved.overlapTokens), maxChars - 1),
  );
  const stride = maxChars - overlapChars;
  return { maxChars, overlapChars, stride };
}

function shouldEmitSingleChunk(excerpt: string, resolved: ResolvedChunkingOptions): boolean {
  // The unit fits in one chunk when its estimated token count does not exceed maxTokens.
  // The `minTokens` lower bound is a *floor* on chunk size, not a gate — a tiny unit still
  // produces one chunk so we never drop content (spec edge case: "Single tiny unit").
  return resolved.tokenEstimator(excerpt) <= resolved.maxTokens;
}

function pushChunk(
  chunks: ChunkingResult[],
  chunk: ChunkingResult | undefined,
  maxChunks: number,
): void {
  if (chunk === undefined) return;
  if (chunks.length >= maxChunks) {
    throw new ChunkingError(`chunkParsedUnit exceeded maxChunks ${String(maxChunks)}`);
  }
  chunks.push(chunk);
}

export function chunkParsedUnit(
  unit: ParsedUnit,
  sourceText: string,
  options?: ChunkingOptions,
): readonly ChunkingResult[] {
  const resolved = resolveChunkingOptions(options);
  const span = spanForUnit(unit, sourceText.length);
  if (span === undefined) return [];

  const excerpt = sourceText.slice(span.start, span.end);
  if (shouldEmitSingleChunk(excerpt, resolved)) {
    const chunk = buildChunk(sourceText, span.start, span.end, resolved.tokenEstimator);
    return chunk === undefined ? [] : [chunk];
  }

  const { maxChars, stride } = computeStepSizes(resolved);
  const chunks: ChunkingResult[] = [];
  let cursor = span.start;
  while (cursor < span.end) {
    const end = Math.min(cursor + maxChars, span.end);
    pushChunk(
      chunks,
      buildChunk(sourceText, cursor, end, resolved.tokenEstimator),
      resolved.maxChunks,
    );
    if (end >= span.end) break;
    cursor += stride;
  }
  return chunks;
}
