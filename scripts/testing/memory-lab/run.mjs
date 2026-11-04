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
import { assertOutsideCheckout } from "./anchor/private-files.mjs";
import {
  holdoutManifest,
  holdoutScenarioName,
  maskHoldoutResult,
  openSealedHoldout,
} from "./corpus/holdout.mjs";
import { ARMS, runScenario } from "./driver.mjs";
import { CEILINGS, pendingGatewayCalls, startLabInstance } from "./instance.mjs";
import { instrumentDigest, productDistDigest } from "./instrument.mjs";
import {
  LabConfigurationError,
  assertGatewayConfigUnchanged,
  assertKeepAllowed,
  assertLoopbackGatewayConfig,
  isAnchorScenario,
  retainBodiesFor,
} from "./isolation.mjs";
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
import { failedUnitResult, isFailedUnit } from "./unit-failure.mjs";

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
  "memory-mode": { type: "string", default: "autonomous-delivery" },
  ceiling: { type: "string", default: "autonomous-delivery" },
  "budget-tokens": { type: "string", default: "1200" },
  keep: { type: "boolean", default: false },
  "allow-folded-env": { type: "boolean", default: false },
  "subject-root": { type: "string" },
  "generated-at": { type: "string", default: "0" },
  "retain-bodies": { type: "boolean", default: true },
  "label-pass": { type: "boolean", default: false },
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
    "    (both default to autonomous-delivery; the Ask for approval configuration is measured explicitly, #4209)",
    "  --keep (retain instance state; refused for real conversations)  --subject-root <checkout>  --generated-at <epoch-ms>",
    "  --allow-folded-env  measure even though the repository .env would fold KEIKO_* keys into an instance",
    "  --retain-bodies / --no-retain-bodies (bodies of real-conversation scenarios are never retained)",
    "  --label-pass  the labelling run: retain the stored bodies of anchor scenarios in the run files (real text; private directory)",
    "  --quiet-ms N  --max-wait-ms N  --learner-grace-ms N  --turn-timeout-ms N",
    "  live: --config <gateway.json> --answer-model <id> --learn-model <id>",
    "  --fail-on-hard-counters  exit 4 when a product-arm hard counter is above zero (the pre-PR run)",
    "  exit 5 when a unit could not be measured (it is recorded as unit-failed and the run goes on)",
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

// A path the run writes or reads real text through: refused inside this checkout and inside any
// other git work tree, symbolic links followed; the path itself stays as the operator spelled it.
function guardedPath(path, flag) {
  assertOutsideCheckout(path, flag);
  return resolve(path);
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
      file: guardedPath(holdout, "--holdout"),
      keyFile: guardedPath(keyFile, "--key-file"),
    },
  };
}

// The labelling pass keeps real text in its run files, so it is a deliberate, narrow request: never
// together with a sealed holdout (which retains nothing), and never without bodies retained at all.
function labelPassOption(values, source) {
  if (values["label-pass"] !== true) return false;
  if (source.holdout !== undefined)
    throw new RangeError(
      "--label-pass cannot be combined with --holdout: a sealed run retains no body",
    );
  if (values["retain-bodies"] === false)
    throw new RangeError("--label-pass keeps bodies; drop --no-retain-bodies");
  return true;
}

