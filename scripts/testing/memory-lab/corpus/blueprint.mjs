// Blueprint format of the MemoriaViva corpus (#4208). A blueprint is a synthetic person with a fixed
// list of facts: what they prefer, how they work, what they decided and why, what changes over time,
// what they ask to be forgotten, and the traps a careful memory must not fall for. The truth comes
// first: the generator turns a blueprint into conversations of any length, and because the facts were
// fixed beforehand every conversation can be scored without anyone labelling it.
//
// Loading fails closed on any shape it does not know. Beyond shape, the validator proves the
// properties the scorer relies on: every sentence classifies as the scorer will judge it (correct,
// stale, forgotten-returned or forbidden), no probe question gives its answer away, and every value
// that looks like a credential or an identifier is one of the documented fake values (values.mjs).
import { scenarioDigest } from "../scenario.mjs";
import { SetFileError, isRecord, loadJsonSet, nonEmptyString } from "../set-files.mjs";
import { TERM_PREFIX_MARK, matchesTermGroups, scoreStore, validPrefixMark } from "../score.mjs";
import { anyTermVisible, clozeQuestion, deriveOracle, factText } from "./oracle.mjs";
import { opensWithMemoryCommand, sharedContentStems, stripSentenceEnd } from "./text.mjs";
import { shannonEntropy, valueShapeFindings, visitStrings } from "./values.mjs";

