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

// Statements that INFORMATION is absent, phrased about what a text holds ("keine Angaben", "no
// information"). They decline only together with a referent or a search outcome in the same
// sentence. Each is bounded (`{0,n}`) so matching stays linear.
const INFORMATION_ABSENCE_PATTERNS: readonly RegExp[] = [
  // German: "keine (relevanten) Informationen/Angaben/Vorgaben/Aussage/...".
  /\bkeine\s+(?:\p{L}+\s+){0,2}(?:informationen?|angaben?|vorgaben?|aussagen?|hinweise?|belege?|nachweise?|anhaltspunkte?|erkenntnisse|treffer|details)\b/iu,
  // German: "nichts ... gefunden|erwähnt|angegeben".
  /\bnichts\s+(?:\p{L}+\s+){0,3}(?:gefunden|erwähnt|angegeben|enthalten|beschrieben|dokumentiert)\b/iu,
  // English: "no (relevant) information/evidence/mention/details ...".
  /\bno\s+(?:\p{L}+\s+){0,2}(?:information|evidence|mentions?|references?|details|indication|guidance|specifications?)\b/iu,
];

// The outcome of a search: an absent-information noun next to it reports what the search found.
const SEARCH_OUTCOME_PATTERN =
  /\b(?:gefunden|finden|auffindbar|ermittel\p{L}*|vorhanden|verfügbar|found|find|located?|identified|available)\b|\bvor[.!?]*$/iu;

// Negated verbs state a negative FACT about the subject as often as a refusal: "The API does not
// provide authentication" is an answer (PR #3678 review). They count only when the text names the
// evidence it searched ("in the provided documents", "in den Unterlagen").
const NEGATED_VERB_PATTERNS: readonly RegExp[] = [
  // German: "... ist/wird nicht enthalten|beschrieben|erwähnt|...", "lässt sich nicht entnehmen",
  // "geht nicht hervor", "kann ich nicht beantworten".
  /\bnicht\s+(?:\p{L}+\s+){0,4}(?:enthalten|beschrieben|erwähnt|genannt|angegeben|dokumentiert|aufgeführt|abgedeckt|gefunden|finden|entnehmen|ableiten|hervor|beantworten|beantwortet)\b/iu,
  // German: "geht dazu nichts hervor", "steht dazu nichts", "sagen nichts über".
  /\bnichts\s+(?:\p{L}+\s+){0,2}hervor\b/iu,
  /\b(?:steht|stehen|sagt|sagen)\s+(?:\p{L}+\s+){0,4}nichts\b/iu,
  // English: "not mentioned|specified|described|covered|documented|stated|found".
  /\b(?:not|never)\s+(?:\p{L}+\s+){0,2}(?:mentioned|specified|described|covered|documented|stated|found)\b/iu,
  // English: "does not contain/include/mention/specify/provide/describe/say/address".
  /\b(?:do|does)(?:\s+not|n[’']t)\s+(?:\p{L}+\s+){0,2}(?:contain|include|mention|specify|provide|describe|say|state|address|cover|discuss)\b/iu,
  // English: "could not find", "cannot answer", "unable to determine".
  /\b(?:(?:could|can)(?:\s+not|not|[’']t|n[’']t)|unable\s+to)\s+(?:\p{L}+\s+){0,2}(?:find|answer|determine|tell)\b/iu,
];

// The evidence a refusal refers to: the documents, sources, excerpts, repository or context Keiko
// retrieved. A plain "file" is not one: "Die Datei enthält keine Angaben zum Autor" is an answer.
const EVIDENCE_REFERENT_PATTERN =
  /\b(?:documents?|documentation|sources?|context|excerpts?|materials?|knowledge\s+base|provided|retrieved|repositor(?:y|ies)|code\s?base|folders?|dokument(?:e|en|s|ation)?|quellen?|unterlagen|kontext|auszüge?n?|bereitgestellt\p{L}*|wissensbasis|vorliegend\p{L}*|repositorys?|codebasis|ordnern?)\b/iu;

// An attribution names the evidence as the source of a statement, not as the place that lacks it:
// "The API does not provide authentication according to the documentation." is a documented
// negative fact (PR #3678 review). Attribution phrases are removed before the referent test.
const ATTRIBUTION_PATTERNS: readonly RegExp[] = [
  /\b(?:according to|as (?:stated|described|documented|specified) in|as per|laut|gemäß)\s+(?:\p{L}+\s+){0,3}\p{L}+/giu,
  /(?:\p{L}+\s+){1,3}zufolge\b/giu,
];

function withoutAttributions(sentence: string): string {
  return ATTRIBUTION_PATTERNS.reduce((text, pattern) => text.replace(pattern, " "), sentence);
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
    (namesEvidence || SEARCH_OUTCOME_PATTERN.test(sentence))
  );
}

function sentencesOf(text: string): readonly string[] {
  return text.split(/(?<=[.!?])\s+/u);
}