/** Validated run options from parsed CLI values (also the shape `runLab` accepts). */
export function normalizeOptions(raw) {
  const values = { ...DEFAULTS, ...raw };
  if (typeof values.out !== "string" || values.out.length === 0)
    throw new RangeError("--out is required");
  const out = guardedPath(values.out, "--out");
  const mode = oneOf(values.mode, ["offline", "live"], "--mode");
  assertLiveOptions(mode, values);
  const source = corpusSource(values);
  const labelPass = labelPassOption(values, source);
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
    allowFoldedEnv: values["allow-folded-env"] === true,
    subjectRoot: optionalPath(values["subject-root"]),
    generatedAt: integer(values["generated-at"], "--generated-at"),
    // A sealed run never retains a body: nothing of the conversation may reach the evidence.
    retainBodies: source.holdout === undefined && values["retain-bodies"] !== false,
    labelPass,
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

function gitOutput(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

function productHead(subjectRoot) {
  return gitOutput(subjectRoot ?? REPO_ROOT, ["rev-parse", "HEAD"]) ?? "unknown";
}

// The lab that measured, for people: its commit, and whether the lab sources carried uncommitted
// changes at the time. The instrument digest beside it is what the judge compares.
function labState() {
  const status = gitOutput(REPO_ROOT, [
    "status",
    "--porcelain",
    "--",
    "scripts/testing/memory-lab",
  ]);
  return {
    labHead: gitOutput(REPO_ROOT, ["rev-parse", "HEAD"]) ?? "unknown",
    labDirty: status === undefined ? null : status.length > 0,
  };
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
    labelPass: options.labelPass,
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

async function startUnit(label, arm, repetition, options, stateRoot) {
  // Every instance of a live run reads the configuration file afresh: it is the one that was checked.
  if (options.gatewayDigest !== undefined)
    assertGatewayConfigUnchanged(options.configPath, options.gatewayDigest);
  // The repetition is part of the name: `usage.mjs` reads it back to tell the repetitions apart.
  const prefix = `${label.replaceAll(":", "-")}-${arm}-r${String(repetition)}-`;
  const dir = mkdtempSync(join(stateRoot, prefix));
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
      allowFoldedEnv: options.allowFoldedEnv,
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
  // Anchor text keeps no body in the evidence, whatever the run asked for, unless this is the
  // labelling pass (the fixture's journal and the driver's result both follow this).
  const unitOptions = {
    ...options,
    retainBodies: retainBodiesFor(scenario, options.retainBodies, options.labelPass),
  };
  const { dir, fixture, instance, instanceStartMs } = await startUnit(
    label,
    arm,
    repetition,
    unitOptions,
    stateRoot,
  );
  activeUnit = { dir, instance, keep: unitOptions.keep };
  try {
    const context = runContext(unitOptions, arm, fixture, instance);
    const result = await runScenario(scenario, instance, context);
    return { ...result, repetition, foldedKeys: instance.foldedKeys, instanceStartMs };
  } finally {
    activeUnit = undefined;
    await instance.close();
    if (!unitOptions.keep) rmSync(dir, { recursive: true, force: true });
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

function meanOf(values) {
  return values.length === 0 ? null : Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

// A sealed run keeps the shape of every hidden conversation out of the evidence: per-unit durations
// would track how long each conversation is, so only means per arm and repetition remain.
function sealedTimingRows(results) {
  const groups = new Map();
  for (const result of results) {
    const key = `${result.arm}:r${String(result.repetition)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(result);
  }
  return [...groups.values()].map((rows) => {
    const measured = rows.filter((row) => !isFailedUnit(row));
    return {
      arm: rows[0].arm,
      repetition: rows[0].repetition,
      units: rows.length,
      failed: rows.length - measured.length,
      meanInstanceStartMs: meanOf(measured.map((row) => row.instanceStartMs)),
      meanLearnMs: meanOf(measured.map((row) => row.timing.learnMs)),
      meanProbeMs: meanOf(measured.map((row) => row.timing.probeMs)),
    };
  });
}

// One row per unit of an open run, with the turn durations and the model calls behind it.
function timingRows(results, sealed) {
  if (sealed) return sealedTimingRows(results);
  return results.map((result) => ({
    scenario: result.scenario,
    arm: result.arm,
    repetition: result.repetition,
    instanceStartMs: result.instanceStartMs,
    learnMs: result.timing.learnMs,
    probeMs: result.timing.probeMs,
    ...(isFailedUnit(result) ? { failed: true } : {}),
    turnMs: result.turns.map((turn) => turn.elapsedMs),
    modelCalls: result.requests.filter((request) => request.phase === "run").length,
    learnerCalls: result.requests.filter(
      (request) => request.phase === "run" && request.model?.endsWith("learner"),
    ).length,
  }));
}

function writeEvidence(options, corpus, results, gateway) {
  const manifest = corpus.manifest;
  const summary = summarizeLabRun(results, { sealed: corpus.sealed });
  const metadata = {
    mode: options.mode,
    productHead: productHead(options.subjectRoot),
    // The product runs from its built packages, which a git head alone does not pin.
    productDistDigest: productDistDigest(options.subjectRoot ?? REPO_ROOT),
    ...labState(),
    instrumentDigest: instrumentDigest(),
    arms: options.arms,
    repetitions: options.repetitions,
    memoryMode: options.memoryMode,
    ceiling: options.ceiling,
    budgetTokens: options.budgetTokens,
    answerModelId: options.answerModelId ?? ANSWERER_MODEL_ID,
    learnModelId: options.learnModelId ?? LEARNER_MODEL_ID,
    brokenLearner: options.brokenLearner ?? null,
    holdout: corpus.sealed,
    // `sealed` is what the judge checks before it accepts a run as the holdout part of a pair.
    sealed: corpus.sealed,
    // The digest of the gateway configuration file of a live run, `offline` otherwise. Temperature
    // and seeds are not controlled through the product, so this digest and the model ids are all the
    // configuration the manifest can name.
    configDigest: gateway.digest,
    allowFoldedEnv: options.allowFoldedEnv,
    foldedKeys: [...new Set(results.flatMap((result) => result.foldedKeys))].toSorted(),
  };
  writeContinuityJson(join(options.out, "manifest.json"), { ...manifest, metadata });
  writeFileSync(
    join(options.out, "scorecard.json"),
    serializeScorecard(buildLabScorecard(results, options.generatedAt, corpus.sealed)),
  );
  writeContinuityJson(join(options.out, "summary.json"), summary);
  writeContinuityJson(join(options.out, "timing.json"), timingRows(results, corpus.sealed));
  writeFileSync(join(options.out, "summary.md"), renderLabSummary(summary, manifest, metadata));
  return summary;
}

// The scenarios of a run and how they appear in its evidence. A sealed holdout is opened in memory
// and appears only under masked names, so no report can carry a scenario id, a fact key or a probe
// id; the names are keyed with the holdout's own key, so a guessed id cannot be checked against them.
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
  const { scenarios, maskingKey } = openSealedHoldout(
    options.holdout.file,
    options.holdout.keyFile,
  );
  return {
    scenarios,
    sealed: true,
    label: (scenario) => holdoutScenarioName(scenario, maskingKey),
    manifest: holdoutManifest(scenarios, maskingKey),
  };
}

// A live run points the product at the gateway configuration the operator named, which must keep
// every conversation on this machine; its digest goes into the manifest. An offline run has none.
function gatewayEvidence(options) {
  if (options.mode !== "live") return { digest: "offline" };
  return assertLoopbackGatewayConfig(options.configPath);
}

// A unit that fails costs that unit, not the run: it is recorded with its error name (and, where the
// scenario text may appear in evidence, a scrubbed message) and the run goes on. A refused
// configuration is different: it would fail every unit, so it ends the run.
async function runOne(scenario, arm, repetition, options, stateRoot, corpus) {
  const label = corpus.label(scenario);
  try {
    const result = await runUnit(scenario, arm, repetition, options, stateRoot, label);
    return corpus.sealed ? maskHoldoutResult(result, label) : result;
  } catch (error) {
    if (error instanceof LabConfigurationError) throw error;
    return failedUnitResult({
      scenario,
      name: label,
      arm,
      repetition,
      error,
      includeMessage: !corpus.sealed && !isAnchorScenario(scenario),
    });
  }
}

function runLine(result) {
  const head = `run ${result.scenario} ${result.arm} r${String(result.repetition)}`;
  if (isFailedUnit(result)) return `${head} FAILED (${result.error.name})`;
  const passed = result.probes.filter((probe) => probe.passed).length;
  return `${head} store=${String(result.store.live)} probes=${String(passed)}/${String(result.probes.length)}`;
}

// A sealed run names no unit and shows no per-unit result on the console: the pass counts of a
// hidden conversation would let a watcher reconstruct the holdout one unit at a time.
function sealedLine(result, ordinal) {
  const head = `holdout unit ${String(ordinal)}`;
  return isFailedUnit(result) ? `${head} failed (${result.error.name})` : `${head} done`;
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
        log(corpus.sealed ? sealedLine(result, results.length) : runLine(result));
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
  const gateway = gatewayEvidence(options);
  const corpus = loadCorpus(options);
  assertKeepAllowed(corpus.scenarios, options.keep);
  const stateRoot = prepareOutput(options, corpus);
  let results;
  try {
    results = await runAll(
      { ...options, gatewayDigest: gateway.digest === "offline" ? undefined : gateway.digest },
      corpus,
      stateRoot,
      log,
    );
  } finally {
    if (corpus.sealed) rmSync(stateRoot, { recursive: true, force: true });
  }
  if (!options.keep) rmSync(stateRoot, { recursive: true, force: true });
  const summary = writeEvidence(options, corpus, results, gateway);
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
  // The pre-PR short run turns red on a hard counter; every other reading stays in the summary. A
  // unit that could not be measured is a harness incident, not a product verdict: its own exit code.
  if (options.failOnHardCounters && summary.hardCountersViolated) return 4;
  return summary.failedUnits > 0 ? 5 : 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runMain(main);
