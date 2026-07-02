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
const COMBINING_MARKS = /\p{M}+/gu;

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "i",
  "is",
  "it",
  "my",
  "of",
  "on",
  "or",
  "the",
  "to",
  "what",
  "which",
  "with",
  "am",
  "an",
  "auf",
  "aus",
  "bei",
  "bin",
  "das",
  "dem",
  "den",
  "der",
  "des",
  "die",
  "du",
  "ein",
  "eine",
  "einem",
  "einen",
  "einer",
  "er",
  "es",
  "fur",
  "fuer",
  "ich",
  "im",
  "in",
  "ist",
  "mit",
  "oder",
  "sind",
  "und",
  "vom",
  "von",
  "was",
  "welche",
  "welchem",
  "welchen",
  "welcher",
  "welches",
  "wie",
  "wir",
  "zu",
  "zum",
  "zur",
]);

function normalizeText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .replace(/ß/gu, "ss")
    .toLocaleLowerCase("und");
}

function stemGermanLikeToken(token: string): string {
  if (token.length <= 5) return token;
  const suffixes = ["ungen", "ern", "en", "er", "es", "s"];
  for (const suffix of suffixes) {
    if (suffix === "s" && token.endsWith("ss")) continue;
    if (token.length - suffix.length >= 5 && token.endsWith(suffix)) {
      return token.slice(0, -suffix.length);
    }
  }
  return token;
}

export function tokenize(text: string): readonly string[] {
  if (text === "") return [];
  const split = normalizeText(text).split(NON_WORD);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of split) {
    if (piece === "") continue;
    if (STOPWORDS.has(piece)) continue;
    const normalized = stemGermanLikeToken(piece);
    if (normalized === "" || STOPWORDS.has(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
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
