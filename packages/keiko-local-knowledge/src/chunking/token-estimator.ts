// Deterministic fallback token estimator (Epic #189, Issue #195; WP4).
//
// LIMITATION: this is still an estimate, not a real Qwen3 tokenizer. There is no local
// SentencePiece/Qwen tokenizer dependency in this workspace, so the fallback is calibrated
// by script class instead of pretending that "4 chars = 1 token" is universal. It stays
// conservative for German compound words, CJK text, code identifiers, and symbol-heavy
// inputs so chunk and batch budgets fail small rather than silently overflowing a 32K
// embedding context. Callers can still inject a real tokenizer through `TokenEstimator`.

const ASCII_WORD_CHARS_PER_TOKEN = 4;
const LONG_WORD_CHARS_PER_TOKEN = 3;
const NON_ASCII_LATIN_CHARS_PER_TOKEN = 2.4;
const DIGITS_PER_TOKEN = 2.5;
const SYMBOLS_PER_TOKEN = 1.5;
const WHITESPACE_PER_TOKEN = 24;
const CHUNK_BUDGET_CHARS_PER_TOKEN = 4;

const CJK_OR_KANA_OR_HANGUL_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const ASCII_LETTER_PATTERN = /[A-Za-z]/u;
const DIGIT_PATTERN = /\p{N}/u;
const LATIN_LETTER_PATTERN = /\p{Script=Latin}/u;
const LETTER_PATTERN = /\p{L}/u;
const WHITESPACE_PATTERN = /\s/u;
const ASCII_WORD_PATTERN = /[A-Za-z]+/gu;

function countCodePoints(text: string, pattern: RegExp): number {
  let count = 0;
  for (const char of text) {
    if (pattern.test(char)) count += 1;
  }
  return count;
}

function longAsciiWordPenalty(text: string): number {
  let penalty = 0;
  for (const match of text.matchAll(ASCII_WORD_PATTERN)) {
    const word = match[0];
    if (word.length <= 12) continue;
    penalty += Math.ceil(word.length / LONG_WORD_CHARS_PER_TOKEN) -
      Math.ceil(word.length / ASCII_WORD_CHARS_PER_TOKEN);
  }
  return Math.max(0, penalty);
}

export function defaultTokenEstimator(text: string): number {
  if (text.length === 0) return 0;
  const cjk = countCodePoints(text, CJK_OR_KANA_OR_HANGUL_PATTERN);
  const asciiLetters = countCodePoints(text, ASCII_LETTER_PATTERN);
  const digits = countCodePoints(text, DIGIT_PATTERN);
  const latinLetters = countCodePoints(text, LATIN_LETTER_PATTERN);
  const letters = countCodePoints(text, LETTER_PATTERN);
  const whitespace = countCodePoints(text, WHITESPACE_PATTERN);
  const nonAsciiLatin = Math.max(0, latinLetters - asciiLetters);
  const nonLatinLetters = Math.max(0, letters - latinLetters - cjk);
  const symbols = Math.max(0, Array.from(text).length - letters - digits - whitespace);

  const estimate =
    cjk +
    Math.ceil(asciiLetters / ASCII_WORD_CHARS_PER_TOKEN) +
    longAsciiWordPenalty(text) +
    Math.ceil(nonAsciiLatin / NON_ASCII_LATIN_CHARS_PER_TOKEN) +
    Math.ceil(nonLatinLetters / NON_ASCII_LATIN_CHARS_PER_TOKEN) +
    Math.ceil(digits / DIGITS_PER_TOKEN) +
    Math.ceil(symbols / SYMBOLS_PER_TOKEN) +
    Math.ceil(whitespace / WHITESPACE_PER_TOKEN);
  return Math.max(1, estimate);
}

// Upper-bound helper used by the chunker to pick an initial character window before it
// verifies the actual slice with `TokenEstimator`. This is not treated as authoritative.
export function charsForTokenBudget(tokenBudget: number): number {
  if (tokenBudget <= 0) return 0;
  return tokenBudget * CHUNK_BUDGET_CHARS_PER_TOKEN;
}
