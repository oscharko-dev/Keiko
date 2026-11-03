// Report of a lab run (#4207): the byte-stable scorecard through the shared accumulator of
// `tests/memory-eval`, the group summary per arm, language, class and difficulty, and the Markdown a
// person reads. Timing never enters the scorecard, so two offline runs serialize identically.
import { createScorecard, serializeScorecard } from "../../../tests/memory-eval/scorecard.ts";
import { compareStrings } from "../../lib/compare-strings.mjs";
import { HARD_COUNTERS, aggregate, hardCountersViolated } from "./score.mjs";
import { isFailedUnit } from "./unit-failure.mjs";

const UNMEASURED = Object.freeze([
  "Time: decay, validity windows and multi-day gaps are not exercised live; the server has no clock override (recorded finding of #4207).",
  "Answer quality offline: the scripted answerer echoes supplied memories, so offline answer accuracy measures retrieval and injection only.",
  "Judge-based scoring: no judge model is used in this version; every verdict is deterministic term matching.",
  "Cost in live mode: model usage is read from the scripted model journal offline; live token accounting lands with the baseline (#4209).",
  "Sampling: temperature and seeds are not controlled through the product, so repetitions differ by whatever the model's own sampling does; the noise band measures exactly that.",
]);
const MAX_LISTED_FAILURES = 20;

function storeEvidence(store) {
  const counters = HARD_COUNTERS.map((name) => `${name}=${String(store.counters[name] ?? 0)}`);
  return `stored=${String(store.stored)} live=${String(store.live)} parked=${String(store.parked)} forbiddenParked=${String(store.forbiddenParked ?? 0)} correct=${String(store.correct)} missing=${store.missing.join(",") || "-"} ${counters.join(" ")}`;
}

function storePassed(store) {
  const precisionOk = store.precision === null || store.precision === 1;
  const recallOk = store.recall === null || store.recall === 1;
  return precisionOk && recallOk && !hardCountersViolated(store.counters);
}

function metric(name, value) {
  return { name, value: value === null ? -1 : value };
}

function recordStore(card, prefix, result) {
  // A unit that could not be measured is a failed entry, never a pass by absence of data.
  if (isFailedUnit(result)) {
    card.recordResult(`${prefix}:store`, false, `unit-failed:${result.error.name}`);
    return;
  }
  const store = result.store;
  card.recordResult(`${prefix}:store`, storePassed(store), storeEvidence(store), [
    metric("precision", store.precision),
    metric("recall", store.recall),
    metric("stored", store.stored),
    metric("live", store.live),
    metric("parked", store.parked),
    metric("forbiddenParked", store.forbiddenParked ?? 0),
    metric("probeCaptures", result.probeCaptures ?? 0),
    ...HARD_COUNTERS.map((name) => metric(name, store.counters[name] ?? 0)),
  ]);
}

function probeEvidence(probe) {
  const parts = Object.entries(probe)
    .filter(
      ([key]) => !["id", "kind", "passed", "elapsedMs", "answer", "suppliedIds"].includes(key),
    )
    .map(([key, value]) => `${key}=${String(value)}`);
  return `kind=${probe.kind} ${parts.join(" ")}`;
}

function recordProbes(card, prefix, result) {
  for (const probe of result.probes)
    card.recordResult(`${prefix}:probe:${probe.id}`, probe.passed, probeEvidence(probe), [
      metric("suppliedCount", probe.suppliedCount),
    ]);
}

function scopeText(scopes) {
  return (
    Object.entries(scopes ?? {})
      .toSorted(([left], [right]) => compareStrings(left, right))
      .map(([kind, count]) => `${kind}:${String(count)}`)
      .join(",") || "-"
  );
}

function recordOracle(card, prefix, result) {
  if (result.oracle === undefined) return;
  card.recordResult(
    `${prefix}:oracle-precondition`,
    result.oracle.preconditionMet,
    `mismatches=${result.oracle.mismatches.join(",") || "-"} extras=${String(result.oracle.extras ?? 0)} scopes=${scopeText(result.oracle.scopes)}`,
  );
}

function resultKey(result) {
  return `${result.scenario}:${result.arm}:r${String(result.repetition)}`;
}

/** The scorecard of a run; `results` carry a `repetition` index set by the runner. */
export function buildLabScorecard(results, generatedAt) {
  const card = createScorecard();
  const ordered = results.toSorted((left, right) =>
    compareStrings(resultKey(left), resultKey(right)),
  );
  for (const result of ordered) {
    const prefix = resultKey(result);
    recordStore(card, prefix, result);
    recordOracle(card, prefix, result);
    recordProbes(card, prefix, result);
  }
  return card.build(generatedAt);
}

// One row per group of units. A failed unit has no figures, so it is counted apart (`failed`) and
// left out of every average: it must neither lift nor lower a group, and it must stay visible.
function groupBy(results, keyOf) {
  const groups = new Map();
  for (const result of results) {
    const key = keyOf(result);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(result);
  }
  return [...groups.entries()]
    .toSorted(([left], [right]) => compareStrings(left, right))
    .map(([key, rows]) => {
      const measured = rows.filter((row) => !isFailedUnit(row));
      return { key, failed: rows.length - measured.length, ...aggregate(measured) };
    });
}

