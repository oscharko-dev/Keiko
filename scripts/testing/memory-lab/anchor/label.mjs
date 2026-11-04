// Labelling of what the product stored from real conversations (#4208). Real text has no truth list,
// so precision, over-application and style are judged by a person (or an agent with a human spot
// check) on the memories a live lab run actually stored.
//
//   node scripts/testing/memory-lab/anchor/label.mjs export --run <run dir> \
//        --scenarios <scenario dir> --out <sheet.json> [--arm product]
//   node scripts/testing/memory-lab/anchor/label.mjs summarize --labels <file> [--sheet <sheet.json>] \
//        [--status accepted]
//   node scripts/testing/memory-lab/anchor/label.mjs sample --labels <agent labels> [--sheet <sheet.json>] \
//        --out <review.json> [--size 50] [--seed 1]
//   node scripts/testing/memory-lab/anchor/label.mjs agreement --review <review.json> \
//        --labels <agent labels> [--sheet <sheet.json>]
//
// `export` reads `runs/*.json` of a lab run whose memory bodies were retained and writes one sheet
// entry per stored memory: `{runFile, memoryId, scenario, class, language, arm, repetition, status,
// type, body, sourceTurn, label}`. `sourceTurn` is the user turn of the scenario that contains the
// body (exact match, else a match after the lab's own text normalization, else null), so the person
// sees the message the memory came from. A label is one of correct, unnecessary, forbidden or
// third-party; the person fills in `label` in the sheet, or an agent writes a flat
// `{memoryId: label}` file.
//
// `summarize` prints counts and the precision of the labelled subset per scenario class and language
// - aggregates only: no body, no source turn, no scenario id. Memories without a label are counted as
// unlabelled and never enter the precision.
//
// `sample` and `agreement` are the human spot check of an agent's labels. `sample` draws a seeded
// random subset into a new sheet with every label empty, so the person judges without seeing what the
// agent said. `agreement` compares the two and prints the agreement, Cohen's kappa (agreement beyond
// what the two label distributions reach by chance) and the confusion counts - counts only.
//
// The sheet and the run directory hold real text: both stay outside every git work tree (a sheet in
// the checkout is refused), and the sheet is never overwritten, so labels are never lost.
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { compareStrings } from "../../../lib/compare-strings.mjs";
import { UsageError, runMain } from "../../coding-workbench-lab/lab-common.mjs";
import { normalizeText } from "../score.mjs";
import { loadScenarioDirectory } from "../scenario.mjs";
import {
  assertOutsideCheckout,
  ensurePrivateDirectory,
  readJsonFile,
  writeNewPrivateFile,
} from "./private-files.mjs";

export const LABELS = Object.freeze(["correct", "unnecessary", "forbidden", "third-party"]);
const SHEET_KIND = "memory-lab-anchor-label-sheet";
const COMMANDS = new Set(["export", "summarize", "sample", "agreement"]);
const DEFAULT_SAMPLE_SIZE = 50;
const DEFAULT_SAMPLE_SEED = 1;
// Labels that mean the product stored something it must never store (the lab's hard-zero classes).
const HARD_ZERO_LABELS = Object.freeze(["forbidden", "third-party"]);

function ratio(numerator, denominator) {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 10000) / 10000;
}

/** The user turn of the scenario that contains `body`: exact first, then normalized; else null. */
export function locateSourceTurn(body, scenario) {
  if (scenario === undefined || typeof body !== "string" || body.trim().length === 0) return null;
  const turns = scenario.turns.map((turn, index) => ({ index, text: turn.user }));
  const exact = turns.find((turn) => turn.text.includes(body));
  if (exact !== undefined) return { ...exact, match: "exact" };
  const needle = normalizeText(body);
  const normalized = turns.find((turn) => normalizeText(turn.text).includes(needle));
  return normalized === undefined ? null : { ...normalized, match: "normalized" };
}

function readRunResults(runDir) {
  const directory = join(runDir, "runs");
  if (!existsSync(directory)) throw new RangeError(`${runDir} holds no runs/ directory`);
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .toSorted((left, right) => compareStrings(left, right))
    .map((name) => ({
      file: name,
      result: readJsonFile(join(directory, name), `run file ${name}`),
    }));
}

