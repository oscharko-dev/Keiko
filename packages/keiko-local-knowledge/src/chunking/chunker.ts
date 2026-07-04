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
//   2. If the slice's estimated tokens fit the max budget, emit a single chunk over the
//      entire slice — never drop content.
//   3. Otherwise walk forward by token-checked windows and choose each end boundary in
//      this order: paragraph/heading, sentence, whitespace/word, hard cut.
//   4. Overlap starts are adjusted to word boundaries when possible, so overlap does not
//      normally begin in the middle of a token-like word.
//   5. Hostile fallback: when no useful boundary exists inside budget (single very long
//      line), the algorithm still emits a bounded hard-cut chunk.

import { createHash } from "node:crypto";

import type { ParsedUnit } from "@oscharko-dev/keiko-contracts";

import { charsForTokenBudget } from "./token-estimator.js";
import type {
  ChunkingOptions,
  ChunkingResult,
  LocalKnowledgeTokenizer,
  ResolvedChunkingOptions,
  TokenEstimator,
} from "./types.js";
import {
  ChunkingError,
  CUSTOM_TOKEN_ESTIMATOR_ID,
  DEFAULT_CHUNKING_STRATEGY_KEY,
  DEFAULT_INDEXING_TEXT_STRATEGY_KEY,
  DEFAULT_MAX_CHUNKS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MIN_TOKENS,
  DEFAULT_OVERLAP_TOKENS,
  MAX_CHUNK_TOKENS,
  MAX_OVERLAP_TOKENS,
  CHUNKING_STRATEGY_VERSION,
} from "./types.js";
import { conservativeTokenEstimatorTokenizer } from "./token-estimator.js";

const WHITESPACE_PATTERN = /\s+/gu;
const SINGLE_WHITESPACE_PATTERN = /\s/u;
const INFORMATIVE_CHARACTER_PATTERN = /[\p{L}\p{N}]/u;
const WORD_CHARACTER_PATTERN = /[\p{L}\p{N}_]/u;
const PARAGRAPH_BOUNDARY_PATTERN = /\n[ \t]*\n+/g;
const MARKDOWN_HEADING_PATTERN = /\n[ \t]*#{1,6}[ \t]+\S/g;
const HTML_HEADING_PATTERN = /\n?[ \t]*<\/?h[1-6](?:\s|>|$)/gi;
const SENTENCE_BOUNDARY_PATTERN = /[.!?。！？][)"'\]\u00bb\u201d\u2019]*\s+/g;

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
  const tokenizer = resolveTokenizer(options);
  return {
    maxTokens,
    minTokens,
    overlapTokens,
    maxChunks,
    tokenizer,
    tokenEstimator: tokenizer.countTokens,
  };
}

