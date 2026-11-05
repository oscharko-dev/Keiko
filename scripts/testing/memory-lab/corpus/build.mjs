// Corpus builder of the MemoriaViva measurement lab (#4208).
//
//   node scripts/testing/memory-lab/corpus/build.mjs --out <dir outside the checkout> \
//        [--blueprints <dir>] [--sizes 100,1000,10000] [--seed 1 | --seeds 1,2,3] [--focused] \
//        [--writer scripted|model] \
//        [--endpoint <url> --model <id> --api-key-env KEIKO_LAB_GENERATOR_API_KEY] \
//        [--generator-label <text>]
//
// By default every blueprint is expanded to one conversation per stated size. With `--focused` it is
// expanded to focused scenarios instead (focused.mjs): one per unit of the blueprint, stated in every
// way it supports (three or four hardness kinds) and built for every seed, each carrying the scenario
// class the report groups by. Generated mass lives outside the repository: `<out>/scenarios/*.json`
// holds the scenarios and `<out>/manifest.json` the versions and digests, the generator, its share,
// the counts per class and language and the variety figures of the set. The manifest is written last,
// so its presence marks a complete corpus, and an existing manifest is never overwritten. No corpus is
// published until every conversation validates; completed jobs survive in a resumable journal.
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { URL, fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { writeContinuityJson } from "../../coding-workbench-lab/chat-continuity-campaign.mjs";
import { runMain } from "../../coding-workbench-lab/lab-common.mjs";
import { digestFiles, instrumentDigest } from "../instrument.mjs";
import { withExclusiveProcessLock } from "../../jira-chat-lab/requirements/work-project-lock.mjs";
import { openProgress } from "../progress.mjs";
import { scenarioSetManifest, validateScenario } from "../scenario.mjs";
import { blueprintDigest, loadBlueprintDirectory } from "./blueprint.mjs";
import { classCounts, coverageSection } from "./coverage.mjs";
import {
  checkFocusedIdRoom,
  focusedHardnessKinds,
  focusedUnits,
  generateFocusedScenario,
} from "./focused.mjs";
import { checkGeneratorLabel, generateScenario } from "./generate.mjs";
import { assertOutsideCheckout } from "./paths.mjs";
import { deriveSeed } from "./random.mjs";
import { mapSequential } from "./sequence.mjs";
import { varietyReport } from "./variety.mjs";
import {
  createModelWriter,
  DEFAULT_REASONING_TOKENS,
  normalizeReasoningTokens,
} from "./writer-model.mjs";
import { createScriptedWriter } from "./writer-scripted.mjs";
import { compareStrings } from "../../../lib/compare-strings.mjs";

export const DEFAULT_BLUEPRINT_DIR = resolve(
  fileURLToPath(new URL("./blueprints/", import.meta.url)),
);
export const GENERATOR_VERSION = "memory-lab-corpus-generator-1";
const WRITERS = Object.freeze(["scripted", "model"]);
const WRITER_SET = new Set(WRITERS);
const MAX_SIZE = 200000;
const MAX_SEED = 4294967295;
const PROGRESS_EVERY = 250;

const OPTIONS = {
  blueprints: { type: "string", default: DEFAULT_BLUEPRINT_DIR },
  out: { type: "string" },
  sizes: { type: "string", default: "100" },
  seed: { type: "string" },
  seeds: { type: "string" },
  focused: { type: "boolean", default: false },
  writer: { type: "string", default: "scripted" },
  endpoint: { type: "string" },
  model: { type: "string" },
  "api-key-env": { type: "string", default: "KEIKO_LAB_GENERATOR_API_KEY" },
  "generator-label": { type: "string" },
  "timeout-ms": { type: "string", default: "120000" },
  "reasoning-tokens": { type: "string", default: String(DEFAULT_REASONING_TOKENS) },
  resume: { type: "boolean", default: false },
  help: { type: "boolean", default: false },
};

const DEFAULTS = Object.fromEntries(
  Object.entries(OPTIONS)
    .filter(([, option]) => option.default !== undefined)
    .map(([name, option]) => [name, option.default]),
);

function usage() {
  return [
    "usage: node scripts/testing/memory-lab/corpus/build.mjs --out <dir> [--blueprints <dir>]",
    "  --sizes 100,1000,10000   messages per scenario (user and assistant both count)",
    "  --seed <int> | --seeds 1,2,3   the same seeds and writer output give the same corpus (default 1)",
    "  --focused                one short scenario per unit of a blueprint, in each hardness kind and for",
    "                           every seed, each with the class the report groups by (several seeds need it)",
    `  --writer ${WRITERS.join("|")}   scripted is the deterministic floor; model needs the options below`,
    "  --endpoint <url> --model <id> [--api-key-env NAME] [--timeout-ms N]",
    "  --generator-label <text> recorded in every scenario and the manifest",
    "  --reasoning-tokens N   extra output allowance, 0..65536 (default 8192; 0 for capped nonreasoning models)",
    "  --resume   continue completed scenarios with identical inputs and writer settings",
  ].join("\n");
}

function integer(value, name, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum)
    throw new RangeError(`${name} must be an integer >= ${String(minimum)}`);
  return parsed;
}

