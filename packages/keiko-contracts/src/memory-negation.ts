// The single owning definition of MemoriaViva's negation vocabulary (Epic #204, children #208/#209).
//
// Two layers ask "does this memory body carry a negation?", and until now each answered it from a
// private copy of the word list:
//
//   * consolidation (#208, `conflicts.ts`) flags a two-record polarity flip as a
//     `potential-conflict` review item;
//   * governance (#209, `conflict.ts`) classifies a conflict pair as `negation-flip`.
//
// The two copies had already drifted in BOTH directions — governance knew "aint" and consolidation
// did not; consolidation knew "cannot"/"neednt" and governance did not — while a comment in
// governance asserted the detectors were the same one. ADR-0019 forbids an edge between those two
// packages (each may depend only on keiko-contracts and keiko-security), so the vocabulary lives
// here: the one layer both already depend on, next to the other shared memory policy tables such as
// MEMORY_TYPE_DECAY_HALF_LIFE_MULTIPLIERS.
//
// The vocabulary is TIERED, because the two layers deliberately ask different questions and the
// tiers make that difference explicit and testable instead of leaving it to drift again:
//
//   * "english-particle"    grammatical negation particles and their contractions. This tier alone
//                           is what governance matches: governance reports a
//                           "yes"/"true" vs "no"/"false" flip separately as `polarity-mismatch`, so
//                           folding the negative quantifiers into negation would erase that reason.
//   * "english-quantifier"  standalone negative quantifiers and prepositions. Consolidation has a
//                           single fused conflict reason and needs them; governance must not.
//   * "german-particle"     the German equivalents. Consolidation scans bilingual bodies.
//
// The tiers are pairwise disjoint and every entry is a single lowercase alphabetic token, because
// both callers match WHOLE normalized tokens: a word that merely ends in "nt" ("important") is not
// a negation.
//
// What this module deliberately does NOT own is tokenization. The two layers normalize a body
// differently on purpose — governance folds to ASCII letters/digits for its Jaccard token sets,
// consolidation preserves Unicode letters for its character bigrams — and unifying that here would
// silently move both layers' similarity scores, which is a different change with different
// evidence. Each caller tokenizes with its own normalizer and asks `hasMemoryNegationToken` about
// the result.

export type MemoryNegationTier = "english-particle" | "english-quantifier" | "german-particle";

export const MEMORY_NEGATION_TIERS: readonly MemoryNegationTier[] = [
  "english-particle",
  "english-quantifier",
  "german-particle",
] as const;

export const MEMORY_NEGATION_VOCABULARY: Readonly<Record<MemoryNegationTier, readonly string[]>> = {
  "english-particle": [
    "aint",
    "arent",
    "cannot",
    "cant",
    "couldnt",
    "didnt",
    "doesnt",
    "dont",
    "hadnt",
    "hasnt",
    "havent",
    "isnt",
    "mustnt",
    "neednt",
    "not",
    "shouldnt",
    "wasnt",
    "werent",
    "wont",
    "wouldnt",
  ],
  "english-quantifier": ["never", "no", "none", "without"],
  "german-particle": [
    "kein",
    "keine",
    "keinem",
    "keinen",
    "keiner",
    "keines",
    "nicht",
    "nie",
    "niemals",
    "ohne",
  ],
} as const;

// Builds the lookup set for the requested tiers. Duplicate tiers collapse; an empty tier list
// yields an empty set (a caller that asks about nothing matches nothing) rather than silently
// falling back to the full vocabulary, which would be a fail-open on a detection boundary.
export function memoryNegationTokens(tiers: readonly MemoryNegationTier[]): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const tier of tiers) {
    for (const token of MEMORY_NEGATION_VOCABULARY[tier]) {
      tokens.add(token);
    }
  }
  return tokens;
}

// Whole-token membership test over an already-normalized token stream. Pure, allocation-free, and
// order-independent: it stops at the first negation token.
export function hasMemoryNegationToken(
  tokens: Iterable<string>,
  vocabulary: ReadonlySet<string>,
): boolean {
  for (const token of tokens) {
    if (vocabulary.has(token)) return true;
  }
  return false;
}
