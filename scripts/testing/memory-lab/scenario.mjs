// Scenario format of the MemoriaViva measurement lab (#4207). A scenario fixes the truth before any
// conversation exists: the facts a correct memory holds afterwards, the facts it must not hold, the
// turns a person writes, and the questions a later chat asks. The oracle never reaches the product;
// the driver sends only the turns and the questions. Loading fails closed on any shape it does not
// know, so a malformed fixture cannot silently measure nothing.
import { createHash } from "node:crypto";
import { literalStem, matchesTermGroups, validPrefixMark } from "./score.mjs";
import { KEY_PATTERN, validateSeed } from "./seed-validate.mjs";
import { SetFileError, isRecord, loadJsonSet, nonEmptyString } from "./set-files.mjs";
import { compareStrings } from "../../lib/compare-strings.mjs";

const SCENARIO_SCHEMA_VERSION = 1;
const SCENARIO_LANGUAGES = Object.freeze(["de", "en", "mixed"]);
export const SCENARIO_CLASSES = Object.freeze([
  "preference",
  "role",
  "way-of-working",
  "decision",
  "project-decision",
  "update",
  "reversal",
  "forget",
  "forget-paraphrase",
  "forget-not",
  "multi-turn",
  "third-party",
  "operator-in-third-party",
  "credential",
  "identifier",
  "hypothetical",
  "irony",
  "contradiction",
  "quote",
  "question",
  "assistant-claim",
  "instruction-smuggling",
  "memory-injection",
  "edit-after-learn",
  "entrenchment",
  "unrelated",
  "anchor-real",
  "anchor-benchmark",
  "long-horizon",
  "paraphrase",
  "scale-window",
  "two-memories",
  "earlier-value",
  "near-miss",
]);
const SCENARIO_DIFFICULTIES = Object.freeze(["plain", "embedded", "split", "noisy"]);
const FORBIDDEN_CLASSES = Object.freeze([
  "credential",
  "identifier",
  "third-party",
  "hypothetical",
  "irony",
  "contradiction",
  "quote",
  "question",
  "assistant-claim",
  "instruction",
  "other",
]);
const PROBE_KINDS = Object.freeze(["answer", "abstain", "no-memory", "not-obeyed"]);
// Every key an `expect` may carry. Any other is a typo that would silently drop a requirement.
const EXPECT_KEYS = Object.freeze([
  "kind",
  "terms",
  "forbidden",
  "needs",
  "earlier",
  "allow",
  "format",
  "forbiddenFormat",
]);
const ANSWER_FORMATS = Object.freeze(["table", "list"]);
const PROBE_LANGUAGES = Object.freeze(["de", "en"]);

class ScenarioError extends SetFileError {
  constructor(id, message) {
    super("ScenarioError", id, message);
  }
}

function fail(id, message) {
  throw new ScenarioError(id, message);
}

// A term group is a list of alternative spellings; one alternative present means the group matched.
// An alternative may end in the prefix mark (`Tabelle*`), which matches at a word start.
function validTermGroups(groups) {
  return (
    Array.isArray(groups) &&
    groups.length > 0 &&
    groups.every(
      (group) =>
        Array.isArray(group) &&
        group.length > 0 &&
        group.every((term) => nonEmptyString(term) && validPrefixMark(term)),
    )
  );
}

// Walks a list whose entries are objects with a unique, non-empty name: refuses the first entry that
// is no object, has no name or repeats one, and hands every other entry to `check`.
function eachUniquelyNamed(id, list, { label, nameField, duplicate }, check) {
  const seen = new Set();
  list.forEach((entry, index) => {
    const where = `${label}[${String(index)}]`;
    if (!isRecord(entry)) fail(id, `${where} must be an object`);
    const name = entry[nameField];
    if (!nonEmptyString(name)) fail(id, `${where}.${nameField} is required`);
    if (seen.has(name)) fail(id, duplicate(where, name));
    seen.add(name);
    check(entry, where);
  });
}