function seedList(values) {
  if (values.seeds !== undefined && values.seed !== undefined)
    throw new RangeError("--seed and --seeds are mutually exclusive");
  const parts = values.seeds === undefined ? [values.seed ?? "1"] : values.seeds.split(",");
  const seeds = parts.map((part) => integer(part.trim(), "--seed", 0));
  if (seeds.some((seed) => seed > MAX_SEED))
    throw new RangeError(`--seeds must not exceed ${String(MAX_SEED)}`);
  return [...new Set(seeds)].toSorted((left, right) => left - right);
}

function sizeList(value) {
  const sizes = value.split(",").map((part) => integer(part.trim(), "--sizes", 10));
  if (sizes.some((size) => size > MAX_SIZE))
    throw new RangeError(`--sizes must not exceed ${String(MAX_SIZE)} messages`);
  return [...new Set(sizes)].toSorted((left, right) => left - right);
}

function modelOptions(values) {
  if (!values.endpoint || !values.model)
    throw new RangeError("--writer model needs --endpoint and --model");
  let endpoint;
  try {
    endpoint = new URL(values.endpoint);
  } catch {
    throw new RangeError("--endpoint must be an http(s) URL");
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:")
    throw new RangeError("--endpoint must be an http(s) URL");
  return { endpoint: endpoint.href, model: values.model, apiKeyEnv: values["api-key-env"] };
}

/** Validated build options from parsed CLI values (also the shape `runBuild` accepts). */
export function normalizeBuildOptions(raw) {
  const values = { ...DEFAULTS, ...raw };
  if (typeof values.out !== "string" || values.out.length === 0)
    throw new RangeError("--out is required");
  const writer = values.writer;
  if (!WRITER_SET.has(writer)) throw new RangeError(`--writer must be one of ${WRITERS.join("|")}`);
  const seeds = seedList(values);
  const focused = values.focused === true;
  if (!focused && seeds.length > 1)
    throw new RangeError("several seeds need --focused: a person's scenario id carries no seed");
  return {
    out: assertOutsideCheckout(values.out, "--out"),
    blueprints: resolve(values.blueprints),
    sizes: sizeList(values.sizes),
    seed: seeds[0],
    seeds,
    focused,
    writer,
    resume: values.resume === true,
    timeoutMs: integer(values["timeout-ms"], "--timeout-ms", 1),
    reasoningTokens: normalizeReasoningTokens(values["reasoning-tokens"]),
    generatorLabel:
      values["generator-label"] === undefined
        ? undefined
        : checkGeneratorLabel(values["generator-label"]),
    ...(writer === "model" ? modelOptions(values) : {}),
  };
}

function createWriter(options, env) {
  if (options.writer === "scripted") return createScriptedWriter();
  const apiKey = env[options.apiKeyEnv];
  return createModelWriter({
    endpoint: options.endpoint,
    model: options.model,
    apiKey: apiKey ? apiKey : undefined,
    timeoutMs: options.timeoutMs,
    reasoningTokens: options.reasoningTokens,
  });
}

function blueprintSummary(blueprint) {
  return {
    id: blueprint.id,
    language: blueprint.language,
    role: blueprint.role,
    digest: blueprintDigest(blueprint),
    facts: blueprint.facts.length,
    changes: blueprint.changes.length,
    forgets: blueprint.forgets.length,
    traps: blueprint.traps.length,
    relational: blueprint.relational.length,
  };
}

function manifestEntry(entry, meta) {
  return {
    ...entry,
    file: `scenarios/${entry.id}.json`,
    blueprint: meta.blueprintId,
    unit:
      meta.focus === undefined
        ? meta.blueprintId
        : `${meta.blueprintId}/${meta.focus.kind}:${meta.focus.unit}`,
    size: meta.size,
    messages: meta.messages,
    seed: meta.seed,
    baseSeed: meta.baseSeed,
    generator: meta.generator,
    hardness: meta.hardness,
    ...(meta.focus === undefined ? {} : { focus: meta.focus }),
  };
}

function buildManifest(options, blueprints, results, writer) {
  const scenarios = results
    .map((result) => result.scenario)
    .toSorted((left, right) => compareStrings(left.id, right.id));
  const base = scenarioSetManifest(scenarios);
  const metaById = new Map(results.map((result) => [result.scenario.id, result.meta]));
  const entries = base.entries.map((entry) => manifestEntry(entry, metaById.get(entry.id)));
  const counts = classCounts(entries);
  return {
    ...base,
    entries,
    corpusVersion: `corpus-v1-${base.setDigest.slice(0, 12)}`,
    generatorVersion: GENERATOR_VERSION,
    ...(options.seeds.length === 1 ? { seed: options.seed } : {}),
    seeds: options.seeds,
    sizes: options.sizes,
    focused: options.focused,
    writer: {
      kind: options.writer,
      id: writer.id,
      label: options.generatorLabel ?? writer.id,
      ...(options.writer === "model"
        ? { model: options.model, reasoningTokens: options.reasoningTokens }
        : {}),
    },
    blueprints: blueprints.map((blueprint) => blueprintSummary(blueprint)),
    counts,
    ...(options.focused ? { coverage: coverageSection(counts, entries) } : {}),
    variety: varietyReport(
      results.map((result) => ({
        generator: result.meta.generator,
        userTexts: result.scenario.turns.map((turn) => turn.user),
      })),
    ),
  };
}

function assertFreshOutput(out, results, resume = false) {
  const directory = join(out, "scenarios");
  const present = existsSync(directory) ? new Set(readdirSync(directory)) : new Set();
  const ids = results.map((result) => result.scenario.id);
  if (new Set(ids).size !== ids.length) throw new Error("two scenarios share one id");
  const clash = results.find(({ scenario }) => {
    if (!present.has(`${scenario.id}.json`)) return false;
    if (!resume) return true;
    const existing = readFileSync(join(directory, `${scenario.id}.json`), "utf8");
    return existing !== JSON.stringify(scenario, null, 2);
  })?.scenario.id;
  if (clash !== undefined) throw new Error(`refusing to overwrite the scenario ${clash} in ${out}`);
}

function writeCorpus(options, blueprints, results, writer) {
  assertFreshOutput(options.out, results, options.resume);
  const directory = join(options.out, "scenarios");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const { scenario } of results) {
    const path = join(directory, `${scenario.id}.json`);
    if (!existsSync(path)) writeContinuityJson(path, scenario);
  }
  const manifest = buildManifest(options, blueprints, results, writer);
  writeContinuityJson(join(options.out, "manifest.json"), manifest);
  return manifest;
}

