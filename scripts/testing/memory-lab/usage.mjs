// Cost of a live run (#4209), read from the product's own Activity Log in the kept instance state
// directories (`--keep`): model calls, prompt and completion tokens and durations per scenario and
// arm, split into learning (calls under a salience correlation) and answering. Counts only; the
// log is body-free by contract and this tool never reads chat or memory content.
//
//   node scripts/testing/memory-lab/usage.mjs --run <dir> [--write]
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readActivityEvents } from "../coding-workbench-lab/activity-log-events.mjs";
import { runMain } from "../coding-workbench-lab/lab-common.mjs";

const GATEWAY_OPS = new Set(["gateway.chat.completed", "gateway.stream.completed"]);
const GATEWAY_STARTED = "gateway.chat.started";
const TURN_OP = "chat.turn.started";
const UNIT_NAME = /^(?<scenario>.+)-(?<arm>off|product|oracle)-[A-Za-z0-9]+$/u;

function emptyBucket() {
  return { calls: 0, promptTokens: 0, completionTokens: 0, durationMs: 0 };
}

function add(bucket, event) {
  bucket.calls += 1;
  bucket.promptTokens += Number(event.promptTokens ?? 0);
  bucket.completionTokens += Number(event.completionTokens ?? 0);
  bucket.durationMs += Number(event.durationMs ?? 0);
}

// A model call that belongs to a chat turn answers; every other call the product made learns.
// Learning calls carry no parent correlation today (recorded finding), so the turn set is the key.
function turnCorrelations(events) {
  const ids = new Set();
  for (const event of events)
    if (event.op === TURN_OP && typeof event.correlationId === "string")
      ids.add(event.correlationId);
  return ids;
}

/** Learning and answering usage of one instance's events, plus calls that never completed. */
export function usageOfEvents(events) {
  const turns = turnCorrelations(events);
  const usage = { learning: emptyBucket(), answering: emptyBucket(), models: new Set() };
  const started = new Set();
  const completed = new Set();
  for (const event of events) {
    if (event.op === GATEWAY_STARTED) started.add(event.correlationId);
    if (!GATEWAY_OPS.has(event.op)) continue;
    completed.add(event.correlationId);
    if (typeof event.modelId === "string") usage.models.add(event.modelId);
    add(turns.has(event.correlationId ?? "") ? usage.answering : usage.learning, event);
  }
  const unfinished = [...started].filter((id) => !completed.has(id)).length;
  return { ...usage, models: [...usage.models].toSorted(), unfinished };
}

async function unitUsage(stateRoot, unit) {
  const logs = join(stateRoot, unit, "state", "logs");
  if (!existsSync(logs)) return undefined;
  const match = UNIT_NAME.exec(unit);
  if (match === null) return undefined;
  const events = await readActivityEvents(logs);
  return { scenario: match.groups.scenario, arm: match.groups.arm, ...usageOfEvents(events) };
}

function liveMemories(runDir) {
  const runs = join(runDir, "runs");
  const totals = new Map();
  if (!existsSync(runs)) return totals;
  for (const name of readdirSync(runs).filter((file) => file.endsWith(".json"))) {
    const result = JSON.parse(readFileSync(join(runs, name), "utf8"));
    const key = `${result.scenario}:${result.arm}`;
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

/** Usage per arm with tokens per learned fact; `units` are the per-instance readings. */
export function summarizeUsage(units, liveByUnit) {
  const byArm = new Map();
  for (const unit of units) {
    const row = byArm.get(unit.arm) ?? {
      arm: unit.arm,
      instances: 0,
      learning: emptyBucket(),
      answering: emptyBucket(),
      liveMemories: 0,
      unfinished: 0,
      models: new Set(),
    };
    row.instances += 1;
    row.unfinished += unit.unfinished;
    merge(row.learning, unit.learning);
    merge(row.answering, unit.answering);
    row.liveMemories += liveByUnit.get(`${unit.scenario}:${unit.arm}`) ?? 0;
    for (const model of unit.models) row.models.add(model);
    byArm.set(unit.arm, row);
  }
  return [...byArm.values()]
    .toSorted((left, right) => left.arm.localeCompare(right.arm))
    .map((row) => ({
      ...row,
      models: [...row.models].toSorted(),
      learningTokensPerLiveMemory:
        row.liveMemories === 0
          ? null
          : Math.round(
              (row.learning.promptTokens + row.learning.completionTokens) / row.liveMemories,
            ),
      meanCallMs:
        row.learning.calls + row.answering.calls === 0
          ? null
          : Math.round(
              (row.learning.durationMs + row.answering.durationMs) /
                (row.learning.calls + row.answering.calls),
            ),
    }));
}

/** Reads every kept instance of a run directory. */
export async function collectUsage(runDir) {
  const stateRoot = join(runDir, "state");
  if (!existsSync(stateRoot)) throw new Error(`no kept state under ${runDir}; run with --keep`);
  const units = [];
  for (const unit of readdirSync(stateRoot).toSorted()) {
    const reading = await unitUsage(stateRoot, unit);
    if (reading !== undefined) units.push(reading);
  }
  return { units, byArm: summarizeUsage(units, liveMemories(runDir)) };
}

/** The Markdown table a person reads. */
export function renderUsage(byArm) {
  const lines = [
    "| Arm | Instances | Models | Learning calls | Learning tokens (prompt+completion) | Answering calls | Answering tokens | Mean call ms | Unfinished calls | Live memories | Learning tokens per live memory |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of byArm)
    lines.push(
      `| ${row.arm} | ${String(row.instances)} | ${row.models.join(", ") || "-"} | ${String(row.learning.calls)} | ${String(row.learning.promptTokens)}+${String(row.learning.completionTokens)} | ${String(row.answering.calls)} | ${String(row.answering.promptTokens)}+${String(row.answering.completionTokens)} | ${row.meanCallMs === null ? "n/a" : String(row.meanCallMs)} | ${String(row.unfinished)} | ${String(row.liveMemories)} | ${row.learningTokensPerLiveMemory === null ? "n/a" : String(row.learningTokensPerLiveMemory)} |`,
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
  if (values.write) {
    writeFileSync(join(runDir, "cost.json"), JSON.stringify(usage, null, 2));
    writeFileSync(join(runDir, "cost.md"), `${table}\n`);
  }
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runMain(main);