// Keys name the facts a probe needs, a link and a verdict point at: two facts with one key would
// collapse into the first, and an answer carrying only its term would pass `needs`.
const TRUTH_NAMES = {
  label: "truth",
  nameField: "key",
  duplicate: (where, key) => `${where}.key "${key}" duplicates an earlier truth`,
};
const PROBE_NAMES = {
  label: "probes",
  nameField: "id",
  duplicate: (where, probeId) => `${where}.id duplicates ${probeId}`,
};

function validateTruth(id, truth) {
  if (!Array.isArray(truth)) fail(id, "truth must be an array");
  eachUniquelyNamed(id, truth, TRUTH_NAMES, (fact, where) => {
    if (!nonEmptyString(fact.seed))
      fail(id, `${where}.seed (exact body for the oracle) is required`);
    if (typeof fact.must !== "boolean") fail(id, `${where}.must must be a boolean`);
    if (!validTermGroups(fact.terms)) fail(id, `${where}.terms must be non-empty term groups`);
    validateTruthOptions(id, where, fact);
  });
}

// The optional fields of a truth: `private`, and `with` (term groups that must occur in the same
// sentence or list item as the terms, for a probe that needs the truth).
function validateTruthOptions(id, where, fact) {
  if (fact.private !== undefined && typeof fact.private !== "boolean")
    fail(id, `${where}.private must be a boolean when present`);
  if (fact.with !== undefined && !validTermGroups(fact.with))
    fail(id, `${where}.with must be non-empty term groups when present`);
  if (fact.with !== undefined && impliesGroups(fact.terms, fact.with))
    fail(id, `${where}.with is carried by its own terms, so it binds nothing`);
}

// A true term that occurs inside a replaced value cannot tell the old body from the new one: every
// old body would match the true terms too, and a swallowed update would look learned.
function validateTruthApartFromReplaced(id, truth, superseded) {
  truth.forEach((fact, factIndex) =>
    fact.terms.flat().forEach((term) => {
      const replaced = (superseded ?? [])
        .flatMap((entry) => entry.terms.flat())
        .find((old) => matchesTermGroups(old, [[term]]));
      if (replaced !== undefined)
        fail(
          id,
          `truth[${String(factIndex)}].terms "${term}" occurs inside the replaced value "${replaced}"`,
        );
    }),
  );
}

function validateTermList(id, list, name, withClass) {
  if (list === undefined) return;
  if (!Array.isArray(list)) fail(id, `${name} must be an array`);
  list.forEach((entry, index) => {
    const where = `${name}[${String(index)}]`;
    if (!isRecord(entry)) fail(id, `${where} must be an object`);
    if (!validTermGroups(entry.terms)) fail(id, `${where}.terms must be non-empty term groups`);
    if (withClass && !FORBIDDEN_CLASSES.includes(entry.class))
      fail(id, `${where}.class must be one of ${FORBIDDEN_CLASSES.join("|")}`);
  });
}

// A replaced value may carry a key so that a probe can ask for it (`expect.earlier`): "what did I
// prefer before?". The key is optional, a slug, and unique among the replaced values.
function validateSupersededKeys(id, superseded) {
  const seen = new Set();
  (superseded ?? []).forEach((entry, index) => {
    if (entry.key === undefined) return;
    if (!nonEmptyString(entry.key) || !KEY_PATTERN.test(entry.key))
      fail(id, `superseded[${String(index)}].key must be a lowercase slug when present`);
    if (seen.has(entry.key)) fail(id, `superseded[${String(index)}].key duplicates ${entry.key}`);
    seen.add(entry.key);
  });
}

function termsOverlap(left, right) {
  return (
    matchesTermGroups(literalStem(left), [[right]]) ||
    matchesTermGroups(literalStem(right), [[left]])
  );
}

// The text and the terms that state a current value: a truth's seed and terms, the body of a seeded
// record linked to a truth, and the probe's own terms.
function currentValueEvidence(scenario, probe) {
  const linked = (scenario.seed?.records ?? []).filter((record) => record.truth !== undefined);
  return {
    texts: [...scenario.truth.map((fact) => fact.seed), ...linked.map((record) => record.body)],
    terms: [...scenario.truth, { terms: probe.expect.terms ?? [] }].flatMap((entry) =>
      entry.terms.flat(),
    ),
  };
}

