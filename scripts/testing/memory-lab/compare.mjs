// Compares lab runs (#4210): a candidate against a baseline, per model and per corpus part, with
// the noise band taken from repetitions. The verdict follows the written rule of the epic: progress
// is a gain on the sealed holdout beyond the noise band, in the same metric on more than one model
// (models by their manifests, not by the pair's label), with every hard counter at zero and no metric
// falling below its target. A band needs at least three repetitions in each run; with fewer the
// difference is "noise unknown" and never progress, because the half range of two repetitions is a
// coin flip. A difference that one unit or one probe alone could produce is not progress either.
// Runs are comparable only when they measured the same thing the same way (see PROVENANCE_FIELDS).
// Pure functions over scorecard and summary files; no model, no clock.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compareStrings } from "../../lib/compare-strings.mjs";
import { HARD_COUNTERS } from "./score.mjs";

const COMPARED_METRICS = Object.freeze([
  "precision",
  "recall",
  "answerAccuracy",
  "abstention",
  "noMemoryOnUnrelated",
]);
const ROUND = 10000;
// A noise band is the spread of repetitions; a half range of two is a coin flip, so each run needs
// at least three of them.
const MIN_REPETITIONS = 3;
// What must be equal between two runs for their difference to mean anything: the kind of run, the
// product configuration, the arms, the two models, the gateway configuration, the environment the
// instance ran in and the lab code that measured.
const PROVENANCE_FIELDS = Object.freeze([
  "mode",
  "memoryMode",
  "ceiling",
  "arms",
  "answerModelId",
  "learnModelId",
  "budgetTokens",
  "brokenLearner",
  "configDigest",
  "foldedKeys",
  "instrumentDigest",
]);
// A sealed run's scorecard carries one entry per group with sums and counts (see report.mjs), not
// one per unit or probe; these are the metric names that carry each compared metric there.
const GROUP_METRICS = Object.freeze({
  precision: ["precisionSum", "precisionCount"],
  recall: ["recallSum", "recallCount"],
  answerAccuracy: ["answerPassed", "answerTotal"],
  abstention: ["abstainPassed", "abstainTotal"],
  noMemoryOnUnrelated: ["noMemoryPassed", "noMemoryTotal"],
});
// The scorecard entries that carry each probe metric: the evidence of a probe starts with its kind.
const PROBE_KIND_PREFIX = Object.freeze({
  answerAccuracy: "kind=answer",
  abstention: "kind=abstain",
  noMemoryOnUnrelated: "kind=no-memory",
});

function round(value) {
  return Math.round(value * ROUND) / ROUND;
}