function sheetEntry(file, result, memory, scenario) {
  return {
    runFile: file,
    memoryId: memory.id,
    scenario: result.scenario,
    class: result.class,
    language: result.language,
    arm: result.arm,
    repetition: result.repetition ?? null,
    status: memory.status ?? null,
    type: memory.type ?? null,
    body: memory.body,
    sourceTurn: locateSourceTurn(memory.body, scenario),
    label: null,
  };
}

function hasBody(memory) {
  return typeof memory?.id === "string" && typeof memory.body === "string";
}

/**
 * Builds the labelling sheet of a run: one entry per stored memory of the chosen arms. Memories
 * whose body was not retained cannot be labelled and are only counted.
 */
export function buildLabelSheet({ runDir, scenarioDir, arms }) {
  const scenarios = new Map(
    loadScenarioDirectory(scenarioDir).map((scenario) => [scenario.id, scenario]),
  );
  const results = readRunResults(runDir).filter(({ result }) => arms.includes(result.arm));
  if (results.length === 0)
    throw new RangeError(`the run holds no result of the arm(s) ${arms.join(", ")}`);
  const stored = results.flatMap(({ file, result }) =>
    (result.store?.memories ?? []).map((memory) => ({ file, result, memory })),
  );
  const entries = stored
    .filter(({ memory }) => hasBody(memory))
    .map(({ file, result, memory }) =>
      sheetEntry(file, result, memory, scenarios.get(result.scenario)),
    );
  if (entries.length === 0)
    throw new RangeError(
      stored.length === 0
        ? "the selected arms stored no memory, so there is nothing to label"
        : "the run kept no memory bodies; run the lab with bodies retained into a private directory",
    );
  return {
    schemaVersion: 1,
    kind: SHEET_KIND,
    labels: LABELS,
    arms,
    counts: {
      runs: results.length,
      memories: stored.length,
      withoutBody: stored.length - entries.length,
      withoutSourceTurn: entries.filter((entry) => entry.sourceTurn === null).length,
    },
    entries,
  };
}

/** Writes the sheet of a run to a new file outside every git work tree; never overwrites. */
export function exportLabelSheet(options) {
  const out = assertOutsideCheckout(options.out, "--out");
  const runDir = assertOutsideCheckout(options.run, "--run");
  const scenarioDir = assertOutsideCheckout(options.scenarios, "--scenarios");
  if (existsSync(out)) throw new RangeError(`refusing to overwrite an existing sheet at ${out}`);
  const sheet = buildLabelSheet({ runDir, scenarioDir, arms: options.arms ?? ["product"] });
  ensurePrivateDirectory(dirname(out));
  writeNewPrivateFile(out, `${JSON.stringify(sheet, null, 2)}\n`);
  return { out: resolve(options.out), counts: sheet.counts, entries: sheet.entries.length };
}

function isSheet(document) {
  return document?.kind === SHEET_KIND && Array.isArray(document.entries);
}

function checkedLabel(value) {
  if (value === null || value === undefined) return null;
  if (!LABELS.includes(value)) throw new RangeError(`a label is not one of ${LABELS.join("|")}`);
  return value;
}

// A flat {memoryId: label} file labels the entries of the sheet it was written for.
function labelledByMap(map, sheet) {
  if (!isSheet(sheet)) throw new RangeError("a flat labels file needs --sheet <sheet.json>");
  const ids = new Set(sheet.entries.map((entry) => entry.memoryId));
  if (ids.size !== sheet.entries.length)
    throw new RangeError("the sheet repeats a memory id, so a flat labels file is ambiguous");
  const unknown = Object.keys(map).filter((memoryId) => !ids.has(memoryId));
  if (unknown.length > 0)
    throw new RangeError(
      `${String(unknown.length)} label(s) name memories that are not in the sheet`,
    );
  return sheet.entries.map((entry) => ({ ...entry, label: checkedLabel(map[entry.memoryId]) }));
}

function labelledEntries(labels, sheet) {
  if (isSheet(labels)) {
    if (sheet !== undefined)
      throw new RangeError("--sheet is only for a flat {memoryId: label} labels file");
    return labels.entries.map((entry) => ({ ...entry, label: checkedLabel(entry.label) }));
  }
  if (labels === null || typeof labels !== "object" || Array.isArray(labels))
    throw new RangeError("the labels file is neither a sheet nor a {memoryId: label} object");
  return labelledByMap(labels, sheet);
}

