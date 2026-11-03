// The blanks of a recall question made from a fact's own sentence (#4208). A blank of one common
// word can be guessed from the words around it, so the blank covers the whole value phrase: every
// occurrence of the answer terms, the small words that belong to them on their left ("am liebsten",
// "at", "every") and never fewer than two words.
import { normalizeText } from "../score.mjs";

const BLANK = "___";
const MIN_BLANK_WORDS = 2;
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
const GAP_ONLY = /^\s+$/u;

// Articles, prepositions, quantifiers and adverbs that stand directly before a value and belong to
// it ("jeden Monat", "am liebsten montags", "on Tuesdays", "at seven"). Stored without diacritics.
const FRAME_WORDS = Object.freeze({
  de: new Set(
    [
      "der die das den dem des ein eine einen einem einer mein meine meinen meinem meiner",
      "am im in an auf aus bei bis mit nach von vor zu zum zur für ab um pro über unter ohne durch seit",
      "jeden jede jedes jedem jeder alle allen nur noch schon immer nie meist meistens oft stets",
      "einmal zweimal jetzt inzwischen neuerdings liebsten lieber gern gerne erst zuerst bereits",
      "rund etwa ungefähr sehr ganz",
    ]
      .join(" ")
      .split(" ")
      .map((word) => normalizeText(word)),
  ),
  en: new Set(
    [
      "a an the my our your their on at in by to for with from of as about around over under",
      "before after within without per every each all only just still always never usually mostly",
      "often once twice rather than more most very really also now nowadays",
    ]
      .join(" ")
      .split(" "),
  ),
});

function escapePattern(text) {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

// The whole words around every occurrence of every alternative of every group, as character spans;
// undefined when a group occurs nowhere.
function termSpans(sentence, groups) {
  const spans = [];
  for (const group of groups) {
    const before = spans.length;
    for (const alternative of group) {
      const pattern = new RegExp(
        `[\\p{L}\\p{N}-]*${escapePattern(alternative)}[\\p{L}\\p{N}-]*`,
        "giu",
      );
      for (const match of sentence.matchAll(pattern))
        spans.push({ start: match.index, end: match.index + match[0].length });
    }
    if (spans.length === before) return undefined;
  }
  return spans;
}

// Spans that overlap, touch or are separated by spaces only become one.
function mergeSpans(sentence, spans) {
  const merged = [];
  for (const span of spans.toSorted((left, right) => left.start - right.start)) {
    const last = merged.at(-1);
    const joined =
      last !== undefined &&
      (span.start <= last.end || GAP_ONLY.test(sentence.slice(last.end, span.start)));
    if (joined) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

function wordsOf(sentence) {
  return [...sentence.matchAll(WORD)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    norm: normalizeText(match[0]),
  }));
}

function countWords(words, span) {
  return words.filter((word) => word.start < span.end && word.end > span.start).length;
}

// The word directly before the span, with nothing but spaces between them.
function wordBefore(sentence, words, span) {
  const word = words.findLast((entry) => entry.end <= span.start);
  return word !== undefined && GAP_ONLY.test(sentence.slice(word.end, span.start))
    ? word
    : undefined;
}

function wordAfter(sentence, words, span) {
  const word = words.find((entry) => entry.start >= span.end);
  return word !== undefined && GAP_ONLY.test(sentence.slice(span.end, word.start))
    ? word
    : undefined;
}

function growLeft(sentence, words, span, frame) {
  const grown = { ...span };
  let word = wordBefore(sentence, words, grown);
  while (word !== undefined && frame.has(word.norm)) {
    grown.start = word.start;
    word = wordBefore(sentence, words, grown);
  }
  return grown;
}

// A span of fewer than MIN_BLANK_WORDS words takes its neighbour on the left, or on the right at the
// start of the sentence.
function padded(sentence, words, span) {
  if (countWords(words, span) >= MIN_BLANK_WORDS) return span;
  const before = wordBefore(sentence, words, span);
  if (before !== undefined) return { start: before.start, end: span.end };
  const after = wordAfter(sentence, words, span);
  return after === undefined ? span : { start: span.start, end: after.end };
}

/**
 * Blanks the value phrases of `sentence`: `{ text, gaps, phrases }` with every blank written as `___`
 * and the phrases that were taken out, or undefined when a term group does not occur literally. The
 * phrase of an occurrence is the whole words around it, widened to the left over the small words
 * that belong to it and padded to at least two words; phrases that touch become one.
 */
export function blankValuePhrases(sentence, groups, language) {
  const found = termSpans(sentence, groups);
  if (found === undefined) return undefined;
  const words = wordsOf(sentence);
  const frame = FRAME_WORDS[language];
  const widened = mergeSpans(sentence, found).map((span) =>
    padded(sentence, words, growLeft(sentence, words, span, frame)),
  );
  const spans = mergeSpans(sentence, widened);
  let text = sentence;
  for (const span of spans.toReversed())
    text = `${text.slice(0, span.start)}${BLANK}${text.slice(span.end)}`;
  return {
    text,
    gaps: spans.length,
    phrases: spans.map((span) => sentence.slice(span.start, span.end)),
  };
}