const BLUEPRINT_SCHEMA_VERSION = 1;
export const BLUEPRINT_LANGUAGES = Object.freeze(["de", "en"]);
export const FACT_CLASSES = Object.freeze(["preference", "role", "way-of-working", "decision"]);
export const TRAP_CLASSES = Object.freeze([
  "credential",
  "identifier",
  "third-party",
  "hypothetical",
  "quote",
  "question",
  "assistant-claim",
  "instruction",
]);
const LANGUAGE_SET = new Set(BLUEPRINT_LANGUAGES);
const FACT_CLASS_SET = new Set(FACT_CLASSES);
const TRAP_CLASS_SET = new Set(TRAP_CLASSES);
// These traps are probed on their own, so the question that probes them is part of the blueprint.
const QUESTION_REQUIRED = new Set(["credential", "identifier", "third-party", "instruction"]);
const IDENTIFIER_KINDS = new Set(["iban", "phone", "customer-id", "email"]);
const LIMITS = Object.freeze({
  facts: 40,
  changes: 20,
  forgets: 10,
  traps: 40,
  relational: 20,
  groups: 4,
  alternatives: 8,
});
const SLUG = /^[a-z0-9][a-z0-9-]{2,47}$/u;
const FACT_KEY = /^[a-z]+(?:-[a-z]+){0,5}$/u;
const ROLE = /^[a-z][a-z-]{2,31}$/u;
// Below the 3.5 bits per character at which secret scanners start to call a string a generated key.
const MAX_FAKE_KEY_ENTROPY = 3.2;
const SENTENCE_END = /[.!?]["”“)]?$/u;

export class BlueprintError extends SetFileError {
  constructor(id, message) {
    super("BlueprintError", id, message);
  }
}

function fail(id, message) {
  throw new BlueprintError(id, message);
}

function checkFields(id, where, record, required, optional = []) {
  if (!isRecord(record)) fail(id, `${where} must be an object`);
  for (const name of required)
    if (record[name] === undefined) fail(id, `${where}.${name} is required`);
  const known = new Set([...required, ...optional]);
  for (const name of Object.keys(record))
    if (!known.has(name)) fail(id, `${where}.${name} is not a known field`);
}

function checkArray(id, name, value, max) {
  if (!Array.isArray(value)) fail(id, `${name} must be an array`);
  if (value.length > max) fail(id, `${name} may hold at most ${String(max)} entries`);
}

function checkSentence(id, where, value, max = 280) {
  if (!nonEmptyString(value) || value.trim() !== value)
    fail(id, `${where} must be a trimmed, non-empty string`);
  if (value.length < 8 || value.length > max)
    fail(id, `${where} must be 8 to ${String(max)} characters`);
  if (/[\n\r]|\[\[|\]\]/u.test(value)) fail(id, `${where} must be one line without [[ or ]]`);
  if (!SENTENCE_END.test(value)) fail(id, `${where} must end with sentence punctuation`);
}

// A statement the product must be able to store whole: one sentence ending in a full stop or an
// exclamation mark, with no sentence break inside, because the product extracts only text that is a
// whole sentence or line of the person's message.
function checkStatement(id, where, value, max = 280) {
  checkSentence(id, where, value, max);
  if (!/[.!]["”“)]?$/u.test(value)) fail(id, `${where} must be a statement, not a question`);
  if (/[.!?]["”“)]?\s/u.test(value)) fail(id, `${where} must be one sentence`);
}

function checkQuestion(id, where, value) {
  checkSentence(id, where, value, 240);
  if (!value.endsWith("?")) fail(id, `${where} must be a question`);
}

function checkTermGroup(id, where, group) {
  if (!Array.isArray(group) || group.length === 0 || group.length > LIMITS.alternatives)
    fail(id, `${where} groups need 1 to ${String(LIMITS.alternatives)} alternatives`);
  for (const term of group) {
    if (!nonEmptyString(term) || term.length < 3 || term.length > 60)
      fail(id, `${where} terms must be 3 to 60 characters`);
    if (!validPrefixMark(term))
      fail(
        id,
        `${where} terms carry ${TERM_PREFIX_MARK} only at the end, after at least three characters`,
      );
  }
}

function checkTerms(id, where, groups) {
  if (!Array.isArray(groups) || groups.length === 0 || groups.length > LIMITS.groups)
    fail(id, `${where} must be 1 to ${String(LIMITS.groups)} term groups`);
  for (const group of groups) checkTermGroup(id, where, group);
}

function checkFactIdentity(id, where, fact) {
  if (typeof fact.key !== "string" || !FACT_KEY.test(fact.key))
    fail(id, `${where}.key must be lowercase words joined by hyphens`);
  if (!FACT_CLASS_SET.has(fact.class))
    fail(id, `${where}.class must be one of ${FACT_CLASSES.join("|")}`);
  if (typeof fact.must !== "boolean" || typeof fact.private !== "boolean")
    fail(id, `${where}.must and ${where}.private must be booleans`);
  if (fact.class !== "decision" && !fact.private)
    fail(id, `${where}: only a decision may be shared with the project (private: false)`);
  if (fact.reason !== undefined && fact.class !== "decision")
    fail(id, `${where}.reason is only for a decision`);
}

function checkFactText(id, where, language, fact) {
  checkStatement(id, `${where}.seed`, fact.seed);
  checkTerms(id, `${where}.terms`, fact.terms);
  if (!matchesTermGroups(fact.seed, fact.terms)) fail(id, `${where}.terms must match the seed`);
  if (fact.reason !== undefined) {
    checkStatement(id, `${where}.reason`, fact.reason, 240);
    if (!/^\p{Ll}/u.test(fact.reason))
      fail(id, `${where}.reason must be a clause that starts in lower case, such as "because ..."`);
  }
  if (clozeQuestion(fact.seed, fact.terms, language) === undefined)
    fail(id, `${where}: the seed must contain every term group literally, so it can be blanked`);
}

function checkApplyQuestion(id, where, fact) {
  checkQuestion(id, `${where}.applyQuestion`, fact.applyQuestion);
  if (anyTermVisible(fact.applyQuestion, fact.terms))
    fail(id, `${where}.applyQuestion must not contain the answer terms`);
  if (sharedContentStems(fact.applyQuestion, factText(fact)).length > 0)
    fail(id, `${where}.applyQuestion must share no content word with the seed`);
}

// A statement told over two turns: a lead that names the subject without any answer term, and the
// rule that follows, which holds every term and, for a decision, ends with its reason. A learner
// that sees the second turn alone stores the rule without its subject.
function checkSplit(id, where, split, { terms, whole, reason }) {
  checkFields(id, where, split, ["lead", "rule"]);
  checkStatement(id, `${where}.lead`, split.lead);
  checkStatement(id, `${where}.rule`, split.rule, 400);
  if (opensWithMemoryCommand(split.lead))
    fail(id, `${where}.lead must not open with a memory command`);
  if (anyTermVisible(split.lead, terms))
    fail(id, `${where}.lead must not contain the answer terms`);
  if (!matchesTermGroups(split.rule, terms)) fail(id, `${where}.rule must contain the terms`);
  if (split.rule === whole) fail(id, `${where}.rule must differ from the whole statement`);
  if (reason !== undefined && !split.rule.endsWith(reason))
    fail(id, `${where}.rule must end with the reason of the decision`);
}

// The optional parts of a fact: a direct recall question, which a probe prefers to the blanked
// sentence, and the split form of its statement.
function checkFactExtras(id, where, fact) {
  if (fact.recallQuestion !== undefined) {
    checkQuestion(id, `${where}.recallQuestion`, fact.recallQuestion);
    if (anyTermVisible(fact.recallQuestion, fact.terms))
      fail(id, `${where}.recallQuestion must not contain the answer terms`);
  }
  if (fact.split === undefined) return;
  const context = { terms: fact.terms, whole: factText(fact), reason: fact.reason };
  checkSplit(id, `${where}.split`, fact.split, context);
  if (sharedContentStems(fact.applyQuestion, fact.split.rule).length > 0)
    fail(id, `${where}.applyQuestion must share no content word with the split rule`);
}

function checkFact(id, language, fact, index) {
  const where = `facts[${String(index)}]`;
  const required = ["key", "class", "seed", "terms", "must", "private", "applyQuestion"];
  checkFields(id, where, fact, required, ["reason", "split", "recallQuestion"]);
  checkFactIdentity(id, where, fact);
  checkFactText(id, where, language, fact);
  checkApplyQuestion(id, where, fact);
  checkFactExtras(id, where, fact);
}

// What a person says when an earlier message of theirs was wrong. It states the new value, so a
// learner that stores it as it stands still holds the right fact; it may also name the old one.
function checkCorrection(id, where, change) {
  checkStatement(id, `${where}.correction`, change.correction);
  if (!matchesTermGroups(change.correction, change.terms))
    fail(id, `${where}.correction must contain the new terms`);
}

function checkChangeExtras(id, where, change) {
  if (change.correction !== undefined) checkCorrection(id, where, change);
  if (change.split !== undefined)
    checkSplit(id, `${where}.split`, change.split, { terms: change.terms, whole: change.seed });
}

function checkChange(id, language, change, index) {
  const where = `changes[${String(index)}]`;
  const optional = ["reversal", "correction", "split"];
  checkFields(id, where, change, ["key", "position", "seed", "terms"], optional);
  if (typeof change.position !== "number" || change.position < 0.2 || change.position > 0.9)
    fail(id, `${where}.position must be a number from 0.2 to 0.9`);
  if (change.reversal !== undefined && typeof change.reversal !== "boolean")
    fail(id, `${where}.reversal must be a boolean when present`);
  checkStatement(id, `${where}.seed`, change.seed);
  checkTerms(id, `${where}.terms`, change.terms);
  if (!matchesTermGroups(change.seed, change.terms))
    fail(id, `${where}.terms must match the new seed`);
  if (clozeQuestion(change.seed, change.terms, language) === undefined)
    fail(id, `${where}: the new seed must contain every term group literally`);
  checkChangeExtras(id, where, change);
}

function checkForget(id, forget, index) {
  const where = `forgets[${String(index)}]`;
  checkFields(id, where, forget, ["key", "position", "paraphrase"]);
  if (typeof forget.position !== "number" || forget.position < 0.2 || forget.position > 0.8)
    fail(id, `${where}.position must be a number from 0.2 to 0.8`);
  checkStatement(id, `${where}.paraphrase`, forget.paraphrase);
}

function checkTrap(id, trap, index) {
  const where = `traps[${String(index)}]`;
  checkFields(id, where, trap, ["class", "text", "terms"], ["question", "teaches"]);
  if (!TRAP_CLASS_SET.has(trap.class))
    fail(id, `${where}.class must be one of ${TRAP_CLASSES.join("|")}`);
  checkSentence(id, `${where}.text`, trap.text, 400);
  checkTerms(id, `${where}.terms`, trap.terms);
  if (!matchesTermGroups(trap.text, trap.terms)) fail(id, `${where}.terms must match the text`);
  if (trap.question === undefined && QUESTION_REQUIRED.has(trap.class))
    fail(id, `${where}.question is required for a ${trap.class} trap`);
  if (trap.question !== undefined) checkQuestion(id, `${where}.question`, trap.question);
  if (trap.teaches !== undefined && trap.class !== "third-party")
    fail(id, `${where}.teaches is only for a third-party trap`);
}

function checkRelational(id, entry, index) {
  const where = `relational[${String(index)}]`;
  checkFields(id, where, entry, ["question", "terms"]);
  checkQuestion(id, `${where}.question`, entry.question);
  checkTerms(id, `${where}.terms`, entry.terms);
}

function checkHeader(blueprint) {
  const id = nonEmptyString(blueprint?.id) ? blueprint.id : "<unnamed>";
  checkFields(id, "blueprint", blueprint, [
    "schemaVersion",
    "id",
    "language",
    "role",
    "styleNotes",
    "facts",
    "changes",
    "forgets",
    "traps",
    "relational",
  ]);
  if (blueprint.schemaVersion !== BLUEPRINT_SCHEMA_VERSION)
    fail(id, `schemaVersion must be ${String(BLUEPRINT_SCHEMA_VERSION)}`);
  if (!SLUG.test(blueprint.id)) fail(id, "id must be a lowercase slug of 3 to 48 characters");
  if (!LANGUAGE_SET.has(blueprint.language))
    fail(id, `language must be one of ${BLUEPRINT_LANGUAGES.join("|")}`);
  if (typeof blueprint.role !== "string" || !ROLE.test(blueprint.role))
    fail(id, "role must be a lowercase slug such as bank-clerk");
  if (!nonEmptyString(blueprint.styleNotes) || blueprint.styleNotes.length > 400)
    fail(id, "styleNotes must be a non-empty string of at most 400 characters");
  return id;
}

function checkCollections(id, blueprint) {
  checkArray(id, "facts", blueprint.facts, LIMITS.facts);
  checkArray(id, "changes", blueprint.changes, LIMITS.changes);
  checkArray(id, "forgets", blueprint.forgets, LIMITS.forgets);
  checkArray(id, "traps", blueprint.traps, LIMITS.traps);
  checkArray(id, "relational", blueprint.relational, LIMITS.relational);
  if (blueprint.facts.length === 0) fail(id, "facts must not be empty");
}

function duplicateOf(values) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

// "ich bevorzuge X." inside a longer sentence: the first letter and the final punctuation may differ.
function containsLoosely(text, sentence) {
  const core = stripSentenceEnd(sentence);
  const lowered = core.charAt(0).toLowerCase() + core.slice(1);
  return text.includes(core) || text.includes(lowered);
}

function checkKeyList(id, name, keys, byKey) {
  const unknown = keys.find((key) => !byKey.has(key));
  if (unknown !== undefined) fail(id, `${name} refers to unknown fact ${unknown}`);
  const duplicate = duplicateOf(keys);
  if (duplicate !== undefined) fail(id, `${name} holds fact ${duplicate} more than once`);
}

function checkChains(id, blueprint, byKey) {
  const changed = blueprint.changes.map((change) => change.key);
  const forgotten = blueprint.forgets.map((forget) => forget.key);
  checkKeyList(id, "changes", changed, byKey);
  checkKeyList(id, "forgets", forgotten, byKey);
  const forgottenKeys = new Set(forgotten);
  const both = changed.find((key) => forgottenKeys.has(key));
  if (both !== undefined) fail(id, `fact ${both} is both changed and forgotten`);
  for (const forget of blueprint.forgets) {
    const fact = byKey.get(forget.key);
    if (!matchesTermGroups(forget.paraphrase, fact.terms))
      fail(id, `forgets ${forget.key}: the paraphrase must match the fact's terms`);
    if (forget.paraphrase.includes(fact.seed))
      fail(id, `forgets ${forget.key}: the paraphrase must not repeat the seed`);
  }
  for (const change of blueprint.changes) checkChangeWording(id, change, byKey.get(change.key));
}

// The apply question is asked after the change, so it may share no word with what the person says
// about the change: the new seed and, when there is one, the correction.
function checkChangeWording(id, change, fact) {
  // A new seed that repeats a term of the old one could not be told apart from it by a probe.
  if (anyTermVisible(change.seed, fact.terms))
    fail(id, `changes ${change.key}: the new seed must not contain a term of the old one`);
  const spoken = [change.seed, change.correction, change.split?.rule].filter(
    (text) => text !== undefined,
  );
  if (spoken.some((text) => sharedContentStems(fact.applyQuestion, text).length > 0))
    fail(id, `changes ${change.key}: the apply question must share no word with what is said`);
  if (change.split !== undefined && anyTermVisible(change.split.rule, fact.terms))
    fail(id, `changes ${change.key}: the split rule must not contain a term of the old seed`);
  // The recall question is asked after the change as well, so it may not hold the new answer either.
  if (fact.recallQuestion !== undefined && anyTermVisible(fact.recallQuestion, change.terms))
    fail(id, `changes ${change.key}: the recall question must not contain the new terms`);
}

function checkTaught(id, blueprint, byKey) {
  const taught = blueprint.traps.filter((trap) => trap.teaches !== undefined);
  const duplicate = duplicateOf(taught.map((trap) => trap.teaches));
  if (duplicate !== undefined) fail(id, `fact ${duplicate} is taught by more than one trap`);
  const chained = new Set([...blueprint.changes, ...blueprint.forgets].map((entry) => entry.key));
  for (const trap of taught) {
    const fact = byKey.get(trap.teaches);
    if (fact === undefined) fail(id, `a trap teaches unknown fact ${trap.teaches}`);
    if (chained.has(fact.key))
      fail(id, `fact ${fact.key} is taught by a trap and cannot change or be forgotten`);
    if (!containsLoosely(trap.text, fact.seed))
      fail(id, `the trap that teaches ${fact.key} must contain the seed sentence`);
  }
}

function checkRelationalAnswers(id, blueprint) {
  const reasons = blueprint.facts.filter((fact) => fact.reason !== undefined);
  for (const [index, entry] of blueprint.relational.entries()) {
    const answerable = reasons.some((fact) => matchesTermGroups(fact.reason, entry.terms));
    if (!answerable)
      fail(id, `relational[${String(index)}].terms must match the reason of a decision`);
  }
}

function checkReferences(id, blueprint) {
  const duplicate = duplicateOf(blueprint.facts.map((fact) => fact.key));
  if (duplicate !== undefined) fail(id, `fact key ${duplicate} is used twice`);
  const byKey = new Map(blueprint.facts.map((fact) => [fact.key, fact]));
  checkChains(id, blueprint, byKey);
  checkTaught(id, blueprint, byKey);
  checkRelationalAnswers(id, blueprint);
}

// What a credential or identifier trap must hold, and what no other trap may hold.
function checkTrapValueKinds(id, where, trap, kinds) {
  const expectsValue = trap.class === "credential" || trap.class === "identifier";
  if (trap.class === "credential" && !kinds.has("api-key"))
    fail(id, `${where}: a credential trap must contain a fake API key`);
  if (trap.class === "identifier" && ![...kinds].some((kind) => IDENTIFIER_KINDS.has(kind)))
    fail(id, `${where}: an identifier trap must contain a fake IBAN, phone, customer id or e-mail`);
  if (!expectsValue && kinds.size > 0)
    fail(id, `${where}: only a credential or identifier trap may hold a fake value`);
}

function checkTrapValues(id, trap, where) {
  const findings = valueShapeFindings(trap.text);
  const rejected = findings.find((finding) => !finding.allowed);
  if (rejected !== undefined)
    fail(id, `${where} holds a ${rejected.kind} outside the fake-value grammar`);
  const key = findings.find((finding) => finding.kind === "api-key");
  if (key !== undefined && shannonEntropy(key.value) >= MAX_FAKE_KEY_ENTROPY)
    fail(id, `${where}: the fake key must be repetitive enough for secret scanners to accept it`);
  checkTrapValueKinds(id, where, trap, new Set(findings.map((finding) => finding.kind)));
}

function checkValueGrammar(id, blueprint) {
  for (const [index, trap] of blueprint.traps.entries())
    checkTrapValues(id, trap, `traps[${String(index)}]`);
  visitStrings({ ...blueprint, traps: [] }, (text) => {
    if (valueShapeFindings(text).length > 0)
      fail(id, "a value-shaped string appears outside a trap; only traps may hold fake values");
  });
}

// The scorer judges a stored memory against a scenario; the oracle of a blueprint has no turns yet.
function verdictOf(oracle, body) {
  const memory = { id: "probe", status: "accepted", body, scope: { kind: "user" } };
  return scoreStore([memory], { turns: [], ...oracle }).verdicts[0];
}

// A split rule is stored without its subject and is judged as the whole statement it replaces.
function ruleVerdict(blueprint, fact) {
  if (blueprint.forgets.some((forget) => forget.key === fact.key))
    return { verdict: "forgotten-returned" };
  if (blueprint.changes.some((change) => change.key === fact.key)) return { verdict: "stale" };
  return { verdict: "correct", key: fact.key };
}

function splitExpectations(blueprint) {
  return [
    ...blueprint.facts
      .filter((fact) => fact.split !== undefined)
      .map((fact) => ({ text: fact.split.rule, ...ruleVerdict(blueprint, fact) })),
    ...blueprint.changes
      .filter((change) => change.split !== undefined)
      .map((change) => ({ text: change.split.rule, verdict: "correct", key: change.key })),
  ];
}

function classificationExpectations(blueprint, oracle) {
  const byKey = new Map(blueprint.facts.map((fact) => [fact.key, fact]));
  return [
    ...splitExpectations(blueprint),
    ...oracle.truth.map((fact) => ({ text: fact.seed, verdict: "correct", key: fact.key })),
    ...blueprint.changes.map((change) => ({
      text: factText(byKey.get(change.key)),
      verdict: "stale",
    })),
    ...blueprint.changes
      .filter((change) => change.correction !== undefined)
      .map((change) => ({ text: change.correction, verdict: "correct", key: change.key })),
    ...blueprint.forgets.flatMap((forget) => [
      { text: factText(byKey.get(forget.key)), verdict: "forgotten-returned" },
      { text: forget.paraphrase, verdict: "forgotten-returned" },
    ]),
    ...blueprint.traps.map((trap) => ({
      text: trap.text,
      verdict: "forbidden",
      class: trap.class,
    })),
  ];
}

function classifiesAsExpected(expected, actual) {
  if (actual.verdict !== expected.verdict) return false;
  if (expected.class !== undefined && actual.class !== expected.class) return false;
  return expected.key === undefined || actual.key === expected.key;
}

// The scorer judges a stored memory by term matching alone. Every sentence the person says must
// classify the way the blueprint intends, with the scorer's own code, or the corpus would measure
// the blueprint's wording instead of the product.
function checkClassification(id, blueprint) {
  const oracle = deriveOracle(blueprint);
  for (const expected of classificationExpectations(blueprint, oracle)) {
    const actual = verdictOf(oracle, expected.text);
    if (!classifiesAsExpected(expected, actual)) {
      const named = (entry) =>
        [entry.verdict, entry.key ?? entry.class].filter((part) => part !== undefined).join(" ");
      fail(id, `a sentence classifies as (${named(actual)}), expected (${named(expected)})`);
    }
  }
  const facts = [...oracle.truth, ...oracle.superseded, ...oracle.forgotten];
  for (const trap of blueprint.traps) {
    if (
      trap.teaches === undefined &&
      facts.some((fact) => matchesTermGroups(trap.text, fact.terms))
    )
      fail(id, "a trap text restates a fact; only a trap that teaches a fact may do so");
  }
}

// The lead of a split statement names the subject and nothing else, so it may state no fact, no
// replaced value and no trap of the blueprint.
function checkSplitLeads(id, blueprint) {
  const oracle = deriveOracle(blueprint);
  const entries = [...oracle.truth, ...oracle.superseded, ...oracle.forgotten, ...oracle.forbidden];
  const leads = [...blueprint.facts, ...blueprint.changes]
    .filter((owner) => owner.split !== undefined)
    .map((owner) => owner.split.lead);
  if (leads.some((lead) => entries.some((entry) => matchesTermGroups(lead, entry.terms))))
    fail(id, "a split lead states a fact, a replaced value or a trap");
}

// A model writer is sent the style notes, so they may describe how the person writes and nothing else.
function checkStyleNotes(id, blueprint) {
  const oracle = deriveOracle(blueprint);
  const entries = [...oracle.truth, ...oracle.superseded, ...oracle.forgotten, ...oracle.forbidden];
  if (entries.some((entry) => matchesTermGroups(blueprint.styleNotes, entry.terms)))
    fail(id, "styleNotes must not state a fact or a trap, because a writer receives them");
}

function checkTrapQuestions(id, blueprint) {
  const sentences = [
    ...blueprint.facts.flatMap((fact) => [factText(fact), fact.split?.rule]),
    ...blueprint.changes.flatMap((change) => [change.seed, change.correction, change.split?.rule]),
  ].filter((text) => text !== undefined);
  for (const [index, trap] of blueprint.traps.entries()) {
    if (trap.question === undefined) continue;
    const clash = sentences.find((text) => sharedContentStems(trap.question, text).length > 0);
    if (clash !== undefined)
      fail(id, `traps[${String(index)}].question shares a content word with a fact`);
  }
}

function deepFreeze(value) {
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

/** Validates one blueprint object and returns a deep-frozen copy; throws BlueprintError on any defect. */
export function validateBlueprint(blueprint) {
  const id = checkHeader(blueprint);
  checkCollections(id, blueprint);
  blueprint.facts.forEach((fact, index) => checkFact(id, blueprint.language, fact, index));
  blueprint.changes.forEach((change, index) => checkChange(id, blueprint.language, change, index));
  blueprint.forgets.forEach((forget, index) => checkForget(id, forget, index));
  blueprint.traps.forEach((trap, index) => checkTrap(id, trap, index));
  blueprint.relational.forEach((entry, index) => checkRelational(id, entry, index));
  checkReferences(id, blueprint);
  checkValueGrammar(id, blueprint);
  checkClassification(id, blueprint);
  checkSplitLeads(id, blueprint);
  checkStyleNotes(id, blueprint);
  checkTrapQuestions(id, blueprint);
  return deepFreeze(structuredClone(blueprint));
}

/** Stable content digest of a blueprint: the canonical digest the scenario format uses. */
export function blueprintDigest(blueprint) {
  return scenarioDigest(blueprint);
}

/** Loads every `*.json` blueprint of a directory, sorted by id, refusing duplicate ids. */
export function loadBlueprintDirectory(directory) {
  return loadJsonSet(directory, { validate: validateBlueprint, fail, what: "blueprint" });
}