/** Reads the files a run wrote; a missing scorecard is a refused comparison, never a zero. */
export function readRun(directory) {
  const summary = JSON.parse(readFileSync(join(directory, "summary.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  const scorecard = JSON.parse(readFileSync(join(directory, "scorecard.json"), "utf8"));
  return { directory, summary, manifest, scorecard };
}

function sameCorpus(left, right) {
  return left.manifest.setDigest === right.manifest.setDigest;
}

const ENTRY_NAME =
  /^(?<scenario>.+):(?<arm>[a-z]+):r(?<rep>\d+):(?<kind>store|probe:.+|oracle-precondition|group)$/u;

function storeMetric(entry, metricName) {
  const metric = entry.metrics?.find((item) => item.name === metricName);
  return metric === undefined || metric.value < 0 ? undefined : metric.value;
}

// What one scorecard entry contributes to a metric, as a sum and a count: a store metric (one unit),
// the pass/fail of a probe of the kind that metric is the pass rate of (one probe), or the sum and
// count a sealed run's group entry carries. The per-repetition mean is the same either way.
function groupContribution(entry, metricName) {
  const [sumName, countName] = GROUP_METRICS[metricName] ?? [];
  const count = storeMetric(entry, countName);
  const sum = storeMetric(entry, sumName);
  return count === undefined || count === 0 || sum === undefined ? undefined : { sum, count };
}

function probeContribution(entry, kind, metricName) {
  const prefix = PROBE_KIND_PREFIX[metricName];
  if (prefix !== undefined && kind.startsWith("probe:") && entry.evidence.startsWith(prefix))
    return { sum: entry.passed ? 1 : 0, count: 1 };
  return undefined;
}

function entryContribution(entry, kind, metricName) {
  if (kind === "group") return groupContribution(entry, metricName);
  if (kind !== "store") return probeContribution(entry, kind, metricName);
  const value = storeMetric(entry, metricName);
  return value === undefined ? undefined : { sum: value, count: 1 };
}

// Per-repetition means of one metric for one arm, from the scorecard's repetition suffix, with the
// number of units or probes each mean rests on.
function repetitionValues(scorecard, arm, metricName) {
  const byRepetition = new Map();
  for (const entry of scorecard.scenarios) {
    const match = ENTRY_NAME.exec(entry.name);
    if (match === null || match.groups.arm !== arm) continue;
    const part = entryContribution(entry, match.groups.kind, metricName);
    if (part === undefined) continue;
    const bucket = byRepetition.get(match.groups.rep) ?? { sum: 0, count: 0 };
    byRepetition.set(match.groups.rep, {
      sum: bucket.sum + part.sum,
      count: bucket.count + part.count,
    });
  }
  const buckets = [...byRepetition.values()];
  return {
    values: buckets.map((bucket) => bucket.sum / bucket.count),
    counts: buckets.map((bucket) => bucket.count),
  };
}

/** Mean and half-range across repetitions: the band a difference must exceed to count. */
export function noiseBand(values) {
  const present = values.filter((value) => typeof value === "number");
  if (present.length === 0) return { mean: null, halfRange: null, repetitions: 0 };
  const mean = present.reduce((sum, value) => sum + value, 0) / present.length;
  const halfRange = (Math.max(...present) - Math.min(...present)) / 2;
  return { mean: round(mean), halfRange: round(halfRange), repetitions: present.length };
}

function groupRow(summary, arm) {
  return summary.byArm.find((row) => row.key === arm);
}

// The band of one metric, pooled over the repetitions of both runs, or null when either run has
// fewer than the minimum: too few repetitions have no spread worth the name, and pooling them with
// the other run would make half the difference between the runs look like noise.
function pooledHalfRange(baselineValues, candidateValues) {
  const enough = [baselineValues, candidateValues].every(
    (values) => values.filter((value) => typeof value === "number").length >= MIN_REPETITIONS,
  );
  return enough ? noiseBand([...baselineValues, ...candidateValues]).halfRange : null;
}

// The smallest difference the metric can show: one unit or one probe out of the fewest that any
// repetition of either run rested on. Repetitions that agree exactly have a band of zero, and a
// change that one unit alone can produce must not count as progress against it.
function minimumDetectable(baselineCounts, candidateCounts) {
  const counts = [...baselineCounts, ...candidateCounts].filter((count) => count > 0);
  return counts.length === 0 ? null : round(1 / Math.min(...counts));
}

function metricDelta(baseline, candidate, arm, metric) {
  const before = groupRow(baseline.summary, arm)?.[metric] ?? null;
  const after = groupRow(candidate.summary, arm)?.[metric] ?? null;
  const baselineValues = repetitionValues(baseline.scorecard, arm, metric);
  const candidateValues = repetitionValues(candidate.scorecard, arm, metric);
  const halfRange = pooledHalfRange(baselineValues.values, candidateValues.values);
  const floor = minimumDetectable(baselineValues.counts, candidateValues.counts);
  const delta = before === null || after === null ? null : round(after - before);
  // null: no judgement possible, either nothing to compare or no band to compare it with.
  const beyondNoise =
    delta === null || halfRange === null ? null : Math.abs(delta) > Math.max(halfRange, floor ?? 0);
  return { metric, before, after, delta, halfRange, minimumDetectable: floor, beyondNoise };
}

function provenanceOf(run, field) {
  const value = run.manifest.metadata?.[field];
  return Array.isArray(value) ? JSON.stringify(value.toSorted(compareStrings)) : value;
}

/** The provenance fields in which two runs differ (see PROVENANCE_FIELDS). */
export function provenanceDifferences(baseline, candidate) {
  return PROVENANCE_FIELDS.filter(
    (field) => provenanceOf(baseline, field) !== provenanceOf(candidate, field),
  );
}

/** One comparison of the product arm between two runs of the same corpus. */
export function compareRuns(baseline, candidate, arm = "product") {
  if (!sameCorpus(baseline, candidate))
    throw new Error("refusing to compare runs of different corpus versions");
  const deltas = COMPARED_METRICS.map((metric) => metricDelta(baseline, candidate, arm, metric));
  const counters = groupRow(candidate.summary, arm)?.counters ?? {};
  const hardZero = HARD_COUNTERS.every((name) => (counters[name] ?? 0) === 0);
  return {
    corpus: candidate.manifest.setDigest,
    arm,
    deltas,
    hardZero,
    provenanceDifferences: provenanceDifferences(baseline, candidate),
    improved: deltas
      .filter((row) => row.beyondNoise === true && row.delta > 0)
      .map((row) => row.metric),
    worsened: deltas
      .filter((row) => row.beyondNoise === true && row.delta < 0)
      .map((row) => row.metric),
    // A change with no band to measure it against: neither progress nor harm can be claimed.
    noiseUnknown: deltas
      .filter((row) => row.beyondNoise === null && row.delta !== null && row.delta !== 0)
      .map((row) => row.metric),
  };
}

function meetsTargets(candidate, targets, arm) {
  const row = groupRow(candidate.summary, arm) ?? {};
  return Object.entries(targets).every(
    ([metric, floor]) => typeof row[metric] === "number" && row[metric] >= floor,
  );
}

// A pair is judged only when its two runs measured the same thing the same way, and a pair offered
// as the holdout part only when both runs were sealed runs (the manifest says so): a run of the open
// corpus under a holdout label would pass the rule without ever being unseen.
function assertJudgeable(pair) {
  const label = `${pair.model} ${pair.part}`;
  const differences = provenanceDifferences(pair.baseline, pair.candidate);
  if (differences.length > 0)
    throw new Error(`refusing to judge ${label}: the runs differ in ${differences.join(", ")}`);
  if (pair.part !== "holdout") return;
  for (const role of ["baseline", "candidate"])
    if (pair[role].manifest.metadata?.sealed !== true)
      throw new Error(`refusing to judge ${label}: the ${role} run is not a sealed holdout run`);
}

function failedUnitsOf(run) {
  return Number(run.summary.failedUnits ?? 0);
}

// The models a run measured, from its manifest: the pair's label is a free string and must not be
// what "more than one model" counts.
function modelsOf(run) {
  const metadata = run.manifest.metadata ?? {};
  return `${String(metadata.answerModelId)} / ${String(metadata.learnModelId)}`;
}

// The metrics that improved beyond noise on the holdout, each with the models (by manifest) it
// improved on, counting only comparisons in which nothing worsened.
function holdoutImprovements(holdout) {
  const byMetric = new Map();
  for (const row of holdout.filter((item) => item.worsened.length === 0))
    for (const metric of row.improved)
      byMetric.set(metric, new Set([...(byMetric.get(metric) ?? []), row.models]));
  return byMetric;
}

function assertDistinctModels(holdout) {
  const models = holdout.map((row) => row.models);
  if (new Set(models).size !== models.length)
    throw new Error(
      "refusing to judge: two holdout pairs measured the same models by their manifests; the pair label is not the model",
    );
}

function unionOf(comparisons, field) {
  return [...new Set(comparisons.flatMap((row) => row[field]))].join(", ");
}

/**
 * The verdict over several models and both corpus parts. `pairs` is a list of
 * `{model, part: "development"|"holdout", baseline, candidate}`, where `model` is a label for people
 * and the models themselves are read from the manifests; `targets` maps metric names to floors
 * agreed with the owner (empty until #4209 records them). A pair whose runs differ in provenance, a
 * holdout pair that is not sealed, and two holdout pairs of the same models are refused with an
 * error rather than judged.
 */
export function judgeProgress(pairs, targets = {}) {
  for (const pair of pairs) assertJudgeable(pair);
  const comparisons = pairs.map((pair) => ({
    model: pair.model,
    models: modelsOf(pair.baseline),
    part: pair.part,
    ...compareRuns(pair.baseline, pair.candidate),
    meetsTargets: meetsTargets(pair.candidate, targets, "product"),
    failedUnits: failedUnitsOf(pair.baseline) + failedUnitsOf(pair.candidate),
  }));
  const holdout = comparisons.filter((row) => row.part === "holdout");
  assertDistinctModels(holdout);
  const onTwoModels = [...holdoutImprovements(holdout).entries()]
    .filter(([, models]) => models.size >= 2)
    .map(([metric]) => metric);
  const reasons = [];
  if (holdout.length === 0) reasons.push("no holdout comparison");
  if (onTwoModels.length === 0)
    reasons.push("no metric improved on the holdout on two models by their manifests");
  if (comparisons.some((row) => !row.hardZero)) reasons.push("a hard counter is above zero");
  if (comparisons.some((row) => row.worsened.length > 0))
    reasons.push(`a metric worsened beyond the noise band: ${unionOf(comparisons, "worsened")}`);
  if (comparisons.some((row) => row.noiseUnknown.length > 0))
    reasons.push(`noise band unknown: ${unionOf(comparisons, "noiseUnknown")}`);
  if (comparisons.some((row) => row.failedUnits > 0)) reasons.push("a run has failed units");
  if (comparisons.some((row) => !row.meetsTargets)) reasons.push("a metric is below its target");
  return { progress: reasons.length === 0, reasons, improvedOnTwoModels: onTwoModels, comparisons };
}

function deltaText(delta) {
  const band =
    delta.beyondNoise === null
      ? "noise unknown"
      : `${delta.beyondNoise ? "beyond" : "within"} noise`;
  const spread = delta.halfRange === null ? "" : ` ±${String(delta.halfRange)}`;
  const floor =
    delta.halfRange !== null &&
    delta.minimumDetectable !== null &&
    delta.minimumDetectable > delta.halfRange
      ? `, one-unit floor ${String(delta.minimumDetectable)}`
      : "";
  return `${delta.metric} ${String(delta.before)}->${String(delta.after)} (${band}${spread}${floor})`;
}

/** One line per comparison: every metric's before, after and its relation to the noise band. */
export function renderComparison(comparison, label) {
  const hard = comparison.hardZero ? "zero" : "VIOLATED";
  const differs =
    comparison.provenanceDifferences.length === 0
      ? ""
      : `; the runs differ in ${comparison.provenanceDifferences.join(", ")}`;
  return `${label}: ${comparison.deltas.map(deltaText).join(", ")}; hard counters ${hard}${differs}`;
}

/** Deterministic lines a person reads; the first word is the verdict. */
export function renderJudgement(judgement) {
  const lines = [judgement.progress ? "PROGRESS" : `NO PROGRESS: ${judgement.reasons.join("; ")}`];
  for (const row of judgement.comparisons)
    lines.push(renderComparison(row, `${row.model} ${row.part}`));
  return lines.join("\n");
}
