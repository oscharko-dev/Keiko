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
  // When a fact holds says nothing about what it is: "Ich arbeite inzwischen bei Foo".
  "aktuell",
  "currently",
  "derzeit",
  "inzwischen",
  "jetzt",
  "kunftig",
  "kuenftig",
  "mittlerweile",
  "momentan",
  "nowadays",
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
  "ohne",
  "nichts",
  "niemand",
  "weder",
  "without",
  "nobody",
  "none",
  "neither",
  "nor",
  // A verb that rejects its object: a body must not turn "Ich hasse Excel" into "Nutzt Excel".
  "hasse",
  "hasst",
  "vermeide",
  "vermeidet",
  "meide",
  "meidet",
  "hate",
  "hates",
  "avoid",
  "avoids",
  "dislike",
  "dislikes",
]);

// Predicates that name different facts, never rewordings of each other: where a person lives, works
// and what they are called. Whether a new value replaces the old one is the slot's preposition.
const SINGLE_VALUE_PREDICATES: readonly string[] = [
  "arbeitet",
  "heisst",
  "live",
  "named",
  "work",
  "wohnt",
];

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

// "C#" and "C++" are different languages and "3.3" is not "3", so they stay one word.
function keepingValueMarks(text: string): string {
  return (
    text
      // Only from a word's start, so a long word is scanned once.
      .replace(/(?<![\p{L}\p{N}])(\p{L}[\p{L}\p{N}]*)\+\+/gu, "$1plusplus")
      .replace(/(?<![\p{L}\p{N}])(\p{L}[\p{L}\p{N}]*)#/gu, "$1sharp")
      .replace(/(\p{N})\.(?=\p{N})/gu, "$1point")
  );
}

// The tokenizer stems long words ("inzwischen" becomes "inzwisch"), so each list also holds the
// tokens its words become.
function withTokens(words: ReadonlySet<string>): ReadonlySet<string> {
  return new Set([...words, ...[...words].flatMap((word) => tokenizeMemoryText(word))]);
}

const FRAME_TOKENS = withTokens(FRAME_WORDS);
const NEGATION_TOKENS = withTokens(NEGATION_WORDS);

export function factWords(text: string): readonly string[] {
  return tokenizeMemoryText(keepingValueMarks(text)).filter(
    (word) => !FRAME_TOKENS.has(word) && !NEGATION_TOKENS.has(word),
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

export function isSingleValuePredicate(word: string): boolean {
  return SINGLE_VALUE_PREDICATES.some((predicate) => sameFactWord(word, predicate));
}

// A word of one list as a pattern that does not match inside a longer word.
export function anyWordPattern(words: readonly string[]): RegExp {
  return new RegExp(`(?:^|[^\\p{L}])(?:${words.join("|")})(?![\\p{L}\\p{N}])`, "iu");
}

export function isNegated(text: string): boolean {
  const normalized = normalizeMemoryText(text);
  if (CONTRACTED_NEGATION_RE.test(normalized)) return true;
  // A hyphenated compound is one word: "no-code" and "Nicht-Raucher" deny nothing.
  return normalized
    .split(/[^\p{L}\p{N}-]+/u)
    .some((word) => NEGATION_WORDS.has(word.replace(/^-+|-+$/gu, "")));
}

export function hasWord(words: readonly string[], word: string): boolean {
  return words.some((candidate) => sameFactWord(candidate, word));
}
