#!/usr/bin/env node
// Body-free summary of one Coding Workbench run, read from the Activity Log segments of a dev
// checkout: model turns, provider-reported prompt tokens, edit outcomes, retries and the settlement.
// Only counts, states and closed reason codes are printed; no prompt, code or model output exists
// in the log. With --ledger-row it prints a draft row for the evidence ledger (edit the outcome);
// the row says who drove the run and who answered its approvals, so a driver-approved run never
// reads as human-in-the-loop evidence. The log names this tool reads are checked against
// docs/observability/op-catalog.generated.json at start.
import { isMainModule } from "../../lib/is-main-module.mjs";
import {
  flatten,
  readActivityEvents,
  resolveLogDirectory,
  selectRunEvents,
} from "./activity-log-events.mjs";
import {
  UsageError,
  approvalPolicyText,
  normalizeRunSuffix,
  parseApprove,
  parseCli,
  runMain,
} from "./lab-common.mjs";
import { assertOperationContract } from "./op-contract.mjs";

const USAGE = [
  "usage: node run-summary.mjs <run-id | trailing digits> [--log-dir <dir>]",
  "                            [--ledger-row --driver wb-ui|wb-run|manual [--approve all|none|ask]",
  "                             [--task T2] [--mode <label>] [--head <commit sha>]]",
  "",
  "Reads <log dir>/activity-*.jsonl through the Activity Log file grammar. The log directory is",
  "--log-dir, else KEIKO_LAB_LOG_DIR, else <KEIKO_STATE_DIR or ./.keiko/dev>/logs.",
  "--ledger-row needs --driver: wb-ui and wb-run also need the --approve policy the run used;",
  "manual means a person drove the Workbench and answered every ask.",
].join("\n");

const OPTIONS = {
  "log-dir": { type: "string" },
  "ledger-row": { type: "boolean" },
  driver: { type: "string" },
  approve: { type: "string" },
  task: { type: "string" },
  mode: { type: "string" },
  head: { type: "string" },
};
const SETTLED_FIELDS = [
  "op",
  "state",
  "failureCode",
  "failureBasis",
  "modelCallFailure",
  "refusalReasonCode",
];
const RUN_SETTLED = "coding-runtime.run.settled";
const DRIVERS = new Set(["wb-ui", "wb-run", "manual"]);

/** Every operation this tool reads and the registered fields it takes from each. */
export const SUMMARY_CONTRACT = Object.freeze({
  "coding-sidecar.gateway.usage-settled": ["promptTokens", "completionTokens"],
  "coding-sidecar.gateway.outcome": ["outcome"],
  "coding-sidecar.gateway.rejected": ["reason"],
  "coding-runtime.editor-mutation.settled": ["state", "editForm"],
  "coding-runtime.edit.refused": ["reasonCode", "editForm"],
  "gateway.retry.scheduled": ["reason"],
  "gateway.retry.exhausted": ["reason"],
  "gateway.circuit.wait": ["reason", "outcome"],
  "gateway.circuit.rejected": ["reason"],
  [RUN_SETTLED]: SETTLED_FIELDS.filter((field) => field !== "op"),
});
export const SUMMARY_OPERATION_PREFIXES = Object.freeze([
  "gateway.retry.",
  "gateway.circuit.",
  "coding-runtime.",
]);

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
  const settled = where((op) => op === RUN_SETTLED);
  return {
    runId:
      events
        .map((event) => event.correlationId)
        .find((id) => id?.startsWith("run-") && id.endsWith(suffix)) ?? `run-${suffix}`,
    firstTs: events[0].ts ?? "",
    lastTs: events.at(-1).ts ?? "",
    settledTs: settled[0]?.ts,
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

function turnCount(summary) {
  return [...summary.turns.values()].reduce((total, count) => total + count, 0);
}

export function formatSummary(summary) {
  const lines = [
    `${summary.runId}: ${summary.firstTs.slice(11, 19)} -> ${summary.lastTs.slice(11, 19)}  events=${String(summary.eventCount)}`,
    `model turns: ${String(turnCount(summary))}  outcomes: ${formatTally(summary.turns)}`,
    `prompt tokens (provider-reported): total=${String(summary.promptTotal)}  max=${String(summary.promptMax)}  completion total=${String(summary.completionTotal)}`,
    `edits: ${formatTally(summary.edits)}`,
    `retries/circuit: ${formatTally(summary.retries)}`,
    `tools: ${formatTally(summary.tools)}`,
    ...summary.settled.map((entry) => `settled: ${JSON.stringify(entry)}`),
  ];
  if (summary.rejected.size > 0) lines.push(`gateway rejected: ${formatTally(summary.rejected)}`);
  return lines;
}

/** Who drove the run and who answered its approvals, as a ledger row states it. */
export function ledgerPolicy({ driver, approve }) {
  if (!DRIVERS.has(driver ?? "")) {
    throw new UsageError(
      "--ledger-row needs --driver wb-ui|wb-run|manual: the row says who drove the run and answered its approvals",
    );
  }
  if (driver === "manual") return "driven by a person, who answered every approval";
  const policy = parseApprove(approve);
  return `driver ${driver}, approvals ${policy}: ${approvalPolicyText(policy)}`;
}

const LEDGER_PLACEHOLDERS = Object.freeze({
  task: "<task>",
  mode: "<mode>",
  head: "<head>",
  policy: "<driver and approvals>",
});

/** The placeholders, replaced by whatever the caller actually has (an absent flag is undefined). */
function withPlaceholders(options) {
  const given = Object.entries(options).filter(([, value]) => value !== undefined);
  return { ...LEDGER_PLACEHOLDERS, ...Object.fromEntries(given) };
}

/** A draft evidence-ledger row: the outcome is the settled state and duration, to be edited by hand. */
export function ledgerRow(summary, options = {}) {
  const { task, mode, head, policy } = withPlaceholders(options);
  const endTs = summary.settledTs ?? summary.lastTs;
  const minutes = (Date.parse(endTs) - Date.parse(summary.firstTs)) / 60_000;
  const state = summary.settled[0]?.state ?? "unsettled";
  const evidence = [
    `${String(turnCount(summary))} model turns`,
    `${summary.promptTotal.toLocaleString("en-US")} cumulative prompt tokens`,
    `edits: ${formatTally(summary.edits)}`,
    `retries/circuit: ${formatTally(summary.retries)}`,
    policy,
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
  assertOperationContract("run-summary", SUMMARY_CONTRACT, SUMMARY_OPERATION_PREFIXES);
  const suffix = normalizeRunSuffix(cli.positionals[0]);
  const policy = cli.values["ledger-row"] ? ledgerPolicy(cli.values) : undefined;
  const logDirectory = resolveLogDirectory(cli.values["log-dir"]);
  const events = selectRunEvents(await readActivityEvents(logDirectory), suffix);
  if (events.length === 0) {
    console.error(`no events for ${suffix} in ${logDirectory}`);
    return 1;
  }
  const summary = summarizeRun(events, suffix);
  console.log(formatSummary(summary).join("\n"));
  if (policy !== undefined) {
    const { task, mode, head } = cli.values;
    console.log(`\n${ledgerRow(summary, { task, mode, head, policy })}`);
  }
  return 0;
}

if (isMainModule(import.meta.url)) runMain(main);
