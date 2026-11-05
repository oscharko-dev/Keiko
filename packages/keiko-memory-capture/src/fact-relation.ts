// How a new fact relates to one the person already stated. The model labels the relation; these
// checks confirm it, because a wrong replacement would quietly lose a true fact and nobody approves
// learned facts. A check that cannot confirm a change leaves both facts standing.

import {
  anyWordPattern,
  factWords,
  hasWord,
  isNegated,
  isNumberWord,
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

export function compareFacts(a: string, b: string): FactComparison {
  const wordsA = factWords(a);
  const wordsB = factWords(b);
  const onlyA = unmatched(wordsA, wordsB);
  const onlyB = unmatched(wordsB, wordsA);
  if (wordsA.length === 0 || wordsB.length === 0) return "different";
  if (onlyA.length === 0 && onlyB.length === 0) return equalWordsComparison(a, b, wordsA, wordsB);
  if ([...onlyA, ...onlyB].every(isPredicateWord))
    return equalWordsComparison(a, b, wordsA, wordsB);
  const shared = wordsA.length - onlyA.length;
  if (shared === 0 || onlyA.length !== onlyB.length) return "different";
  if ([...onlyA, ...onlyB].every(isNumberWord)) return "number-changed";
  return onlyA.length <= MAX_SLOT_WORDS ? "slot-changed" : "different";
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
  if (compareFacts(body, related.body) === "slot-changed") {
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

export function decideFactRelation(input: FactRelationInput): FactRelationDecision {
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