function emptyGroup(key) {
  return {
    key,
    labelled: 0,
    counts: Object.fromEntries(LABELS.map((label) => [label, 0])),
    precision: null,
  };
}

function addLabel(group, label) {
  group.labelled += 1;
  group.counts[label] += 1;
  group.precision = ratio(group.counts.correct, group.labelled);
}

/**
 * Aggregates labelled entries per `class/language` and overall. The result carries counts and
 * precision only; entries without a label are counted as unlabelled.
 */
export function aggregateLabels(entries) {
  const groups = new Map();
  const overall = emptyGroup("all");
  for (const entry of entries) {
    if (entry.label === null) continue;
    const key = `${entry.class}/${entry.language}`;
    if (!groups.has(key)) groups.set(key, emptyGroup(key));
    addLabel(groups.get(key), entry.label);
    addLabel(overall, entry.label);
  }
  return {
    entries: entries.length,
    labelled: overall.labelled,
    unlabelled: entries.length - overall.labelled,
    groups: [...groups.values()].toSorted((left, right) => compareStrings(left.key, right.key)),
    overall,
    hardZero: Object.fromEntries(HARD_ZERO_LABELS.map((label) => [label, overall.counts[label]])),
  };
}

/** Summarizes a labels file (a filled-in sheet, or a flat map plus its sheet), aggregates only. */
export function summarizeLabels({ labelsPath, sheetPath, statuses }) {
  const entries = loadLabelled(labelsPath, sheetPath).filter(
    (entry) => statuses === undefined || statuses.includes(entry.status),
  );
  return { ...aggregateLabels(entries), statuses: statuses ?? null };
}

function loadLabelled(labelsPath, sheetPath) {
  const labelsFile = assertOutsideCheckout(labelsPath, "--labels");
  const sheetFile =
    sheetPath === undefined ? undefined : assertOutsideCheckout(sheetPath, "--sheet");
  const labels = readJsonFile(labelsFile, "the labels file");
  const sheet = sheetFile === undefined ? undefined : readJsonFile(sheetFile, "the label sheet");
  return labelledEntries(labels, sheet);
}

function sampleRank(seed, entry) {
  return createHash("sha256")
    .update(`${String(seed)}\0${entry.runFile}\0${entry.memoryId}`)
    .digest("hex");
}

/**
 * Draws the review sheet of a person: a seeded random subset of what the agent labelled, with every
 * label empty, so the agent's verdict cannot steer the person's.
 */
export function exportReviewSample({
  labelsPath,
  sheetPath,
  out,
  size = DEFAULT_SAMPLE_SIZE,
  seed = DEFAULT_SAMPLE_SEED,
}) {
  const outFile = assertOutsideCheckout(out, "--out");
  if (existsSync(outFile))
    throw new RangeError(`refusing to overwrite an existing sheet at ${outFile}`);
  if (!Number.isInteger(size) || size < 1)
    throw new RangeError("--size must be a positive integer");
  const labelled = loadLabelled(labelsPath, sheetPath).filter((entry) => entry.label !== null);
  if (labelled.length === 0)
    throw new RangeError("the labels file holds no label, so there is nothing to spot-check");
  const ranked = labelled
    .map((entry) => ({ entry, rank: sampleRank(seed, entry) }))
    .toSorted((left, right) => compareStrings(left.rank, right.rank));
  const entries = ranked.slice(0, size).map(({ entry }) => ({ ...entry, label: null }));
  const sheet = {
    schemaVersion: 1,
    kind: SHEET_KIND,
    labels: LABELS,
    sample: { seed, requested: size, drawn: entries.length, population: labelled.length },
    entries,
  };
  ensurePrivateDirectory(dirname(outFile));
  writeNewPrivateFile(outFile, `${JSON.stringify(sheet, null, 2)}\n`);
  return { out: resolve(out), drawn: entries.length, population: labelled.length };
}

function entryKey(entry) {
  return `${entry.runFile}\0${entry.memoryId}`;
}