// An `earlier` probe must be failed by an answer that gives only the current value: no replaced term
// may occur in a current-value text, nor overlap (either way, `*` stems included) a current term.
function currentValueHit(old, { texts, terms }) {
  return (
    texts.find((text) => matchesTermGroups(text, [[old]])) ??
    terms.find((term) => termsOverlap(term, old))
  );
}

function validateEarlierApart(id, scenario) {
  for (const probe of scenario.probes ?? []) {
    if (!Array.isArray(probe.expect?.earlier)) continue;
    const evidence = currentValueEvidence(scenario, probe);
    const replaced = (scenario.superseded ?? []).filter((entry) =>
      probe.expect.earlier.includes(entry.key),
    );
    for (const old of replaced.flatMap((entry) => entry.terms.flat())) {
      const hit = currentValueHit(old, evidence);
      if (hit !== undefined)
        fail(
          id,
          `probe ${probe.id}: replaced term "${old}" also occurs in the current value "${hit}"`,
        );
    }
  }
}

// The term groups an answer probe wants, labelled: its own terms, the terms of each truth it needs and
// of each replaced value it asks for.
function wantedTermLists(scenario, probe) {
  const { expect } = probe;
  const named = (list, keys, label) =>
    (keys ?? []).map((key) => ({
      label: `${label} "${key}"`,
      groups: list.find((entry) => entry.key === key).terms,
    }));
  return [
    ...(expect.terms === undefined ? [] : [{ label: "terms", groups: expect.terms }]),
    ...named(scenario.truth, expect.needs, "needs"),
    ...named(scenario.superseded ?? [], expect.earlier, "earlier"),
  ];
}

// True when an answer that carries the `wanted` groups carries every `listed` group as well: each
// listed group has an alternative inside every term of some wanted group (a term "Liste*" contains
// "Liste", so the wanted group implies the listed one). Over-reports when a prefix term stands for
// more than its stem, which only refuses a scenario, never passes a contradictory one.
function impliesGroups(wanted, listed) {
  const implies = (term, alternative) => matchesTermGroups(literalStem(term), [[alternative]]);
  return listed.every((group) =>
    wanted.some((cut) =>
      cut.every((term) => group.some((alternative) => implies(term, alternative))),
    ),
  );
}

// The term groups a probe may not both want and forbid: its own `forbidden`, and the scenario's
// forgotten and forbidden facts, which no answer may carry whatever the question asked for.
function listedTermLists(scenario, probe) {
  return [
    ...(probe.expect.forbidden === undefined
      ? []
      : [{ label: "the probe's own forbidden terms", groups: probe.expect.forbidden }]),
    ...(scenario.forgotten ?? []).map((entry, index) => ({
      label: `forgotten[${String(index)}]`,
      groups: entry.terms,
    })),
    ...(scenario.forbidden ?? []).map((entry, index) => ({
      label: `forbidden[${String(index)}]`,
      groups: entry.terms,
    })),
  ];
}

// A wanted term the probe's own question already contains is passed by an answer that repeats the
// question (the scorer folds diacritics, so "Fähre" is "fahre" and occurs in "Womit fahre ich"); one
// that a forbidden or forgotten term contains can only fail once a memory is supplied, which reverses
// the signal: memory off passes, memory on fails.
function validateWantedTerms(id, scenario) {
  for (const probe of scenario.probes) {
    if (probe.expect.kind !== "answer") continue;
    const listed = listedTermLists(scenario, probe);
    const wanted = wantedTermLists(scenario, probe);
    for (const { label, groups } of wanted) {
      const asked = groups.flat().find((term) => matchesTermGroups(probe.question, [[term]]));
      if (asked !== undefined)
        fail(id, `probe ${probe.id}: ${label} term "${asked}" occurs in the probe's own question`);
      const contradicted = listed.find((entry) => impliesGroups(groups, entry.groups));
      if (contradicted !== undefined)
        fail(id, `probe ${probe.id}: ${label} is also ${contradicted.label}`);
    }
    // A complete answer carries every wanted list at once, so together they may not imply a
    // prohibition that none of them implies alone.
    const together = wanted.flatMap((entry) => entry.groups);
    const jointly = listed.find((entry) => impliesGroups(together, entry.groups));
    if (wanted.length > 1 && jointly !== undefined)
      fail(id, `probe ${probe.id}: its wanted terms together are ${jointly.label}`);
  }
}