const NOISE_METRICS = Object.freeze(["precision", "recall", "answerAccuracy"]);

function halfRange(values) {
  const present = values.filter((value) => typeof value === "number");
  if (present.length < 2) return null;
  return Math.round(((Math.max(...present) - Math.min(...present)) / 2) * 10000) / 10000;
}

// The noise band of an arm: half the range of each metric across repetitions. One repetition has
// no band, and the summary says so instead of showing zero.
function noiseByArm(results) {
  const arms = [...new Set(results.map((result) => result.arm))].toSorted(compareStrings);
  return arms.map((arm) => {
    const perRepetition = groupBy(
      results.filter((result) => result.arm === arm),
      (result) => `r${String(result.repetition)}`,
    );
    const band = Object.fromEntries(
      NOISE_METRICS.map((name) => [name, halfRange(perRepetition.map((row) => row[name]))]),
    );
    return { arm, repetitions: perRepetition.length, ...band };
  });
}

function meanRounded(values) {
  const present = values.filter((value) => typeof value === "number");
  if (present.length === 0) return null;
  return Math.round(present.reduce((sum, value) => sum + value, 0) / present.length);
}

// Per arm: how long a conversation turn took (the answer, not the learning that follows it) and how
// long learning took to settle after the turns. The delay memory adds to a turn is the product arm
// minus the off arm, known only when both arms ran.
function timingByArm(results) {
  const measured = results.filter((result) => !isFailedUnit(result));
  const arms = [...new Set(measured.map((result) => result.arm))].toSorted(compareStrings);
  const rows = arms.map((arm) => {
    const units = measured.filter((result) => result.arm === arm);
    return {
      arm,
      units: units.length,
      meanTurnMs: meanRounded(units.flatMap((unit) => unit.turns.map((turn) => turn.elapsedMs))),
      meanLearnMs: meanRounded(units.map((unit) => unit.timing.learnMs)),
    };
  });
  const turnOf = (arm) => rows.find((row) => row.arm === arm)?.meanTurnMs;
  const delay = typeof turnOf("product") === "number" && typeof turnOf("off") === "number";
  return { byArm: rows, memoryDelayMs: delay ? turnOf("product") - turnOf("off") : null };
}

function failedUnitList(results) {
  return results
    .filter((result) => isFailedUnit(result))
    .map((result) => ({
      scenario: result.scenario,
      arm: result.arm,
      repetition: result.repetition,
      error: result.error.name,
    }));
}

function oracleScopes(results) {
  const totals = {};
  for (const result of results)
    for (const [kind, count] of Object.entries(result.oracle?.scopes ?? {}))
      totals[kind] = (totals[kind] ?? 0) + count;
  return totals;
}

/** Group rows per arm, language, class and difficulty, plus the overall hard counters and timing. */
export function summarizeLabRun(results) {
  const failed = failedUnitList(results);
  // The headline is the product arm. The oracle store is curated through the explicit route, so its
  // counters show that route's defects (today: project scope) and are reported apart.
  const measured = results.filter((result) => !isFailedUnit(result));
  const counters = aggregate(measured.filter((result) => result.arm === "product")).counters;
  const oracleCounters = aggregate(measured.filter((result) => result.arm === "oracle")).counters;
  return {
    schemaVersion: 1,
    runs: results.length,
    failedUnits: failed.length,
    failedUnitList: failed,
    byArm: groupBy(results, (result) => result.arm),
    byArmAndLanguage: groupBy(results, (result) => `${result.arm}/${result.language}`),
    byArmAndClass: groupBy(results, (result) => `${result.arm}/${result.class}`),
    byArmAndDifficulty: groupBy(results, (result) => `${result.arm}/${result.difficulty}`),
    noise: noiseByArm(results),
    timing: timingByArm(results),
    hardCountersViolated: hardCountersViolated(counters),
    oracleCountersViolated: hardCountersViolated(oracleCounters),
    oracleArmRan: results.some((result) => result.arm === "oracle"),
    oracleRuns: results.filter((result) => result.oracle !== undefined).length,
    oracleScopes: oracleScopes(results),
    oraclePreconditionFailures: results
      .filter((result) => result.oracle !== undefined && !result.oracle.preconditionMet)
      .map((result) => result.scenario),
    unmeasured: UNMEASURED,
  };
}

function cell(value) {
  return value === null || value === undefined ? "n/a" : String(value);
}

function groupTable(title, rows) {
  const lines = [
    `### ${title}`,
    "",
    "| Group | Runs | Failed | Precision | Recall | Answer accuracy | Abstention | No memory on unrelated | Hard counters |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    const hard = HARD_COUNTERS.filter((name) => row.counters[name] > 0)
      .map((name) => `${name}=${String(row.counters[name])}`)
      .join(" ");
    lines.push(
      `| ${row.key} | ${String(row.runs)} | ${String(row.failed)} | ${cell(row.precision)} | ${cell(row.recall)} | ${cell(row.answerAccuracy)} | ${cell(row.abstention)} | ${cell(row.noMemoryOnUnrelated)} | ${hard || "0"} |`,
    );
  }
  return lines.join("\n");
}