function comparedPairs(reviewed, agent) {
  const agentLabels = new Map(agent.map((entry) => [entryKey(entry), entry.label]));
  const pairs = [];
  for (const entry of reviewed) {
    if (entry.label === null) continue;
    if (!agentLabels.has(entryKey(entry)))
      throw new RangeError("the review names a memory the agent's labels do not cover");
    const agentLabel = agentLabels.get(entryKey(entry));
    if (agentLabel === null) throw new RangeError("the review names a memory the agent left open");
    pairs.push({ human: entry.label, agent: agentLabel });
  }
  return pairs;
}

function shareOf(pairs, side, label) {
  return pairs.filter((pair) => pair[side] === label).length / pairs.length;
}

/** Cohen's kappa; null when the two sides used one label only, where chance explains everything. */
export function cohensKappa(pairs) {
  if (pairs.length === 0) return null;
  const observed = pairs.filter((pair) => pair.human === pair.agent).length / pairs.length;
  const chance = LABELS.reduce(
    (sum, label) => sum + shareOf(pairs, "human", label) * shareOf(pairs, "agent", label),
    0,
  );
  return chance === 1 ? null : Math.round(((observed - chance) / (1 - chance)) * 10000) / 10000;
}

function confusionOf(pairs) {
  const confusion = {};
  for (const human of LABELS) {
    confusion[human] = {};
    for (const agent of LABELS)
      confusion[human][agent] = pairs.filter(
        (pair) => pair.human === human && pair.agent === agent,
      ).length;
  }
  return confusion;
}

/** How far a person agrees with the agent on the reviewed sample; counts only. */
export function measureAgreement({ reviewPath, labelsPath, sheetPath }) {
  const reviewFile = assertOutsideCheckout(reviewPath, "--review");
  const reviewed = labelledEntries(readJsonFile(reviewFile, "the review sheet"));
  const pairs = comparedPairs(reviewed, loadLabelled(labelsPath, sheetPath));
  if (pairs.length === 0)
    throw new RangeError("the review holds no label yet, so there is no agreement to measure");
  const agreed = pairs.filter((pair) => pair.human === pair.agent).length;
  return {
    sampled: reviewed.length,
    compared: pairs.length,
    agreed,
    agreement: ratio(agreed, pairs.length),
    kappa: cohensKappa(pairs),
    confusion: confusionOf(pairs),
  };
}

/** The Markdown table a person reads; rows are the person's label, columns the agent's. */
export function renderAgreement(result) {
  const rows = LABELS.map(
    (human) =>
      `| ${human} | ${LABELS.map((agent) => String(result.confusion[human][agent])).join(" | ")} |`,
  );
  return [
    `Compared ${String(result.compared)} of ${String(result.sampled)} sampled memories: agreed on ${String(result.agreed)}.`,
    `Agreement ${cell(result.agreement)}, Cohen's kappa ${cell(result.kappa)}.`,
    "",
    `| Person \\ Agent | ${LABELS.join(" | ")} |`,
    `| --- | ${LABELS.map(() => "---").join(" | ")} |`,
    ...rows,
  ].join("\n");
}

function cell(value) {
  return value === null || value === undefined ? "n/a" : String(value);
}

/** The Markdown table a person reads; it holds counts only. */
export function renderLabelSummary(summary) {
  const rows = [...summary.groups, summary.overall].map(
    (group) =>
      `| ${group.key} | ${String(group.labelled)} | ${LABELS.map((label) => String(group.counts[label])).join(" | ")} | ${cell(group.precision)} |`,
  );
  const hard = HARD_ZERO_LABELS.filter((label) => summary.hardZero[label] > 0)
    .map((label) => `${label}=${String(summary.hardZero[label])}`)
    .join(" ");
  return [
    `Labelled ${String(summary.labelled)} of ${String(summary.entries)} stored memories (${String(summary.unlabelled)} unlabelled).`,
    ...(summary.statuses === null || summary.statuses === undefined
      ? []
      : [`Only memories with status ${summary.statuses.join(", ")} are counted.`]),
    "",
    `| Group | Labelled | ${LABELS.join(" | ")} | Precision |`,
    `| --- | --- | ${LABELS.map(() => "---").join(" | ")} | --- |`,
    ...rows,
    "",
    `Hard-zero labels: ${hard || "none"}.`,
    "Precision is correct over labelled, on the labelled subset only.",
  ].join("\n");
}

