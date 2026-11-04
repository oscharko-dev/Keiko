// The rhythm of measurement (#4210) as commands, so that a short run precedes every memory pull
// request and a full run follows every merged memory change or runs when the machine is free.
//
//   node scripts/testing/memory-lab/rhythm.mjs compare --baseline <dir> --candidate <dir> [--model <id>]
//   node scripts/testing/memory-lab/rhythm.mjs judge --pairs <json file> [--targets <json file>]
//   node scripts/testing/memory-lab/rhythm.mjs ledger --run <dir> --model <id> [--date YYYY-MM-DD] [--doc <path>]
//   node scripts/testing/memory-lab/rhythm.mjs headroom [--max-cpu 70] [--max-memory 70]
//
// `judge` reads `[{model, part, baseline, candidate}]` and prints the written verdict; `headroom`
// exits non-zero when the machine is busier than the given averages, so a scheduled full run yields.
import { readFileSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runMain } from "../coding-workbench-lab/lab-common.mjs";
import {
  compareRuns,
  judgeProgress,
  readRun,
  renderComparison,
  renderJudgement,
} from "./compare.mjs";
import { appendLedgerFile, ledgerRow } from "./trend.mjs";

const DEFAULT_DOC = "docs/qa/memoria-viva-lab.md";
const OPTIONS = {
  baseline: { type: "string" },
  candidate: { type: "string" },
  pairs: { type: "string" },
  targets: { type: "string" },
  run: { type: "string" },
  model: { type: "string" },
  date: { type: "string" },
  doc: { type: "string", default: DEFAULT_DOC },
  "max-cpu": { type: "string", default: "70" },
  "max-memory": { type: "string", default: "70" },
};

function required(values, name) {
  const value = values[name];
  if (typeof value !== "string" || value.length === 0)
    throw new RangeError(`--${name} is required`);
  return value;
}

// A plain comparison of two runs prints the deltas; the verdict needs holdout pairs (`judge`).
function compareCommand(values) {
  const baseline = readRun(resolve(required(values, "baseline")));
  const candidate = readRun(resolve(required(values, "candidate")));
  console.log(renderComparison(compareRuns(baseline, candidate), values.model ?? "unnamed"));
  return 0;
}

function judgeCommand(values) {
  const pairs = JSON.parse(readFileSync(resolve(required(values, "pairs")), "utf8")).map(
    (pair) => ({
      model: pair.model,
      part: pair.part,
      baseline: readRun(resolve(pair.baseline)),
      candidate: readRun(resolve(pair.candidate)),
    }),
  );
  const targets =
    values.targets === undefined ? {} : JSON.parse(readFileSync(resolve(values.targets), "utf8"));
  const judgement = judgeProgress(pairs, targets);
  console.log(renderJudgement(judgement));
  return judgement.progress ? 0 : 1;
}

function ledgerCommand(values) {
  const run = readRun(resolve(required(values, "run")));
  const date = values.date ?? new Date().toISOString().slice(0, 10);
  const row = ledgerRow(run, date, required(values, "model"));
  appendLedgerFile(resolve(values.doc), [row]);
  console.log(row);
  return 0;
}

/** Load averages as a percentage of the cores, and used memory as a percentage. */
export function headroomReading() {
  const cores = cpus().length;
  const [oneMinute] = loadavg();
  return {
    cpuPercent: Math.round((oneMinute / cores) * 100),
    memoryPercent: Math.round(((totalmem() - freemem()) / totalmem()) * 100),
  };
}

/** Parses a percentage limit; anything that is not 0..100 is a usage error, never a silent verdict. */
export function percentLimit(value, name) {
  // Number("") is 0, so an empty value must be refused before it is parsed.
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100)
    throw new RangeError(`${name} must be a percentage between 0 and 100`);
  return parsed;
}

function headroomCommand(values) {
  // Windows reports load averages as zeros, which would read as an idle machine.
  if (process.platform === "win32")
    throw new RangeError("headroom needs load averages, which this platform does not report");
  const reading = headroomReading();
  const maxCpu = percentLimit(values["max-cpu"], "--max-cpu");
  const maxMemory = percentLimit(values["max-memory"], "--max-memory");
  const ok = reading.cpuPercent <= maxCpu && reading.memoryPercent <= maxMemory;
  console.log(
    `headroom cpu=${String(reading.cpuPercent)}% memory=${String(reading.memoryPercent)}% ${ok ? "ok" : "busy"}`,
  );
  return ok ? 0 : 3;
}

const COMMANDS = {
  compare: compareCommand,
  judge: judgeCommand,
  ledger: ledgerCommand,
  headroom: headroomCommand,
};

async function main() {
  const { values, positionals } = parseArgs({ options: OPTIONS, allowPositionals: true });
  const command = COMMANDS[positionals[0] ?? ""];
  if (command === undefined)
    throw new RangeError(`usage: rhythm.mjs <${Object.keys(COMMANDS).join("|")}> ...`);
  return command(values);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runMain(main);
