// CLI and programmatic entry of the MemoriaViva measurement lab (#4207).
//
//   node scripts/testing/memory-lab/run.mjs --mode offline --out /tmp/memory-lab-run
//   node scripts/testing/memory-lab/run.mjs --mode live --out <dir> --config <gateway.json> \
//        --answer-model <id> --learn-model <id> [--memory-mode ...] [--ceiling ...]
//
// Every scenario runs on its own fresh instance per arm and repetition. Evidence lands under
// `--out`, which must lie outside the checkout: the byte-stable scorecard, the group summary, the
// timing file, the manifest and one JSON per run. The last line is the deterministic harness
// result; a product verdict is read from the summary, never from the exit code.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { URL, fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { REPO_ROOT, runMain } from "../coding-workbench-lab/lab-common.mjs";
import { writeContinuityJson } from "../coding-workbench-lab/chat-continuity-campaign.mjs";
import {
  holdoutManifest,
  holdoutScenarioName,
  maskHoldoutResult,
  openHoldout,
} from "./corpus/holdout.mjs";
import { assertOutsideCheckout, outsideCheckout } from "./corpus/paths.mjs";
import { ARMS, runScenario } from "./driver.mjs";
import { CEILINGS, pendingGatewayCalls, startLabInstance } from "./instance.mjs";
import {
  buildLabScorecard,
  passFailLine,
  renderLabSummary,
  serializeScorecard,
  summarizeLabRun,
} from "./report.mjs";
import { loadScenarioDirectory, scenarioSetManifest } from "./scenario.mjs";
import {
  ANSWERER_MODEL_ID,
  LEARNER_MODEL_ID,
  startScriptedModelServer,
} from "./scripted-model.mjs";

export const DEFAULT_SCENARIO_DIR = fileURLToPath(new URL("./scenarios/", import.meta.url));
export const BROKEN_LEARNERS = Object.freeze(["whole-message", "credential", "invented"]);
const MEMORY_MODES = Object.freeze(["governed-assist", "supervised-coding", "autonomous-delivery"]);

const OPTIONS = {
  mode: { type: "string", default: "offline" },
  out: { type: "string" },
  scenarios: { type: "string" },
  holdout: { type: "string" },
  "key-file": { type: "string" },
  arms: { type: "string", default: ARMS.join(",") },
  repetitions: { type: "string", default: "1" },
  "memory-mode": { type: "string", default: "governed-assist" },
  ceiling: { type: "string", default: "governed-assist" },
  "budget-tokens": { type: "string", default: "1200" },
  keep: { type: "boolean", default: false },
  "subject-root": { type: "string" },
  "generated-at": { type: "string", default: "0" },
  "retain-bodies": { type: "boolean", default: true },
  "quiet-ms": { type: "string", default: "1500" },
  "max-wait-ms": { type: "string", default: "60000" },
  "learner-grace-ms": { type: "string", default: "3000" },
  "turn-timeout-ms": { type: "string", default: "120000" },
  config: { type: "string" },
  "answer-model": { type: "string" },
  "learn-model": { type: "string" },
  "broken-learner": { type: "string" },
  "fail-on-hard-counters": { type: "boolean", default: false },
  help: { type: "boolean", default: false },
};

function usage() {
  return [
    "usage: node scripts/testing/memory-lab/run.mjs --out <dir> [--mode offline|live]",
    `  --scenarios <dir> (default ${DEFAULT_SCENARIO_DIR})  --arms ${ARMS.join(",")}  --repetitions N`,
    "  --holdout <file> --key-file <path>  run a sealed holdout instead (aggregates only; no --scenarios, no --keep)",
    `  --memory-mode ${MEMORY_MODES.join("|")}  --ceiling ${CEILINGS.join("|")}  --budget-tokens N`,
    "  --keep (retain instance state)  --subject-root <checkout>  --generated-at <epoch-ms>",
    "  --retain-bodies / --no-retain-bodies  --quiet-ms N  --max-wait-ms N  --learner-grace-ms N  --turn-timeout-ms N",
    "  live: --config <gateway.json> --answer-model <id> --learn-model <id>",
    "  --fail-on-hard-counters  exit 4 when a product-arm hard counter is above zero (the pre-PR run)",
    `  proofs: --broken-learner ${BROKEN_LEARNERS.join("|")}`,
  ].join("\n");
}

function integer(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new RangeError(`${name} must be an integer`);
  return parsed;
}

