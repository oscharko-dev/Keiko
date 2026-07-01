// Shared invariant helpers for the quality-intelligence domain modules
// (Epic #270, Issue #272).
//
// Pure, deterministic, no IO. Inspired structurally by the deterministic
// guards in the upstream Test Intelligence (TI) reference repo at
// packages/core-engine/src/intent-derivation.ts and coverage-relevance.ts,
// but rewritten to consume only the contracts surface exposed by
// keiko-contracts via the QualityIntelligence namespace. TI is NOT a
// runtime dependency: ADR-0023 D12 + supply-chain gate forbid it.

import type { QualityIntelligence } from "@oscharko-dev/keiko-contracts";

/**
 * NFKC-normalise + trim a free-text fragment, returning the empty string for
 * `undefined`. Used to make heuristics invariant to compatibility-equivalent
 * code points (full-width digits, decomposed accents) without rewriting any
 * value-bearing field.
 */
export const normaliseText = (value: string | undefined): string => {
  if (value === undefined) {
    return "";
  }
  return value.normalize("NFKC").trim();
};

/**
 * Returns true when `value` is a non-empty string of unicode-aware characters
 * after NFKC normalisation + trim. Used as a structural guard before counting
 * a fragment as evidence.
 */
export const isMeaningfulText = (value: string | undefined): boolean =>
  normaliseText(value).length > 0;

/**
 * Type guard mapping an arbitrary string to a known QI priority. Pure; used
 * to keep the test-design model's priority field type-correct.
 */
export const isKnownPriority = (
  value: string,
): value is QualityIntelligence.QualityIntelligencePriority => {
  for (const candidate of [
    "P0",
    "P1",
    "P2",
    "P3",
  ] as readonly QualityIntelligence.QualityIntelligencePriority[]) {
    if (candidate === value) {
      return true;
    }
  }
  return false;
};

// Returns true for code points in the lower unsafe range (U+0000–U+009F plus DEL).
// Split from isUnsafeCodePoint to keep cyclomatic complexity below the lint limit.
const isUnsafeLow = (cp: number): boolean => {
  // C0 controls except TAB (U+0009) / LF (U+000A) / CR (U+000D)
  if (cp <= 0x001f) return cp !== 0x0009 && cp !== 0x000a && cp !== 0x000d;
  // DEL
  if (cp === 0x007f) return true;
  // C1 controls
  return cp >= 0x0080 && cp <= 0x009f;
};

// Returns true for code points in the upper unsafe range (bidi / zero-width / BOM).
// Split from isUnsafeCodePoint to keep cyclomatic complexity below the lint limit.
const isUnsafeHigh = (cp: number): boolean => {
  if (cp === 0x061c) return true; // Arabic letter mark
  if (cp >= 0x200b && cp <= 0x200f) return true; // ZWSP/ZWNJ/ZWJ/LRM/RLM
  if (cp >= 0x202a && cp <= 0x202e) return true; // Bidi embedding + override
  if (cp === 0xfeff) return true; // BOM / ZWNBSP
  return cp >= 0x2066 && cp <= 0x2069; // Bidi isolates
};

/**
 * Returns true when `cp` is a code point that must be removed from persisted
 * candidate text. See {@link stripUnsafeFormatChars} for the full set.
 */
export const isUnsafeFormatCodePoint = (cp: number): boolean => isUnsafeLow(cp) || isUnsafeHigh(cp);

/**
 * Remove Unicode bidi-override, zero-width, and C0/C1/DEL control code points
 * from `value`, preserving ordinary text, accents, CJK, emoji, and the
 * legitimate whitespace trio TAB (U+0009) / LF (U+000A) / CR (U+000D).
 *
 * Removed code-point ranges:
 *   - C0 controls U+0000–U+001F except U+0009, U+000A, U+000D
 *   - DEL U+007F
 *   - C1 controls U+0080–U+009F
 *   - Arabic letter mark U+061C
 *   - Zero-width / BOM: U+200B, U+200C, U+200D, U+FEFF
 *   - LRM / RLM: U+200E, U+200F
 *   - Bidi embedding / override: U+202A–U+202E
 *   - Bidi isolate: U+2066–U+2069
 *
 * Iterates by code point (not UTF-16 code unit) so surrogate pairs for
 * supplementary-plane emoji are handled correctly. Pure and deterministic.
 */
export const stripUnsafeFormatChars = (value: string): string => {
  const chars: string[] = [];
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && !isUnsafeFormatCodePoint(cp)) {
      chars.push(ch);
    }
  }
  return chars.join("");
};

/**
 * Value-bearing candidate-text normaliser: NFKC-normalise, strip unsafe
 * control/bidi/zero-width spoofing code points, then trim. Returns `""` for
 * `undefined`.
 *
 * Distinct from the heuristic {@link normaliseText} (NFKC + trim only) which
 * is used for deduplication keys and must remain byte-stable. This function is
 * the single chokepoint for persisted candidate text fields (title, steps,
 * preconditions, expectedResults, tags).
 */
export const normaliseCandidateText = (value: string | undefined): string => {
  if (value === undefined) {
    return "";
  }
  return stripUnsafeFormatChars(value.normalize("NFKC")).trim();
};

/**
 * Comparison-only German case fold. This is deliberately NOT used for value-bearing fields:
 * it exists for equivalence keys and lexical heuristics where "Straße" and "Strasse" must
 * compare identically without mutating the human-readable source/candidate text.
 */
export const normaliseGermanComparisonText = (value: string | undefined): string =>
  normaliseCandidateText(value).toLowerCase().replace(/ß/gu, "ss");

/**
 * Keyword-matching fold layered on top of the comparison fold. Umlauts are mapped to their
 * ASCII transliterations so German source text and ASCII fixtures ("Überweisung"/"Ueberweisung")
 * hit the same deterministic lexica.
 */
export const normaliseGermanKeywordText = (value: string | undefined): string =>
  normaliseGermanComparisonText(value)
    .replace(/ä/gu, "ae")
    .replace(/ö/gu, "oe")
    .replace(/ü/gu, "ue");

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const KEYWORD_PART_SEPARATOR = /[\s-]+/u;
const KEYWORD_BOUNDARY = "[^\\p{L}\\p{N}]";

/**
 * Boundary-aware keyword test over the German keyword fold. Hyphens and whitespace are equivalent
 * inside multi-part keywords, while surrounding letters/digits must not be part of the match.
 */
export const containsNormalisedKeyword = (text: string, keyword: string): boolean => {
  const normalisedText = normaliseGermanKeywordText(text);
  const normalisedKeyword = normaliseGermanKeywordText(keyword);
  if (normalisedText.length === 0 || normalisedKeyword.length === 0) {
    return false;
  }
  const parts = normalisedKeyword.split(KEYWORD_PART_SEPARATOR).filter((part) => part.length > 0);
  if (parts.length === 0) {
    return false;
  }
  const keywordPattern = parts.map(escapeRegExp).join("[\\s-]+");
  return new RegExp(
    `(?:^|${KEYWORD_BOUNDARY})${keywordPattern}(?=$|${KEYWORD_BOUNDARY})`,
    "u",
  ).test(normalisedText);
};

/**
 * Returns a stable, lexicographic, NFKC-normalised copy of the supplied
 * fragments. Equal fragments after normalisation collapse to a single entry.
 * Used by deduplication and canonicalisation routines.
 */
export const canonicaliseFragmentList = (fragments: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  for (const fragment of fragments) {
    const normalised = normaliseCandidateText(fragment);
    if (normalised.length === 0) {
      continue;
    }
    seen.add(normalised);
  }
  return Array.from(seen).sort();
};
