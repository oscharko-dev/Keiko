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
import { DEFAULT_MAX_TOKENS, DEFAULT_MIN_TOKENS, DEFAULT_OVERLAP_TOKENS } from "./types.js";
import { defaultTokenEstimator } from "./token-estimator.js";

function resolveOptions(options: ChunkingOptions | undefined): ResolvedChunkingOptions {
  const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const minTokens = options?.minTokens ?? DEFAULT_MIN_TOKENS;
  const overlapTokens = options?.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;
  const tokenEstimator: TokenEstimator = options?.tokenEstimator ?? defaultTokenEstimator;
  return { maxTokens, minTokens, overlapTokens, tokenEstimator };
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

function buildChunk(
  sourceText: string,
  start: number,
  end: number,
  estimator: TokenEstimator,
): ChunkingResult {
  const excerpt = sourceText.slice(start, end);
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

export function chunkParsedUnit(
  unit: ParsedUnit,
  sourceText: string,
  options?: ChunkingOptions,
): readonly ChunkingResult[] {
  const resolved = resolveOptions(options);
  const span = spanForUnit(unit, sourceText.length);
  if (span === undefined) return [];

  const excerpt = sourceText.slice(span.start, span.end);
  if (shouldEmitSingleChunk(excerpt, resolved)) {
    return [buildChunk(sourceText, span.start, span.end, resolved.tokenEstimator)];
  }

  const { maxChars, stride } = computeStepSizes(resolved);
  const chunks: ChunkingResult[] = [];
  let cursor = span.start;
  while (cursor < span.end) {
    const end = Math.min(cursor + maxChars, span.end);
    chunks.push(buildChunk(sourceText, cursor, end, resolved.tokenEstimator));
    if (end >= span.end) break;
    cursor += stride;
  }
  return chunks;
}