function oneOf(value, allowed, name) {
  if (!allowed.includes(value)) throw new RangeError(`${name} must be one of ${allowed.join("|")}`);
  return value;
}

function optionalOneOf(value, allowed, name) {
  return value === undefined ? undefined : oneOf(value, allowed, name);
}

function optionalPath(value) {
  return value === undefined ? undefined : resolve(value);
}

function assertLiveOptions(mode, values) {
  if (mode !== "live") return;
  if (!values.config || !values["answer-model"] || !values["learn-model"])
    throw new RangeError("live mode needs --config, --answer-model and --learn-model");
  if (values["broken-learner"] !== undefined)
    throw new RangeError("--broken-learner is an offline proof; live mode has no scripted learner");
}

const DEFAULTS = Object.fromEntries(
  Object.entries(OPTIONS)
    .filter(([, option]) => option.default !== undefined)
    .map(([name, option]) => [name, option.default]),
);

// Where the scenarios come from: a directory, or a sealed holdout that is opened only in memory.
function corpusSource(values) {
  const { holdout, scenarios } = values;
  const keyFile = values["key-file"];
  if (holdout === undefined && keyFile === undefined)
    return { scenarios: resolve(scenarios ?? DEFAULT_SCENARIO_DIR), holdout: undefined };
  if (holdout === undefined || keyFile === undefined)
    throw new RangeError("--holdout and --key-file are used together");
  if (scenarios !== undefined)
    throw new RangeError("--holdout and --scenarios are mutually exclusive");
  if (values.keep === true)
    throw new RangeError(
      "--keep cannot be combined with --holdout: instance state holds the sealed conversation",
    );
  return {
    scenarios: undefined,
    holdout: {
      file: assertOutsideCheckout(holdout, "--holdout"),
      keyFile: assertOutsideCheckout(keyFile, "--key-file"),
    },
  };
}

/** Validated run options from parsed CLI values (also the shape `runLab` accepts). */
export function normalizeOptions(raw) {
  const values = { ...DEFAULTS, ...raw };
  if (typeof values.out !== "string" || values.out.length === 0)
    throw new RangeError("--out is required");
  const out = resolve(values.out);
  if (!outsideCheckout(out)) throw new RangeError("--out must lie outside the checkout");
  const mode = oneOf(values.mode, ["offline", "live"], "--mode");
  assertLiveOptions(mode, values);
  const source = corpusSource(values);
  const arms = values.arms.split(",").map((arm) => oneOf(arm.trim(), ARMS, "--arms"));
  return {
    mode,
    out,
    scenarios: source.scenarios,
    holdout: source.holdout,
    arms: [...new Set(arms)],
    repetitions: Math.max(1, integer(values.repetitions, "--repetitions")),
    memoryMode: oneOf(values["memory-mode"], MEMORY_MODES, "--memory-mode"),
    ceiling: oneOf(values.ceiling, CEILINGS, "--ceiling"),
    budgetTokens: integer(values["budget-tokens"], "--budget-tokens"),
    keep: values.keep === true,
    subjectRoot: optionalPath(values["subject-root"]),
    generatedAt: integer(values["generated-at"], "--generated-at"),
    // A sealed run never retains a body: nothing of the conversation may reach the evidence.
    retainBodies: source.holdout === undefined && values["retain-bodies"] !== false,
    quietMs: integer(values["quiet-ms"], "--quiet-ms"),
    maxWaitMs: integer(values["max-wait-ms"], "--max-wait-ms"),
    graceMs: integer(values["learner-grace-ms"], "--learner-grace-ms"),
    turnTimeoutMs: integer(values["turn-timeout-ms"], "--turn-timeout-ms"),
    configPath: optionalPath(values.config),
    answerModelId: values["answer-model"],
    learnModelId: values["learn-model"],
    failOnHardCounters: values["fail-on-hard-counters"] === true,
    brokenLearner: optionalOneOf(values["broken-learner"], BROKEN_LEARNERS, "--broken-learner"),
  };
}

// Deliberately wrong learners prove that the scorer and the product's guards can go red.
function brokenLearnerItems(kind) {
  if (kind === "whole-message") return (turn) => [{ body: turn.user, type: "fact" }];
  if (kind === "credential")
    return () => [{ body: "My API key is sk-lab-0123456789abcdef0123456789abcdef", type: "fact" }];
  return () => [{ body: "Der Nutzer liebt Sardinen zum Fruehstueck.", type: "preference" }];
}

function productHead(subjectRoot) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: subjectRoot ?? REPO_ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

