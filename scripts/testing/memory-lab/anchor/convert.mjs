// Converter of fetched conversation sets into scenario v1 files for the MemoriaViva lab (#4208).
//
//   node scripts/testing/memory-lab/anchor/convert.mjs --in <fetch dir> --out <target dir> \
//        [--set wildchat-de,oasst2-de,longmemeval] [--sample N] [--max-turns N]
//   node scripts/testing/memory-lab/run.mjs --scenarios <target dir>/scenarios --no-retain-bodies ...
//
// Both directories must lie outside every git work tree (private-files.mjs). Scenarios land in
// `<target>/scenarios/<id>.json`, so the lab loads that directory as it is; `<target>/manifest.json`
// sits beside it because the loader refuses any JSON file that is not a scenario. The manifest holds
// counts, skip and redaction counts, style figures, licenses and the scenario digests of
// `scenarioSetManifest` - never a word of conversation text.
//
// Mapping (every scenario is validated with validateScenario before a byte is written):
//
// WildChat-1M row (`conversation` is a list of {role, content, ...}):
//   id `wildchat-<lang>-<hash12>` (hash of the dataset's conversation_hash), class `anchor-real`,
//   difficulty `noisy`, `truth: []`, `turns` = the user messages in order (the assistant's text is NOT
//   kept: the lab's answerer replies), one probe `unrelated` with kind `no-memory`.
//   Skipped: fewer than 2 user turns, more than 40 user turns, any user turn over 4000 characters, a
//   truncated or malformed cell, a duplicate id.
// OASST2 message rows (`message_id`, `parent_id`, `message_tree_id`, `role`, `text`, `lang`):
//   one thread per tree, from the root following the best-ranked child at every level (rank, then
//   creation time, then id; deleted and review-failed messages are ignored). Prompter texts become the
//   user turns; id `oasst2-<lang>-<hash12>`; the same shape and skip rules as WildChat.
// LongMemEval instance (`question_id`, `question_type`, `question`, `answer`, `haystack_sessions`,
//   `haystack_session_ids`, `answer_session_ids`):
//   id `longmemeval-<question_id slug>`, language `en`, class `anchor-benchmark`, difficulty `split`.
//   `turns` = the user turns of the haystack sessions in their order, capped by --max-turns (default
//   200): the evidence sessions (`answer_session_ids`, or any turn flagged `has_answer`) are kept
//   whole, and filler sessions are admitted in their original order while they still fit, so the
//   latest fillers are dropped first. Truth: one fact with key = question_id, `seed` = the answer,
//   `must: true`, `terms: [[answer]]` (the full answer as one alternative, never split into words).
//   The probe `question` expects `answer` with the same terms.
//   An abstention question (question_id ending in `_abs`, or question_type `abstention`) has no truth
//   and expects `abstain`. A numeric answer is written as text. Skipped: a malformed instance, a
//   `single-session-preference` question (its answer is a rubric for a judge model, which term
//   matching can never find), a question without an answer or without an evidence session, or one
//   whose kept sessions hold no user turn.
//
// Redaction (redact.mjs) runs over every real user turn and over the filler sessions of the
// benchmark; the synthetic evidence sessions stay verbatim so the answer remains findable.
import { existsSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { UsageError, runMain } from "../../coding-workbench-lab/lab-common.mjs";
import { loadScenarioDirectory, scenarioSetManifest, validateScenario } from "../scenario.mjs";
import {
  CONVERSION_LIMITS,
  convertLongMemEval,
  convertOasstTree,
  convertWildChat,
  groupOasstMessages,
} from "./converters.mjs";
import {
  assertOutsideCheckout,
  ensurePrivateDirectory,
  readJsonFile,
  writeNewPrivateFile,
  writePrivateFile,
} from "./private-files.mjs";
import { addRedactionCounts, emptyRedactionCounts, totalRedactions } from "./redact.mjs";
import { ANCHOR_SET_NAMES, anchorSet, sourceOf } from "./sets.mjs";

const PROVENANCE_KEYS = Object.freeze([
  "fetchedAt",
  "filter",
  "rowCount",
  "numRowsTotal",
  "limit",
  "partial",
  "file",
  "bytes",
  "sha256",
]);

function readFetchManifest(setDir, name) {
  const path = join(setDir, "fetch-manifest.json");
  if (!existsSync(path)) throw new RangeError(`${name} has no fetch-manifest.json; fetch it first`);
  const manifest = readJsonFile(path, `the fetch manifest of ${name}`);
  if (manifest?.set !== name)
    throw new RangeError(`the fetch manifest in ${setDir} is not ${name}`);
  if (anchorSet(name).family !== "longmemeval" && !Number.isSafeInteger(manifest.rowCount))
    throw new RangeError(`the fetch manifest of ${name} has no row count`);
  return manifest;
}

function readPageRows(path) {
  if (!existsSync(path)) return [];
  const page = readJsonFile(path, "a fetched page");
  return Array.isArray(page?.rows) ? page.rows : [];
}

// Follows the chain the fetcher wrote: offset 0, then offset + rows received, and so on, for exactly
// the row count its manifest states. A stale or overlapping page file outside the chain is never
// read, and a chain that ends early fails closed.
function* pageEntries(setDir, expectedRows) {
  const pagesDir = join(setDir, "pages");
  let offset = 0;
  while (offset < expectedRows) {
    const rows = readPageRows(join(pagesDir, `${String(offset)}.json`));
    if (rows.length === 0)
      throw new Error(
        `pages hold ${String(offset)} of ${String(expectedRows)} fetched rows; fetch again`,
      );
    yield* rows.slice(0, expectedRows - offset);
    offset += rows.length;
  }
}

function* wildChatOutcomes(set, setDir, fetched) {
  for (const entry of pageEntries(setDir, fetched.rowCount)) yield convertWildChat(entry, set);
}

function* oasstOutcomes(set, setDir, fetched) {
  const { trees, malformed } = groupOasstMessages(pageEntries(setDir, fetched.rowCount));
  for (let index = 0; index < malformed; index += 1) yield { skip: "malformed" };
  for (const [treeId, messages] of trees) yield convertOasstTree(treeId, messages, set);
}

function* longMemEvalOutcomes(setDir, fetched, maxTurns) {
  if (typeof fetched.file !== "string" || basename(fetched.file) !== fetched.file)
    throw new RangeError("the longmemeval fetch manifest names no plain file");
  const instances = readJsonFile(join(setDir, fetched.file), "the LongMemEval file");
  if (!Array.isArray(instances)) throw new RangeError("the LongMemEval file is not a JSON array");
  for (const instance of instances) yield convertLongMemEval(instance, maxTurns);
}

function outcomesFor(set, setDir, fetched, maxTurns) {
  if (set.family === "wildchat") return wildChatOutcomes(set, setDir, fetched);
  if (set.family === "oasst2") return oasstOutcomes(set, setDir, fetched);
  return longMemEvalOutcomes(setDir, fetched, maxTurns);
}

function newSetStats(set) {
  const source = sourceOf(set);
  return {
    dataset: set.dataset,
    license: source.license,
    citation: source.citation,
    language: set.language,
    examined: 0,
    produced: 0,
    skipped: {},
    redactions: emptyRedactionCounts(),
    turnsPerScenario: [],
    turnChars: [],
  };
}

// Nearest-rank percentiles of a list of numbers, or null when the list is empty.
function distribution(values) {
  if (values.length === 0) return null;
  const sorted = values.toSorted((left, right) => left - right);
  const at = (fraction) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  return { min: sorted[0], median: at(0.5), p90: at(0.9), max: sorted.at(-1) };
}

function finishStats(stats) {
  const { turnsPerScenario, turnChars, ...rest } = stats;
  return {
    ...rest,
    redactions: { ...stats.redactions, total: totalRedactions(stats.redactions) },
    style: {
      userTurns: turnChars.length,
      userTurnsPerScenario: distribution(turnsPerScenario),
      userTurnChars: distribution(turnChars),
    },
  };
}

// Counts a skip, or validates and records a produced scenario. Returns the scenario, if any.
function admit(outcome, stats, seenIds) {
  if (outcome.skip !== undefined) {
    stats.skipped[outcome.skip] = (stats.skipped[outcome.skip] ?? 0) + 1;
    return undefined;
  }
  const scenario = validateScenario(outcome.scenario);
  if (seenIds.has(scenario.id)) {
    stats.skipped.duplicate = (stats.skipped.duplicate ?? 0) + 1;
    return undefined;
  }
  seenIds.add(scenario.id);
  stats.produced += 1;
  addRedactionCounts(stats.redactions, outcome.redactions);
  stats.turnsPerScenario.push(scenario.turns.length);
  for (const turn of scenario.turns) stats.turnChars.push(turn.user.length);
  return scenario;
}

function convertSet(name, context) {
  const set = anchorSet(name);
  const setDir = join(context.inDir, name);
  const fetched = readFetchManifest(setDir, name);
  const stats = newSetStats(set);
  const scenarios = [];
  for (const outcome of outcomesFor(set, setDir, fetched, context.maxTurns)) {
    stats.examined += 1;
    const scenario = admit(outcome, stats, context.seenIds);
    if (scenario !== undefined) scenarios.push(scenario);
    if (context.sample !== undefined && scenarios.length >= context.sample) break;
  }
  const fetch = Object.fromEntries(
    PROVENANCE_KEYS.filter((key) => key in fetched).map((key) => [key, fetched[key]]),
  );
  return { name, scenarios, stats: finishStats(stats), fetch };
}

function countScenarios(results) {
  const byLanguage = {};
  for (const result of results)
    for (const scenario of result.scenarios)
      byLanguage[scenario.language] = (byLanguage[scenario.language] ?? 0) + 1;
  return {
    total: results.reduce((sum, result) => sum + result.scenarios.length, 0),
    bySet: Object.fromEntries(results.map((result) => [result.name, result.scenarios.length])),
    byLanguage,
  };
}

// `loaded` is what the lab's own loader reads back from the written files, so the digests in the
// manifest are exactly the ones a lab run over that directory reports.
function buildManifest(results, context, loaded) {
  return {
    schemaVersion: 1,
    kind: "memory-lab-anchor-conversion",
    limits: { ...CONVERSION_LIMITS, sample: context.sample ?? null, maxTurns: context.maxTurns },
    counts: countScenarios(results),
    sets: Object.fromEntries(
      results.map((result) => [result.name, { ...result.stats, fetch: result.fetch }]),
    ),
    scenarioSet: scenarioSetManifest(loaded),
  };
}

function refuseExistingOutput(outDir) {
  const scenarioDir = join(outDir, "scenarios");
  const holdsScenarios = existsSync(scenarioDir) && readdirSync(scenarioDir).length > 0;
  if (holdsScenarios || existsSync(join(outDir, "manifest.json")))
    throw new RangeError(`refusing to overwrite an existing conversion in ${outDir}`);
}

function writeScenarios(directory, scenarios) {
  ensurePrivateDirectory(directory);
  for (const scenario of scenarios)
    writeNewPrivateFile(
      join(directory, `${scenario.id}.json`),
      `${JSON.stringify(scenario, null, 2)}\n`,
    );
}

/**
 * Converts the fetched sets under `options.in` into `<options.out>/scenarios` plus `manifest.json`
 * and returns the manifest. Options: in, out, sets (default: every fetched set), sample (scenarios
 * per set, default all), maxTurns (LongMemEval user-turn cap, default 200).
 */
export function convertAnchorSets(options) {
  const inDir = assertOutsideCheckout(options.in, "--in");
  const outDir = assertOutsideCheckout(options.out, "--out");
  const names =
    options.sets ??
    ANCHOR_SET_NAMES.filter((name) => existsSync(join(inDir, name, "fetch-manifest.json")));
  if (names.length === 0) throw new RangeError("--in holds no fetched set");
  refuseExistingOutput(outDir);
  const context = {
    inDir,
    sample: options.sample,
    maxTurns: options.maxTurns ?? CONVERSION_LIMITS.defaultMaxTurns,
    seenIds: new Set(),
  };
  const results = names.map((name) => convertSet(name, context));
  const scenarioDir = join(outDir, "scenarios");
  writeScenarios(
    scenarioDir,
    results.flatMap((result) => result.scenarios),
  );
  const manifest = buildManifest(results, context, loadScenarioDirectory(scenarioDir));
  writePrivateFile(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

const OPTIONS = {
  in: { type: "string" },
  out: { type: "string" },
  set: { type: "string", multiple: true },
  sample: { type: "string" },
  "max-turns": { type: "string" },
  help: { type: "boolean", short: "h", default: false },
};

function usage() {
  return [
    "usage: node scripts/testing/memory-lab/anchor/convert.mjs --in <fetch dir> --out <target dir>",
    `  [--set ${ANCHOR_SET_NAMES.join(",")}] [--sample N per set] [--max-turns N, LongMemEval cap, default ${String(CONVERSION_LIMITS.defaultMaxTurns)}]`,
    "  both directories must lie outside every git work tree; scenarios land in <target>/scenarios",
  ].join("\n");
}

function optionalPositive(value, name) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new RangeError(`${name} must be a positive integer`);
  return parsed;
}

/** CLI values to convert options; a defect in them is a RangeError. */
export function normalizeConvertOptions(values) {
  if (typeof values.in !== "string" || typeof values.out !== "string")
    throw new RangeError("--in and --out are required");
  const names = (values.set ?? [])
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim());
  for (const name of names) anchorSet(name);
  return {
    in: resolve(values.in),
    out: resolve(values.out),
    sets: names.length === 0 ? undefined : [...new Set(names)],
    sample: optionalPositive(values.sample, "--sample"),
    maxTurns: optionalPositive(values["max-turns"], "--max-turns"),
  };
}

function summaryLine(name, stats) {
  const skipped = Object.entries(stats.skipped)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => `${reason}=${String(count)}`)
    .join(",");
  return `${name} examined=${String(stats.examined)} produced=${String(stats.produced)} skipped=${skipped || "-"} redactions=${String(stats.redactions.total)}`;
}

/** The CLI body; returns the exit code. */
export async function main(argv = process.argv.slice(2), log = (line) => console.log(line)) {
  let values;
  try {
    values = parseArgs({ args: argv, options: OPTIONS, strict: true }).values;
  } catch (error) {
    throw new UsageError(`${error.message}\n\n${usage()}`);
  }
  if (values.help) {
    log(usage());
    return 0;
  }
  const options = normalizeConvertOptions(values);
  const manifest = convertAnchorSets(options);
  for (const [name, stats] of Object.entries(manifest.sets)) log(summaryLine(name, stats));
  log(`scenarios: ${join(options.out, "scenarios")}`);
  log(`PASS anchor-convert scenarios=${String(manifest.counts.total)}`);
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runMain(() => main());
