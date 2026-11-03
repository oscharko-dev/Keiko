// The oracle of a blueprint (#4208): the truth list, the replaced values, the forgotten facts and the
// forbidden content that a correct memory is judged against. It is derived from the blueprint alone,
// before any conversation exists, which is what lets thousands of generated conversations be scored
// without anyone labelling them. The same derivation feeds the blueprint validator, the generator and
// the scenario, so the three can never disagree about what the truth is.
import { matchesTermGroups, normalizeText } from "../score.mjs";
import { blankValuePhrases } from "./cloze.mjs";
import { stripSentenceEnd } from "./text.mjs";

const CLOZE_WORDS = Object.freeze({
  de: {
    one: "Ergänze die Lücke",
    many: "Ergänze die Lücken",
    rest: "in dem, was ich dir über mich gesagt habe:",
    open: "„",
    close: "“",
  },
  en: {
    one: "Fill in the gap",
    many: "Fill in the gaps",
    rest: "in what I told you about myself:",
    open: "“",
    close: "”",
  },
});

/**
 * The label a correct learner gives a fact class. They are the labels of the product's extraction
 * contract (`preference`, `identity`, `procedural`, `decision`), not its stored memory types: a
 * label the contract does not know, such as `semantic-fact`, is dropped before any guard runs.
 */
export const LEARNER_TYPE = Object.freeze({
  preference: "preference",
  role: "identity",
  "way-of-working": "procedural",
  decision: "decision",
});

/**
 * What the person says about a fact. A decision carries its reason as a clause of the same
 * sentence: "<seed without its full stop>, <reason>". The product stores only text that is a whole
 * sentence or line of the user's message, so the decision and its reason must be one sentence for a
 * correct learner to be able to extract both.
 */
export function factText(fact) {
  if (fact.reason === undefined) return fact.seed;
  return `${stripSentenceEnd(fact.seed)}, ${fact.reason}`;
}

/**
 * The sentence a fact is stated with: its whole statement or, told over two turns, the rule of its
 * split form, which names no subject (the lead of the first turn does).
 */
export function statementText(fact, split = false) {
  return split ? fact.split.rule : factText(fact);
}

/**
 * What the person says when a fact changes: the new statement (or, told over two turns, its rule),
 * and, for an edit, their correction of the earlier message in front of it. A correct learner
 * extracts only the statement, so a correction that names the old value never becomes part of the
 * truth.
 */
export function changeText(change, edit = false, split = false) {
  const statement = split ? change.split.rule : change.seed;
  return edit ? `${change.correction} ${statement}` : statement;
}

/**
 * The scenario-side truth of a blueprint. A changed fact is true in its new form and its old terms
 * become superseded; a forgotten fact leaves the truth list and its terms become forgotten; every
 * trap becomes forbidden content of its class.
 */
export function deriveOracle(blueprint) {
  const changes = new Map(blueprint.changes.map((change) => [change.key, change]));
  const forgottenKeys = new Set(blueprint.forgets.map((forget) => forget.key));
  const byKey = new Map(blueprint.facts.map((fact) => [fact.key, fact]));
  const truth = blueprint.facts
    .filter((fact) => !forgottenKeys.has(fact.key))
    .map((fact) => {
      const change = changes.get(fact.key);
      return {
        key: fact.key,
        seed: change === undefined ? factText(fact) : change.seed,
        must: fact.must,
        private: fact.private,
        terms: change === undefined ? fact.terms : change.terms,
      };
    });
  return {
    truth,
    superseded: blueprint.changes.map((change) => ({ terms: byKey.get(change.key).terms })),
    forgotten: blueprint.forgets.map((forget) => ({ terms: byKey.get(forget.key).terms })),
    forbidden: blueprint.traps.map((trap) => ({ class: trap.class, terms: trap.terms })),
  };
}

/** True when any alternative of any term group is still readable in `text`. */
export function anyTermVisible(text, groups) {
  const haystack = normalizeText(text);
  return groups.some((group) => group.some((term) => haystack.includes(normalizeText(term))));
}

/**
 * Compiles term groups into a predicate over already normalized text that agrees with the scorer's
 * `matchesTermGroups` on every text. The scorer decides: a cheap substring test, with the terms
 * normalized once, rules out the texts that cannot match (a whole-word match is also a substring
 * match), so the generator can test thousands of texts against every term set without asking the
 * scorer about the many that mention nothing. The corpus tests pin it to the scorer's own function.
 */
export function compileTermGroups(groups) {
  const normalized = groups.map((group) => group.map((term) => normalizeText(term)));
  return (haystack) =>
    normalized.every((group) => group.some((term) => haystack.includes(term))) &&
    matchesTermGroups(haystack, groups);
}

/**
 * A recall question made from the fact's own sentence with the value phrase blanked out (see
 * cloze.mjs: the answer terms, the small words that belong to them, never a single word), so it
 * shares the rest of the sentence and cannot be answered from the question. Returns undefined when a
 * term group does not occur literally or a term would stay visible.
 */
export function clozeQuestion(sentence, groups, language) {
  const blanked = blankValuePhrases(sentence, groups, language);
  if (blanked === undefined || anyTermVisible(blanked.text, groups)) return undefined;
  const words = CLOZE_WORDS[language];
  const lead = blanked.gaps > 1 ? words.many : words.one;
  return `${lead} ${words.rest} ${words.open}${blanked.text}${words.close}`;
}