function personJobs(blueprints, options) {
  return blueprints.flatMap((blueprint) =>
    options.sizes.map((size) => ({
      run: (writer) => generatePerson(blueprint, size, options, writer),
    })),
  );
}

function generatePerson(blueprint, size, options, writer) {
  return generateScenario(blueprint, {
    size,
    seed: deriveSeed(options.seed, blueprint.id, size),
    baseSeed: options.seed,
    writer,
    generatorLabel: options.generatorLabel,
  });
}

function focusedJob(blueprint, descriptor, hardness, size, seed, options) {
  return {
    run: (writer) =>
      generateFocusedScenario(blueprint, descriptor, hardness, {
        size,
        seed,
        writer,
        generatorLabel: options.generatorLabel,
      }),
  };
}

function blueprintJobs(blueprint, options) {
  return options.sizes.flatMap((size) =>
    options.seeds.flatMap((seed) =>
      focusedUnits(blueprint).flatMap((descriptor) =>
        focusedHardnessKinds(descriptor).map((hardness) =>
          focusedJob(blueprint, descriptor, hardness, size, seed, options),
        ),
      ),
    ),
  );
}

// One job per blueprint, size, seed, unit and way of stating it, in a fixed order.
function focusedJobs(blueprints, options) {
  return blueprints.flatMap((blueprint) => blueprintJobs(blueprint, options));
}

