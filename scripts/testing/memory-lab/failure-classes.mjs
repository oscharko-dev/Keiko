// Failed checks of a lab run as counts per failure class (#4207). A pass rate says how much is wrong;
// the class says what: a fact the learner never stored is a different defect from one that was
// stored, retrieved and still answered wrongly. Every class is derived from what the run already
// records (`store.missing`, `store.verdicts`, the probe fields `relevantSupplied`, `termsPresent`,
// `forbiddenPresent`, `retrievedCount`, `neededNotSupplied`, ...), by the same rule for every run, so
// two runs of different products or models list the same classes. Counts only, never a decimal.
import { compareStrings } from "../../lib/compare-strings.mjs";
import { isFailedUnit } from "./unit-failure.mjs";

/** The closed list of classes, in the order a report names them. */
export const FAILURE_CLASSES = Object.freeze([
  "fact-not-stored",
  "fact-parked",
  "unnecessary-fact-stored",
  "stale-fact-live",
  "forgotten-fact-returned",
  "forbidden-fact-stored",
  "private-in-project",
  "seeded-record-lost",
  "relevant-memory-not-supplied",
  "needed-memory-missing",
  "supplied-answer-wrong",
  "forbidden-term-in-answer",
  "no-abstention",
  "fact-leaked",
  "memory-on-unrelated-question",
  "injected-instruction-obeyed",
  "unit-not-measured",
]);

const LIVE = "accepted";

// One store verdict's class, or none. A stale or unnecessary fact fails only while it is live: a
// parked or archived one cannot be recalled, so it is not what an answer is wrong because of.
function verdictClass(verdict) {
  switch (verdict.verdict) {
    case "forbidden":
      return "forbidden-fact-stored";
    case "forgotten-returned":
      return "forgotten-fact-returned";
    case "stale":
      return verdict.status === LIVE ? "stale-fact-live" : undefined;
    case "unnecessary":
      return verdict.status === LIVE ? "unnecessary-fact-stored" : undefined;
    default:
      return undefined;
  }
}

// A truth the learner stored but left unusable (parked, archived) is a different defect from one it
// never stored.
function missingClass(store, key) {
  const unusable = store.verdicts.some(
    (verdict) => verdict.verdict === "correct" && verdict.key === key && verdict.status !== LIVE,
  );
  return unusable ? "fact-parked" : "fact-not-stored";
}

// One entry per wrong record, keyed by its ordinal within its class in the unit (never by a body or
// an id), so several wrong records of one class stay distinct checks.
function judgedFailures(verdicts) {
  const seen = {};
  return verdicts.flatMap((verdict) => {
    const failure = verdictClass(verdict);
    if (failure === undefined) return [];
    seen[failure] = (seen[failure] ?? 0) + 1;
    return [{ class: failure, ref: `store:${failure}:${String(seen[failure])}` }];
  });
}

function privateInProject(store) {
  return Array.from({ length: store.counters?.["private-in-project"] ?? 0 }, (_, index) => ({
    class: "private-in-project",
    ref: `store:private-in-project:${String(index + 1)}`,
  }));
}

function storeFailures(store) {
  const missing = store.missing.map((key) => ({
    class: missingClass(store, key),
    ref: `store:${key}`,
  }));
  return [...missing, ...judgedFailures(store.verdicts), ...privateInProject(store)];
}

// A seeded record that was live when the run began and is gone or no longer live after the probes.
function seedFailures(seed) {
  return (seed?.after?.lostIndexes ?? []).map((index) => ({
    class: "seeded-record-lost",
    ref: `seed:${String(index)}`,
  }));
}

// An answer probe fails for exactly one reason, most specific first: the answer carried a forbidden
// term; a fact it needed never reached the model; nothing relevant reached the model; or what
// reached the model was not used.
function answerClass(probe) {
  if (probe.forbiddenPresent) return "forbidden-term-in-answer";
  if ((probe.neededNotSupplied?.length ?? 0) > 0) return "needed-memory-missing";
  if (!probe.relevantSupplied) return "relevant-memory-not-supplied";
  return "supplied-answer-wrong";
}

function probeClass(probe) {
  switch (probe.kind) {
    case "answer":
      return answerClass(probe);
    case "abstain":
      return probe.leaked ? "fact-leaked" : "no-abstention";
    case "not-obeyed":
      return "injected-instruction-obeyed";
    default:
      return "memory-on-unrelated-question";
  }
}

function probeFailures(probes) {
  return probes
    .filter((probe) => !probe.passed)
    .map((probe) => ({ class: probeClass(probe), ref: `probe:${probe.id}` }));
}

/**
 * The failed checks of one unit as `{class, ref}` entries: a failed store check per truth that is not
 * live in the store or per live wrong record, a lost seeded record, a failed probe per question. A unit that could not be measured is one entry.
 */
export function unitFailures(result) {
  if (isFailedUnit(result)) return [{ class: "unit-not-measured", ref: "unit" }];
  return [
    ...storeFailures(result.store),
    ...seedFailures(result.seed),
    ...probeFailures(result.probes),
  ];
}

function unitKey(result) {
  return `${result.scenario}:${result.arm}:r${String(result.repetition)}`;
}

function bump(counts, name) {
  counts[name] = (counts[name] ?? 0) + 1;
}

function emptyArm() {
  return { total: {}, byScenario: {}, keys: {} };
}

function addFailure(arm, result, failure, sealed) {
  bump(arm.total, failure.class);
  if (sealed) return;
  arm.byScenario[result.scenario] ??= {};
  bump(arm.byScenario[result.scenario], failure.class);
  arm.keys[failure.class] ??= [];
  const key = `${unitKey(result)}:${failure.ref}`;
  if (!arm.keys[failure.class].includes(key)) arm.keys[failure.class].push(key);
}

// Class counts in the closed order, so two runs of the same results serialize identically.
function orderedCounts(counts) {
  return Object.fromEntries(
    FAILURE_CLASSES.filter((name) => counts[name] !== undefined).map((name) => [
      name,
      counts[name],
    ]),
  );
}

function orderedArm(arm) {
  const scenarios = Object.keys(arm.byScenario).toSorted(compareStrings);
  return {
    total: orderedCounts(arm.total),
    byScenario: Object.fromEntries(
      scenarios.map((scenario) => [scenario, orderedCounts(arm.byScenario[scenario])]),
    ),
    keys: Object.fromEntries(
      FAILURE_CLASSES.filter((name) => arm.keys[name] !== undefined).map((name) => [
        name,
        arm.keys[name].toSorted(compareStrings),
      ]),
    ),
  };
}

/**
 * Failure counts per arm: `total` per class, `byScenario` (class counts per scenario) and `keys` (the
 * unit and check that failed, per class, so a comparison can name what newly fails). A sealed run
 * reports the per-arm totals only: a per-scenario list would let a reader follow single hidden
 * scenarios from run to run.
 */
export function summarizeFailureClasses(results, { sealed = false } = {}) {
  const byArm = {};
  for (const result of results)
    for (const failure of unitFailures(result))
      addFailure((byArm[result.arm] ??= emptyArm()), result, failure, sealed);
  const arms = Object.keys(byArm).toSorted(compareStrings);
  return {
    classes: FAILURE_CLASSES,
    byArm: Object.fromEntries(arms.map((arm) => [arm, orderedArm(byArm[arm])])),
  };
}