// A truth's `with` binds the terms to a subject that tells it from the other facts of the probe. One
// that names another needed truth's subject or value binds nothing: the other fact's sentence would
// carry this one as well.
function validateBindingsApart(id, scenario) {
  for (const probe of scenario.probes) {
    const needed = (probe.expect.needs ?? []).map((key) =>
      scenario.truth.find((entry) => entry.key === key),
    );
    for (const fact of needed.filter((entry) => entry.with !== undefined))
      for (const other of needed.filter((entry) => entry !== fact)) {
        const theirs = [...(other.with ?? []), ...other.terms].flat();
        const named = fact.with.flat().find((mine) => theirs.some((it) => termsOverlap(mine, it)));
        if (named !== undefined)
          fail(
            id,
            `probe ${probe.id}: truth "${fact.key}" with "${named}" names the subject or value of truth "${other.key}"`,
          );
      }
  }
}

function validateLearnerItems(id, where, items) {
  if (items === undefined) return;
  if (!Array.isArray(items)) fail(id, `${where}.learner must be an array`);
  items.forEach((item, index) => {
    if (!isRecord(item) || !nonEmptyString(item.body) || !nonEmptyString(item.type))
      fail(id, `${where}.learner[${String(index)}] needs body and type`);
  });
}

// A scenario with a seeded store may have nothing to say before its questions: the history is the
// seed, so its turns may be empty. Without a seed a scenario with no turn measures nothing.
function validateTurns(id, turns, seeded) {
  if (!Array.isArray(turns) || (turns.length === 0 && !seeded))
    fail(id, "turns must be a non-empty array");
  turns.forEach((turn, index) => {
    const where = `turns[${String(index)}]`;
    if (!isRecord(turn)) fail(id, `${where} must be an object`);
    if (!nonEmptyString(turn.user)) fail(id, `${where}.user is required`);
    if (turn.assistant !== undefined && !nonEmptyString(turn.assistant))
      fail(id, `${where}.assistant must be a non-empty string when present`);
    if (turn.memory !== undefined && typeof turn.memory !== "boolean")
      fail(id, `${where}.memory must be a boolean when present`);
    if (turn.requireStoredBefore !== undefined && !validTermGroups(turn.requireStoredBefore))
      fail(id, `${where}.requireStoredBefore must be non-empty term groups`);
    validateLearnerItems(id, where, turn.learner);
  });
}

// `allow` names true facts (by key) that an abstain or no-memory probe tolerates in the answer and in
// the supplied memories: the person's own fact, asked for a colleague's.
function validateAllowance(id, where, expect, truthKeys) {
  if (expect.allow === undefined) return;
  if (expect.kind === "answer" || expect.kind === "not-obeyed")
    fail(id, `${where}.expect.allow is only measured on an abstain or no-memory probe`);
  if (!Array.isArray(expect.allow) || expect.allow.length === 0)
    fail(id, `${where}.expect.allow must be a non-empty array of truth keys`);
  for (const key of expect.allow)
    if (!truthKeys.has(key)) fail(id, `${where}.expect.allow names no truth key: ${String(key)}`);
}

// A preference for a form shows in the form of the answer, whether or not the answer names it.
function validateFormats(id, where, expect) {
  for (const field of ["format", "forbiddenFormat"]) {
    if (expect[field] === undefined) continue;
    if (expect.kind !== "answer")
      fail(id, `${where}.expect.${field} is only measured on an answer probe`);
    if (!ANSWER_FORMATS.includes(expect[field]))
      fail(id, `${where}.expect.${field} must be one of ${ANSWER_FORMATS.join("|")}`);
  }
}

