// Deterministic fallback token estimator (Epic #189, Issue #195).
//
// LIMITATION: this is a crude ~4-chars-per-token heuristic that mirrors what the OpenAI
// cookbook documents as a rough rule of thumb for English text using cl100k_base. It is
// NOT a real tokenizer — it over-estimates for CJK / code, under-estimates for languages
// with long words, and ignores subword boundaries entirely. The point of the seam is so a
// downstream consumer (#196 indexing orchestrator, #199 retrieval) can inject a real
// tokenizer (e.g. `js-tiktoken`) without forcing this package to ship the dependency.
//
// Why not zero or one-char-per-token? Zero would let `maxTokens` produce empty chunks;
// one-char-per-token would force absurdly small chunks (every page splits into 400-char
// fragments). Four matches the order-of-magnitude expectation that callers seeing a
// `maxTokens: 400` chunk get a ~1.5 KB excerpt rather than a 400-byte one.

const CHARS_PER_TOKEN = 4;

export function defaultTokenEstimator(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// Inverse helper used by the chunker to translate a token budget into a character budget.
// Kept here so a future tokenizer swap can override it consistently with the estimator.
export function charsForTokenBudget(tokenBudget: number): number {
  if (tokenBudget <= 0) return 0;
  return tokenBudget * CHARS_PER_TOKEN;
}
