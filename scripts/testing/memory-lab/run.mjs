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
import { isAbsolute, join, relative, resolve } from "node:path";
import { URL, fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { REPO_ROOT, runMain } from "../coding-workbench-lab/lab-common.mjs";
import { writeContinuityJson } from "../coding-workbench-lab/chat-continuity-campaign.mjs";
import { ARMS, runScenario } from "./driver.mjs";
import { CEILINGS, startLabInstance } from "./instance.mjs";
import {
  buildLabScorecard,
  passFailLine,
  renderLabSummary,
  serializeScorecard,
  summarizeLabRun,
} from "./report.mjs";
import { loadScenarioDirectory, scenarioSetManifest } from "./scenario.mjs";
import { startScriptedModelServer } from "./scripted-model.mjs";

export const DEFAULT_SCENARIO_DIR = fileURLToPath(new URL("./scenarios/", import.meta.url));
export const BROKEN_LEARNERS = Object.freeze(["whole-message", "credential", "invented"]);
const MEMORY_MODES = Object.freeze(["governed-assist", "supervised-coding", "autonomous-delivery"]);

const OPTIONS = {
  mode: { type: "string", default: "offline" },
  out: { type: "string" },
  scenarios: { type: "string", default: DEFAULT_SCENARIO_DIR },
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
  help: { type: "boolean", default: false },
};

function usage() {
  return [
    "usage: node scripts/testing/memory-lab/run.mjs --out <dir> [--mode offline|live]",
    `  --scenarios <dir> (default ${DEFAULT_SCENARIO_DIR})  --arms ${ARMS.join(",")}  --repetitions N`,
    `  --memory-mode ${MEMORY_MODES.join("|")}  --ceiling ${CEILINGS.join("|")}  --budget-tokens N`,
    "  --keep (retain instance state)  --subject-root <checkout>  --generated-at <epoch-ms>",
    "  --retain-bodies / --no-retain-bodies  --quiet-ms N  --max-wait-ms N  --learner-grace-ms N  --turn-timeout-ms N",
    "  live: --config <gateway.json> --answer-model <id> --learn-model <id>",
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

function outsideCheckout(path) {
  const relativePath = relative(REPO_ROOT, path);
  return relativePath.startsWith("..") || isAbsolute(relativePath);
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

/** Validated run options from parsed CLI values (also the shape `runLab` accepts). */
export function normalizeOptions(raw) {
  const values = { ...DEFAULTS, ...raw };
  if (typeof values.out !== "string" || values.out.length === 0)
    throw new RangeError("--out is required");
  const out = resolve(values.out);
  if (!outsideCheckout(out)) throw new RangeError("--out must lie outside the checkout");
  const mode = oneOf(values.mode, ["offline", "live"], "--mode");
  assertLiveOptions(mode, values);
  const arms = values.arms.split(",").map((arm) => oneOf(arm.trim(), ARMS, "--arms"));
  return {
    mode,
    out,
    scenarios: resolve(values.scenarios),
    arms: [...new Set(arms)],
    repetitions: Math.max(1, integer(values.repetitions, "--repetitions")),
    memoryMode: oneOf(values["memory-mode"], MEMORY_MODES, "--memory-mode"),
    ceiling: oneOf(values.ceiling, CEILINGS, "--ceiling"),
    budgetTokens: integer(values["budget-tokens"], "--budget-tokens"),
    keep: values.keep === true,
    subjectRoot: optionalPath(values["subject-root"]),
    generatedAt: integer(values["generated-at"], "--generated-at"),
    retainBodies: values["retain-bodies"] !== false,
    quietMs: integer(values["quiet-ms"], "--quiet-ms"),
    maxWaitMs: integer(values["max-wait-ms"], "--max-wait-ms"),
    graceMs: integer(values["learner-grace-ms"], "--learner-grace-ms"),
    turnTimeoutMs: integer(values["turn-timeout-ms"], "--turn-timeout-ms"),
    configPath: optionalPath(values.config),
    answerModelId: values["answer-model"],
    learnModelId: values["learn-model"],
    brokenLearner: optionalOneOf(values["broken-learner"], BROKEN_LEARNERS, "--broken-learner"),
  };
}

// Deliberately wrong learners prove that the scorer and the product's guards can go red.
function brokenLearnerItems(kind) {
  if (kind === "whole-message") return (turn) => [{ body: turn.user, type: "semantic-fact" }];
  if (kind === "credential")
    return () => [
      { body: "My API key is sk-lab-0123456789abcdef0123456789abcdef", type: "semantic-fact" },
    ];
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

function runContext(options, arm, fixture) {
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

async function startUnit(scenario, arm, options, stateRoot) {
  const dir = mkdtempSync(join(stateRoot, `${scenario.id}-${arm}-`));
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

async function runUnit(scenario, arm, repetition, options, stateRoot) {
  const { dir, fixture, instance, instanceStartMs } = await startUnit(
    scenario,
    arm,
    options,
    stateRoot,
  );
  try {
    const result = await runScenario(scenario, instance, runContext(options, arm, fixture));
    return { ...result, repetition, foldedKeys: instance.foldedKeys, instanceStartMs };
  } finally {
    await instance.close();
    if (!options.keep) rmSync(dir, { recursive: true, force: true });
  }
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

function writeEvidence(options, scenarios, results) {
  const manifest = scenarioSetManifest(scenarios);
  const summary = summarizeLabRun(results);
  const metadata = {
    mode: options.mode,
    productHead: productHead(options.subjectRoot),
    arms: options.arms,
    repetitions: options.repetitions,
    memoryMode: options.memoryMode,
    ceiling: options.ceiling,
    brokenLearner: options.brokenLearner ?? null,
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

/** Runs the lab with validated options and returns the summary; writes evidence under `out`. */
export async function runLab(options, log = console.log) {
  if (existsSync(join(options.out, "scorecard.json")))
    throw new Error(`refusing to overwrite an existing run in ${options.out}`);
  mkdirSync(join(options.out, "runs"), { recursive: true });
  const stateRoot =
    mkdirSync(join(options.out, "state"), { recursive: true }) ?? join(options.out, "state");
  const scenarios = loadScenarioDirectory(options.scenarios);
  const results = [];
  for (let repetition = 0; repetition < options.repetitions; repetition += 1)
    for (const scenario of scenarios)
      for (const arm of options.arms) {
        const result = await runUnit(scenario, arm, repetition, options, stateRoot);
        results.push(result);
        writeContinuityJson(
          join(options.out, "runs", `${scenario.id}.${arm}.r${String(repetition)}.json`),
          result,
        );
        log(
          `run ${scenario.id} ${arm} r${String(repetition)} store=${String(result.store.live)} probes=${String(result.probes.filter((probe) => probe.passed).length)}/${String(result.probes.length)}`,
        );
      }
  if (!options.keep) rmSync(stateRoot, { recursive: true, force: true });
  const summary = writeEvidence(options, scenarios, results);
  log(passFailLine(summary));
  return summary;
}

async function main() {
  const { values } = parseArgs({ options: OPTIONS, allowNegative: true });
  if (values.help) {
    console.log(usage());
    return;
  }
  await runLab(normalizeOptions(values));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runMain(main);
