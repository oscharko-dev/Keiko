// Quality Intelligence — oversize guards (Epic #270, Issue #284).
//
// Pure assertion-style predicates that callers can layer at boundaries to reject
// inputs whose size would force unbounded work downstream (gateway prompt
// budgets, evidence-atom payload caps, candidate-fan-out caps). The predicates
// never throw — they return a typed outcome so callers can attach the violation
// to their own typed error union without losing the byte/element count.
//
// Pure: no IO, no clock, no randomness, no `node:fs`. Byte counts use TextEncoder
// for deterministic UTF-8 length.

/** Maximum permitted UTF-8 byte length of an ingested source snippet. */
export const MAX_SOURCE_BYTES = 5_000_000;

/** Maximum permitted UTF-8 byte length of a gateway-bound prompt. */
export const MAX_PROMPT_BYTES = 256_000;

/** Maximum permitted number of candidates produced per QI run. */
export const MAX_CANDIDATES_PER_RUN = 1024;

export type OversizeGuardOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly limit: number;
      readonly observed: number;
      readonly reason: string;
    };

const encoder = new TextEncoder();

const measureUtf8Bytes = (value: string): number => encoder.encode(value).length;

const exceedsBy = (limit: number, observed: number, reason: string): OversizeGuardOutcome =>
  observed <= limit ? { ok: true } : { ok: false, limit, observed, reason };

/** Reject source snippets whose UTF-8 length exceeds {@link MAX_SOURCE_BYTES}. */
export const assertSourceSize = (source: string): OversizeGuardOutcome =>
  exceedsBy(MAX_SOURCE_BYTES, measureUtf8Bytes(source), "source exceeds MAX_SOURCE_BYTES");

/** Reject prompts whose UTF-8 length exceeds {@link MAX_PROMPT_BYTES}. */
export const assertPromptSize = (prompt: string): OversizeGuardOutcome =>
  exceedsBy(MAX_PROMPT_BYTES, measureUtf8Bytes(prompt), "prompt exceeds MAX_PROMPT_BYTES");

/** Reject candidate batches whose count exceeds {@link MAX_CANDIDATES_PER_RUN}. */
export const assertCandidateCount = (count: number): OversizeGuardOutcome => {
  if (!Number.isFinite(count) || !Number.isInteger(count) || count < 0) {
    return {
      ok: false,
      limit: MAX_CANDIDATES_PER_RUN,
      observed: Number.isFinite(count) ? count : -1,
      reason: "candidate count must be a non-negative integer",
    };
  }
  return exceedsBy(MAX_CANDIDATES_PER_RUN, count, "candidate count exceeds MAX_CANDIDATES_PER_RUN");
};