function validateCompletedScenario(result, blueprints) {
  if (!blueprints.some((blueprint) => blueprint.id === result?.meta?.blueprintId)) return false;
  try {
    validateScenario(result.scenario);
    return true;
  } catch {
    throw new Error("a completed corpus scenario no longer validates");
  }
}

function buildProgress(options, blueprints, writer, total, assertOwned) {
  const { out, resume, ...settings } = options;
  const directory = fileURLToPath(new URL("./", import.meta.url));
  const sources = readdirSync(directory, { recursive: true })
    .filter((name) => /\.(?:mjs|json)$/u.test(name))
    .toSorted();
  return openProgress({
    out,
    resume,
    total,
    assertOwned,
    validate: (result) => validateCompletedScenario(result, blueprints),
    identity: {
      kind: "corpus-build",
      generatorVersion: GENERATOR_VERSION,
      settings,
      blueprints: blueprints.map(blueprintDigest),
      writer: writer.id,
      code: digestFiles(sources, (name) => readFileSync(join(directory, name))),
      instrument: instrumentDigest(),
    },
  });
}

/**
 * Builds a corpus with validated options. `dependencies` (for tests): `createWriter(options)` replaces
 * the writer, `env` replaces the environment the API key is read from. Returns the manifest.
 */
export function runBuild(options, log = console.log, dependencies = {}) {
  return withExclusiveProcessLock(options.out, "memory-lab-corpus", (assertOwned) =>
    runBuildExclusive(options, log, dependencies, assertOwned),
  );
}

async function runBuildExclusive(options, log, dependencies, assertOwned) {
  if (existsSync(join(options.out, "manifest.json")))
    throw new Error(`refusing to overwrite an existing corpus in ${options.out}`);
  const blueprints = loadBlueprintDirectory(options.blueprints);
  if (blueprints.length === 0) throw new RangeError("the blueprint directory holds no blueprint");
  if (options.focused)
    for (const blueprint of blueprints) checkFocusedIdRoom(blueprint.id, options.seeds);
  const writer = (dependencies.createWriter ?? createWriter)(
    options,
    dependencies.env ?? process.env,
  );
  const jobs = options.focused ? focusedJobs(blueprints, options) : personJobs(blueprints, options);
  const progress = buildProgress(options, blueprints, writer, jobs.length, assertOwned);
  const completed = progress.results.length;
  await mapSequential(jobs.slice(completed), async (job, offset) => {
    const index = completed + offset;
    const { scenario, meta } = await job.run(writer);
    progress.append({ scenario, meta });
    if (!options.focused || (index + 1) % PROGRESS_EVERY === 0 || index + 1 === jobs.length)
      log(
        options.focused
          ? `generated ${String(index + 1)} of ${String(jobs.length)} scenarios`
          : `generated ${scenario.id}: ${String(meta.messages)} messages`,
      );
    return { scenario, meta };
  });
  progress.assertOwned();
  const manifest = writeCorpus(options, blueprints, progress.results, writer);
  progress.clear();
  log(
    `PASS memory-lab-corpus scenarios=${String(manifest.count)} version=${manifest.corpusVersion} nearDuplicateRate=${String(manifest.variety.nearDuplicate.rate)}`,
  );
  return manifest;
}

async function main() {
  const { values } = parseArgs({ options: OPTIONS });
  if (values.help) {
    console.log(usage());
    return;
  }
  await runBuild(normalizeBuildOptions(values));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runMain(main);
