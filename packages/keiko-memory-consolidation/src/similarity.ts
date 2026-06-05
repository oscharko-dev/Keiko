// String-similarity primitives used by dedupe and conflict detection. Pure functions, bounded
// work, no unbounded regex backtracking — `normalizeBody` walks the input once character-by-
// character so an adversarial input cannot push it beyond O(n).
//
// Design choices:
//   • Character bigrams (not word bigrams) — robust to whitespace drift and short utterances
//     ("yes" vs "yep" share "ye"). The cost is sensitivity to spelling variants, which is
//     acceptable for v1 (the Jaccard threshold backs off recall in exchange for precision).
//   • Set-based Jaccard (not multiset) — collapses repeated bigrams. Same precision intuition.
//   • Punctuation stripping is char-class based (Unicode-aware via `RegExp` `\p{...}` escapes
//     in a NON-greedy single-char form so there is no backtracking; the `g` flag walks the
//     string linearly). Lowercase is locale-independent (`String.prototype.toLowerCase` uses
//     case-folding without locale; we deliberately do NOT call `toLocaleLowerCase` because the
//     output must be byte-stable across hosts).

// Single-character matcher: anything that is NOT a Unicode letter, digit, or whitespace.
// Strips ASCII punctuation, NUL bytes, control chars, and emoji-adjacent symbols. Uses the
// `u` flag (Unicode-aware character classes) and a SINGLE quantifier (no nesting) — no ReDoS.
const PUNCT_OR_CONTROL = /[^\p{L}\p{N}\s]/gu;

// Whitespace run matcher. `\s+` over a finite input has linear time; no nesting.
const WHITESPACE_RUN = /\s+/g;

// Normalizes a memory body for similarity comparison. Output is lowercase, NUL-free, with
// internal whitespace collapsed to single spaces, leading/trailing whitespace stripped, and
// ASCII/Unicode punctuation removed. Returns `""` when no normalizable characters survive.
export function normalizeBody(body: string): string {
  const lowered = body.toLowerCase();
  const stripped = lowered.replace(PUNCT_OR_CONTROL, "");
  const collapsed = stripped.replace(WHITESPACE_RUN, " ");
  return collapsed.trim();
}

// Builds the set of character bigrams of a normalized string. Returns an empty Set for inputs
// shorter than 2 characters (no bigrams to form). Uses a Set (not an array) so the caller can
// take set-intersection in O(min(|a|, |b|)) for Jaccard.
export function bigramTokens(normalized: string): Set<string> {
  const tokens = new Set<string>();
  for (let i = 0; i + 1 < normalized.length; i += 1) {
    tokens.add(normalized.slice(i, i + 2));
  }
  return tokens;
}

export interface PreparedBody {
  readonly normalized: string;
  readonly tokens: ReadonlySet<string>;
}

export function prepareBody(body: string): PreparedBody {
  const normalized = normalizeBody(body);
  return {
    normalized,
    tokens: bigramTokens(normalized),
  };
}

export function jaccardSimilarityPrepared(a: PreparedBody, b: PreparedBody): number {
  if (a.tokens.size === 0 && b.tokens.size === 0) return 1;
  if (a.tokens.size === 0 || b.tokens.size === 0) return 0;
  let intersectionSize = 0;
  for (const token of a.tokens) {
    if (b.tokens.has(token)) intersectionSize += 1;
  }
  const unionSize = a.tokens.size + b.tokens.size - intersectionSize;
  return intersectionSize / unionSize;
}

// Jaccard similarity of two strings over their normalized character-bigram sets. Returns 1 for
// two empty inputs (vacuously similar — they map to the same equivalence class) and 0 when one
// side is empty but the other is not (no overlap is possible). Output is in [0, 1].
export function jaccardSimilarity(a: string, b: string): number {
  return jaccardSimilarityPrepared(prepareBody(a), prepareBody(b));
}
