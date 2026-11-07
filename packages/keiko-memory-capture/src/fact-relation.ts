// How a new fact relates to one the person already stated. The model labels the relation; these
// checks confirm it, because a wrong replacement would quietly lose a true fact and nobody approves
// learned facts. A check that cannot confirm a change leaves both facts standing.

import { normalizeMemoryText, type MemoryScopeKind } from "@oscharko-dev/keiko-contracts/memory";

import {
  anyWordPattern,
  factWords,
  hasWord,
  isNegated,
  isNumberWord,
  isPredicateWord,
  isSingleValuePredicate,
  sameFactWord,
  spansPredicateClasses,
} from "./fact-text.js";

export const FACT_RELATION_LABELS = ["new", "same", "update", "contradiction"] as const;

export type FactRelationLabel = (typeof FACT_RELATION_LABELS)[number];

export type FactComparison =
  "same" | "reversed" | "number-changed" | "polarity-changed" | "slot-changed" | "different";

export const FACT_CHANGE_BASES = [
  "reversed",
  "number-changed",
  "polarity-changed",
  "slot-changed",
  "stated-change",
] as const;

export type FactChangeBasis = (typeof FACT_CHANGE_BASES)[number];

export interface KnownFact {
  readonly id: string;
  readonly body: string;
  // A fact a learned one may confirm and never replace: what the person stated clearly, and anything
  // outside their private scope.
  readonly fixed?: boolean;
  // Where the fact lives. A team's fact is compared only with its project's facts, so it never
  // confirms or replaces what the person keeps privately.
  readonly scopeKind?: MemoryScopeKind;
}

export type FactRelationDecision =
  | { readonly kind: "new" }
  | { readonly kind: "confirm"; readonly factId: string }
  | { readonly kind: "supersede"; readonly factId: string; readonly basis: FactChangeBasis }
  // The model calls it the same fact and the lexical check cannot tell. Only a semantic duplicate
  // can confirm it; otherwise nothing is stored.
  | { readonly kind: "same-unconfirmed" };

const MAX_SLOT_WORDS = 2;
const COMPARATOR_RE = anyWordPattern([
  "als",
  "anstatt",
  "instead",
  "over",
  "rather",
  "statt",
  "than",
  "versus",
  "vs",
  "über",
  "ueber",
  "gegenüber",
  "gegenueber",
]);
// "Ab jetzt lieber Listen" names no word of "Ich bevorzuge Tabellen" and changes it all the same:
// both are preferences. Only a stated change with a model label gets this far.
const PREFERENCE_RE = anyWordPattern([
  "bevorzuge",
  "bevorzugt",
  "lieber",
  "liebe",
  "liebt",
  "mag",
  "like",
  "likes",
  "prefer",
  "prefers",
  "rather",
]);
const QUALIFIER_RE = /(?:^|[^\p{L}])(?:für|fuer|for)\s+(\S.*)$/iu;
const STATED_CHANGE_RE = anyWordPattern([
  "ab jetzt",
  "ab sofort",
  "von nun an",
  "künftig",
  "kuenftig",
  "inzwischen",
  "mittlerweile",
  "nicht mehr",
  "stattdessen",
  "lieber",
  "jetzt",
  "gewechselt",
  "umgestiegen",
  "from now on",
  "no longer",
  "instead",
  "anymore",
  "any more",
  "switched",
  "moved to",
  "now",
  "these days",
  "nowadays",
]);

function unmatched(words: readonly string[], other: readonly string[]): readonly string[] {
  return words.filter((word) => !hasWord(other, word));
}

function keepsOrder(a: readonly string[], b: readonly string[]): boolean {
  let last = -1;
  for (const word of a) {
    const index = b.findIndex((candidate) => sameFactWord(candidate, word));
    if (index < last) return false;
    last = index;
  }
  return true;
}

function equalWordsComparison(
  a: string,
  b: string,
  wordsA: readonly string[],
  wordsB: readonly string[],
): FactComparison {
  if (isNegated(a) !== isNegated(b)) return "polarity-changed";
  return COMPARATOR_RE.test(a) && !keepsOrder(wordsA, wordsB) ? "reversed" : "same";
}

