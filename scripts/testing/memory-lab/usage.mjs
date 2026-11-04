// Cost of a live run (#4209), read from the product's own Activity Log in the kept instance state
// directories (`--keep`): model calls, prompt and completion tokens and durations per scenario and
// arm, split by what the call was for. Counts only; the log is body-free by contract and this tool
// never reads chat or memory content.
//
//   node scripts/testing/memory-lab/usage.mjs --run <dir> [--write]
//
// A call that belongs to a chat turn (its correlation is the turn's) is `answering`. Every other
// call is the learner's, and the log gives it no parent turn, so it is placed by where it falls
// among the turns of its instance: before the first turn it is `other` (start-up work); between the
// first turn and the first probe question it is `learning` (the conversation); from the first probe
// question on it is `probing`, because memory is one switch for recall and learning and the product
// also learns from the questions the lab asks afterwards. The boundary is the (N+1)th turn of the
// instance, with N the number of conversation turns the run file of that unit records; the lab waits
// for learning to settle before it asks its first question, so a learner call does not cross it.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { compareStrings } from "../../lib/compare-strings.mjs";
import { readActivityEvents } from "../coding-workbench-lab/activity-log-events.mjs";
import { runMain } from "../coding-workbench-lab/lab-common.mjs";
import { isCallCompleted, isCallFailed, openCallKeys } from "./gateway-calls.mjs";

const TURN_OP = "chat.turn.started";
// `<scenario>-<arm>-r<repetition>-<random>`: the name run.mjs gives a unit's state directory.
const UNIT_NAME = /^(?<scenario>.+)-(?<arm>off|product|oracle)-r(?<repetition>\d+)-[A-Za-z0-9]+$/u;
const BUCKETS = Object.freeze(["learning", "answering", "probing", "other"]);

function emptyBucket() {
  return { calls: 0, promptTokens: 0, completionTokens: 0, durationMs: 0 };
}

function add(bucket, event) {
  bucket.calls += 1;
  bucket.promptTokens += Number(event.promptTokens ?? 0);
  bucket.completionTokens += Number(event.completionTokens ?? 0);
  bucket.durationMs += Number(event.durationMs ?? 0);
}

function turnCorrelations(events) {
  const ids = new Set();
  for (const event of events)
    if (event.op === TURN_OP && typeof event.correlationId === "string")
      ids.add(event.correlationId);
  return ids;
}

// Positions in the log of the first turn and of the first probe question. Without a known number of
// conversation turns there is no probe boundary, and every call after the first turn is learning.
function phaseBoundaries(events, learningTurns) {
  const starts = [];
  for (const [index, event] of events.entries()) if (event.op === TURN_OP) starts.push(index);
  const never = Number.POSITIVE_INFINITY;
  return {
    firstTurn: starts[0] ?? never,
    probeStart: learningTurns === undefined ? never : (starts[learningTurns] ?? never),
  };
}

function bucketOf(event, index, turns, phases) {
  if (turns.has(event.correlationId ?? "")) return "answering";
  if (index < phases.firstTurn) return "other";
  return index < phases.probeStart ? "learning" : "probing";
}

/**
 * Usage of one instance's events by bucket, plus calls that failed and calls that never ended.
 * `learningTurns` is the number of conversation turns of the unit (its probes follow them); leave it
 * out when it is unknown and every call after the first turn counts as learning.
 */
export function usageOfEvents(events, learningTurns) {
  const turns = turnCorrelations(events);
  const phases = phaseBoundaries(events, learningTurns);
  const usage = Object.fromEntries(BUCKETS.map((name) => [name, emptyBucket()]));
  const models = new Set();
  for (const [index, event] of events.entries()) {
    if (!isCallCompleted(event)) continue;
    if (typeof event.modelId === "string") models.add(event.modelId);
    add(usage[bucketOf(event, index, turns, phases)], event);
  }
  return {
    ...usage,
    models: [...models].toSorted(compareStrings),
    failed: events.filter((event) => isCallFailed(event)).length,
    unfinished: openCallKeys(events).size,
  };
}

