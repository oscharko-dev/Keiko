// Report of a lab run (#4207): the byte-stable scorecard through the shared accumulator of
// `tests/memory-eval`, the group summary per arm, language and class, and the Markdown a person
// reads. Timing never enters the scorecard, so two offline runs serialize identically.
import { createScorecard, serializeScorecard } from "../../../tests/memory-eval/scorecard.ts";
import { HARD_COUNTERS, aggregate, hardCountersViolated } from "./score.mjs";

const UNMEASURED = Object.freeze([
  "Time: decay, validity windows and multi-day gaps are not exercised live; the server has no clock override (recorded finding of #4207).",
  "Answer quality offline: the scripted answerer echoes supplied memories, so offline answer accuracy measures retrieval and injection only.",
  "Judge-based scoring: no judge model is used in this version; every verdict is deterministic term matching.",
  "Cost in live mode: model usage is read from the scripted model journal offline; live token accounting lands with the baseline (#4209).",
]);

function storeEvidence(store) {
  const counters = HARD_COUNTERS.map((name) => `${name}=${String(store.counters[name] ?? 0)}`);
  return `stored=${String(store.stored)} live=${String(store.live)} parked=${String(store.parked)} correct=${String(store.correct)} missing=${store.missing.join(",") || "-"} ${counters.join(" ")}`;
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
  const store = result.store;
  card.recordResult(`${prefix}:store`, storePassed(store), storeEvidence(store), [
    metric("precision", store.precision),
    metric("recall", store.recall),
    metric("stored", store.stored),
    metric("live", store.live),
    metric("parked", store.parked),
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

function recordOracle(card, prefix, result) {
  if (result.oracle === undefined) return;
  card.recordResult(
    `${prefix}:oracle-precondition`,
    result.oracle.preconditionMet,
    `mismatches=${result.oracle.mismatches.join(",") || "-"}`,
  );
}

/** The scorecard of a run; `results` carry a `repetition` index set by the runner. */
export function buildLabScorecard(results, generatedAt) {
  const card = createScorecard();
  const ordered = results.toSorted((left, right) =>
    resultKey(left).localeCompare(resultKey(right)),
  );
  for (const result of ordered) {
    const prefix = resultKey(result);
    recordStore(card, prefix, result);
    recordOracle(card, prefix, result);
    recordProbes(card, prefix, result);
  }
  return card.build(generatedAt);
}

function resultKey(result) {
  return `${result.scenario}:${result.arm}:r${String(result.repetition)}`;
}

function groupBy(results, keyOf) {
  const groups = new Map();
  for (const result of results) {
    const key = keyOf(result);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(result);
  }
  return [...groups.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, rows]) => ({ key, ...aggregate(rows) }));
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
  const arms = [...new Set(results.map((result) => result.arm))].toSorted();
  return arms.map((arm) => {
    const perRepetition = groupBy(
      results.filter((result) => result.arm === arm),
      (result) => `r${String(result.repetition)}`,
    );
    const band = Object.fromEntries(
      NOISE_METRICS.map((metric) => [metric, halfRange(perRepetition.map((row) => row[metric]))]),
    );
    return { arm, repetitions: perRepetition.length, ...band };
  });
}

/** Group rows per arm, per arm and language, per arm and class, plus the overall hard counters. */
export function summarizeLabRun(results) {
  // The headline is the product arm. The oracle store is curated through the explicit route, so its
  // counters show that route's defects (today: project scope) and are reported apart.
  const counters = aggregate(results.filter((result) => result.arm === "product")).counters;
  const oracleCounters = aggregate(results.filter((result) => result.arm === "oracle")).counters;
  return {
    schemaVersion: 1,
    runs: results.length,
    byArm: groupBy(results, (result) => result.arm),
    byArmAndLanguage: groupBy(results, (result) => `${result.arm}/${result.language}`),
    byArmAndClass: groupBy(results, (result) => `${result.arm}/${result.class}`),
    noise: noiseByArm(results),
    hardCountersViolated: hardCountersViolated(counters),
    oracleCountersViolated: hardCountersViolated(oracleCounters),
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
    "| Group | Runs | Precision | Recall | Answer accuracy | Abstention | No memory on unrelated | Hard counters |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    const hard = HARD_COUNTERS.filter((name) => row.counters[name] > 0)
      .map((name) => `${name}=${String(row.counters[name])}`)
      .join(" ");
    lines.push(
      `| ${row.key} | ${String(row.runs)} | ${cell(row.precision)} | ${cell(row.recall)} | ${cell(row.answerAccuracy)} | ${cell(row.abstention)} | ${cell(row.noMemoryOnUnrelated)} | ${hard || "0"} |`,
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

/** The Markdown a person reads: what was measured, per group, and what was not. */
export function renderLabSummary(summary, manifest, metadata) {
  return [
    "# MemoriaViva lab run",
    "",
    `Mode: ${metadata.mode}. Product head: ${metadata.productHead}. Corpus: ${manifest.count} scenarios, set digest \`${manifest.setDigest}\`. Arms: ${metadata.arms.join(", ")}. Repetitions: ${String(metadata.repetitions)}. Memory mode: ${metadata.memoryMode}, ceiling: ${metadata.ceiling}.`,
    "",
    `Hard counters in the product arm: ${summary.hardCountersViolated ? "VIOLATED" : "all zero"}. Oracle arm: ${summary.oracleCountersViolated ? "VIOLATED (the explicit route's own doing)" : "all zero"}.`,
    summary.oraclePreconditionFailures.length === 0
      ? "Oracle precondition: met for every scenario."
      : `Oracle precondition failed for: ${summary.oraclePreconditionFailures.join(", ")}.`,
    "",
    groupTable("By arm", summary.byArm),
    "",
    groupTable("By arm and language", summary.byArmAndLanguage),
    "",
    groupTable("By arm and class", summary.byArmAndClass),
    "",
    noiseTable(summary.noise),
    "",
    "### Not measured in this run",
    "",
    ...summary.unmeasured.map((line) => `- ${line}`),
    "",
  ].join("\n");
}

/** The deterministic last line of a run: the harness result, never a product verdict. */
export function passFailLine(summary) {
  const hard = summary.hardCountersViolated ? "hard-counters=violated" : "hard-counters=zero";
  const oracle =
    summary.oraclePreconditionFailures.length === 0 ? "oracle=ok" : "oracle=precondition-failed";
  const oracleHard = summary.oracleCountersViolated
    ? "oracle-counters=violated"
    : "oracle-counters=zero";
  return `PASS memory-lab runs=${String(summary.runs)} ${hard} ${oracleHard} ${oracle}`;
}

export { serializeScorecard };
