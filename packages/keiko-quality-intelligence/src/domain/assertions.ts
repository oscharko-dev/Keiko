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
// Single canonical Unicode-strip primitive lives in the base layer (keiko-contracts).
// It is a true SUPERSET of the former QI-local removal set (GEN-DUP-NEAR-003): it additionally
// strips the U+2060..U+206F block. Re-export it here so the QI-internal call sites and the QI
// package barrel keep the same `stripUnsafeFormatChars` name without a second implementation.
import { stripUnsafeFormatChars } from "@oscharko-dev/keiko-contracts/text-safety";

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

// Returns true for code points in the upper unsafe range (bidi / zero-width / BOM / format block).
// Split from isUnsafeCodePoint to keep cyclomatic complexity below the lint limit. Kept byte-for-byte
// aligned with the canonical keiko-contracts `stripUnsafeFormatChars` removal set (including the
// U+2060..U+206F block) so this predicate faithfully reflects exactly which code points the
// re-exported stripper removes.
const isUnsafeHigh = (cp: number): boolean => {
  if (cp === 0x061c) return true; // Arabic letter mark
  if (cp >= 0x200b && cp <= 0x200f) return true; // ZWSP/ZWNJ/ZWJ/LRM/RLM
  if (cp >= 0x202a && cp <= 0x202e) return true; // Bidi embedding + override
  if (cp >= 0x2060 && cp <= 0x206f) return true; // Word joiner / invisible math / deprecated format
  if (cp >= 0x2066 && cp <= 0x2069) return true; // Bidi isolates (subset of the block above)
  return cp === 0xfeff; // BOM / ZWNBSP
};

/**
 * Returns true when `cp` is a code point that the canonical
 * {@link stripUnsafeFormatChars} removes from persisted candidate text. QI-only
 * predicate (consumed by keiko-server runIngestion + QI tests); keiko-contracts
 * exposes only the stripper, so this mirror stays local but tracks that removal
 * set exactly.
 */
export const isUnsafeFormatCodePoint = (cp: number): boolean => isUnsafeLow(cp) || isUnsafeHigh(cp);

// The value-bearing stripper itself is the single canonical implementation in the base layer.
// Re-exported (not reimplemented) here so QI-internal call sites and the package barrel keep the
// `stripUnsafeFormatChars` name. See the import at the top of this file (GEN-DUP-NEAR-003).
export { stripUnsafeFormatChars };

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