// `needs` names the truths an answer must carry all of (a question about two memories); `earlier`
// names the replaced values it must carry (a question about what held before). Both belong to an
// answer probe and name keys that exist, once each.
function validateWanted(id, where, expect, wantedKeys) {
  for (const [field, keys] of Object.entries(wantedKeys)) {
    if (expect[field] === undefined) continue;
    if (expect.kind !== "answer")
      fail(id, `${where}.expect.${field} is only measured on an answer probe`);
    if (!Array.isArray(expect[field]) || expect[field].length === 0)
      fail(id, `${where}.expect.${field} must be a non-empty array of keys`);
    if (new Set(expect[field]).size !== expect[field].length)
      fail(id, `${where}.expect.${field} names a key twice`);
    for (const key of expect[field])
      if (!keys.has(key)) fail(id, `${where}.expect.${field} names no such key: ${String(key)}`);
  }
}

function validateAnswerTerms(id, where, expect) {
  const named = expect.needs !== undefined || expect.earlier !== undefined;
  if (named && expect.format !== undefined)
    fail(
      id,
      `${where}.expect.format cannot be combined with needs or earlier: a form proves no fact`,
    );
  if (expect.kind === "answer" && named && expect.terms === undefined) return;
  if ((expect.kind === "answer" || expect.kind === "not-obeyed") && !validTermGroups(expect.terms))
    fail(id, `${where}.expect.terms must be non-empty term groups for a ${expect.kind} probe`);
}

function validateExpectation(id, where, expect, keys) {
  if (!isRecord(expect) || !PROBE_KINDS.includes(expect.kind))
    fail(id, `${where}.expect.kind must be one of ${PROBE_KINDS.join("|")}`);
  for (const key of Object.keys(expect))
    if (!EXPECT_KEYS.includes(key))
      fail(id, `${where}.expect.${key} is not a key of expect (${EXPECT_KEYS.join("|")})`);
  validateAnswerTerms(id, where, expect);
  validateWanted(id, where, expect, { needs: keys.truth, earlier: keys.superseded });
  if (expect.forbidden !== undefined && expect.kind !== "answer" && expect.kind !== "abstain")
    fail(id, `${where}.expect.forbidden is only measured on an answer or abstain probe`);
  if (expect.forbidden !== undefined && !validTermGroups(expect.forbidden))
    fail(id, `${where}.expect.forbidden must be term groups when present`);
  validateFormats(id, where, expect);
  validateAllowance(id, where, expect, keys.truth);
}

// Memories already in the store when the conversation starts, each carrying an instruction: the lab
// seeds them in every arm that has memory and leaves them out of the store's score, because they
// test what the answer does with a poisoned memory, not what the learner stored.
function validatePoison(id, poison) {
  if (poison === undefined) return;
  if (!Array.isArray(poison) || poison.length === 0)
    fail(id, "poison must be a non-empty array when present");
  poison.forEach((entry, index) => {
    const where = `poison[${String(index)}]`;
    if (!isRecord(entry) || !nonEmptyString(entry.body)) fail(id, `${where}.body is required`);
    if (!validTermGroups(entry.terms)) fail(id, `${where}.terms must be non-empty term groups`);
    if (!matchesTermGroups(entry.body, entry.terms)) fail(id, `${where}.terms must match its body`);
  });
}

function validateProbes(id, probes, keys) {
  if (!Array.isArray(probes) || probes.length === 0) fail(id, "probes must be a non-empty array");
  eachUniquelyNamed(id, probes, PROBE_NAMES, (probe, where) => {
    if (!nonEmptyString(probe.question)) fail(id, `${where}.question is required`);
    if (probe.language !== undefined && !PROBE_LANGUAGES.includes(probe.language))
      fail(id, `${where}.language must be one of ${PROBE_LANGUAGES.join("|")} when present`);
    validateExpectation(id, where, probe.expect, keys);
  });
}

// A not-obeyed probe measures a poisoned memory, so it needs one that carries its marker: without it
// the probe would pass as a resisted injection although nothing was there to resist.
function validatePoisonProbes(id, poison, probes) {
  for (const probe of probes) {
    if (probe.expect.kind !== "not-obeyed") continue;
    if (poison === undefined)
      fail(id, `probe ${probe.id}: a not-obeyed probe needs a poison section`);
    if (!poison.some((entry) => matchesTermGroups(entry.body, probe.expect.terms)))
      fail(id, `probe ${probe.id}: expect.terms match no poison body`);
  }
}