async function startFixture(options) {
  if (options.mode !== "offline") return undefined;
  return startScriptedModelServer({ retainBodies: options.retainBodies });
}

function runContext(options, arm, fixture, instance) {
  return {
    arm,
    memoryMode: options.memoryMode,
    budgetTokens: options.budgetTokens,
    confirmForget: true,
    retainBodies: options.retainBodies,
    turnTimeoutMs: options.turnTimeoutMs,
    learning: {
      quietMs: options.quietMs,
      maxMs: options.maxWaitMs,
      graceMs: options.graceMs,
      // The product's own open model calls, from its Activity Log, are never cut short; the lab's
      // queued scripted replies are an expectation bounded by the grace period.
      openCalls: () => pendingGatewayCalls(instance),
      ...(fixture === undefined ? {} : { pendingLearner: () => fixture.pendingLearner() }),
    },
    ...(fixture === undefined ? {} : { fixture }),
    ...(options.brokenLearner === undefined
      ? {}
      : { learnerItems: brokenLearnerItems(options.brokenLearner) }),
  };
}

async function closeFixture(fixture) {
  if (fixture === undefined) return;
  await new Promise((resolve) => {
    fixture.close(() => resolve());
    fixture.closeAllConnections();
  });
}

async function startUnit(label, arm, options, stateRoot) {
  const dir = mkdtempSync(join(stateRoot, `${label.replaceAll(":", "-")}-${arm}-`));
  const fixture = await startFixture(options);
  const startedAt = Date.now();
  try {
    const instance = await startLabInstance({
      dir,
      fixture,
      ceiling: options.ceiling,
      configPath: options.configPath,
      answerModelId: options.answerModelId,
      learnModelId: options.learnModelId,
      subjectRoot: options.subjectRoot,
    });
    return { dir, fixture, instance, instanceStartMs: Date.now() - startedAt };
  } catch (error) {
    // The instance's own close would have torn the fixture down; a failed start leaves it to us.
    await closeFixture(fixture);
    if (!options.keep) rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

// The unit currently running, so that an interrupt can close its instance and fixture.
let activeUnit;

/** Closes the running unit, if any; an interrupted run must leave no process, port or state behind. */
export async function closeActiveUnit() {
  const unit = activeUnit;
  activeUnit = undefined;
  if (unit === undefined) return;
  await unit.instance.close();
  if (!unit.keep) rmSync(unit.dir, { recursive: true, force: true });
}

async function runUnit(scenario, arm, repetition, options, stateRoot, label) {
  const { dir, fixture, instance, instanceStartMs } = await startUnit(
    label,
    arm,
    options,
    stateRoot,
  );
  activeUnit = { dir, instance, keep: options.keep };
  try {
    const context = runContext(options, arm, fixture, instance);
    const result = await runScenario(scenario, instance, context);
    return { ...result, repetition, foldedKeys: instance.foldedKeys, instanceStartMs };
  } finally {
    activeUnit = undefined;
    await instance.close();
    if (!options.keep) rmSync(dir, { recursive: true, force: true });
  }
}

function installInterruptHandlers() {
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      void closeActiveUnit().finally(() => {
        process.exit(130);
      });
    });
}

function timingRows(results) {
  return results.map((result) => ({
    scenario: result.scenario,
    arm: result.arm,
    repetition: result.repetition,
    instanceStartMs: result.instanceStartMs,
    learnMs: result.timing.learnMs,
    probeMs: result.timing.probeMs,
    turnMs: result.turns.map((turn) => turn.elapsedMs),
    modelCalls: result.requests.filter((request) => request.phase === "run").length,
    learnerCalls: result.requests.filter(
      (request) => request.phase === "run" && request.model?.endsWith("learner"),
    ).length,
  }));
}

function writeEvidence(options, corpus, results) {
  const manifest = corpus.manifest;
  const summary = summarizeLabRun(results);
  const metadata = {
    mode: options.mode,
    productHead: productHead(options.subjectRoot),
    arms: options.arms,
    repetitions: options.repetitions,
    memoryMode: options.memoryMode,
    ceiling: options.ceiling,
    answerModelId: options.answerModelId ?? ANSWERER_MODEL_ID,
    learnModelId: options.learnModelId ?? LEARNER_MODEL_ID,
    brokenLearner: options.brokenLearner ?? null,
    holdout: corpus.sealed,
    foldedKeys: [...new Set(results.flatMap((result) => result.foldedKeys))].toSorted(),
  };
  writeContinuityJson(join(options.out, "manifest.json"), { ...manifest, metadata });
  writeFileSync(
    join(options.out, "scorecard.json"),
    serializeScorecard(buildLabScorecard(results, options.generatedAt)),
  );
  writeContinuityJson(join(options.out, "summary.json"), summary);
  writeContinuityJson(join(options.out, "timing.json"), timingRows(results));
  writeFileSync(join(options.out, "summary.md"), renderLabSummary(summary, manifest, metadata));
  return summary;
}

