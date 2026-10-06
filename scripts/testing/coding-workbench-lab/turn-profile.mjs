#!/usr/bin/env node
// Per-turn, per-step timing profile of one Coding Workbench run, read from the Activity Log
// segments of a dev checkout. Only body-free fields are used: timestamps, durations, token counts,
// byte counts and closed states. For every model turn it prints the dispatch offset, the message
// count, the provider-reported prompt tokens, the time to the response headers
// (`http.gateway.fetch.completed durationMs`), the generation time (`chat.response.streamed
// durationMs`), the completion tokens and tokens per second, the reasoning tokens and bytes when the
// log carries them, the finish reason, the tool invocations the turn produced (`toolCanonicalId` and
// `durationMs`) and the gap until the next model request. A breakdown of the wall clock follows,
// bounded at `coding-runtime.run.settled`. The readiness gateway-challenge request has no
// `gateway.chat.started` and is not a model turn. The operator-pause figure is not a separate
// slice: the wait is part of the tool call that needed the decision (a package-script trust pause
// shows up in the tool time of the verification that waited for it).
import { isMainModule } from "../../lib/is-main-module.mjs";
import {
  flatten,
  readActivityEvents,
  resolveLogDirectory,
  selectRunEvents,
} from "./activity-log-events.mjs";
import { normalizeRunSuffix, parseCli, runMain } from "./lab-common.mjs";

const USAGE = [
  "usage: node turn-profile.mjs <run-id | trailing digits> [--log-dir <dir>]",
  "",
  "Reads <log dir>/activity-*.jsonl through the Activity Log file grammar and prints one row per",
  "model turn plus a breakdown of where the wall clock went. The log directory is --log-dir, else",
  "KEIKO_LAB_LOG_DIR, else <KEIKO_STATE_DIR or ./.keiko/dev>/logs. Times are UTC.",
  "The operator-pause figure overlaps the tool time of the call that waited for the decision.",
].join("\n");

const REQUEST_VALIDATED = "coding-sidecar.gateway.request-validated";
const RETRY_OR_CIRCUIT = /^gateway\.(?:retry|circuit)/u;
const REASONING_FIELDS = ["reasoningTokens", "reasoningBytes"];
// Below this, an http.gateway.fetch.completed is the token-counter call, not the model call.
const MODEL_FETCH_MIN_MS = 100;
// A tool that starts this long before the turn's response is still attributed to the turn.
const TOOL_ATTRIBUTION_SLACK_S = 0.5;

const seconds = (row) => Date.parse(row.ts) / 1000;

// Per-operation updates of one model request; a Map, so a hostile `op` can never reach a prototype.
const REQUEST_EVENT_HANDLERS = new Map([
  [
    "http.gateway.fetch.completed",
    (request, row) => {
      if ((row.durationMs ?? 0) > MODEL_FETCH_MIN_MS) request.headersMs ??= row.durationMs;
    },
  ],
  [
    "chat.response.streamed",
    (request, row) => {
      request.streamMs = row.durationMs;
    },
  ],
  [
    "gateway.chat.completed",
    (request, row) => {
      request.end = seconds(row);
      request.completion = row.completionTokens;
      request.prompt = row.promptTokens;
      request.finish = row.finishReason;
    },
  ],
  [
    "coding-sidecar.gateway.outcome",
    (request, row) => {
      request.outcome = row.outcome;
    },
  ],
]);

function applyRequestEvent(request, row) {
  for (const field of REASONING_FIELDS) {
    if (row[field] !== undefined) request[field] = row[field];
  }
  if (row.op === "gateway.chat.started") request.dispatched = true;
  else if (RETRY_OR_CIRCUIT.test(row.op)) request.retries.push(row.op.split(".").at(-1));
  else REQUEST_EVENT_HANDLERS.get(row.op)?.(request, row);
}

/** One entry per sidecar model request, keyed by its correlation id. */
function collectRequests(rows) {
  const requests = new Map();
  for (const row of rows) {
    if (row.op === REQUEST_VALIDATED) {
      requests.set(row.correlationId, {
        start: seconds(row),
        messages: row.inputMessageCount,
        retries: [],
      });
    } else if (requests.has(row.correlationId)) {
      applyRequestEvent(requests.get(row.correlationId), row);
    }
  }
  return requests;
}

