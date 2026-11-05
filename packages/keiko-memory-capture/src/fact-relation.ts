// How a new fact relates to one the person already stated. The model labels the relation; these
// checks confirm it, because a wrong replacement would quietly lose a true fact and nobody approves
// learned facts. A check that cannot confirm a change leaves both facts standing.

import { normalizeMemoryText } from "@oscharko-dev/keiko-contracts/memory";

import {
  anyWordPattern,
  factWords,
  hasWord,
  isNegated,
  isNumberWord,
  isSingleValuePredicate,
  isPredicateWord,
  sameFactWord,
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
const QUALIFIER_RE = /(?:^|[^\p{L}])(?:für|fuer|for)\s+(.+)$/iu;
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
// "Arbeitet bei Acme" names one employer, "Arbeitet mit Excel" one of many tools. Each pattern
// captures the slot's value.
const SINGLE_VALUE_SLOT_RES: readonly RegExp[] = [
  /(?:^|[^\p{L}])arbeite\p{L}*\s+(?:bei|fur|fuer)\s+([\p{L}\p{N}]+)/u,
  /(?:^|[^\p{L}])works?\s+(?:at|for)\s+([\p{L}\p{N}]+)/u,
  /(?:^|[^\p{L}])wohn\p{L}*\s+in\s+([\p{L}\p{N}]+)/u,
  /(?:^|[^\p{L}])lives?\s+in\s+([\p{L}\p{N}]+)/u,
  /(?:^|[^\p{L}])heiss\p{L}*\s+([\p{L}\p{N}]+)/u,
  /(?:^|[^\p{L}])(?:named|called)\s+([\p{L}\p{N}]+)/u,
];
// One preference at a time for one purpose: "Bevorzugt Tabellen für Zahlen". Using or liking
// something does not end using or liking another thing.
const CHOSEN_PREFERENCE_RE = anyWordPattern([
  String.raw`bevorzug\p{L}*`,
  String.raw`prefers?`,
  String.raw`preferred`,
  "lieber",
  "rather",
]);

function slotValues(text: string): readonly (string | undefined)[] {
  const normalized = normalizeMemoryText(text);
  return SINGLE_VALUE_SLOT_RES.map((slot) => slot.exec(normalized)?.[1]);
}

function sharesSingleValueSlot(a: string, b: string): boolean {
  const valuesB = slotValues(b);
  return slotValues(a).some((value, index) => value !== undefined && valuesB[index] !== undefined);
}

// Whether the value of a one-at-a-time slot differs: the new employer, not a new tool beside it.
function singleValueChanged(a: string, b: string): boolean {
  if (CHOSEN_PREFERENCE_RE.test(a) && CHOSEN_PREFERENCE_RE.test(b)) return true;
  const valuesB = slotValues(b);
  return slotValues(a).some((value, index) => {
    const other = valuesB[index];
    return value !== undefined && other !== undefined && !sameFactWord(value, other);
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
// there are two facts, so a differing single-value predicate never reads as a rewording.
function predicateOnlyComparison(
  a: string,
  b: string,
  wordsA: readonly string[],
  wordsB: readonly string[],
  differing: readonly string[],
): FactComparison {
  return differing.some(isSingleValuePredicate)
    ? "different"
    : equalWordsComparison(a, b, wordsA, wordsB);
}

export function compareFacts(a: string, b: string): FactComparison {
  const wordsA = factWords(a);
  const wordsB = factWords(b);
  const onlyA = unmatched(wordsA, wordsB);
  const onlyB = unmatched(wordsB, wordsA);
  if (wordsA.length === 0 || wordsB.length === 0) return "different";
  const differing = [...onlyA, ...onlyB];
  if (differing.every(isPredicateWord)) {
    return predicateOnlyComparison(a, b, wordsA, wordsB, differing);
  }
  const shared = wordsA.length - onlyA.length;
  if (shared === 0 || onlyA.length !== onlyB.length) return "different";
  if (differing.every(isNumberWord)) return "number-changed";
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
  if (!sameSubject(body, related.body)) return null;
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
    sameSubject(statement, fact.body)
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
