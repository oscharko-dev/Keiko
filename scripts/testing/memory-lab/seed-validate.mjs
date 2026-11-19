// Validation of a scenario's `seed` section (#4207), strict like the rest of the schema: a typo in a
// field name or a record that contradicts the truth would otherwise measure something other than
// the author meant. `fail` is the scenario loader's own, so every defect names its scenario.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "../coding-workbench-lab/lab-common.mjs";
import { matchesTermGroups } from "./score.mjs";
import { isRecord, nonEmptyString } from "./set-files.mjs";
import {
  MAX_FILLER_RECORDS,
  MEMORY_TYPES,
  LEARNED_CONFIDENCE_RANGE,
  LEARNED_TYPES,
  SEED_ORIGINS,
  SEED_SCOPES,
  SEED_STATUSES,
  fillerBodies,
  planSeed,
} from "./seed-plan.mjs";

// The memory contract's own record validator, from the built contracts package of the SUBJECT being
// measured (its public entry point): the vault refuses a record it does not accept, at instance start,
// with an error that names no scenario, and a subject at another version has another contract. Until
// `useSubjectContract` names a subject the lab's own checkout is the subject. A contract that cannot be
// loaded is kept as a named error with its cause, and a scenario with a seed is refused with it: a seed
// is never accepted unchecked, and never for a reason that is hidden.
let contract = await loadContract(REPO_ROOT);

async function loadContract(subjectRoot) {
  const entry = join(subjectRoot, "packages", "keiko-contracts", "dist", "index.js");
  try {
    const { validateMemoryRecord } = await import(pathToFileURL(entry).href);
    if (typeof validateMemoryRecord !== "function")
      throw new TypeError("it exports no validateMemoryRecord");
    return { validateMemoryRecord };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return {
      error: new Error(
        `the memory contract of the subject at ${subjectRoot} cannot be loaded from ${entry} (build it with npm run build:packages): ${reason}`,
        { cause },
      ),
    };
  }
}

/** Names the subject whose memory contract validates the seeds of the scenarios loaded after this. */
export async function useSubjectContract(subjectRoot) {
  contract = await loadContract(subjectRoot ?? REPO_ROOT);
}

const MAX_AGE_DAYS = 36_500;
const MAX_ACCESS_COUNT = 1000;
const MAX_BODY_CHARS = 4096;
/** The slug every key of a scenario (seed record, replaced value) is written as. */
export const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const SEED_FIELDS = Object.freeze(["records", "filler"]);
const RECORD_FIELDS = Object.freeze([
  "key",
  "body",
  "type",
  "scope",
  "status",
  "ageDays",
  "pinned",
  "origin",
  "standing",
  "confidence",
  "mustStay",
  "explained",
  "supersedes",
  "accessCount",
  "lastAccessDays",
  "truth",
  "earlier",
]);
const FILLER_FIELDS = Object.freeze([
  "count",
  "status",
  "minAgeDays",
  "maxAgeDays",
  "seed",
  "scope",
  "type",
  "origin",
]);

function unknownFields(fail, id, where, value, allowed) {
  for (const field of Object.keys(value))
    if (!allowed.includes(field)) fail(id, `${where} has an unknown field: ${field}`);
}

function ageIn(fail, id, where, value, name) {
  if (!Number.isFinite(value) || value < 0 || value > MAX_AGE_DAYS)
    fail(id, `${where}.${name} must be a number of days between 0 and ${String(MAX_AGE_DAYS)}`);
}

function oneOfIn(fail, id, where, value, allowed, name) {
  if (!allowed.includes(value)) fail(id, `${where}.${name} must be one of ${allowed.join("|")}`);
}

function optionalBoolean(fail, id, where, value, name) {
  if (value !== undefined && typeof value !== "boolean")
    fail(id, `${where}.${name} must be a boolean when present`);
}