// A person has one of these at a time, so a new value replaces the old one. The preposition decides:
// "Arbeitet bei Acme" names one employer, "Arbeitet mit Excel" one of many tools. A few words may
// stand between ("Ich arbeite jetzt bei Foo"). Each pattern ends where the slot's value begins.
const BETWEEN = String.raw`(?:[\p{L}\p{N}]+\s+){0,3}?`;
const SINGLE_VALUE_SLOT_RES: readonly RegExp[] = [
  new RegExp(String.raw`(?:^|[^\p{L}])arbeite\p{L}*\s+${BETWEEN}(?:bei|fur|fuer)\s+`, "u"),
  new RegExp(String.raw`(?:^|[^\p{L}])works?\s+${BETWEEN}(?:at|for)\s+`, "u"),
  new RegExp(String.raw`(?:^|[^\p{L}])wohn\p{L}*\s+${BETWEEN}in\s+`, "u"),
  new RegExp(String.raw`(?:^|[^\p{L}])lives?\s+${BETWEEN}in\s+`, "u"),
  // The verb, never the adjective: "Heißt Alex", "Ich heiße Alex", not "heiße Schokolade".
  /(?:^|[^\p{L}])(?:heisst|ich\s+heisse)\s+/u,
  /(?:^\s*|(?:is|am|i['’]m|be)\s+)(?:named|called)\s+/u,
];
// The value ends where the next phrase begins: "Acme" in "bei Acme mit Excel".
const VALUE_END_WORDS = [
  "mit",
  "seit",
  "als",
  "im",
  "in",
  "am",
  "an",
  "auf",
  "fur",
  "fuer",
  "wegen",
  "weil",
  "und",
  "oder",
  "with",
  "as",
  "since",
  "from",
  "on",
  "at",
  "for",
  "because",
  "and",
  "or",
];
const VALUE_END_RE = new RegExp(String.raw`\s(?:${VALUE_END_WORDS.join("|")})\s|[,;:.!?]`, "u");
// One preference at a time for one purpose: "Bevorzugt Tabellen für Zahlen". Using or liking
// something does not end using or liking another thing.
const CHOSEN_PREFERENCE_RE = anyWordPattern([
  String.raw`bevorzug\p{L}*`,
  "prefers?",
  "preferred",
  "lieber",
  "rather",
]);
// "Ich nutze jetzt auch Python" adds a fact; only a replacing word makes it a change.
const ADDITIVE_RE = anyWordPattern([
  "auch",
  "ebenfalls",
  "zusätzlich",
  "zusaetzlich",
  "außerdem",
  "ausserdem",
  "also",
  "too",
  "as well",
]);
const REPLACING_RE = anyWordPattern([
  "nicht mehr",
  "kein(?:e|en)? mehr",
  "stattdessen",
  "statt",
  "anstatt",
  "no longer",
  "anymore",
  "instead",
  "rather than",
]);

// The words of each one-at-a-time slot's value, or undefined where the text has no such slot.
function slotValues(text: string): readonly (readonly string[] | undefined)[] {
  const normalized = `${normalizeMemoryText(text)} `;
  return SINGLE_VALUE_SLOT_RES.map((slot) => {
    const match = slot.exec(normalized);
    if (match === null) return undefined;
    const rest = normalized.slice(match.index + match[0].length);
    const end = VALUE_END_RE.exec(rest);
    return factWords(end === null ? rest : rest.slice(0, end.index));
  });
}

function sameWords(a: readonly string[], b: readonly string[]): boolean {
  return unmatched(a, b).length === 0 && unmatched(b, a).length === 0;
}

// Whether a statement only adds to what is known: "auch", "also", without "nicht mehr" or "instead".
export function addsRatherThanReplaces(text: string): boolean {
  return ADDITIVE_RE.test(text) && !REPLACING_RE.test(text);
}

function sharesSingleValueSlot(a: string, b: string): boolean {
  const valuesB = slotValues(b);
  return slotValues(a).some((value, index) => value !== undefined && valuesB[index] !== undefined);
}

// A chosen preference changes when exactly one word differs on each side and the rest, its purpose
// and context, stays: "lange Antworten in Chats" is no change of "kurze Antworten in Meetings".
function preferenceChanged(a: string, b: string): boolean {
  if (!CHOSEN_PREFERENCE_RE.test(a) || !CHOSEN_PREFERENCE_RE.test(b)) return false;
  const wordsA = factWords(a);
  const wordsB = factWords(b);
  return unmatched(wordsA, wordsB).length === 1 && unmatched(wordsB, wordsA).length === 1;
}

// A changed preference keeps its context: "light mode in the terminal" is no change of "dark mode in
// the editor". Other facts are not preferences, so this leaves them alone.
function keepsPreferenceContext(a: string, b: string): boolean {
  if (!CHOSEN_PREFERENCE_RE.test(a) || !CHOSEN_PREFERENCE_RE.test(b)) return true;
  return preferenceChanged(a, b);
}

// Whether the value of a one-at-a-time slot differs: the new employer, not a new tool beside it.
function singleValueChanged(a: string, b: string): boolean {
  if (preferenceChanged(a, b)) return true;
  const valuesB = slotValues(b);
  return slotValues(a).some((value, index) => {
    const other = valuesB[index];
    return value !== undefined && other !== undefined && !sameWords(value, other);
  });
}

// A shared "bevorzugt" does not make "Tabellen" and "Tee" two values of one fact; a shared content
// word or a shared single-value slot does.
function sharesSlot(
  a: string,
  b: string,
  wordsA: readonly string[],
  wordsB: readonly string[],
): boolean {
  if (sharesSingleValueSlot(a, b)) return true;
  return wordsA.some((word) => hasWord(wordsB, word) && !isPredicateWord(word));
}

// Only the wording differs: "Mag Tabellen" and "Bevorzugt Tabellen". Living somewhere and working
// there are two facts, so a differing single-value predicate never reads as a rewording; nor does a
// predicate of another kind: using Python is not preferring it.
function predicateOnlyComparison(
  a: string,
  b: string,
  wordsA: readonly string[],
  wordsB: readonly string[],
  differing: readonly string[],
): FactComparison {
  if (differing.some((word) => isSingleValuePredicate(word))) return "different";
  if (spansPredicateClasses(differing)) return "different";
  return equalWordsComparison(a, b, wordsA, wordsB);
}

export function compareFacts(a: string, b: string): FactComparison {
  const wordsA = factWords(a);
  const wordsB = factWords(b);
  const onlyA = unmatched(wordsA, wordsB);
  const onlyB = unmatched(wordsB, wordsA);
  if (wordsA.length === 0 || wordsB.length === 0) return "different";
  const differing = [...onlyA, ...onlyB];
  if (differing.every((word) => isPredicateWord(word))) {
    return predicateOnlyComparison(a, b, wordsA, wordsB, differing);
  }
  const shared = wordsA.length - onlyA.length;
  if (shared === 0 || onlyA.length !== onlyB.length) return "different";
  if (differing.every((word) => isNumberWord(word))) return "number-changed";
  return sharesSlot(a, b, wordsA, wordsB) && onlyA.length <= MAX_SLOT_WORDS
    ? "slot-changed"
    : "different";
}

// Whether two bodies state one fact. A changed value or a reversed preference is never the same
// fact, however alike the two read.
export function statesSameFact(a: string, b: string): boolean {
  return compareFacts(a, b) === "same";
}

// Reads alike and states something else: a semantic duplicate must not swallow it.
export function statesChangedFact(a: string, b: string): boolean {
  const comparison = compareFacts(a, b);
  return comparison !== "same" && comparison !== "different";
}

function qualifierOf(body: string): readonly string[] | null {
  const match = QUALIFIER_RE.exec(body);
  return match?.[1] === undefined ? null : factWords(match[1]);
}

// "Tabellen für Zahlen" and "Tabellen für Text" share a preference and differ in what it is about.
function sameSubject(a: string, b: string): boolean {
  const qualifierA = qualifierOf(a);
  const qualifierB = qualifierOf(b);
  if (qualifierA === null || qualifierB === null) return true;
  return (
    unmatched(qualifierA, qualifierB).length === 0 && unmatched(qualifierB, qualifierA).length === 0
  );
}

function sharesWord(a: string, b: string): boolean {
  const wordsB = factWords(b);
  return factWords(a).some((word) => hasWord(wordsB, word));
}

function sharesContentWord(a: string, b: string): boolean {
  const wordsB = factWords(b);
  return factWords(a).some((word) => !isPredicateWord(word) && hasWord(wordsB, word));
}

function deterministicRelation(
  body: string,
  known: readonly KnownFact[],
): FactRelationDecision | null {
  for (const fact of known) {
    const comparison = compareFacts(body, fact.body);
    if (comparison === "same") return { kind: "confirm", factId: fact.id };
    if (
      comparison === "reversed" ||
      comparison === "number-changed" ||
      comparison === "polarity-changed"
    ) {
      return { kind: "supersede", factId: fact.id, basis: comparison };
    }
  }
  return null;
}

function labelledChange(
  body: string,
  evidence: string,
  related: KnownFact,
): FactRelationDecision | null {
  if (!sameSubject(body, related.body) || addsRatherThanReplaces(evidence)) return null;
  // A model label alone replaces only a one-at-a-time value; anything else needs a stated change.
  if (
    compareFacts(body, related.body) === "slot-changed" &&
    singleValueChanged(body, related.body)
  ) {
    return { kind: "supersede", factId: related.id, basis: "slot-changed" };
  }
  const sameKind =
    sharesWord(body, related.body) ||
    (PREFERENCE_RE.test(evidence) && PREFERENCE_RE.test(related.body));
  if (STATED_CHANGE_RE.test(evidence) && sameKind) {
    return { kind: "supersede", factId: related.id, basis: "stated-change" };
  }
  return null;
}

export interface FactRelationInput {
  readonly body: string;
  readonly evidence: string;
  readonly label: FactRelationLabel;
  // The known fact the model named, when it named one.
  readonly related?: KnownFact;
  readonly known: readonly KnownFact[];
}

function keepingFixedFacts(
  decision: FactRelationDecision,
  known: readonly KnownFact[],
): FactRelationDecision {
  if (decision.kind !== "supersede") return decision;
  const fixed = known.some((fact) => fact.id === decision.factId && fact.fixed === true);
  return fixed ? { kind: "new" } : decision;
}

export function decideFactRelation(input: FactRelationInput): FactRelationDecision {
  return keepingFixedFacts(relationOf(input), input.known);
}

function relationOf(input: FactRelationInput): FactRelationDecision {
  const { body, evidence, label, related, known } = input;
  const certain = deterministicRelation(body, known);
  if (certain !== null) return certain;
  if (related === undefined) return { kind: "new" };
  if (label === "update" || label === "contradiction") {
    return labelledChange(body, evidence, related) ?? { kind: "new" };
  }
  if (label === "same" && sharesContentWord(body, related.body)) {
    return { kind: "same-unconfirmed" };
  }
  return { kind: "new" };
}

function statementChanges(statement: string, fact: KnownFact): boolean {
  const comparison = compareFacts(statement, fact.body);
  if (
    comparison === "reversed" ||
    comparison === "number-changed" ||
    comparison === "polarity-changed"
  ) {
    return true;
  }
  return (
    comparison === "slot-changed" &&
    STATED_CHANGE_RE.test(statement) &&
    !addsRatherThanReplaces(statement) &&
    sameSubject(statement, fact.body) &&
    keepsPreferenceContext(statement, fact.body)
  );
}

// The older learned fact a person's clear statement replaces. No model labels such a statement, so
// the words alone must show the change; several matches leave it unclear which one is meant.
export function factReplacedByStatement(
  statement: string,
  learned: readonly KnownFact[],
): KnownFact | null {
  const changed = learned.filter((fact) => statementChanges(statement, fact));
  return changed.length === 1 ? (changed[0] ?? null) : null;
}

function charBigrams(text: string): ReadonlySet<string> {
  const normalized = factWords(text).join(" ");
  const bigrams = new Set<string>();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    bigrams.add(normalized.slice(index, index + 2));
  }
  return bigrams;
}

function bigramSimilarity(a: string, b: string): number {
  const bigramsA = charBigrams(a);
  const bigramsB = charBigrams(b);
  if (bigramsA.size === 0 || bigramsB.size === 0) return 0;
  const shared = [...bigramsA].filter((bigram) => bigramsB.has(bigram)).length;
  return shared / (bigramsA.size + bigramsB.size - shared);
}

// The known facts worth showing the model for one message: those that read most like it.
export function mostSimilarFacts(
  userText: string,
  known: readonly KnownFact[],
  limit: number,
): readonly KnownFact[] {
  // "Ab jetzt lieber Listen" shares no letters with "Bevorzugt Tabellen" and still changes it, so a
  // dissimilar fact stays eligible while there is room.
  if (factWords(userText).length === 0) return [];
  return known
    .map((fact) => ({ fact, similarity: bigramSimilarity(userText, fact.body) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit)
    .map(({ fact }) => fact);
}
