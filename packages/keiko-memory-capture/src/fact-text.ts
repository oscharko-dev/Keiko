// Words of a learned fact: what it says, whom it is about and whether it is negated. Deterministic
// and language-bound (German and English); the model never decides any of this.

import {
  normalizeMemoryText,
  sameMemoryWord,
  tokenizeMemoryText,
} from "@oscharko-dev/keiko-contracts/memory";

// Words that carry no fact of their own: pronouns, particles and the framing of a preference.
const FRAME_WORDS = new Set([
  "ab",
  "actually",
  "all",
  "also",
  "always",
  "auch",
  "bitte",
  "d",
  "dir",
  "dass",
  "eigentlich",
  "ganz",
  "gern",
  "gerne",
  "immer",
  "jetzt",
  "lieber",
  "ll",
  "m",
  "mehr",
  "me",
  "mein",
  "meine",
  "meinem",
  "meinen",
  "meiner",
  "mich",
  "mine",
  "mir",
  "now",
  "re",
  "really",
  "s",
  "sehr",
  "t",
  "that",
  "ve",
  "wenn",
  "when",
  "you",
]);

const NEGATION_WORDS = new Set([
  "aren",
  "cannot",
  "didn",
  "doesn",
  "don",
  "isn",
  "wasn",
  "weren",
  "kein",
  "keine",
  "keinem",
  "keinen",
  "keiner",
  "keines",
  "never",
  "nicht",
  "nie",
  "niemals",
  "no",
  "not",
]);

// A normalized body may name the kind of fact in a word the person did not use: "Bevorzugt Tabellen"
// for "Ich mag Tabellen lieber". Every other word of a body must come from the person's own words.
const PREDICATE_WORDS: readonly string[] = [
  "arbeitet",
  "bevorzugt",
  "decided",
  "decision",
  "entscheidung",
  "heisst",
  "live",
  "liebt",
  "like",
  "mag",
  "named",
  "nutzt",
  "prefer",
  "use",
  "uses",
  "verwendet",
  "wohnt",
  "work",
];

// English contraction "don't" and German "nicht" read the same to polarity.
const CONTRACTED_NEGATION_RE = /\p{L}n['’]t\b/u;
const NUMBER_RE = /^\p{N}/u;
const HAS_DIGIT_RE = /\p{N}/u;
// "bevorzuge" and "bevorzugt" are one word; a stem this short could be two.
const MIN_SHARED_STEM = 4;

export function factWords(text: string): readonly string[] {
  return tokenizeMemoryText(text).filter(
    (word) => !FRAME_WORDS.has(word) && !NEGATION_WORDS.has(word),
  );
}

export function isNumberWord(word: string): boolean {
  return NUMBER_RE.test(word);
}

export function sameFactWord(a: string, b: string): boolean {
  if (sameMemoryWord(a, b)) return true;
  if (HAS_DIGIT_RE.test(a) || HAS_DIGIT_RE.test(b)) return false;
  return sharedPrefixLength(a, b) >= Math.max(MIN_SHARED_STEM, Math.max(a.length, b.length) - 2);
}

function sharedPrefixLength(a: string, b: string): number {
  let length = 0;
  while (length < a.length && a.charAt(length) === b.charAt(length)) length += 1;
  return length;
}

export function isPredicateWord(word: string): boolean {
  return PREDICATE_WORDS.some((predicate) => sameFactWord(word, predicate));
}

// A word of one list as a pattern that does not match inside a longer word.
export function anyWordPattern(words: readonly string[]): RegExp {
  return new RegExp(`(?:^|[^\\p{L}])(?:${words.join("|")})(?![\\p{L}\\p{N}])`, "iu");
}

export function isNegated(text: string): boolean {
  const normalized = normalizeMemoryText(text);
  if (CONTRACTED_NEGATION_RE.test(normalized)) return true;
  return normalized.split(/[^\p{L}\p{N}]+/u).some((word) => NEGATION_WORDS.has(word));
}

export function hasWord(words: readonly string[], word: string): boolean {
  return words.some((candidate) => sameFactWord(candidate, word));
}