function validateRecordShape(fail, id, where, record, keys) {
  if (!isRecord(record)) fail(id, `${where} must be an object`);
  unknownFields(fail, id, where, record, RECORD_FIELDS);
  if (!nonEmptyString(record.key) || !KEY_PATTERN.test(record.key))
    fail(id, `${where}.key must be a lowercase slug`);
  if (keys.has(record.key)) fail(id, `${where}.key duplicates ${record.key}`);
  keys.add(record.key);
  if (!nonEmptyString(record.body) || record.body.length > MAX_BODY_CHARS)
    fail(id, `${where}.body is required (at most ${String(MAX_BODY_CHARS)} characters)`);
  oneOfIn(fail, id, where, record.type, MEMORY_TYPES, "type");
  oneOfIn(fail, id, where, record.status, SEED_STATUSES, "status");
  oneOfIn(fail, id, where, record.scope ?? "project", SEED_SCOPES, "scope");
  ageIn(fail, id, where, record.ageDays, "ageDays");
  validateLoss(fail, id, where, record);
  optionalBoolean(fail, id, where, record.pinned, "pinned");
  validateOrigin(fail, id, where, record);
}

// `mustStay` makes the record's disappearance a failure; `explained` says the scenario's own turns
// (a correction, a forget) account for its loss. Both are about an accepted record.
function validateLoss(fail, id, where, record) {
  optionalBoolean(fail, id, where, record.mustStay, "mustStay");
  optionalBoolean(fail, id, where, record.explained, "explained");
  if (record.mustStay === true && record.explained === true)
    fail(id, `${where} cannot be both mustStay and explained`);
  if ((record.mustStay === true || record.explained === true) && record.status !== "accepted")
    fail(id, `${where}.mustStay and explained are about an accepted record`);
}

// A learned record is one the learner could have written: its types, user scope for a self fact, no
// pin, the standing mark only on a self identity or constraint fact (a semantic fact in user scope),
// and a confidence in the range its checks derive. A stated record is the explicit-instruction form.
function validateOrigin(fail, id, where, record) {
  optionalBoolean(fail, id, where, record.standing, "standing");
  oneOfIn(fail, id, where, record.origin ?? "learned", SEED_ORIGINS, "origin");
  if (record.origin === "stated") {
    if (record.standing === true || record.confidence !== undefined)
      fail(id, `${where}: standing and confidence belong to a learned record, not a stated one`);
    return;
  }
  validateLearned(fail, id, where, record);
}

function validateLearned(fail, id, where, record) {
  if (!LEARNED_TYPES.includes(record.type))
    fail(id, `${where}.type must be one of ${LEARNED_TYPES.join("|")} for a learned record`);
  if (record.pinned === true)
    fail(id, `${where}: the learner never pins a fact; use origin "stated" for a pinned record`);
  if (record.standing === true && (record.type !== "semantic-fact" || record.scope === "project"))
    fail(id, `${where}.standing needs a semantic-fact in user scope`);
  const { confidence } = record;
  if (confidence === undefined) return;
  const { min, max } = LEARNED_CONFIDENCE_RANGE;
  if (!Number.isFinite(confidence) || confidence < min || confidence > max)
    fail(id, `${where}.confidence must be between ${String(min)} and ${String(max)}`);
}

function validateReinforcement(fail, id, where, record) {
  if (record.accessCount === undefined && record.lastAccessDays === undefined) return;
  if (
    !Number.isSafeInteger(record.accessCount) ||
    record.accessCount < 0 ||
    record.accessCount > MAX_ACCESS_COUNT
  )
    fail(id, `${where}.accessCount must be an integer between 0 and ${String(MAX_ACCESS_COUNT)}`);
  if (record.lastAccessDays === undefined) return;
  ageIn(fail, id, where, record.lastAccessDays, "lastAccessDays");
  if (record.lastAccessDays > record.ageDays)
    fail(id, `${where}.lastAccessDays cannot be older than the record itself`);
}

// A record that supersedes another one names it by key; the replaced record must say it was replaced
// (status superseded) and must be older, or the chain would run backwards in time.
function validateSupersedes(fail, id, where, record, byKey) {
  if (record.supersedes === undefined) return;
  const predecessor = byKey.get(record.supersedes);
  if (predecessor === undefined || record.supersedes === record.key)
    fail(id, `${where}.supersedes names no other seed record: ${String(record.supersedes)}`);
  if (predecessor.status !== "superseded")
    fail(id, `${where}.supersedes names ${record.supersedes}, which is not status superseded`);
  if (predecessor.ageDays < record.ageDays)
    fail(id, `${where}.supersedes names a record that is newer than this one`);
}

