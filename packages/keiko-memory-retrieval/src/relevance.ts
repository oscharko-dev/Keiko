// Lexical-relevance primitive. Deterministic Jaccard over (body + tags) tokens.
// No IDF, no document-frequency state — keeps the function pure and the score reproducible
// across runs without a corpus dependency. The brief explicitly permits "normalized token
// Jaccard or simple BM25-lite without IDF — keep deterministic"; Jaccard is the simplest
// fully-deterministic choice and the cheapest to reason about for explainability.

import {
  sameMemoryWord,
  tokenizeMemoryText,
  type MemoryRecord,
} from "@oscharko-dev/keiko-contracts/memory";

export const tokenize = tokenizeMemoryText;

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

// Words that name no topic: pronouns, auxiliaries, modal verbs, particles and politeness, in the
// shared tokenizer's folded and stemmed spelling. The shared stopword list keeps them because
// capture reads them; the strict floor ignores them, so a shared "mir" or "bitte" never makes an
// unrelated memory fit a question (#4228). Words shorter than three letters are ignored as well.
const FUNCTION_WORDS: ReadonlySet<string> = new Set([
  "aber",
  "alle",
  "alles",
  "also",
  "auch",
  "bist",
  "bitte",
  "dabei",
  "dann",
  "danke",
  "dass",
  "dein",
  "deine",
  "deinem",
  "deinen",
  "deiner",
  "dich",
  "diese",
  "dieser",
  "dies",
  "dir",
  "doch",
  "dort",
  "durfen",
  "etwas",
  "euch",
  "habe",
  "haben",
  "hast",
  "hat",
  "hier",
  "ihm",
  "ihn",
  "ihnen",
  "ihr",
  "ihre",
  "immer",
  "jetzt",
  "kann",
  "kannst",
  "kein",
  "keine",
  "konnen",
  "konntest",
  "mal",
  "mein",
  "meine",
  "meinem",
  "meinen",
  "meiner",
  "mich",
  "mir",
  "muss",
  "musst",
  "mussen",
  "nicht",
  "noch",
  "nur",
  "schon",
  "sehr",
  "sein",
  "seine",
  "sich",
  "sie",
  "soll",
  "sollst",
  "sollen",
  "uns",
  "unser",
  "unsere",
  "wann",
  "war",
  "waren",
  "warum",
  "weil",
  "wenn",
  "werden",
  "wer",
  "wird",
  "wirst",
  "willst",
  "wollen",
  "wurde",
  "wurdest",
  "about",
  "all",
  "any",
  "been",
  "being",
  "but",
  "can",
  "could",
  "did",
  "does",
  "had",
  "has",
  "have",
  "her",
  "his",
  "how",
  "into",
  "just",
  "may",
  "might",
  "must",
  "not",
  "our",
  "please",
  "shall",
  "she",
  "should",
  "some",
  "than",
  "thanks",
  "that",
  "their",
  "them",
  "then",
  "these",
  "they",
  "this",
  "those",
  "very",
  "was",
  "were",
  "when",
  "where",
  "who",
  "why",
  "will",
  "would",
  "you",
  "your",
  "yours",
]);
const MIN_INFORMATIVE_CHARS = 3;

function informativeWords(text: string): readonly string[] {
  return tokenize(text).filter(
    (word) => word.length >= MIN_INFORMATIVE_CHARS && !FUNCTION_WORDS.has(word),
  );
}

/**
 * Number of the question's informative words that the record's body states, counting a short
 * inflection as the same word ("Tabelle" and "Tabellen"). Tags are not read: they are labels the
 * system set, not words the person said.
 */
export function sharedInformativeWordCount(
  queryText: string | undefined,
  record: MemoryRecord,
): number {
  if (queryText === undefined || queryText === "") return 0;
  const recordWords = informativeWords(record.body);
  if (recordWords.length === 0) return 0;
  return informativeWords(queryText).filter((word) =>
    recordWords.some((recordWord) => sameMemoryWord(word, recordWord)),
  ).length;
}
