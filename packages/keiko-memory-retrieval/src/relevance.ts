// Lexical-relevance primitive. Deterministic Jaccard over (body + tags) tokens.
// No IDF, no document-frequency state — keeps the function pure and the score reproducible
// across runs without a corpus dependency. The brief explicitly permits "normalized token
// Jaccard or simple BM25-lite without IDF — keep deterministic"; Jaccard is the simplest
// fully-deterministic choice and the cheapest to reason about for explainability.

import type { MemoryRecord } from "@oscharko-dev/keiko-contracts/memory";

// Word boundary uses a Unicode-aware non-word matcher: any character that is not a letter,
// digit, or underscore (in any script) becomes a separator. This is a fixed-length pattern
// with no alternation or backreferences — not ReDoS-prone.
const NON_WORD = /[^\p{L}\p{N}_]+/u;

export function tokenize(text: string): readonly string[] {
  if (text === "") return [];
  const lowered = text.toLowerCase();
  const split = lowered.split(NON_WORD);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of split) {
    if (piece === "") continue;
    if (seen.has(piece)) continue;
    seen.add(piece);
    out.push(piece);
  }
  return out;
}

function recordTokens(record: MemoryRecord): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const t of tokenize(record.body)) tokens.add(t);
  for (const tag of record.tags) {
    for (const t of tokenize(tag)) tokens.add(t);
  }
  return tokens;
}

/**
 * Jaccard similarity between the query token set and the record token set (body + tags).
 * Returns 0 for empty/undefined queries; returns 1 when the two sets are equal.
 */
export function lexicalRelevance(queryText: string | undefined, record: MemoryRecord): number {
  if (queryText === undefined || queryText === "") return 0;
  const queryTokens = new Set(tokenize(queryText));
  if (queryTokens.size === 0) return 0;
  const docTokens = recordTokens(record);
  if (docTokens.size === 0) return 0;
  let intersection = 0;
  for (const t of queryTokens) {
    if (docTokens.has(t)) intersection += 1;
  }
  // Union = |A| + |B| - |A ∩ B|
  const union = queryTokens.size + docTokens.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}