/** Tool invocations that started and settled, with the settled event's durationMs when it has one. */
function collectTools(rows) {
  const open = new Map();
  const tools = [];
  for (const row of rows) {
    if (row.op === "tool-catalog.invocation-started") {
      open.set(row.invocationId, { start: seconds(row), tool: row.toolCanonicalId });
    } else if (row.op === "tool-catalog.invocation-settled" && open.has(row.invocationId)) {
      const started = open.get(row.invocationId);
      open.delete(row.invocationId);
      const end = seconds(row);
      tools.push({
        start: started.start,
        end,
        durationS: Number.isFinite(row.durationMs) ? row.durationMs / 1000 : end - started.start,
        name: String(row.toolCanonicalId ?? started.tool ?? "?").replaceAll("keiko.", ""),
      });
    }
  }
  return tools;
}

/** Seconds the run spent waiting for an operator decision (each wait ends at the settled decision). */
function operatorPauseSeconds(rows) {
  const waits = rows.filter(
    (row) =>
      row.op === "coding-runtime.run.operator-decision" &&
      (row.state === undefined || row.state === "waiting"),
  );
  return waits.reduce((total, wait) => {
    const started = seconds(wait);
    const resolved = rows.find(
      (row) =>
        seconds(row) > started &&
        (row.op === "coding-runtime.operator-decision" || row.op === "coding-runtime.run.resumed"),
    );
    return resolved === undefined ? total : total + (seconds(resolved) - started);
  }, 0);
}

function toolsProducedBy(request, next, tools) {
  if (request.end === undefined) return [];
  const from = request.end - TOOL_ATTRIBUTION_SLACK_S;
  const until = next?.start ?? Infinity;
  return tools.filter((tool) => from <= tool.start && tool.start <= until);
}

/** The "then" cell of a turn and the seconds its tools and the gap to the next request took. */
function followUp(request, next, tools) {
  const produced = toolsProducedBy(request, next, tools);
  let then = produced.map((tool) => `${tool.name} ${tool.durationS.toFixed(1)}s`).join(", ");
  if (then === "" && request.retries.length > 0) then = `retries ${request.retries.join(",")}`;
  if (request.end === undefined) return { then: "(in flight)", toolSeconds: 0, gapSeconds: 0 };
  if (next === undefined) return { then, toolSeconds: 0, gapSeconds: 0 };
  const toolSeconds = produced.reduce((total, tool) => total + tool.durationS, 0);
  const gap = next.start - request.end - toolSeconds;
  return { then: `${then}  gap ${gap.toFixed(1)}s`, toolSeconds, gapSeconds: Math.max(gap, 0) };
}

/** The row cells and the time shares of one model turn; `next` is the following turn, if any. */
function describeTurn(request, next, tools, t0) {
  const generation = (request.streamMs ?? 0) / 1000;
  const completion = request.completion ?? 0;
  return {
    offset: request.start - t0,
    messages: request.messages,
    prompt: request.prompt,
    headersS: (request.headersMs ?? 0) / 1000,
    generationS: generation,
    completion,
    tokensPerSecond: generation > 0 ? completion / generation : 0,
    reasoningTokens: request.reasoningTokens,
    reasoningBytes: request.reasoningBytes,
    finish: String(request.finish ?? request.outcome ?? ""),
    modelSeconds: request.end === undefined ? 0 : request.end - request.start,
    ...followUp(request, next, tools),
  };
}

/** Pure projection of a run's events (oldest first) into turns, tools and the wall-clock breakdown. */
export function profileRun(events, suffix) {
  const rows = events.map((event) => ({ ...flatten(event), op: event.op ?? "" }));
  const t0 = seconds(rows[0]);
  const settled = rows.find((row) => row.op === "coding-runtime.run.settled");
  const tEnd = settled === undefined ? seconds(rows.at(-1)) : seconds(settled);
  const bounded = rows.filter((row) => seconds(row) <= tEnd);
  const tools = collectTools(rows);
  const requests = [...collectRequests(rows).values()].filter((request) => request.dispatched);
  const ordered = requests.toSorted((left, right) => left.start - right.start);
  const turns = ordered.map((request, index) =>
    describeTurn(request, ordered[index + 1], tools, t0),
  );
  const sum = (field) => turns.reduce((total, turn) => total + turn[field], 0);
  return {
    runId:
      rows
        .map((row) => row.correlationId)
        .find((id) => id?.startsWith("run-") && id.endsWith(suffix)) ?? `run-${suffix}`,
    firstTs: bounded[0].ts,
    lastTs: bounded.at(-1).ts,
    wall: tEnd - t0,
    isSettled: settled !== undefined,
    turns,
    tools,
    modelSeconds: sum("modelSeconds"),
    toolSeconds: sum("toolSeconds"),
    gapSeconds: sum("gapSeconds"),
    pauseSeconds: operatorPauseSeconds(bounded),
  };
}