// The chain of `supersedes` links must end: records of equal age pass the age check in both
// directions, so two superseded records could name each other and the planner would write a cyclic
// history. Each chain is followed from its record and refused when it comes back to a key it saw.
function validateNoSupersedesCycle(fail, id, records, byKey) {
  records.forEach((record, index) => {
    const seen = new Set([record.key]);
    for (let next = record.supersedes; next !== undefined; next = byKey.get(next)?.supersedes) {
      if (seen.has(next))
        fail(id, `seed.records[${String(index)}].supersedes forms a cycle through ${String(next)}`);
      seen.add(next);
    }
  });
}

// A record that states a truth (or a replaced value) must be matched by that fact's own terms, so the
// scorer and the author mean the same thing by the link.
function validateTruthLink(fail, id, where, record, scenario) {
  if (record.status !== "accepted")
    fail(id, `${where}.truth needs status accepted; link a superseded record with earlier`);
  const fact = scenario.truth.find((entry) => entry.key === record.truth);
  if (fact === undefined) fail(id, `${where}.truth names no truth key: ${String(record.truth)}`);
  if (!matchesTermGroups(record.body, fact.terms))
    fail(id, `${where}.body does not match the terms of truth ${record.truth}`);
}

function validateLinks(fail, id, where, record, scenario) {
  if (record.truth !== undefined && record.earlier !== undefined)
    fail(id, `${where} cannot link both truth and earlier`);
  if (record.truth !== undefined) validateTruthLink(fail, id, where, record, scenario);
  if (record.earlier === undefined) return;
  const replaced = (scenario.superseded ?? []).find((entry) => entry.key === record.earlier);
  if (replaced === undefined)
    fail(id, `${where}.earlier names no superseded key: ${String(record.earlier)}`);
  if (!matchesTermGroups(record.body, replaced.terms))
    fail(id, `${where}.body does not match the terms of superseded ${record.earlier}`);
}

function validateRecords(fail, id, records, scenario) {
  if (records === undefined) return;
  if (!Array.isArray(records)) fail(id, "seed.records must be an array");
  const keys = new Set();
  records.forEach((record, index) =>
    validateRecordShape(fail, id, `seed.records[${String(index)}]`, record, keys),
  );
  const byKey = new Map(records.map((record) => [record.key, record]));
  records.forEach((record, index) => {
    const where = `seed.records[${String(index)}]`;
    validateReinforcement(fail, id, where, record);
    validateSupersedes(fail, id, where, record, byKey);
    validateLinks(fail, id, where, record, scenario);
  });
  validateNoSupersedesCycle(fail, id, records, byKey);
  validateOneSuccessor(fail, id, records);
}

// A record is superseded by at most one successor: its validity ends once, and the product writes one
// edge per replacement. Two successors would end it at the later one's time and write two edges.
function validateOneSuccessor(fail, id, records) {
  const taken = new Set();
  records.forEach((record, index) => {
    if (record.supersedes === undefined) return;
    if (taken.has(record.supersedes))
      fail(
        id,
        `seed.records[${String(index)}].supersedes names ${String(record.supersedes)}, which another record already supersedes`,
      );
    taken.add(record.supersedes);
  });
}

function validateFillerOrigin(fail, id, where, group) {
  oneOfIn(fail, id, where, group.origin ?? "learned", SEED_ORIGINS, "origin");
  const types = group.origin === "stated" ? MEMORY_TYPES : LEARNED_TYPES;
  oneOfIn(fail, id, where, group.type ?? "semantic-fact", types, "type");
}

function validateFillerShape(fail, id, where, group) {
  if (!isRecord(group)) fail(id, `${where} must be an object`);
  unknownFields(fail, id, where, group, FILLER_FIELDS);
  if (!Number.isSafeInteger(group.count) || group.count < 1 || group.count > MAX_FILLER_RECORDS)
    fail(id, `${where}.count must be an integer between 1 and ${String(MAX_FILLER_RECORDS)}`);
  if (!Number.isSafeInteger(group.seed)) fail(id, `${where}.seed must be an integer`);
  oneOfIn(fail, id, where, group.status, SEED_STATUSES, "status");
  oneOfIn(fail, id, where, group.scope ?? "user", SEED_SCOPES, "scope");
  validateFillerOrigin(fail, id, where, group);
  ageIn(fail, id, where, group.minAgeDays, "minAgeDays");
  ageIn(fail, id, where, group.maxAgeDays, "maxAgeDays");
  if (group.minAgeDays > group.maxAgeDays) fail(id, `${where}.minAgeDays exceeds maxAgeDays`);
}