function runResult(runDir, scenario, arm, repetition) {
  const file = join(runDir, "runs", `${scenario}.${arm}.r${repetition}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
}

async function unitUsage(runDir, unit) {
  const stateRoot = join(runDir, "state");
  const logs = join(stateRoot, unit, "state", "logs");
  if (!existsSync(logs)) return undefined;
  const match = UNIT_NAME.exec(unit);
  if (match === null) return { skipped: unit };
  const { scenario, arm, repetition } = match.groups;
  // A unit that failed recorded no turns although its instance ran some: its boundary is unknown.
  const result = runResult(runDir, scenario, arm, repetition);
  const learningTurns = result?.error === undefined ? result?.turns?.length : undefined;
  const events = await readActivityEvents(logs);
  return { scenario, arm, repetition: Number(repetition), ...usageOfEvents(events, learningTurns) };
}

// Live memories of each unit, keyed by scenario, arm and repetition: one run file per unit. A key
// without the repetition would add the same scenario once per kept state directory.
function liveMemories(runDir) {
  const runs = join(runDir, "runs");
  const totals = new Map();
  if (!existsSync(runs)) return totals;
  for (const name of readdirSync(runs).filter((file) => file.endsWith(".json"))) {
    const result = JSON.parse(readFileSync(join(runs, name), "utf8"));
    const key = `${result.scenario}:${result.arm}:r${String(result.repetition)}`;
    totals.set(key, (totals.get(key) ?? 0) + Number(result.store?.live ?? 0));
  }
  return totals;
}

function merge(target, source) {
  target.calls += source.calls;
  target.promptTokens += source.promptTokens;
  target.completionTokens += source.completionTokens;
  target.durationMs += source.durationMs;
}

function emptyRow(arm) {
  return {
    arm,
    instances: 0,
    ...Object.fromEntries(BUCKETS.map((name) => [name, emptyBucket()])),
    liveMemories: 0,
    failed: 0,
    unfinished: 0,
    models: new Set(),
  };
}

function meanCallMs(row) {
  const calls = BUCKETS.reduce((sum, name) => sum + row[name].calls, 0);
  const duration = BUCKETS.reduce((sum, name) => sum + row[name].durationMs, 0);
  return calls === 0 ? null : Math.round(duration / calls);
}

/** Usage per arm with tokens per learned fact; `units` are the per-instance readings. */
export function summarizeUsage(units, liveByUnit) {
  const byArm = new Map();
  for (const unit of units) {
    const row = byArm.get(unit.arm) ?? emptyRow(unit.arm);
    row.instances += 1;
    row.failed += unit.failed ?? 0;
    row.unfinished += unit.unfinished;
    for (const name of BUCKETS) merge(row[name], unit[name]);
    row.liveMemories +=
      liveByUnit.get(`${unit.scenario}:${unit.arm}:r${String(unit.repetition)}`) ?? 0;
    for (const model of unit.models) row.models.add(model);
    byArm.set(unit.arm, row);
  }
  return [...byArm.values()]
    .toSorted((left, right) => compareStrings(left.arm, right.arm))
    .map((row) => ({
      ...row,
      models: [...row.models].toSorted(compareStrings),
      learningTokensPerLiveMemory:
        row.liveMemories === 0
          ? null
          : Math.round(
              (row.learning.promptTokens + row.learning.completionTokens) / row.liveMemories,
            ),
      meanCallMs: meanCallMs(row),
    }));
}

/** Reads every kept instance of a run directory; directories of an older layout are listed as skipped. */
export async function collectUsage(runDir) {
  const stateRoot = join(runDir, "state");
  if (!existsSync(stateRoot)) throw new Error(`no kept state under ${runDir}; run with --keep`);
  const units = [];
  const skipped = [];
  for (const unit of readdirSync(stateRoot).toSorted(compareStrings)) {
    const reading = await unitUsage(runDir, unit);
    if (reading?.skipped !== undefined) skipped.push(reading.skipped);
    else if (reading !== undefined) units.push(reading);
  }
  return { units, skipped, byArm: summarizeUsage(units, liveMemories(runDir)) };
}

function tokens(bucket) {
  return `${String(bucket.promptTokens)}+${String(bucket.completionTokens)}`;
}

/** The Markdown table a person reads. */
export function renderUsage(byArm) {
  const lines = [
    "| Arm | Instances | Models | Learning calls | Learning tokens (prompt+completion) | Answering calls | Answering tokens | Probe-phase learning calls | Probe-phase learning tokens | Other calls | Mean call ms | Failed calls | Unfinished calls | Live memories | Learning tokens per live memory |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of byArm)
    lines.push(
      `| ${row.arm} | ${String(row.instances)} | ${row.models.join(", ") || "-"} | ${String(row.learning.calls)} | ${tokens(row.learning)} | ${String(row.answering.calls)} | ${tokens(row.answering)} | ${String(row.probing.calls)} | ${tokens(row.probing)} | ${String(row.other.calls)} | ${row.meanCallMs === null ? "n/a" : String(row.meanCallMs)} | ${String(row.failed)} | ${String(row.unfinished)} | ${String(row.liveMemories)} | ${row.learningTokensPerLiveMemory === null ? "n/a" : String(row.learningTokensPerLiveMemory)} |`,
    );
  return lines.join("\n");
}

async function main() {
  const { values } = parseArgs({
    options: { run: { type: "string" }, write: { type: "boolean", default: false } },
  });
  if (typeof values.run !== "string") throw new RangeError("--run <dir> is required");
  const runDir = resolve(values.run);
  const usage = await collectUsage(runDir);
  const table = renderUsage(usage.byArm);
  console.log(table);
  if (usage.skipped.length > 0)
    console.log(
      `skipped ${String(usage.skipped.length)} state director(ies) whose name carries no repetition (an older lab version wrote them)`,
    );
  if (values.write) {
    writeFileSync(join(runDir, "cost.json"), JSON.stringify(usage, null, 2));
    writeFileSync(join(runDir, "cost.md"), `${table}\n`);
  }
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runMain(main);
