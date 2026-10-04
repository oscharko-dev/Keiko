// Shared "the answer declines for lack of evidence" detector (grounded answers).
//
// A grounded answer over retrieved references that says "nothing about this in the documents" is a
// refusal, not an answer with missing citations: it makes no source-backed claim, so there is
// nothing to cite. Two lists of English/German refusal phrasings once decided that independently
// (the Knowledge Pod answer enforcement in keiko-server and the citation-repair skip in
// keiko-local-knowledge), and both only knew the handful of stock phrases ("no evidence found",
// "keine Belege"). A natural German refusal ("In den bereitgestellten Dokumenten wurden keine
// Informationen oder Vorgaben zur Java-Version gefunden.") matched neither, so it was reported as an
// answer with "1 unsupported citation" and a needless citation-repair model call was spent on it.
// This module is the ONE list, in the contracts leaf so every grounded path can import it.
//
// Conservative by construction — a false positive replaces a real answer with a generic notice:
//   * Only a SHORT text can be a refusal (a long answer states something, whatever it also says).
//   * A text that carries an inline citation marker is an answer: it cites a source.
//   * Only explicit "not enough evidence/information" statements are unconditional. Every other
//     phrasing additionally requires that the text does not continue with a contrast ("... aber Y ist
//     in Kapitel 3 beschrieben"): that is a partial answer, not a refusal.
//   * An absent-information noun ("keine Angaben", "no details") declines only when its own sentence
//     names the evidence it searched or a search outcome ("gefunden", "available"): "The API returns
//     no details on errors." is a negative fact about the subject (PR #3678 review).
//   * A negated verb ("does not contain", "nicht erwähnt", "geht nicht hervor") additionally requires
//     that its own sentence names the evidence it searched; without it the sentence is a negative
//     fact about the subject.

import { findCitationMarkerGroups } from "./citation-markers.js";

/** Longest answer (after whitespace collapse) that can still be read as a bare refusal. */
export const NO_EVIDENCE_ANSWER_MAX_CHARS = 240;

