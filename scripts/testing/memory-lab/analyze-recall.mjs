// Independent, body-free analysis of completed synthetic lab artifacts. No model calls.
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { matchesTermGroups } from "./score.mjs";
import { readRun, provenanceDifferences, compareRuns } from "./compare.mjs";
import { loadScenarioDirectory, scenarioSetManifest } from "./scenario.mjs";

const DEFAULT_SCENARIOS = fileURLToPath(new URL("./scenarios", import.meta.url));
const MEASUREMENT_MODES = new Set(["offline", "live"]);
const ARMS = new Set(["product", "off", "oracle"]);
const ratio = (hits, count) => (count === 0 ? null : hits / count);
const unitKey = (run) => `${run.scenario}:${run.arm}:r${run.repetition}`;
function requireTrue(condition, message) {
  if (!condition) throw new Error(message);
}

function verifyMetadata(metadata) {
  requireTrue(metadata !== undefined, "Missing manifest metadata");
  requireTrue(MEASUREMENT_MODES.has(metadata.mode), "Unknown manifest measurement mode");
  for (const field of [
    "answerModelId",
    "learnModelId",
    "configDigest",
    "instrumentDigest",
    "memoryMode",
    "ceiling",
  ]) {
    requireTrue(
      typeof metadata[field] === "string" && metadata[field].length > 0,
      `Missing manifest ${field}`,
    );
  }
  requireTrue(
    metadata.mode !== "live" || /^[a-f\d]{64}$/u.test(metadata.configDigest),
    "Live config digest missing or invalid",
  );
  requireTrue(
    Number.isInteger(metadata.repetitions) && metadata.repetitions > 0,
    "Invalid manifest repetitions",
  );
  requireTrue(
    Number.isInteger(metadata.budgetTokens) && metadata.budgetTokens >= 0,
    "Invalid manifest budget",
  );
}

function verifyArms(metadata, arm) {
  requireTrue(
    Array.isArray(metadata.arms) &&
      metadata.arms.length > 0 &&
      new Set(metadata.arms).size === metadata.arms.length,
    "Invalid manifest arms",
  );
  requireTrue(
    metadata.arms.every((value) => ARMS.has(value)),
    "Unknown manifest arm",
  );
  requireTrue(metadata.arms.includes(arm), `Selected arm ${arm} absent from manifest`);
}

function verifyManifest(run, actualCorpus, arm) {
  const { manifest, summary } = run;
  const { metadata } = manifest;
  verifyMetadata(metadata);
  verifyArms(metadata, arm);
  requireTrue(
    metadata.sealed === false && summary.sealed === false,
    "Per-probe diagnosis requires an open corpus",
  );
  requireTrue(
    manifest.setDigest === actualCorpus.setDigest,
    "Scenario directory corpus digest differs from manifest",
  );
  requireTrue(
    manifest.count === actualCorpus.count &&
      isDeepStrictEqual(manifest.entries, actualCorpus.entries),
    "Scenario inventory or scenario digest differs from manifest",
  );
  requireTrue(
    summary.failedUnits === 0 && (summary.failedUnitList ?? []).length === 0,
    "Run contains failed units",
  );
}

function expectedUnitKeys(scenarioMap, metadata) {
  const expected = new Set();
  for (const scenario of scenarioMap.values())
    for (const arm of metadata.arms) {
      for (let repetition = 0; repetition < metadata.repetitions; repetition += 1) {
        expected.add(unitKey({ scenario: scenario.id, arm, repetition }));
      }
    }
  return expected;
}

function verifyProbe(probe, spec, probeIds, key, entry) {
  requireTrue(
    spec !== undefined && !probeIds.has(probe.id),
    `Unknown or duplicate probe in ${key}`,
  );
  requireTrue(
    probe.kind === spec.expect.kind,
    `Probe kind differs from corpus in ${key}:${probe.id}`,
  );
  requireTrue(
    Number.isInteger(probe.retrievedCount) && probe.retrievedCount >= 0,
    `Missing retrieval count ${key}:${probe.id}`,
  );
  requireTrue(
    Number.isInteger(probe.profileCount) && probe.profileCount >= 0,
    `Missing profile count ${key}:${probe.id}`,
  );
  requireTrue(
    entry !== undefined && typeof probe.passed === "boolean" && entry.passed === probe.passed,
    `Missing or stale probe scorecard entry ${key}:${probe.id}`,
  );
  if (probe.kind === "answer")
    requireTrue(
      typeof probe.relevantSupplied === "boolean",
      `Missing positive supply verdict ${key}:${probe.id}`,
    );
}