const OPTIONS = {
  run: { type: "string" },
  scenarios: { type: "string" },
  out: { type: "string" },
  arm: { type: "string", multiple: true },
  labels: { type: "string" },
  sheet: { type: "string" },
  status: { type: "string" },
  review: { type: "string" },
  size: { type: "string" },
  seed: { type: "string" },
  help: { type: "boolean", short: "h", default: false },
};

function usage() {
  return [
    "usage: node scripts/testing/memory-lab/anchor/label.mjs export --run <run dir> --scenarios <dir> --out <sheet.json> [--arm product]",
    "       node scripts/testing/memory-lab/anchor/label.mjs summarize --labels <file> [--sheet <sheet.json>] [--status accepted,proposed]",
    "       node scripts/testing/memory-lab/anchor/label.mjs sample --labels <file> [--sheet <sheet.json>] --out <review.json> [--size 50] [--seed 1]",
    "       node scripts/testing/memory-lab/anchor/label.mjs agreement --review <review.json> --labels <file> [--sheet <sheet.json>]",
    `  labels: ${LABELS.join(", ")}; the sheet holds real text and must stay outside every git work tree`,
  ].join("\n");
}

function commaList(entries) {
  return entries
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function requireOptions(values, names) {
  for (const name of names)
    if (typeof values[name] !== "string" || values[name].length === 0)
      throw new RangeError(`--${name} is required`);
}

function runExport(values, log) {
  requireOptions(values, ["run", "scenarios", "out"]);
  const arms = commaList(values.arm ?? ["product"]);
  const exported = exportLabelSheet({
    run: resolve(values.run),
    scenarios: resolve(values.scenarios),
    out: resolve(values.out),
    arms,
  });
  log(`sheet: ${exported.out}`);
  log(
    `entries=${String(exported.entries)} withoutBody=${String(exported.counts.withoutBody)} withoutSourceTurn=${String(exported.counts.withoutSourceTurn)}`,
  );
  log(`PASS anchor-label export entries=${String(exported.entries)}`);
}

function runSummarize(values, log) {
  requireOptions(values, ["labels"]);
  const summary = summarizeLabels({
    labelsPath: resolve(values.labels),
    sheetPath: values.sheet === undefined ? undefined : resolve(values.sheet),
    statuses: values.status === undefined ? undefined : commaList([values.status]),
  });
  log(renderLabelSummary(summary));
}

function integerOption(value, name, fallback) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new RangeError(`--${name} must be a whole number`);
  return Number(value);
}

function resolvedOptional(value) {
  return value === undefined ? undefined : resolve(value);
}

function runSample(values, log) {
  requireOptions(values, ["labels", "out"]);
  const sampled = exportReviewSample({
    labelsPath: resolve(values.labels),
    sheetPath: resolvedOptional(values.sheet),
    out: resolve(values.out),
    size: integerOption(values.size, "size", DEFAULT_SAMPLE_SIZE),
    seed: integerOption(values.seed, "seed", DEFAULT_SAMPLE_SEED),
  });
  log(`review sheet: ${sampled.out}`);
  log(
    `PASS anchor-label sample drawn=${String(sampled.drawn)} population=${String(sampled.population)}`,
  );
}

function runAgreement(values, log) {
  requireOptions(values, ["review", "labels"]);
  const result = measureAgreement({
    reviewPath: resolve(values.review),
    labelsPath: resolve(values.labels),
    sheetPath: resolvedOptional(values.sheet),
  });
  log(renderAgreement(result));
}

const COMMAND_BODIES = {
  export: runExport,
  summarize: runSummarize,
  sample: runSample,
  agreement: runAgreement,
};

/** The CLI body; returns the exit code. */
export async function main(argv = process.argv.slice(2), log = (line) => console.log(line)) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(`${error.message}\n\n${usage()}`);
  }
  const [command, ...extra] = parsed.positionals;
  if (parsed.values.help || command === undefined) {
    log(usage());
    return parsed.values.help ? 0 : 2;
  }
  if (extra.length > 0 || !COMMANDS.has(command))
    throw new UsageError(`unknown command\n\n${usage()}`);
  COMMAND_BODIES[command](parsed.values, log);
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runMain(() => main());
