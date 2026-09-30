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
//   * The broad absence phrasings additionally require that the text does not continue with a
//     contrast ("... aber Y ist in Kapitel 3 beschrieben"): that is a partial answer, not a refusal.
//   * A negated verb ("does not contain", "nicht erwähnt") additionally requires that its own sentence
//     names the evidence it searched; without it the sentence is a negative fact about the subject.

import { findCitationMarkerGroups } from "./citation-markers.js";

/** Longest answer (after whitespace collapse) that can still be read as a bare refusal. */
export const NO_EVIDENCE_ANSWER_MAX_CHARS = 240;

// The stock phrasings both former lists carried. They are explicit "there is no evidence" statements
// and stay unconditional (bar the length and marker guards).
const STOCK_REFUSAL_PATTERNS: readonly RegExp[] = [
  /\bno\s+evidence\s+(?:found|available|in|within)\b/iu,
  /\binsufficient\s+evidence\b/iu,
  /\bnot\s+enough\s+evidence\b/iu,
  /\bkeine\s+evidenz\b/iu,
  /\bkeine\s+(?:belege|hinweise)\b/iu,
  /\bnicht\s+genug\s+(?:evidenz|belege|hinweise)\b/iu,
];

// Natural statements that INFORMATION is absent: phrased about what the evidence holds ("keine
// Angaben", "no information", "could not find"). Each is bounded (`{0,n}`) so matching stays linear.
const INFORMATION_ABSENCE_PATTERNS: readonly RegExp[] = [
  // German: "keine (relevanten) Informationen/Angaben/Vorgaben/... gefunden|enthalten".
  /\bkeine\s+(?:\p{L}+\s+){0,2}(?:informationen?|angaben?|vorgaben?|hinweise?|belege?|nachweise?|anhaltspunkte?|erkenntnisse|treffer|details)\b/iu,
  // German: "nichts ... gefunden|erwähnt|angegeben".
  /\bnichts\s+(?:\p{L}+\s+){0,3}(?:gefunden|erwähnt|angegeben|enthalten|beschrieben|dokumentiert)\b/iu,
  // English: "no (relevant) information/evidence/mention/details ...".
  /\bno\s+(?:\p{L}+\s+){0,2}(?:information|evidence|mentions?|references?|details|indication|guidance|specifications?)\b/iu,
  // English: "could not find", "cannot find", "unable to find".
  /\b(?:could|can)(?:\s+not|not|'t|n't)\s+(?:\p{L}+\s+){0,2}find\b/iu,
  /\bunable\s+to\s+find\b/iu,
];

// Negated verbs state a negative FACT about the subject as often as a refusal: "The API does not
// provide authentication" is an answer (PR #3678 review). They count only when the text names the
// evidence it searched ("in the provided documents", "in den Unterlagen").
const NEGATED_VERB_PATTERNS: readonly RegExp[] = [
  // German: "... ist/wird nicht enthalten|beschrieben|erwähnt|angegeben|gefunden".
  /\bnicht\s+(?:\p{L}+\s+){0,4}(?:enthalten|beschrieben|erwähnt|genannt|angegeben|dokumentiert|aufgeführt|abgedeckt|gefunden)\b/iu,
  // English: "not mentioned|specified|described|covered|documented|stated|found".
  /\b(?:not|never)\s+(?:\p{L}+\s+){0,2}(?:mentioned|specified|described|covered|documented|stated|found)\b/iu,
  // English: "does not contain/include/mention/specify/provide/describe".
  /\b(?:do|does)(?:\s+not|n't)\s+(?:\p{L}+\s+){0,2}(?:contain|include|mention|specify|provide|describe)\b/iu,
];

// The evidence a refusal refers to: the documents, sources, excerpts or context Keiko retrieved.
const EVIDENCE_REFERENT_PATTERN =
  /\b(?:documents?|documentation|sources?|context|excerpts?|materials?|knowledge\s+base|provided|retrieved|dokument(?:e|en|s|ation)?|quellen?|unterlagen|kontext|auszüge?n?|bereitgestellt\p{L}*|wissensbasis|vorliegend\p{L}*)\b/iu;

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
  if (STOCK_REFUSAL_PATTERNS.some((pattern) => pattern.test(compact))) return true;
  if (CONTRAST_PATTERN.test(compact)) return false;
  if (INFORMATION_ABSENCE_PATTERNS.some((pattern) => pattern.test(compact))) return true;
  return sentencesOf(compact).some(isEvidenceAbsenceSentence);
}

// A negated verb declines only when the SAME sentence names the evidence it searched: "The API does
// not provide authentication. Documentation is public." states a fact and mentions documentation
// separately (PR #3678 review).
function isEvidenceAbsenceSentence(sentence: string): boolean {
  return (
    EVIDENCE_REFERENT_PATTERN.test(sentence) &&
    NEGATED_VERB_PATTERNS.some((pattern) => pattern.test(sentence))
  );
}

function sentencesOf(text: string): readonly string[] {
  return text.split(/(?<=[.!?])\s+/u);
}