function validateHeader(scenario) {
  if (!isRecord(scenario)) fail("<unnamed>", "scenario must be an object");
  const id = nonEmptyString(scenario.id) ? scenario.id : "<unnamed>";
  if (scenario.schemaVersion !== SCENARIO_SCHEMA_VERSION)
    fail(id, `schemaVersion must be ${String(SCENARIO_SCHEMA_VERSION)}`);
  if (!nonEmptyString(scenario.id) || !/^[a-z0-9][a-z0-9-]{2,63}$/u.test(scenario.id))
    fail(id, "id must be a lowercase slug of 3 to 64 characters");
  if (!SCENARIO_LANGUAGES.includes(scenario.language))
    fail(id, `language must be one of ${SCENARIO_LANGUAGES.join("|")}`);
  if (!SCENARIO_CLASSES.includes(scenario.class))
    fail(id, `class must be one of ${SCENARIO_CLASSES.join("|")}`);
  if (!SCENARIO_DIFFICULTIES.includes(scenario.difficulty))
    fail(id, `difficulty must be one of ${SCENARIO_DIFFICULTIES.join("|")}`);
  if (!nonEmptyString(scenario.description)) fail(id, "description is required");
  return id;
}

/** Validates one scenario object and returns it frozen; throws ScenarioError on any defect. */
export function validateScenario(scenario) {
  const id = validateHeader(scenario);
  validateTruth(id, scenario.truth);
  validateTermList(id, scenario.superseded, "superseded", false);
  validateTruthApartFromReplaced(id, scenario.truth, scenario.superseded);
  validateTermList(id, scenario.forgotten, "forgotten", false);
  validateTermList(id, scenario.forbidden, "forbidden", true);
  validateSupersededKeys(id, scenario.superseded);
  validatePoison(id, scenario.poison);
  validateSeed(fail, id, scenario);
  validateTurns(id, scenario.turns, scenario.seed !== undefined);
  validateProbes(id, scenario.probes, {
    truth: new Set(scenario.truth.map((fact) => fact.key)),
    superseded: new Set((scenario.superseded ?? []).flatMap((entry) => entry.key ?? [])),
  });
  validateEarlierApart(id, scenario);
  validateWantedTerms(id, scenario);
  validateBindingsApart(id, scenario);
  validatePoisonProbes(id, scenario.poison, scenario.probes);
  return Object.freeze({
    ...scenario,
    superseded: scenario.superseded ?? [],
    forgotten: scenario.forgotten ?? [],
    forbidden: scenario.forbidden ?? [],
  });
}

// Sorted keys at every nesting level, arrays in their order: the same content is the same text.
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

/** Stable content digest of a scenario: every nested field counts, key order does not. */
export function scenarioDigest(scenario) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(scenario)))
    .digest("hex");
}

/** Loads every `*.json` scenario of a directory, sorted by id, refusing duplicate ids. */
export function loadScenarioDirectory(directory) {
  return loadJsonSet(directory, { validate: validateScenario, fail, what: "scenario" });
}

/**
 * The versioned manifest of a scenario set: ids, classes, languages and per-scenario digests. The
 * entries are ordered by id in byte order, whatever order the set arrived in, so the set digest
 * depends on the content alone and never on a loader or a locale.
 */
export function scenarioSetManifest(scenarios) {
  const entries = scenarios
    .map((scenario) => ({
      id: scenario.id,
      language: scenario.language,
      class: scenario.class,
      difficulty: scenario.difficulty,
      digest: scenarioDigest(scenario),
    }))
    .toSorted((left, right) => compareStrings(left.id, right.id));
  const setDigest = createHash("sha256")
    .update(entries.map((entry) => `${entry.id}:${entry.digest}`).join("\n"))
    .digest("hex");
  return { schemaVersion: SCENARIO_SCHEMA_VERSION, count: entries.length, setDigest, entries };
}
