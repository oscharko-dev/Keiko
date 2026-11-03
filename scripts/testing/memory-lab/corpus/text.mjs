// Text helpers of the MemoriaViva corpus (#4208). A probe question that "shares no word" with a fact
// must be checked by a rule, not by eye: content words are compared by a five-character stem of the
// score ruler's own normalization (diacritics and case folded), so inflections of one word count as
// the same word and function words never do.
import { normalizeText } from "../score.mjs";

const STEM_LENGTH = 5;

const FUNCTION_WORDS = Object.freeze([
  // German
  "nicht",
  "immer",
  "damit",
  "dabei",
  "diese",
  "dieser",
  "dieses",
  "diesen",
  "einer",
  "einen",
  "einem",
  "eines",
  "meine",
  "meinen",
  "meiner",
  "meinem",
  "meines",
  "unsere",
  "unseren",
  "unserer",
  "unserem",
  "kannst",
  "können",
  "sollte",
  "sollen",
  "sollst",
  "würde",
  "möchte",
  "bitte",
  "welche",
  "welcher",
  "welches",
  "welchen",
  "warum",
  "wieso",
  "weshalb",
  "womit",
  "wobei",
  "worauf",
  "dafür",
  "dagegen",
  "gerne",
  "etwas",
  "alles",
  "jetzt",
  "heute",
  "haben",
  "hatte",
  "hatten",
  "waren",
  "werden",
  "wurde",
  "wurden",
  "bevor",
  "nachdem",
  "sodass",
  "durch",
  "gegen",
  "über",
  "unter",
  "zwischen",
  "während",
  "danach",
  "vorher",
  "wieder",
  "viele",
  "vielen",
  "jeden",
  "jeder",
  "jedes",
  "jedem",
  "keine",
  "einmal",
  "selbst",
  "sondern",
  "obwohl",
  "andere",
  "anderen",
  "zuerst",
  "zuletzt",
  "zusammen",
  "bereits",
  "vielleicht",
  "eigentlich",
  "natürlich",
  "genau",
  "gleich",
  "machen",
  "mache",
  "muss",
  "müssen",
  "wollen",
  // English
  "which",
  "would",
  "could",
  "should",
  "about",
  "there",
  "their",
  "other",
  "these",
  "those",
  "where",
  "while",
  "being",
  "doing",
  "using",
  "always",
  "never",
  "every",
  "before",
  "after",
  "still",
  "again",
  "please",
  "really",
  "something",
  "because",
  "between",
  "through",
  "during",
  "without",
  "within",
  "around",
  "another",
  "whether",
  "maybe",
  "often",
  "usually",
  "though",
  "since",
  "until",
  "above",
  "below",
  "first",
  "second",
  "third",
  "might",
  "shall",
  "thing",
  "things",
  "going",
  "having",
  "getting",
  "making",
  "taking",
]);

const STOPPED_STEMS = new Set(
  FUNCTION_WORDS.map((word) => normalizeText(word).slice(0, STEM_LENGTH)),
);

/** Stems of the content words of `text`: tokens of five or more letters that are not function words. */
function contentStems(text) {
  const stems = normalizeText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= STEM_LENGTH)
    .map((token) => token.slice(0, STEM_LENGTH))
    .filter((stem) => !STOPPED_STEMS.has(stem));
  return new Set(stems);
}

/** The content-word stems two texts share; empty when they share no word. */
export function sharedContentStems(left, right) {
  const known = contentStems(left);
  return [...contentStems(right)].filter((stem) => known.has(stem));
}

// Sentences that open with a command the memory pipeline acts on. Such a sentence must come from the
// blueprint, never from filler: "Vergiss nicht, ..." or "Remember ..." in generic talk would forget or
// store by accident, and a command only acts at the start of a turn.
const MEMORY_COMMANDS = Object.freeze([
  /^\s*merk(?:e)?\s+dir/iu,
  /^\s*vergiss/iu,
  /^\s*speicher(?:e)?\b/iu,
  /^\s*notier(?:e)?\b/iu,
  /^\s*lösche/iu,
  /^\s*aktualisiere/iu,
  /^\s*forget/iu,
  /^\s*remember/iu,
  /^\s*update\s+(?:the\s+)?memory/iu,
  /^\s*(?:korrektur|correction)\s*:/iu,
  /^\s*(?:eigentlich|actually),?\s/iu,
  /^\s*das\s+stimmt\s+nicht/iu,
  /^\s*that(?:'s|\s+is)\s+wrong/iu,
  /^\s*falsch\b/iu,
]);

/** True when the text as a whole opens with a memory command, the only place a command acts. */
export function opensWithMemoryCommand(text) {
  return MEMORY_COMMANDS.some((pattern) => pattern.test(text));
}

/** True when any sentence of `text` opens with a memory command. */
export function startsWithMemoryCommand(text) {
  return text.split(/(?<=[.!?:])\s+/u).some((sentence) => opensWithMemoryCommand(sentence));
}

const SENTENCE_END_CHARACTERS = new Set([".", "!", "?"]);

/** The text without its final full stops, exclamation marks and question marks. */
export function stripSentenceEnd(text) {
  let end = text.length;
  while (end > 0 && SENTENCE_END_CHARACTERS.has(text.charAt(end - 1))) end -= 1;
  return text.slice(0, end);
}