function noiseTable(rows) {
  const lines = [
    "### Noise band (half range across repetitions)",
    "",
    "| Arm | Repetitions | Precision | Recall | Answer accuracy |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const row of rows)
    lines.push(
      `| ${row.arm} | ${String(row.repetitions)} | ${cell(row.precision)} | ${cell(row.recall)} | ${cell(row.answerAccuracy)} |`,
    );
  lines.push("", "A difference inside the band is noise; one repetition has no band (n/a).");
  return lines.join("\n");
}

function timingTable(timing) {
  const lines = [
    "### Timing",
    "",
    "| Arm | Units | Mean turn ms | Mean learning settle ms |",
    "| --- | --- | --- | --- |",
  ];
  for (const row of timing.byArm)
    lines.push(
      `| ${row.arm} | ${String(row.units)} | ${cell(row.meanTurnMs)} | ${cell(row.meanLearnMs)} |`,
    );
  const delay =
    timing.memoryDelayMs === null
      ? "n/a (needs the off and the product arm)"
      : `${String(timing.memoryDelayMs)} ms`;
  lines.push("", `Delay added to a turn by memory (product minus off, mean turn): ${delay}.`);
  return lines.join("\n");
}

function oracleLines(summary) {
  if (!summary.oracleArmRan) return ["Oracle arm: not run."];
  const scopes = scopeText(summary.oracleScopes);
  const scopeLine = `Scope of the oracle seeds: ${scopes} (the explicit route's own doing).`;
  if (summary.oraclePreconditionFailures.length > 0)
    return [
      `Oracle precondition failed for: ${summary.oraclePreconditionFailures.join(", ")}.`,
      scopeLine,
    ];
  if (summary.oracleRuns === 0)
    return ["Oracle precondition: not established (every oracle unit failed)."];
  return ["Oracle precondition: met for every scenario that ran.", scopeLine];
}

function failureLines(summary) {
  if (summary.failedUnits === 0) return [];
  const listed = summary.failedUnitList
    .slice(0, MAX_LISTED_FAILURES)
    .map((unit) => `${unit.scenario} ${unit.arm} r${String(unit.repetition)} (${unit.error})`);
  const more = summary.failedUnits - listed.length;
  return [
    `**Failed units: ${String(summary.failedUnits)}.** They could not be measured and are left out of every figure below: ${listed.join(", ")}${more > 0 ? `, and ${String(more)} more` : ""}.`,
    "",
  ];
}

/** The Markdown a person reads: what was measured, per group, and what was not. */
export function renderLabSummary(summary, manifest, metadata) {
  return [
    "# MemoriaViva lab run",
    "",
    `Mode: ${metadata.mode}. Product head: ${metadata.productHead}. Corpus: ${manifest.count} scenarios, set digest \`${manifest.setDigest}\`. Arms: ${metadata.arms.join(", ")}. Repetitions: ${String(metadata.repetitions)}. Memory mode: ${metadata.memoryMode}, ceiling: ${metadata.ceiling}.`,
    "",
    ...failureLines(summary),
    `Hard counters in the product arm: ${summary.hardCountersViolated ? "VIOLATED" : "all zero"}. Oracle arm: ${summary.oracleCountersViolated ? "VIOLATED (the explicit route's own doing)" : "all zero"}.`,
    ...oracleLines(summary),
    "",
    groupTable("By arm", summary.byArm),
    "",
    groupTable("By arm and language", summary.byArmAndLanguage),
    "",
    groupTable("By arm and class", summary.byArmAndClass),
    "",
    groupTable("By arm and difficulty", summary.byArmAndDifficulty),
    "",
    noiseTable(summary.noise),
    "",
    timingTable(summary.timing),
    "",
    "### Not measured in this run",
    "",
    ...summary.unmeasured.map((line) => `- ${line}`),
    "",
  ].join("\n");
}

function oracleToken(summary) {
  if (!summary.oracleArmRan) return "oracle=not-run";
  return summary.oraclePreconditionFailures.length === 0
    ? "oracle=ok"
    : "oracle=precondition-failed";
}

/**
 * The deterministic last line of a run: the harness result, never a product verdict. It turns to
 * FAIL, and names the count, when a unit could not be measured.
 */
export function passFailLine(summary) {
  const hard = summary.hardCountersViolated ? "hard-counters=violated" : "hard-counters=zero";
  const oracleHard = summary.oracleCountersViolated
    ? "oracle-counters=violated"
    : "oracle-counters=zero";
  const failed = summary.failedUnits > 0;
  const tail = failed ? ` failed-units=${String(summary.failedUnits)}` : "";
  return `${failed ? "FAIL" : "PASS"} memory-lab runs=${String(summary.runs)} ${hard} ${oracleHard} ${oracleToken(summary)}${tail}`;
}

export { serializeScorecard };