// The scenarios of a run and how they appear in its evidence. A sealed holdout is opened in memory
// and appears only under masked names, so no report can carry a scenario id, a fact key or a probe id.
function loadCorpus(options) {
  if (options.holdout === undefined) {
    const scenarios = loadScenarioDirectory(options.scenarios);
    return {
      scenarios,
      sealed: false,
      label: (scenario) => scenario.id,
      manifest: scenarioSetManifest(scenarios),
    };
  }
  const scenarios = openHoldout(options.holdout.file, options.holdout.keyFile);
  return {
    scenarios,
    sealed: true,
    label: (scenario) => holdoutScenarioName(scenario),
    manifest: holdoutManifest(scenarios),
  };
}

// A failing call can echo the conversation in its message, and an error cause is printed by many
// callers, so a sealed run reports a failure by its masked unit and the error's name alone.
function sealedFailure(label, arm, repetition, error) {
  return new Error(
    `holdout unit ${label} ${arm} r${String(repetition)} failed (${error?.name ?? "error"})`,
  );
}

function runOne(scenario, arm, repetition, options, stateRoot, corpus) {
  const label = corpus.label(scenario);
  return runUnit(scenario, arm, repetition, options, stateRoot, label).then(
    (result) => (corpus.sealed ? maskHoldoutResult(result, label) : result),
    (error) => {
      throw corpus.sealed ? sealedFailure(label, arm, repetition, error) : error;
    },
  );
}

function runLine(result) {
  const passed = result.probes.filter((probe) => probe.passed).length;
  return `run ${result.scenario} ${result.arm} r${String(result.repetition)} store=${String(result.store.live)} probes=${String(passed)}/${String(result.probes.length)}`;
}

async function runAll(options, corpus, stateRoot, log) {
  const results = [];
  for (let repetition = 0; repetition < options.repetitions; repetition += 1)
    for (const scenario of corpus.scenarios)
      for (const arm of options.arms) {
        const result = await runOne(scenario, arm, repetition, options, stateRoot, corpus);
        results.push(result);
        if (!corpus.sealed)
          writeContinuityJson(
            join(options.out, "runs", `${scenario.id}.${arm}.r${String(repetition)}.json`),
            result,
          );
        log(runLine(result));
      }
  return results;
}

// A sealed run keeps its instance state outside the evidence directory, in a private temporary one,
// so that nothing of the conversation can end up beside the report, even if the run is killed.
function prepareOutput(options, corpus) {
  if (corpus.sealed) {
    mkdirSync(options.out, { recursive: true });
    return mkdtempSync(join(tmpdir(), "memory-lab-sealed-"));
  }
  mkdirSync(join(options.out, "runs"), { recursive: true });
  mkdirSync(join(options.out, "state"), { recursive: true });
  return join(options.out, "state");
}

/** Runs the lab with validated options and returns the summary; writes evidence under `out`. */
export async function runLab(options, log = console.log) {
  if (existsSync(join(options.out, "scorecard.json")))
    throw new Error(`refusing to overwrite an existing run in ${options.out}`);
  const corpus = loadCorpus(options);
  const stateRoot = prepareOutput(options, corpus);
  let results;
  try {
    results = await runAll(options, corpus, stateRoot, log);
  } finally {
    if (corpus.sealed) rmSync(stateRoot, { recursive: true, force: true });
  }
  if (!options.keep) rmSync(stateRoot, { recursive: true, force: true });
  const summary = writeEvidence(options, corpus, results);
  log(passFailLine(summary));
  return summary;
}

async function main() {
  installInterruptHandlers();
  const { values } = parseArgs({ options: OPTIONS, allowNegative: true });
  if (values.help) {
    console.log(usage());
    return;
  }
  const options = normalizeOptions(values);
  const summary = await runLab(options);
  // The pre-PR short run turns red on a hard counter; every other reading stays in the summary.
  return options.failOnHardCounters && summary.hardCountersViolated ? 4 : 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runMain(main);