function verifyProbeInventory(unit, scenario, scorecard) {
  const key = unitKey(unit);
  requireTrue(
    unit.probes.length === scenario.probes.length,
    `Incomplete probe inventory in ${key}`,
  );
  const probeIds = new Set();
  requireTrue(scorecard.has(`${key}:store`), `Missing store scorecard entry ${key}`);
  for (const probe of unit.probes) {
    const spec = scenario.probes.find((item) => item.id === probe.id);
    verifyProbe(probe, spec, probeIds, key, scorecard.get(`${key}:probe:${probe.id}`));
    probeIds.add(probe.id);
  }
}

function verifyUnit(unit, file, expected, found) {
  const key = unitKey(unit);
  requireTrue(expected.has(key), `Unexpected run unit ${key}`);
  requireTrue(!found.has(key), `Duplicate run unit ${key}`);
  requireTrue(
    file === `${unit.scenario}.${unit.arm}.r${unit.repetition}.json`,
    `Run filename mismatch for ${key}`,
  );
  requireTrue(
    unit.error === undefined && unit.store !== undefined && Array.isArray(unit.probes),
    `Failed or incomplete unit ${key}`,
  );
}

function verifySummary(run, scenarioMap, expected) {
  const { metadata } = run.manifest;
  requireTrue(
    run.summary.runs === expected.size,
    "Summary run count differs from raw unit inventory",
  );
  for (const arm of metadata.arms) {
    const armSummary = run.summary.byArm.find((entry) => entry.key === arm);
    requireTrue(
      armSummary?.runs === scenarioMap.size * metadata.repetitions && armSummary.failed === 0,
      `Summary arm run count differs for ${arm}`,
    );
  }
}

function verifiedUnits(run, scenarioMap) {
  const expected = expectedUnitKeys(scenarioMap, run.manifest.metadata);
  const found = new Map();
  const scorecard = new Map(run.scorecard.scenarios.map((entry) => [entry.name, entry]));
  requireTrue(scorecard.size === run.scorecard.scenarios.length, "Duplicate scorecard key");
  const directory = join(run.directory, "runs");
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()) {
    const unit = JSON.parse(readFileSync(join(directory, file), "utf8"));
    verifyUnit(unit, file, expected, found);
    verifyProbeInventory(unit, scenarioMap.get(unit.scenario), scorecard);
    found.set(unitKey(unit), unit);
  }
  requireTrue(
    found.size === expected.size && [...expected].every((key) => found.has(key)),
    "Missing run units for declared corpus/arms/repetitions",
  );
  verifySummary(run, scenarioMap, expected);
  return [...found.values()];
}

function probeRows(units, scenarioMap) {
  return units.flatMap((unit) => {
    const scenario = scenarioMap.get(unit.scenario);
    return unit.probes.map((probe) => {
      const expected = scenario.probes.find((item) => item.id === probe.id).expect;
      // Existing accepted, correct truth-key verdicts avoid retaining/reinterpreting memory bodies.
      const targetKeys =
        probe.kind === "answer"
          ? scenario.truth
              .filter((fact) => matchesTermGroups(fact.seed ?? "", expected.terms))
              .map((fact) => fact.key)
          : [];
      const targetStored =
        targetKeys.length === 0
          ? null
          : (unit.store.verdicts ?? []).some(
              (verdict) =>
                verdict.status === "accepted" &&
                verdict.verdict === "correct" &&
                targetKeys.includes(verdict.key),
            );
      return {
        key: `${unitKey(unit)}:probe:${probe.id}`,
        scenario: unit.scenario,
        arm: unit.arm,
        repetition: unit.repetition,
        probe: probe.id,
        kind: probe.kind,
        storeTargetAvailable: targetStored,
        storeTargetKeys: targetKeys,
        storeMissingKeys: unit.store.missing,
        relevantSupplied: probe.relevantSupplied ?? null,
        retrievedCount: probe.retrievedCount,
        profileCount: probe.profileCount,
        originalPassed: probe.passed,
        abstained: probe.abstained ?? null,
        leaked: probe.leaked ?? null,
        overApplied: probe.overApplied ?? null,
        valueStated: probe.valueStated ?? null,
        negativeRetrievalHit: probe.kind === "no-memory" ? probe.retrievedCount > 0 : null,
      };
    });
  });
}

