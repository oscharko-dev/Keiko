// Scenario format of the MemoriaViva measurement lab (#4207). A scenario fixes the truth before any
// conversation exists: the facts a correct memory holds afterwards, the facts it must not hold, the
// turns a person writes, and the questions a later chat asks. The oracle never reaches the product;
// the driver sends only the turns and the questions. Loading fails closed on any shape it does not
// know, so a malformed fixture cannot silently measure nothing.
import { createHash } from "node:crypto";
import { matchesTermGroups, validPrefixMark } from "./score.mjs";
import { SetFileError, isRecord, loadJsonSet, nonEmptyString } from "./set-files.mjs";

const SCENARIO_SCHEMA_VERSION = 1;
const SCENARIO_LANGUAGES = Object.freeze(["de", "en", "mixed"]);
export const SCENARIO_CLASSES = Object.freeze([
  "preference",
  "role",
  "way-of-working",
  "decision",
  "update",
  "reversal",
  "forget",
  "forget-paraphrase",
  "forget-not",
  "multi-turn",
  "third-party",
  "credential",
  "identifier",
  "hypothetical",
  "quote",
  "question",
  "assistant-claim",
  "instruction-smuggling",
  "edit-after-learn",
  "entrenchment",
  "unrelated",
  "anchor-real",
  "anchor-benchmark",
]);
const SCENARIO_DIFFICULTIES = Object.freeze(["plain", "embedded", "split", "noisy"]);
const FORBIDDEN_CLASSES = Object.freeze([
  "credential",
  "identifier",
  "third-party",
  "hypothetical",
  "quote",
  "question",
  "assistant-claim",
  "instruction",
  "other",
]);
const PROBE_KINDS = Object.freeze(["answer", "abstain", "no-memory"]);

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

function validateTruth(id, truth) {
  if (!Array.isArray(truth)) fail(id, "truth must be an array");
  truth.forEach((fact, index) => {
    const where = `truth[${String(index)}]`;
    if (!isRecord(fact)) fail(id, `${where} must be an object`);
    if (!nonEmptyString(fact.key)) fail(id, `${where}.key is required`);
    if (!nonEmptyString(fact.seed))
      fail(id, `${where}.seed (exact body for the oracle) is required`);
    if (typeof fact.must !== "boolean") fail(id, `${where}.must must be a boolean`);
    if (!validTermGroups(fact.terms)) fail(id, `${where}.terms must be non-empty term groups`);
    if (fact.private !== undefined && typeof fact.private !== "boolean")
      fail(id, `${where}.private must be a boolean when present`);
  });
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

function validateLearnerItems(id, where, items) {
  if (items === undefined) return;
  if (!Array.isArray(items)) fail(id, `${where}.learner must be an array`);
  items.forEach((item, index) => {
    if (!isRecord(item) || !nonEmptyString(item.body) || !nonEmptyString(item.type))
      fail(id, `${where}.learner[${String(index)}] needs body and type`);
  });
}

function validateTurns(id, turns) {
  if (!Array.isArray(turns) || turns.length === 0) fail(id, "turns must be a non-empty array");
  turns.forEach((turn, index) => {
    const where = `turns[${String(index)}]`;
    if (!isRecord(turn)) fail(id, `${where} must be an object`);
    if (!nonEmptyString(turn.user)) fail(id, `${where}.user is required`);
    if (turn.assistant !== undefined && !nonEmptyString(turn.assistant))
      fail(id, `${where}.assistant must be a non-empty string when present`);
    if (turn.memory !== undefined && typeof turn.memory !== "boolean")
      fail(id, `${where}.memory must be a boolean when present`);
    validateLearnerItems(id, where, turn.learner);
  });
}

// `allow` names true facts (by key) that an abstain or no-memory probe tolerates in the answer and in
// the supplied memories: the person's own fact, asked for a colleague's.
function validateAllowance(id, where, expect, truthKeys) {
  if (expect.allow === undefined) return;
  if (expect.kind === "answer")
    fail(id, `${where}.expect.allow is not measured on an answer probe`);
  if (!Array.isArray(expect.allow) || expect.allow.length === 0)
    fail(id, `${where}.expect.allow must be a non-empty array of truth keys`);
  for (const key of expect.allow)
    if (!truthKeys.has(key)) fail(id, `${where}.expect.allow names no truth key: ${String(key)}`);
}

function validateExpectation(id, where, expect, truthKeys) {
  if (!isRecord(expect) || !PROBE_KINDS.includes(expect.kind))
    fail(id, `${where}.expect.kind must be one of ${PROBE_KINDS.join("|")}`);
  if (expect.kind === "answer" && !validTermGroups(expect.terms))
    fail(id, `${where}.expect.terms must be non-empty term groups for an answer probe`);
  if (expect.forbidden !== undefined && expect.kind !== "answer")
    fail(id, `${where}.expect.forbidden is only measured on an answer probe`);
  if (expect.forbidden !== undefined && !validTermGroups(expect.forbidden))
    fail(id, `${where}.expect.forbidden must be term groups when present`);
  validateAllowance(id, where, expect, truthKeys);
}

function validateProbes(id, probes, truthKeys) {
  if (!Array.isArray(probes) || probes.length === 0) fail(id, "probes must be a non-empty array");
  const seen = new Set();
  probes.forEach((probe, index) => {
    const where = `probes[${String(index)}]`;
    if (!isRecord(probe)) fail(id, `${where} must be an object`);
    if (!nonEmptyString(probe.id)) fail(id, `${where}.id is required`);
    if (seen.has(probe.id)) fail(id, `${where}.id duplicates ${probe.id}`);
    seen.add(probe.id);
    if (!nonEmptyString(probe.question)) fail(id, `${where}.question is required`);
    validateExpectation(id, where, probe.expect, truthKeys);
  });
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
  validateTurns(id, scenario.turns);
  validateProbes(id, scenario.probes, new Set(scenario.truth.map((fact) => fact.key)));
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

/** The versioned manifest of a scenario set: ids, classes, languages and per-scenario digests. */
export function scenarioSetManifest(scenarios) {
  const entries = scenarios.map((scenario) => ({
    id: scenario.id,
    language: scenario.language,
    class: scenario.class,
    difficulty: scenario.difficulty,
    digest: scenarioDigest(scenario),
  }));
  const setDigest = createHash("sha256")
    .update(entries.map((entry) => `${entry.id}:${entry.digest}`).join("\n"))
    .digest("hex");
  return { schemaVersion: SCENARIO_SCHEMA_VERSION, count: entries.length, setDigest, entries };
}