function resolveTokenizer(options: ChunkingOptions | undefined): LocalKnowledgeTokenizer {
  if (options?.tokenizer !== undefined) return options.tokenizer;
  if (options?.tokenEstimator !== undefined) {
    return {
      identity: CUSTOM_TOKEN_ESTIMATOR_ID,
      kind: "estimator",
      countTokens: options.tokenEstimator,
    };
  }
  return conservativeTokenEstimatorTokenizer;
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
    `tokenizer=${resolved.tokenizer.identity}`,
    options.indexingTextStrategyKey ?? DEFAULT_INDEXING_TEXT_STRATEGY_KEY,
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

function estimateSliceTokens(
  sourceText: string,
  start: number,
  end: number,
  estimator: TokenEstimator,
): number {
  return estimator(sourceText.slice(start, end));
}

function tokenBudgetEnd(
  sourceText: string,
  start: number,
  limit: number,
  resolved: ResolvedChunkingOptions,
): number {
  const initialEnd = Math.max(
    start + 1,
    Math.min(limit, start + Math.max(1, charsForTokenBudget(resolved.maxTokens))),
  );
  if (
    estimateSliceTokens(sourceText, start, initialEnd, resolved.tokenEstimator) <=
    resolved.maxTokens
  ) {
    return initialEnd;
  }

  let lo = start + 1;
  let hi = initialEnd;
  let best = lo;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (
      estimateSliceTokens(sourceText, start, mid, resolved.tokenEstimator) <= resolved.maxTokens
    ) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function boundaryAfterMatch(start: number, matchIndex: number, matchText: string): number {
  return start + matchIndex + matchText.length;
}

function collectBoundaryMatches(
  sourceText: string,
  start: number,
  maxEnd: number,
  pattern: RegExp,
  mode: "after-match" | "before-match",
): number[] {
  const slice = sourceText.slice(start, maxEnd);
  const out: number[] = [];
  pattern.lastIndex = 0;
  for (;;) {
    const match = pattern.exec(slice);
    if (match === null) break;
    const boundary =
      mode === "after-match"
        ? boundaryAfterMatch(start, match.index, match[0])
        : start + match.index + (match[0].startsWith("\n") ? 1 : 0);
    out.push(boundary);
  }
  return out;
}

function lastBoundaryAtOrAfter(
  candidates: readonly number[],
  minEnd: number,
  maxEnd: number,
): number | undefined {
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const candidate = candidates[i];
    if (candidate === undefined) continue;
    if (candidate >= minEnd && candidate <= maxEnd) return candidate;
  }
  return undefined;
}

function isWordBoundary(sourceText: string, index: number): boolean {
  if (index <= 0 || index >= sourceText.length) return true;
  const before = sourceText[index - 1] ?? "";
  const after = sourceText[index] ?? "";
  return !(WORD_CHARACTER_PATTERN.test(before) && WORD_CHARACTER_PATTERN.test(after));
}

function lastWhitespaceBoundary(
  sourceText: string,
  minEnd: number,
  maxEnd: number,
): number | undefined {
  for (let i = maxEnd; i >= minEnd; i -= 1) {
    const before = sourceText[i - 1] ?? "";
    if (SINGLE_WHITESPACE_PATTERN.test(before)) return i;
  }
  return undefined;
}

function adjustedHardEnd(sourceText: string, minEnd: number, maxEnd: number): number {
  if (isWordBoundary(sourceText, maxEnd)) return maxEnd;
  return lastWhitespaceBoundary(sourceText, minEnd, maxEnd) ?? maxEnd;
}

function chooseChunkEnd(
  sourceText: string,
  start: number,
  spanEnd: number,
  resolved: ResolvedChunkingOptions,
): number {
  const maxEnd = tokenBudgetEnd(sourceText, start, spanEnd, resolved);
  if (maxEnd >= spanEnd) return spanEnd;
  const minBoundaryEnd = Math.min(
    maxEnd,
    start + Math.max(1, charsForTokenBudget(Math.min(resolved.minTokens, resolved.maxTokens))),
  );
  const paragraph = lastBoundaryAtOrAfter(
    collectBoundaryMatches(sourceText, start, maxEnd, PARAGRAPH_BOUNDARY_PATTERN, "after-match"),
    minBoundaryEnd,
    maxEnd,
  );
  if (paragraph !== undefined) return paragraph;
  const heading = lastBoundaryAtOrAfter(
    [
      ...collectBoundaryMatches(
        sourceText,
        start,
        maxEnd,
        MARKDOWN_HEADING_PATTERN,
        "before-match",
      ),
      ...collectBoundaryMatches(sourceText, start, maxEnd, HTML_HEADING_PATTERN, "before-match"),
    ].sort((a, b) => a - b),
    minBoundaryEnd,
    maxEnd,
  );
  if (heading !== undefined && heading > start) return heading;
  const sentence = lastBoundaryAtOrAfter(
    collectBoundaryMatches(sourceText, start, maxEnd, SENTENCE_BOUNDARY_PATTERN, "after-match"),
    minBoundaryEnd,
    maxEnd,
  );
  if (sentence !== undefined) return sentence;
  return adjustedHardEnd(sourceText, minBoundaryEnd, maxEnd);
}

function firstWordBoundaryAtOrAfter(
  sourceText: string,
  start: number,
  end: number,
): number | undefined {
  for (let i = start; i < end; i += 1) {
    const before = sourceText[i - 1] ?? "";
    if (SINGLE_WHITESPACE_PATTERN.test(before) && isWordBoundary(sourceText, i)) return i;
  }
  return undefined;
}

function overlapStart(
  sourceText: string,
  chunkStart: number,
  chunkEnd: number,
  resolved: ResolvedChunkingOptions,
): number {
  if (resolved.overlapTokens <= 0) return chunkEnd;
  const target = Math.max(chunkStart, chunkEnd - charsForTokenBudget(resolved.overlapTokens));
  if (target <= chunkStart) return chunkEnd;
  if (isWordBoundary(sourceText, target)) return target;
  const before = lastWhitespaceBoundary(sourceText, chunkStart + 1, target);
  if (before !== undefined && before > chunkStart) return before;
  return firstWordBoundaryAtOrAfter(sourceText, target, chunkEnd) ?? chunkEnd;
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

  const chunks: ChunkingResult[] = [];
  let cursor = span.start;
  while (cursor < span.end) {
    const end = chooseChunkEnd(sourceText, cursor, span.end, resolved);
    pushChunk(
      chunks,
      buildChunk(sourceText, cursor, end, resolved.tokenEstimator),
      resolved.maxChunks,
    );
    if (end >= span.end) break;
    const nextCursor = overlapStart(sourceText, cursor, end, resolved);
    cursor = nextCursor > cursor && nextCursor < end ? nextCursor : end;
  }
  return chunks;
}