function summarize(rows, units) {
  const positives = rows.filter((row) => row.kind === "answer");
  const available = positives.filter((row) => row.storeTargetAvailable === true);
  const negatives = rows.filter((row) => row.kind === "no-memory");
  const abstain = rows.filter((row) => row.kind === "abstain");
  const counters = {};
  for (const unit of units)
    for (const [name, value] of Object.entries(unit.store.counters ?? {})) {
      counters[name] = (counters[name] ?? 0) + value;
    }
  return {
    positiveSupplyHits: positives.filter((row) => row.relevantSupplied === true).length,
    positiveProbeCount: positives.length,
    positiveSupplyHitRate: ratio(
      positives.filter((row) => row.relevantSupplied === true).length,
      positives.length,
    ),
    availableTargetSupplyHits: available.filter((row) => row.relevantSupplied === true).length,
    availableTargetProbeCount: available.length,
    conditionalSupplyHitRate: ratio(
      available.filter((row) => row.relevantSupplied === true).length,
      available.length,
    ),
    positiveMissingStoredTargetCount: positives.filter((row) => row.storeTargetAvailable === false)
      .length,
    positiveUnresolvedTargetCount: positives.filter((row) => row.storeTargetAvailable === null)
      .length,
    negativeRetrievalHits: negatives.filter((row) => row.negativeRetrievalHit === true).length,
    negativeProbeCount: negatives.length,
    negativeRetrievalFalsePositiveRate: ratio(
      negatives.filter((row) => row.negativeRetrievalHit === true).length,
      negatives.length,
    ),
    negativeAnswerFailures: negatives.filter((row) => row.originalPassed === false).length,
    negativeAnswerOverApplications: negatives.filter((row) => row.overApplied === true).length,
    abstentionVerdictsPassed: abstain.filter((row) => row.originalPassed).length,
    abstentionProbeCount: abstain.length,
    abstentionQueriesWithRetrieval: abstain.filter((row) => row.retrievedCount > 0).length,
    abstentionQueriesWithAllowedProfile: abstain.filter((row) => row.profileCount > 0).length,
    probeCaptures: units.reduce((sum, unit) => sum + (unit.probeCaptures ?? 0), 0),
    unknownProbeCaptureUnits: units.filter((unit) => unit.probeCaptures === undefined).length,
    hardCounters: counters,
  };
}

function transitionOf(beforeHit, afterHit) {
  if (beforeHit) return afterHit ? "persistent" : "resolved";
  return afterHit ? "introduced" : "clear";
}

function negativeTransitions(paired, basis = "retrieval") {
  const probes = paired
    .filter((pair) => pair.after.kind === "no-memory")
    .map((pair) => {
      const oldHit =
        basis === "retrieval" ? pair.before.negativeRetrievalHit : !pair.before.originalPassed;
      const newHit =
        basis === "retrieval" ? pair.after.negativeRetrievalHit : !pair.after.originalPassed;
      return {
        key: pair.key,
        scenario: pair.after.scenario,
        arm: pair.after.arm,
        repetition: pair.after.repetition,
        probe: pair.after.probe,
        beforeHit: oldHit,
        afterHit: newHit,
        transition: transitionOf(oldHit, newHit),
      };
    });
  const keys = (transition) =>
    probes.filter((row) => row.transition === transition).map((row) => row.key);
  return {
    basis:
      basis === "retrieval"
        ? "query-specific retrieval count > 0"
        : "original no-memory probe verdict failed",
    introducedCount: keys("introduced").length,
    introducedKeys: keys("introduced"),
    resolvedCount: keys("resolved").length,
    resolvedKeys: keys("resolved"),
    persistentCount: keys("persistent").length,
    clearCount: keys("clear").length,
    probes,
  };
}

function sourceDetails(run, unitCount) {
  const meta = run.manifest.metadata;
  return {
    directory: run.directory,
    productHead: meta.productHead,
    productDistDigest: meta.productDistDigest,
    measurementMode: meta.mode,
    answeringKind: meta.mode === "offline" ? "scripted-echo" : "configured-model",
    answerModelId: meta.answerModelId,
    learnModelId: meta.learnModelId,
    configDigest: meta.configDigest,
    instrumentDigest: meta.instrumentDigest,
    arms: meta.arms,
    repetitions: meta.repetitions,
    validatedUnitCount: unitCount,
  };
}

function pairRows(before, after) {
  const oldByKey = new Map(before.map((row) => [row.key, row]));
  requireTrue(
    oldByKey.size === before.length && new Set(after.map((row) => row.key)).size === after.length,
    "Duplicate probe key",
  );
  requireTrue(
    before.length === after.length && after.every((row) => oldByKey.has(row.key)),
    "Different paired probe inventories",
  );
  return after.map((row) => ({ key: row.key, before: oldByKey.get(row.key), after: row }));
}

