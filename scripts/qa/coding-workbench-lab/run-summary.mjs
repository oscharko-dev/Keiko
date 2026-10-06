#!/usr/bin/env node
// Body-free summary of one Coding Workbench run, read from the Activity Log segments of a dev
// checkout: model turns, provider-reported prompt tokens, edit outcomes, retries and the settlement.
// Only counts, states and closed reason codes are printed; no prompt, code or model output exists
// in the log. With --ledger-row it prints a draft row for the evidence ledger (edit the outcome).
import { isMainModule } from "../../lib/is-main-module.mjs";
import {
  flatten,
  readActivityEvents,
  resolveLogDirectory,
  selectRunEvents,
} from "./activity-log-events.mjs";
import { normalizeRunSuffix, parseCli, runMain } from "./lab-common.mjs";

const USAGE = [
  "usage: node run-summary.mjs <run-id | trailing digits> [--log-dir <dir>]",
  "                            [--ledger-row [--task T2] [--mode <label>] [--head <git sha>]]",
  "",
  "Reads <log dir>/activity-*.jsonl through the Activity Log file grammar. The log directory is",
  "--log-dir, else KEIKO_LAB_LOG_DIR, else <KEIKO_STATE_DIR or ./.keiko/dev>/logs.",
].join("\n");

const OPTIONS = {
  "log-dir": { type: "string" },
  "ledger-row": { type: "boolean" },
  task: { type: "string" },
  mode: { type: "string" },
  head: { type: "string" },
};
const SETTLED_FIELDS = ["state", "status", "failureCode", "failureSummary", "outcome"];

function tally(rows, keyOf) {
  const counts = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function formatTally(counts) {
  if (counts.size === 0) return "none";
  return [...counts]
    .toSorted(
      ([leftKey, left], [rightKey, right]) => right - left || leftKey.localeCompare(rightKey),
    )
    .map(([key, count]) => `${key} x${String(count)}`)
    .join(", ");
}

function sumOf(rows, field) {
  return rows.reduce((total, row) => total + (row[field] ?? 0), 0);
}

function editKey(row) {
  const kind = row.op.split(".").at(-1);
  return `${kind} ${row.state ?? row.reasonCode ?? "-"} ${row.editForm ?? "-"}`;
}

/** Pure projection of a run's events (oldest first) into the counts the summary prints. */
export function summarizeRun(events, suffix) {
  const rows = events.map((event) => ({ ...flatten(event), op: event.op ?? "" }));
  const where = (predicate) => rows.filter((row) => predicate(row.op));
  const usage = where((op) => op === "coding-sidecar.gateway.usage-settled");
  const settled = where((op) => op.endsWith("run.settled"));
  return {
    runId:
      events
        .map((event) => event.correlationId)
        .find((id) => id?.startsWith("run-") && id.endsWith(suffix)) ?? `run-${suffix}`,
    firstTs: events[0].ts ?? "",
    lastTs: events.at(-1).ts ?? "",
    eventCount: events.length,
    turns: tally(
      where((op) => op === "coding-sidecar.gateway.outcome"),
      (row) => row.outcome,
    ),
    promptTotal: sumOf(usage, "promptTokens"),
    promptMax: Math.max(0, ...usage.map((row) => row.promptTokens ?? 0)),
    completionTotal: sumOf(usage, "completionTokens"),
    edits: tally(
      where(
        (op) =>
          op === "coding-runtime.editor-mutation.settled" || op === "coding-runtime.edit.refused",
      ),
      editKey,
    ),
    retries: tally(
      where((op) => op.startsWith("gateway.retry") || op.startsWith("gateway.circuit")),
      (row) => `${row.op} ${row.reason ?? row.outcome ?? "-"}`,
    ),
    tools: tally(
      where((op) => op.startsWith("coding-runtime.")),
      (row) => row.op,
    ),
    rejected: tally(
      where((op) => op === "coding-sidecar.gateway.rejected"),
      (row) => row.reason ?? "-",
    ),
    settled: settled.map((row) =>
      Object.fromEntries(
        SETTLED_FIELDS.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]),
      ),
    ),
  };
}

export function formatSummary(summary) {
  const turnCount = [...summary.turns.values()].reduce((total, count) => total + count, 0);
  const lines = [
    `${summary.runId}: ${summary.firstTs.slice(11, 19)} -> ${summary.lastTs.slice(11, 19)}  events=${String(summary.eventCount)}`,
    `model turns: ${String(turnCount)}  outcomes: ${formatTally(summary.turns)}`,
    `prompt tokens (provider-reported): total=${String(summary.promptTotal)}  max=${String(summary.promptMax)}  completion total=${String(summary.completionTotal)}`,
    `edits: ${formatTally(summary.edits)}`,
    `retries/circuit: ${formatTally(summary.retries)}`,
    `tools: ${formatTally(summary.tools)}`,
    ...summary.settled.map((entry) => `settled: ${JSON.stringify(entry)}`),
  ];
  if (summary.rejected.size > 0) lines.push(`gateway rejected: ${formatTally(summary.rejected)}`);
  return lines;
}

/** A draft evidence-ledger row: the outcome is the settled state and duration, to be edited by hand. */
export function ledgerRow(summary, { task = "<task>", mode = "<mode>", head = "<head>" } = {}) {
  const minutes = (Date.parse(summary.lastTs) - Date.parse(summary.firstTs)) / 60_000;
  const state = summary.settled[0]?.state ?? summary.settled[0]?.status ?? "unsettled";
  const turnCount = [...summary.turns.values()].reduce((total, count) => total + count, 0);
  const evidence = [
    `${String(turnCount)} model turns`,
    `${summary.promptTotal.toLocaleString("en-US")} cumulative prompt tokens`,
    `edits: ${formatTally(summary.edits)}`,
    `retries/circuit: ${formatTally(summary.retries)}`,
  ].join(", ");
  const cells = [
    `\`${summary.runId}\``,
    task,
    mode,
    `\`${head}\``,
    `${state} in ${minutes.toFixed(1)} min`,
    evidence,
  ];
  return `| ${cells.map((cell) => cell.replaceAll("|", "/")).join(" | ")} |`;
}

async function main() {
  const cli = parseCli({ usage: USAGE, options: OPTIONS, positionals: true });
  if (cli.help) return 0;
  const suffix = normalizeRunSuffix(cli.positionals[0]);
  const logDirectory = resolveLogDirectory(cli.values["log-dir"]);
  const events = selectRunEvents(await readActivityEvents(logDirectory), suffix);
  if (events.length === 0) {
    console.error(`no events for ${suffix} in ${logDirectory}`);
    return 1;
  }
  const summary = summarizeRun(events, suffix);
  console.log(formatSummary(summary).join("\n"));
  if (cli.values["ledger-row"]) {
    const { task, mode, head } = cli.values;
    console.log(`\n${ledgerRow(summary, { task, mode, head })}`);
  }
  return 0;
}

if (isMainModule(import.meta.url)) runMain(main);