// Every term list a filler body must stay clear of: a body that a scenario's truth, replaced value,
// forgotten or forbidden entry matches would be a stored fact the scorer judges, not filler.
function termEntries(scenario) {
  return [
    ...scenario.truth,
    ...(scenario.superseded ?? []),
    ...(scenario.forgotten ?? []),
    ...(scenario.forbidden ?? []),
    ...(scenario.poison ?? []),
    ...probeTermEntries(scenario.probes),
  ];
}

// A probe's own `expect.terms` and `expect.forbidden` are matched against stored records and answers
// too: a filler body that carries them would be a record the scorer judges, not filler.
function probeTermEntries(probes) {
  if (!Array.isArray(probes)) return [];
  return probes.flatMap((probe) =>
    [probe?.expect?.terms, probe?.expect?.forbidden]
      .filter((terms) => Array.isArray(terms))
      .map((terms) => ({ terms })),
  );
}

function validateFillerApart(fail, id, filler, scenario) {
  const entries = termEntries(scenario);
  for (const body of fillerBodies(filler))
    if (entries.some((entry) => matchesTermGroups(body, entry.terms)))
      fail(id, `a seed filler body matches a term list of the scenario: ${body}`);
}

function validateFiller(fail, id, filler, scenario) {
  if (filler === undefined) return;
  if (!Array.isArray(filler)) fail(id, "seed.filler must be an array");
  filler.forEach((group, index) =>
    validateFillerShape(fail, id, `seed.filler[${String(index)}]`, group),
  );
  const total = filler.reduce((sum, group) => sum + group.count, 0);
  if (total > MAX_FILLER_RECORDS)
    fail(id, `seed.filler totals ${String(total)} records; at most ${String(MAX_FILLER_RECORDS)}`);
  validateFillerApart(fail, id, filler, scenario);
  validateDistinctFillerSeeds(fail, id, filler);
}

// Two groups with one seed write identical bodies, which the product's duplicate handling may merge,
// and the lab would then report the merge as faded filler.
function validateDistinctFillerSeeds(fail, id, filler) {
  const seen = new Set();
  filler.forEach((group, index) => {
    if (seen.has(group.seed))
      fail(id, `seed.filler[${String(index)}].seed repeats the seed of an earlier group`);
    seen.add(group.seed);
  });
}

/** Validates a scenario's `seed` section when it has one; truth, superseded and the lists are checked already. */
export function validateSeed(fail, id, scenario) {
  const { seed } = scenario;
  if (seed === undefined) return;
  if (!isRecord(seed)) fail(id, "seed must be an object");
  unknownFields(fail, id, "seed", seed, SEED_FIELDS);
  // Real conversations and a sealed holdout keep nothing but counts: a seed is authored text.
  if (scenario.class.startsWith("anchor-"))
    fail(id, "a real-conversation scenario (class anchor-*) cannot carry a seed");
  if ((seed.records?.length ?? 0) + (seed.filler?.length ?? 0) === 0)
    fail(id, "seed must hold at least one record or filler group");
  validateRecords(fail, id, seed.records, scenario);
  validateFiller(fail, id, seed.filler, scenario);
  validateAgainstContract(fail, id, seed);
}

// Every planned record goes through the memory contract's validator, as the vault will at placement:
// a body the learned form copies into a bounded evidence span, a control character or an age that
// makes a timestamp negative fails here, naming the scenario, not at instance start.
function validateAgainstContract(fail, id, seed) {
  if (contract.error !== undefined) fail(id, contract.error.message);
  const { validateMemoryRecord } = contract;
  // The reference time is the wall clock, as at placement (`seed-store.mjs` plans with `Date.now()`);
  // `--generated-at` is a label that defaults to 0 for digest stability and cannot date a record.
  const plan = planSeed(seed, { nowMs: Date.now(), projectId: "/lab/project" });
  plan.records.forEach((record, index) => {
    const result = validateMemoryRecord(record);
    if (!result.ok)
      fail(
        id,
        `seed record ${String(index)} (${record.status}, ${String(record.body.length)} characters) is refused by the memory contract: ${result.errors.join("; ")}`,
      );
  });
}