const pad = (value, width) => String(value).padStart(width);

const COLUMNS = [
  ["turn", 4],
  ["at", 6],
  ["msgs", 4],
  ["prompt", 6],
  ["hdr s", 6],
  ["gen s", 6],
  ["compl", 6],
  ["tok/s", 5],
  ["reas", 5],
  ["rbyte", 6],
  ["finish", 10],
];

function tableHeader(withBytes) {
  const shown = COLUMNS.filter(([label]) => withBytes || label !== "rbyte");
  return `${shown.map(([label, width]) => pad(label, width)).join(" ")}  then`;
}

function turnRow(turn, index, withBytes) {
  const cells = [
    pad(index + 1, 4),
    pad(turn.offset.toFixed(0), 6),
    pad(turn.messages || "", 4),
    pad(turn.prompt || "", 6),
    pad(turn.headersS.toFixed(1), 6),
    pad(turn.generationS.toFixed(1), 6),
    pad(turn.completion, 6),
    pad(turn.tokensPerSecond.toFixed(1), 5),
    pad(turn.reasoningTokens ?? "-", 5),
    ...(withBytes ? [pad(turn.reasoningBytes ?? "-", 6)] : []),
    pad(turn.finish, 10),
  ];
  return `${cells.join(" ")}  ${turn.then}`;
}

function share(part, wall) {
  return wall > 0 ? Math.round((100 * part) / wall) : 0;
}

export function formatProfile(profile) {
  const { wall, turns, tools } = profile;
  const withBytes = turns.some((turn) => turn.reasoningBytes !== undefined);
  const other = wall - profile.modelSeconds - profile.toolSeconds - profile.gapSeconds;
  const slowest = tools
    .toSorted((left, right) => right.durationS - left.durationS)
    .slice(0, 3)
    .map((tool) => `${tool.name} ${tool.durationS.toFixed(1)}s`);
  return [
    `${profile.runId}: ${profile.firstTs.slice(11, 19)}Z -> ${profile.lastTs.slice(11, 19)}Z  wall=${wall.toFixed(0)}s  turns=${String(turns.length)}  tools=${String(tools.length)}  ${profile.isSettled ? "settled" : "in flight"}`,
    tableHeader(withBytes),
    ...turns.map((turn, index) => turnRow(turn, index, withBytes)),
    `breakdown: model ${profile.modelSeconds.toFixed(0)}s (${String(share(profile.modelSeconds, wall))}%)  tools ${profile.toolSeconds.toFixed(0)}s (${String(share(profile.toolSeconds, wall))}%)  sidecar/bff gaps ${profile.gapSeconds.toFixed(0)}s (${String(share(profile.gapSeconds, wall))}%)  operator pauses ~${profile.pauseSeconds.toFixed(0)}s  other ${other.toFixed(0)}s`,
    `slowest tools: ${slowest.join(", ")}`,
  ];
}

async function main() {
  const cli = parseCli({
    usage: USAGE,
    options: { "log-dir": { type: "string" } },
    positionals: true,
  });
  if (cli.help) return 0;
  const suffix = normalizeRunSuffix(cli.positionals[0]);
  const logDirectory = resolveLogDirectory(cli.values["log-dir"]);
  const events = selectRunEvents(await readActivityEvents(logDirectory), suffix);
  if (events.length === 0) {
    console.error(`no events for ${suffix} in ${logDirectory}`);
    return 1;
  }
  console.log(formatProfile(profileRun(events, suffix)).join("\n"));
  return 0;
}

if (isMainModule(import.meta.url)) runMain(main);