function interpretation(metadata) {
  return {
    measurementMode: metadata.mode,
    answerModelId: metadata.answerModelId,
    learnModelId: metadata.learnModelId,
    answerAndInjectionMetrics:
      metadata.mode === "offline"
        ? "scripted echo; no live-model behavior claim"
        : "configured live model; original deterministic term/form verdicts, no judge model",
    profilePresenceOnUnrelated: "allowed standing facts are separate from query-specific recall",
    positiveSupplyHitRate:
      "target supplied, including standing profile; independent of answer verdict",
    conditionalSupplyHitRate:
      "positive probes whose labelled target truth key was scored correct and accepted in the pre-probe store",
    negativeRetrievalFalsePositiveRate:
      "only explicitly declared no-memory probes; any query-specific recall is a false positive",
    negativeTransitions:
      "introduced/resolved per identical scenario, arm, repetition and negative-probe id; totals cannot cancel an introduced hit",
  };
}

function summarizeRepetition(repetition, data) {
  const { before, after, beforeUnits, afterUnits, paired } = data;
  const probePairs = paired.filter((pair) => pair.after.repetition === repetition);
  return {
    repetition,
    before: summarize(
      before.filter((row) => row.repetition === repetition),
      beforeUnits.filter((unit) => unit.repetition === repetition),
    ),
    after: summarize(
      after.filter((row) => row.repetition === repetition),
      afterUnits.filter((unit) => unit.repetition === repetition),
    ),
    negativeTransitions: negativeTransitions(probePairs),
    negativeAnswerTransitions: negativeTransitions(probePairs, "answer"),
  };
}

function buildReport({ baseline, candidate, corpus, arm, allBefore, allAfter, scenarioMap }) {
  const beforeUnits = allBefore.filter((unit) => unit.arm === arm);
  const afterUnits = allAfter.filter((unit) => unit.arm === arm);
  const before = probeRows(beforeUnits, scenarioMap);
  const after = probeRows(afterUnits, scenarioMap);
  const paired = pairRows(before, after);
  const data = { before, after, beforeUnits, afterUnits, paired };
  const repetitions = [...new Set(afterUnits.map((unit) => unit.repetition))].sort((a, b) => a - b);
  return {
    schemaVersion: 2,
    source: {
      baseline: sourceDetails(baseline, allBefore.length),
      candidate: sourceDetails(candidate, allAfter.length),
    },
    arm,
    setDigest: corpus.setDigest,
    instrumentDigest: candidate.manifest.metadata.instrumentDigest,
    repetitionsPresent: repetitions,
    missingOfRequestedThree: [0, 1, 2].filter((rep) => !repetitions.includes(rep)),
    interpretation: interpretation(candidate.manifest.metadata),
    before: summarize(before, beforeUnits),
    after: summarize(after, afterUnits),
    negativeTransitions: negativeTransitions(paired),
    negativeAnswerTransitions: negativeTransitions(paired, "answer"),
    byRepetition: repetitions.map((rep) => summarizeRepetition(rep, data)),
    existingComparison: compareRuns(baseline, candidate, arm),
    pairedProbes: paired,
  };
}

export function analyzePair(
  baselineDirectory,
  candidateDirectory,
  { scenarioDir = DEFAULT_SCENARIOS, arm = "product" } = {},
) {
  const baseline = readRun(resolve(baselineDirectory));
  const candidate = readRun(resolve(candidateDirectory));
  const scenarios = loadScenarioDirectory(scenarioDir);
  const corpus = scenarioSetManifest(scenarios);
  const scenarioMap = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  verifyManifest(baseline, corpus, arm);
  verifyManifest(candidate, corpus, arm);
  requireTrue(
    baseline.manifest.setDigest === candidate.manifest.setDigest,
    "Different scenario set digests",
  );
  requireTrue(
    baseline.manifest.metadata.repetitions === candidate.manifest.metadata.repetitions,
    "Different declared repetition counts",
  );
  const drift = provenanceDifferences(baseline, candidate);
  requireTrue(drift.length === 0, `Different provenance: ${drift.join(", ")}`);
  const allBefore = verifiedUnits(baseline, scenarioMap);
  const allAfter = verifiedUnits(candidate, scenarioMap);
  return buildReport({ baseline, candidate, corpus, arm, allBefore, allAfter, scenarioMap });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [baselineDir, candidateDir, scenarioDir = DEFAULT_SCENARIOS, arm = "product"] =
    process.argv.slice(2);
  if (!baselineDir || !candidateDir)
    throw new Error(
      "Usage: node analyze-recall.mjs BASELINE_DIR CANDIDATE_DIR [SCENARIO_DIR] [ARM]",
    );
  console.log(
    JSON.stringify(analyzePair(baselineDir, candidateDir, { scenarioDir, arm }), null, 2),
  );
}