// Explicit "there is not enough evidence/information" statements. They stay unconditional (bar the
// length and marker guards): no answer about a subject is phrased this way.
const STOCK_REFUSAL_PATTERNS: readonly RegExp[] = [
  /\bno\s+evidence\s+(?:found|available|in|within)\b/iu,
  /(?:\binsufficient|\bnot\s+(?:have\s+)?enough|n[’']t\s+have\s+enough)\s+(?:evidence|information)\b/iu,
  /\bkeine\s+(?:evidenz|belege)\b/iu,
  /\bnicht\s+(?:genug|genügend|ausreichend\p{L}*)\s+(?:evidenz|belege|hinweise|informationen|angaben)\b/iu,
  /\bunzureichend\p{L}*\s+(?:informationen|angaben|belege)\b/iu,
];

// `lead`, then at most `gap` further words, then one of `terms` (each a regex fragment). Every phrase
// below shares this shape; the bounded gap keeps matching linear.
function phrase(lead: string, gap: number, terms: readonly string[]): RegExp {
  return new RegExp(
    String.raw`\b${lead}\s+(?:\p{L}+\s+){0,${String(gap)}}(?:${terms.join("|")})\b`,
    "iu",
  );
}

// Any one of `terms` (each a regex fragment) as a whole word.
function anyWord(terms: readonly string[]): RegExp {
  return new RegExp(String.raw`\b(?:${terms.join("|")})\b`, "iu");
}

// Statements that INFORMATION is absent, phrased about what a text holds ("keine Angaben", "no
// information"). They decline only together with a referent or a search outcome in the same
// sentence.
const INFORMATION_ABSENCE_PATTERNS: readonly RegExp[] = [
  // German: "keine (relevanten) Informationen/Angaben/Vorgaben/Aussage/...".
  phrase("keine", 2, [
    "informationen?",
    "angaben?",
    "vorgaben?",
    "aussagen?",
    "hinweise?",
    "belege?",
    "nachweise?",
    "anhaltspunkte?",
    "erkenntnisse",
    "treffer",
    "details",
  ]),
  // German: "nichts ... gefunden|erwähnt|angegeben".
  phrase("nichts", 3, [
    "gefunden",
    "erwähnt",
    "angegeben",
    "enthalten",
    "beschrieben",
    "dokumentiert",
  ]),
  // English: "no (relevant) information/evidence/mention/details ...".
  phrase("no", 2, [
    "information",
    "evidence",
    "mentions?",
    "references?",
    "details",
    "indication",
    "guidance",
    "specifications?",
  ]),
];

// The outcome of a search: an absent-information noun next to it reports what the search found. A
// sentence-final German "vor" closes "... liegen keine Angaben vor".
const SEARCH_OUTCOME_WORD = anyWord([
  "gefunden",
  "finden",
  "auffindbar",
  String.raw`ermittel\p{L}*`,
  "vorhanden",
  "verfügbar",
  "found",
  "find",
  "located?",
  "identified",
  "available",
]);
const SEARCH_OUTCOME_TRAILING_VOR = /\bvor[.!?]*$/iu;

function namesSearchOutcome(sentence: string): boolean {
  return SEARCH_OUTCOME_WORD.test(sentence) || SEARCH_OUTCOME_TRAILING_VOR.test(sentence);
}

// Negated verbs state a negative FACT about the subject as often as a refusal: "The API does not
// provide authentication" is an answer (PR #3678 review). They count only when the text names the
// evidence it searched ("in the provided documents", "in den Unterlagen").
const NEGATED_VERB_PATTERNS: readonly RegExp[] = [
  // German: "... ist/wird nicht enthalten|beschrieben|erwähnt|...", "lässt sich nicht entnehmen",
  // "geht nicht hervor", "kann ich nicht beantworten".
  phrase("nicht", 4, [
    "enthalten",
    "beschrieben",
    "erwähnt",
    "genannt",
    "angegeben",
    "dokumentiert",
    "aufgeführt",
    "abgedeckt",
    "gefunden",
    "finden",
    "entnehmen",
    "ableiten",
    "hervor",
    "beantworten",
    "beantwortet",
  ]),
  // German: "geht dazu nichts hervor", "steht dazu nichts", "sagen nichts über".
  phrase("nichts", 2, ["hervor"]),
  phrase("(?:steht|stehen|sagt|sagen)", 4, ["nichts"]),
  // English: "not mentioned|specified|described|covered|documented|stated|found".
  phrase("(?:not|never)", 2, [
    "mentioned",
    "specified",
    "described",
    "covered",
    "documented",
    "stated",
    "found",
  ]),
  // English: "does not contain/include/mention/specify/provide/describe/say/address".
  phrase(String.raw`(?:do|does)(?:\s+not|n[’']t)`, 2, [
    "contain",
    "include",
    "mention",
    "specify",
    "provide",
    "describe",
    "say",
    "state",
    "address",
    "cover",
    "discuss",
  ]),
  // English: "could not find", "cannot answer", "unable to determine".
  phrase(String.raw`(?:(?:could|can)(?:\s+not|not|[’']t|n[’']t)|unable\s+to)`, 2, [
    "find",
    "answer",
    "determine",
    "tell",
  ]),
];

// The evidence a refusal refers to: the documents, sources, excerpts, repository or context Keiko
// retrieved. A plain "file" is not one: "Die Datei enthält keine Angaben zum Autor" is an answer.
const EVIDENCE_REFERENT_PATTERN = anyWord([
  "documents?",
  "documentation",
  "sources?",
  "context",
  "excerpts?",
  "materials?",
  String.raw`knowledge\s+base`,
  "provided",
  "retrieved",
  "repositor(?:y|ies)",
  String.raw`code\s?base`,
  "folders?",
  "dokument(?:e|en|s|ation)?",
  "quellen?",
  "unterlagen",
  "kontext",
  "auszüge?n?",
  String.raw`bereitgestellt\p{L}*`,
  "wissensbasis",
  String.raw`vorliegend\p{L}*`,
  "repositorys?",
  "codebasis",
  "ordnern?",
]);

// An attribution names the evidence as the source of a statement, not as the place that lacks it:
// "The API does not provide authentication according to the documentation." is a documented
// negative fact (PR #3678 review). Attribution phrases are removed before the referent test.
// The attributed source is the noun phrase after the trigger: "the current API reference
// documentation", "the v2.0 documentation", "the project's documentation", "the README of the
// repository" (PR #3678 review). It ends at a clause mark, at a word that opens the main clause (a
// verb, a negation or a pronoun), or at a second article not after a preposition, which opens the
// main clause's subject: in "According to the search results the retrieved documents do not
// mention X" the source is "the search results", and the refusal keeps its referent. No word count
// bounds it, so a long source never leaves its own noun behind as a referent; the words are read
// one by one, so nothing backtracks.
const ATTRIBUTION_TRIGGER =
  /\b(?:according to|as (?:stated|described|documented|specified) in|as per|laut|gemäß)\s+/giu;
const CLAUSE_MARKS: ReadonlySet<string> = new Set([",", ";", ":", ".", "!", "?"]);
const MAIN_CLAUSE_WORDS: ReadonlySet<string> = new Set(
  (
    "do does did is are was were has have had there it can cannot could will would should may " +
    "might must not no never nothing none we i you they contains mentions states says provides " +
    "includes " +
    "describes specifies covers ist sind war wird werden wurde wurden hat haben gibt enthält " +
    "enthalten nennt nennen steht stehen liegt liegen lässt kann können bietet beschreibt sagt " +
    "geht keine kein keinen nicht nichts es wir ich man"
  ).split(" "),
);
const ARTICLES: ReadonlySet<string> = new Set(
  "the a an this these those der die das den dem des ein eine einer einem einen".split(" "),
);
// An article after one of these continues the source ("the README of the repository").
const PREPOSITIONS: ReadonlySet<string> = new Set(
  "of for from in on at by with to von aus für mit bei zu zum zur im am".split(" "),
);

function endsWithClauseMark(word: string): boolean {
  return CLAUSE_MARKS.has(word.at(-1) ?? "");
}

// The word without its trailing clause marks, lower-cased; read character by character.
function bareWord(word: string): string {
  let end = word.length;
  while (end > 0 && CLAUSE_MARKS.has(word.charAt(end - 1))) end -= 1;
  return word.slice(0, end).toLowerCase();
}

function endsSourcePhrase(word: string, previous: string | undefined): boolean {
  const bare = bareWord(word);
  if (MAIN_CLAUSE_WORDS.has(bare)) return true;
  return previous !== undefined && ARTICLES.has(bare) && !PREPOSITIONS.has(bareWord(previous));
}

// The length of the source phrase at the start of `rest`, trailing whitespace included.
function sourcePhraseLength(rest: string): number {
  let length = 0;
  let previous: string | undefined;
  for (const part of rest.split(/(\s+)/u)) {
    if (part.trim().length === 0) {
      length += part.length;
      continue;
    }
    if (endsSourcePhrase(part, previous)) break;
    length += part.length;
    previous = part;
    if (endsWithClauseMark(part)) break;
  }
  return length;
}

function withoutLeadingAttributions(sentence: string): string {
  let kept = "";
  let cursor = 0;
  for (const trigger of sentence.matchAll(ATTRIBUTION_TRIGGER)) {
    if (trigger.index < cursor) continue;
    const phraseStart = trigger.index + trigger[0].length;
    kept += `${sentence.slice(cursor, trigger.index)} `;
    cursor = phraseStart + sourcePhraseLength(sentence.slice(phraseStart));
  }
  return kept + sentence.slice(cursor);
}

// "den bereitgestellten Dokumenten zufolge": up to three whitespace-separated letter runs before a
// "zufolge" name the source; the earliest may end a token that starts with punctuation ("„den").
// Read word by word, so no pattern backtracks over the words.
const ZUFOLGE = /^zufolge\b/iu;
const ZUFOLGE_MAX_WORDS = 3;
const LETTER = /^\p{L}$/u;

function trailingLetterCount(word: string): number {
  const characters = Array.from(word);
  let start = characters.length;
  while (start > 0 && LETTER.test(characters[start - 1] ?? "")) start -= 1;
  return characters.slice(start).join("").length;
}

// Removes the source words before a "zufolge" from `kept`; true when at least one was removed.
function dropAttributedSource(kept: string[]): boolean {
  for (let dropped = 0; dropped < ZUFOLGE_MAX_WORDS; dropped += 1) {
    const word = kept.at(-1) ?? "";
    const letters = trailingLetterCount(word);
    if (letters === 0) return dropped > 0;
    if (letters < word.length) {
      kept[kept.length - 1] = word.slice(0, word.length - letters);
      return true;
    }
    kept.pop();
  }
  return true;
}

function withoutTrailingAttributions(sentence: string): string {
  const kept: string[] = [];
  for (const word of sentence.split(/\s+/u)) {
    const attributes = ZUFOLGE.test(word) && dropAttributedSource(kept);
    kept.push(attributes ? word.replace(ZUFOLGE, "") : word);
  }
  return kept.join(" ");
}

function withoutAttributions(sentence: string): string {
  return withoutTrailingAttributions(withoutLeadingAttributions(sentence));
}

// A contrast after an absence statement turns it into a partial answer that still says something.
const CONTRAST_PATTERN =
  /\b(?:aber|jedoch|allerdings|sondern|dagegen|außer|however|but|although|whereas|except)\b/iu;

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * True when `answer` is a short refusal that states there is no evidence/information for the
 * question (English or German). It never fires for an answer that carries a citation marker, that
 * is longer than NO_EVIDENCE_ANSWER_MAX_CHARS, or that continues an absence statement with a
 * contrast. An empty answer is not a refusal here (callers treat emptiness on its own).
 */
export function isNoEvidenceAnswerText(answer: string): boolean {
  const compact = collapseWhitespace(answer);
  if (compact.length === 0 || compact.length > NO_EVIDENCE_ANSWER_MAX_CHARS) return false;
  if (findCitationMarkerGroups(compact).length > 0) return false;
  const text = withoutInlineMarkdown(compact);
  if (STOCK_REFUSAL_PATTERNS.some((pattern) => pattern.test(text))) return true;
  if (CONTRAST_PATTERN.test(text)) return false;
  return sentencesOf(text).some(isEvidenceAbsenceSentence);
}

// Inline Markdown is read as the words it renders: "according to the [documentation](docs/a.md)"
// and "**documentation**" are the same attribution as the plain word (PR #3678 review). Bounded
// quantifiers keep the rewrite linear over the already length-capped text.
const MARKDOWN_LINK_PATTERN = /\[([^\]\n]{1,200})\]\([^)\n]{0,500}\)/gu;
const MARKDOWN_EMPHASIS_PATTERN = /[*_`~]+/gu;

function withoutInlineMarkdown(text: string): string {
  return text.replace(MARKDOWN_LINK_PATTERN, "$1").replace(MARKDOWN_EMPHASIS_PATTERN, "");
}

// A sentence declines only when it names the evidence it searched, or, for an absent-information
// noun, a search outcome: "The API does not provide authentication. Documentation is public." states
// a fact and mentions documentation separately (PR #3678 review).
function isEvidenceAbsenceSentence(sentence: string): boolean {
  const namesEvidence = EVIDENCE_REFERENT_PATTERN.test(withoutAttributions(sentence));
  if (namesEvidence && NEGATED_VERB_PATTERNS.some((pattern) => pattern.test(sentence))) return true;
  return (
    INFORMATION_ABSENCE_PATTERNS.some((pattern) => pattern.test(sentence)) &&
    (namesEvidence || namesSearchOutcome(sentence))
  );
}

function sentencesOf(text: string): readonly string[] {
  return text.split(/(?<=[.!?])\s+/u);
}
