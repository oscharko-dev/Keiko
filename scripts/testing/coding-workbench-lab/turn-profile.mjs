#!/usr/bin/env node
// Per-turn, per-step timing profile of one Coding Workbench run, read from the Activity Log
// segments of a dev checkout. Only body-free fields are used: timestamps, durations, token counts,
// byte counts and closed states.
//
// A model turn is one sidecar gateway request (`coding-sidecar.gateway.request-validated`) that the
// gateway dispatched: it starts with `gateway.stream.started` (streamed, the default for coding
// turns) or `gateway.chat.started` (buffered) and ends with `gateway.stream.completed` /
// `gateway.chat.completed`, with `gateway.stream.failed` / `gateway.chat.failed`, or with
// `gateway.stream.abandoned`. The readiness gateway-challenge request has no started line and is not
// a turn. Per turn the table prints the dispatch offset, the message count, the prompt and
// completion tokens of the end line, and where the model time went:
//   hdr s   `http.gateway.fetch.completed durationMs` of the model's own fetch: the one that follows
//           the attempt's `gateway.prompt.admission` (the token-counter round trip before it is
//           not the model);
//   ttft s  seconds from the model request to its first data event: hdr s plus `firstDataMs` of the
//           adapter's read line `chat.response.streamed`, whose clock starts after the headers, so
//           the prefill that happens after the headers is in here, not in gen s;
//   gen s   decoding seconds: that read's `durationMs` minus `firstDataMs`; tok/s is completion
//           tokens over gen s. A whole-body answer has no first data event, so ttft s and gen s
//           stay "-".
// Reasoning tokens and bytes come from the end line. Failures are visible: a failed, exhausted or
// abandoned turn has an end, and its seconds are model time ("failed"), not "other".
// A breakdown of the wall clock follows, bounded at `coding-runtime.run.settled`. Its slices never
// overlap: model, then operator pauses (a script-trust wait, an approval from
// `coding-runtime.approval.waiting` to its `.decided` / `.retired`, or a change review of Ask for
// approval, which the edit invocation itself waits for, from `coding-runtime.editor-review.decided`
// to `coding-runtime.editor-mutation.settled`), then tools, then the gaps between a turn and the
// next; "other" is what no slice claims.
// The log names this tool reads are checked against docs/observability/op-catalog.generated.json
// at start, so a renamed operation or field fails loudly instead of printing zeros.
import { isMainModule } from "../../lib/is-main-module.mjs";
import {
  flatten,
  readActivityEvents,
  resolveLogDirectory,
  selectRunEvents,
} from "./activity-log-events.mjs";
import { clip, lengthOf, subtract, unionOf } from "./intervals.mjs";
import { normalizeRunSuffix, parseCli, runMain } from "./lab-common.mjs";
import { assertOperationContract } from "./op-contract.mjs";

const USAGE = [
  "usage: node turn-profile.mjs <run-id | trailing digits> [--log-dir <dir>]",
  "",
  "Reads <log dir>/activity-*.jsonl through the Activity Log file grammar and prints one row per",
  "model turn (buffered or streamed, failed turns included) plus a breakdown of where the wall",
  "clock went. The log directory is --log-dir, else KEIKO_LAB_LOG_DIR, else",
  "<KEIKO_STATE_DIR or ./.keiko/dev>/logs. Times are UTC. Operator pauses (script trust, approvals",
  "and the change reviews of Ask for approval) are their own slice, taken out of the tool time or gap",
  "they overlap.",
].join("\n");

const REQUEST_VALIDATED = "coding-sidecar.gateway.request-validated";
const RUN_SETTLED = "coding-runtime.run.settled";
const APPROVAL_WAITING = "coding-runtime.approval.waiting";
const APPROVAL_DECIDED = "coding-runtime.approval.decided";
const APPROVAL_RETIRED = "coding-runtime.approval.retired";
const RUN_OPERATOR_DECISION = "coding-runtime.run.operator-decision";
const OPERATOR_DECISION = "coding-runtime.operator-decision";
const TOOL_STARTED = "tool-catalog.invocation-started";
const TOOL_SETTLED = "tool-catalog.invocation-settled";
const REVIEW_DECIDED = "coding-runtime.editor-review.decided";
const MUTATION_SETTLED = "coding-runtime.editor-mutation.settled";
/**
 * The tool catalog's id of the edit tool. A change review happens inside its invocation: the call
 * waits in place for the person's decision on the diff (packages/keiko-tool-catalog opencode.ts).
 */
export const EDIT_TOOL = "keiko.changeset.edit";
const INSTRUCTIONS_CONTEXT = "coding-runtime.repository-instructions.context";
const RETRY_OR_CIRCUIT = /^gateway\.(?:retry|circuit)\./u;
// A tool that starts this long before the turn's response is still attributed to the turn.
const TOOL_ATTRIBUTION_SLACK_S = 0.5;
// The sidecar's own verdict on a turn that the gateway itself completed.
const FAILED_OUTCOMES = new Set(["failed", "output-limit"]);
// A model server that answers a tool call as one block (Ollama does) sends two to four data events
// after a long wait; a read with fewer events than this did not stream, so its decoding rate is not
// a rate: tokens over a few milliseconds.
const MIN_STREAMED_EVENTS = 8;

/**
 * Every operation this tool reads and the registered fields it takes from each. Envelope fields
 * (ts, correlationId, parentCorrelationId, durationMs) are not registered fields.
 */
export const PROFILE_CONTRACT = Object.freeze({
  [REQUEST_VALIDATED]: ["inputMessageCount"],
  "gateway.chat.started": [],
  "gateway.stream.started": [],
  "gateway.prompt.admission": ["state"],
  "http.gateway.fetch.completed": [],
  "http.gateway.fetch.failed": [],
  "chat.response.streamed": ["dataEvents", "firstDataMs"],
  "gateway.chat.completed": [
    "finishReason",
    "promptTokens",
    "completionTokens",
    "reasoningTokens",
    "reasoningBytes",
  ],
  "gateway.stream.completed": [
    "promptTokens",
    "completionTokens",
    "reasoningTokens",
    "reasoningBytes",
  ],
  "gateway.chat.failed": ["outputExhausted"],
  "gateway.stream.failed": ["outputExhausted"],
  "gateway.stream.abandoned": [],
  "coding-sidecar.gateway.outcome": ["outcome"],
  [TOOL_STARTED]: ["invocationId", "toolCanonicalId"],
  [TOOL_SETTLED]: ["invocationId", "toolCanonicalId"],
  [APPROVAL_WAITING]: ["requestId", "permissionKind", "queuePosition"],
  [APPROVAL_DECIDED]: ["requestId"],
  [APPROVAL_RETIRED]: ["requestId"],
  [RUN_OPERATOR_DECISION]: ["state"],
  [OPERATOR_DECISION]: [],
  [REVIEW_DECIDED]: ["disposition"],
  [MUTATION_SETTLED]: [],
  [RUN_SETTLED]: [],
  [INSTRUCTIONS_CONTEXT]: ["state", "byteCount", "totalByteCount", "estimatedTokens", "reason"],
});
/** Operation families matched by prefix (the retry and circuit-breaker lines of a request). */
export const PROFILE_OPERATION_PREFIXES = Object.freeze(["gateway.retry.", "gateway.circuit."]);

const seconds = (row) => Date.parse(row.ts) / 1000;
const toSeconds = (ms) => (Number.isFinite(ms) ? ms / 1000 : undefined);

// ---- model requests ------------------------------------------------------------------------

function newRequest(row) {
  return {
    start: seconds(row),
    messages: row.inputMessageCount,
    dispatched: false,
    retries: [],
    // The final provider attempt: its model fetch (headers) and its incremental read.
    attempt: undefined,
    // The latest completed fetch, the model's own only when no admission line brackets the attempt.
    lastFetchMs: undefined,
    end: undefined,
    endKind: undefined,
    outcome: undefined,
    finish: undefined,
    prompt: undefined,
    completion: undefined,
    reasoningTokens: undefined,
    reasoningBytes: undefined,
    outputExhausted: false,
  };
}

function markDispatched(request) {
  request.dispatched = true;
}

/** Every attempt starts with its admission: the token counter ran before it, the model fetch follows. */
function openAttempt(request, row) {
  request.attempt = { awaitingFetch: row.state === "admitted" };
}

function recordFetch(request, row) {
  request.lastFetchMs = row.durationMs;
  const { attempt } = request;
  if (attempt?.awaitingFetch !== true) return;
  attempt.headersMs = row.durationMs;
  attempt.awaitingFetch = false;
}

/** A failed fetch ends the attempt's wait, so the next attempt's counter call is not taken for it. */
function closeFetchWindow(request) {
  if (request.attempt !== undefined) request.attempt.awaitingFetch = false;
}

function recordRead(request, row) {
  // Without an admission line the last fetch before the read is the model's own.
  request.attempt ??= { headersMs: request.lastFetchMs, awaitingFetch: false };
  Object.assign(request.attempt, {
    readMs: row.durationMs,
    firstDataMs: row.firstDataMs,
    dataEvents: row.dataEvents,
  });
}

function settleCall(request, row, kind) {
  request.end = seconds(row);
  request.endKind = kind;
}

function completeCall(request, row) {
  settleCall(request, row, "completed");
  request.prompt = row.promptTokens;
  request.completion = row.completionTokens;
  request.finish = row.finishReason;
  request.reasoningTokens = row.reasoningTokens;
  request.reasoningBytes = row.reasoningBytes;
}

function failCall(request, row) {
  settleCall(request, row, "failed");
  request.outputExhausted = row.outputExhausted === true;
}

function abandonCall(request, row) {
  settleCall(request, row, "abandoned");
}

function recordOutcome(request, row) {
  request.outcome = row.outcome;
}

// Per-operation updates of one model request; a Map, so a hostile `op` can never reach a prototype.
const REQUEST_EVENT_HANDLERS = new Map([
  ["gateway.chat.started", markDispatched],
  ["gateway.stream.started", markDispatched],
  ["gateway.prompt.admission", openAttempt],
  ["http.gateway.fetch.completed", recordFetch],
  ["http.gateway.fetch.failed", closeFetchWindow],
  ["chat.response.streamed", recordRead],
  ["gateway.chat.completed", completeCall],
  ["gateway.stream.completed", completeCall],
  ["gateway.chat.failed", failCall],
  ["gateway.stream.failed", failCall],
  ["gateway.stream.abandoned", abandonCall],
  ["coding-sidecar.gateway.outcome", recordOutcome],
]);

function applyRequestEvent(request, row) {
  if (RETRY_OR_CIRCUIT.test(row.op)) request.retries.push(row.op.split(".").at(-1));
  else REQUEST_EVENT_HANDLERS.get(row.op)?.(request, row);
}

/** The dispatched sidecar model requests, keyed by correlation id, oldest first. */
function collectRequests(rows) {
  const requests = new Map();
  for (const row of rows) {
    if (row.op === REQUEST_VALIDATED) requests.set(row.correlationId, newRequest(row));
    else if (requests.has(row.correlationId))
      applyRequestEvent(requests.get(row.correlationId), row);
  }
  return [...requests.values()]
    .filter((request) => request.dispatched)
    .toSorted((left, right) => left.start - right.start);
}

// ---- tools and operator waits ----------------------------------------------------------------

function settledTool(started, row) {
  const end = seconds(row);
  return {
    start: started.start,
    end,
    durationS: Number.isFinite(row.durationMs) ? row.durationMs / 1000 : end - started.start,
    name: String(row.toolCanonicalId ?? started.tool ?? "?").replaceAll("keiko.", ""),
  };
}

/** Tool invocations that started and settled, with the settled event's durationMs when it has one. */
function collectTools(rows) {
  const open = new Map();
  const tools = [];
  for (const row of rows) {
    if (row.op === TOOL_STARTED) {
      open.set(row.invocationId, { start: seconds(row), tool: row.toolCanonicalId });
    } else if (row.op === TOOL_SETTLED && open.has(row.invocationId)) {
      tools.push(settledTool(open.get(row.invocationId), row));
      open.delete(row.invocationId);
    }
  }
  return tools;
}

function endsScriptTrustWait(row) {
  return (
    row.op === OPERATOR_DECISION || (row.op === RUN_OPERATOR_DECISION && row.state !== "waiting")
  );
}

/** The workspace-script trust waits: from the run's waiting line to its settled decision. */
function scriptTrustWaits(rows, tEnd) {
  const waits = [];
  let started;
  for (const row of rows) {
    if (row.op === RUN_OPERATOR_DECISION && row.state === "waiting") {
      started ??= seconds(row);
    } else if (started !== undefined && endsScriptTrustWait(row)) {
      waits.push({ label: "script-trust", start: started, end: seconds(row) });
      started = undefined;
    }
  }
  if (started !== undefined) waits.push({ label: "script-trust", start: started, end: tEnd });
  return waits;
}

/**
 * The runtime approval waits, paired by requestId: the ask that becomes active (a queued ask has a
 * queuePosition and does not block the run until it is promoted) to its decision or retirement.
 * A wait nobody answered lasts until the run's last event.
 */
function approvalWaits(rows, tEnd) {
  const open = new Map();
  const waits = [];
  for (const row of rows) {
    if (row.op === APPROVAL_WAITING && row.queuePosition === undefined) {
      open.set(row.requestId, { label: `approval ${row.permissionKind}`, start: seconds(row) });
    } else if (
      (row.op === APPROVAL_DECIDED || row.op === APPROVAL_RETIRED) &&
      open.has(row.requestId)
    ) {
      waits.push({ ...open.get(row.requestId), end: seconds(row) });
      open.delete(row.requestId);
    }
  }
  for (const wait of open.values()) waits.push({ ...wait, end: tEnd });
  return waits;
}

const CHANGE_REVIEW = "change review";

/** The edit invocation a review line belongs to: the oldest running one that has none yet. */
function claimEditInvocation(edits) {
  for (const [invocationId, claimed] of edits) {
    if (!claimed) {
      edits.set(invocationId, true);
      return invocationId;
    }
  }
  return undefined;
}

function trackEditInvocation({ edits }, row) {
  if (row.toolCanonicalId === EDIT_TOOL) edits.set(row.invocationId, false);
}

function openChangeReview(state, row) {
  if (row.disposition !== "review-required") return;
  state.open.push({ start: seconds(row), invocationId: claimEditInvocation(state.edits) });
}

function settleChangeReview(state, row) {
  const review = state.open.shift();
  if (review !== undefined) {
    state.waits.push({ label: CHANGE_REVIEW, start: review.start, end: seconds(row) });
  }
}

/** The edit ended without a settlement: it was refused, nobody reviewed it, so its start is retired. */
function retireChangeReviews(state, row) {
  state.edits.delete(row.invocationId);
  state.open = state.open.filter((review) => review.invocationId !== row.invocationId);
}

// Per-operation updates of the change-review pairing; a Map, like the request handlers above.
const REVIEW_EVENT_HANDLERS = new Map([
  [TOOL_STARTED, trackEditInvocation],
  [REVIEW_DECIDED, openChangeReview],
  [MUTATION_SETTLED, settleChangeReview],
  [TOOL_SETTLED, retireChangeReviews],
]);

/**
 * The change reviews of Ask for approval. The run stays `running` and no approval is asked: the edit
 * invocation itself waits in place for the person, from the registration that requires a review
 * (`editor-review.decided`, disposition `review-required`) to the edit's `editor-mutation.settled`.
 * Both lines carry the run's own correlation id, so they pair by order, never by correlation.
 * An edit refused after its registration (no live Workbench, a refusal of the editor route) shows
 * no review to anyone and never settles: its start is retired when that edit invocation settles,
 * without a wait, so it is neither booked as a pause (its seconds before the refusal are tool time,
 * the registration comes before the bounded wait for a Workbench) nor paired with a later edit's
 * settlement. A review still open when the log ends lasted until its last event.
 */
function changeReviewWaits(rows, tEnd) {
  const state = { waits: [], open: [], edits: new Map() };
  for (const row of rows) REVIEW_EVENT_HANDLERS.get(row.op)?.(state, row);
  for (const review of state.open) {
    if (review.invocationId !== undefined) {
      state.waits.push({ label: CHANGE_REVIEW, start: review.start, end: tEnd });
    }
  }
  return state.waits;
}

function collectWaits(rows, tEnd) {
  return [
    ...scriptTrustWaits(rows, tEnd),
    ...approvalWaits(rows, tEnd),
    ...changeReviewWaits(rows, tEnd),
  ];
}

// ---- turns ----------------------------------------------------------------------------------

/**
 * accepted, failed, cancelled (the run was stopped or the consumer left: the gateway logs that as a
 * failed or abandoned call, the sidecar outcome says cancelled) or open (no end line yet).
 */
function turnKind(request) {
  if (request.endKind === "abandoned" || request.outcome === "cancelled") return "cancelled";
  if (request.endKind === "failed" || FAILED_OUTCOMES.has(request.outcome)) return "failed";
  return request.end === undefined ? "open" : "accepted";
}

function finishLabel(request, kind) {
  if (kind === "cancelled") return request.endKind === "abandoned" ? "abandoned" : "cancelled";
  if (kind === "failed" && request.outputExhausted) return "exhausted";
  if (kind === "failed" && request.endKind === "failed") return "failed";
  return String(request.finish ?? request.outcome ?? "");
}

/** Headers, first-data and decoding seconds of the final attempt; undefined where its lines are absent. */
function responseTiming(attempt) {
  const headersS = toSeconds(attempt?.headersMs);
  const incremental = attempt?.firstDataMs !== undefined && attempt.readMs !== undefined;
  return {
    headersS,
    // The read's clock starts after the headers: the first data event is headers + firstDataMs
    // after the request, and decoding is the rest of the read.
    firstS:
      incremental && headersS !== undefined ? headersS + attempt.firstDataMs / 1000 : undefined,
    genS: incremental ? (attempt.readMs - attempt.firstDataMs) / 1000 : undefined,
  };
}

function decodeRate(completion, genS, dataEvents) {
  return completion > 0 && genS > 0 && dataEvents >= MIN_STREAMED_EVENTS
    ? completion / genS
    : undefined;
}

function describeTurn(request, { t0, tEnd }) {
  const timing = responseTiming(request.attempt);
  const kind = turnKind(request);
  return {
    kind,
    start: request.start,
    // A turn with no end line was still open when the run settled or the log ended.
    endAt: request.end ?? tEnd,
    ended: request.end !== undefined,
    offset: request.start - t0,
    messages: request.messages,
    prompt: request.prompt,
    ...timing,
    completion: request.completion,
    tokensPerSecond: decodeRate(request.completion, timing.genS, request.attempt?.dataEvents),
    reasoningTokens: request.reasoningTokens,
    reasoningBytes: request.reasoningBytes,
    finish: finishLabel(request, kind),
    retries: request.retries,
  };
}

// ---- the wall clock --------------------------------------------------------------------------

/** Disjoint slices of [t0, tEnd]: model first, then pauses, tools and the gaps nothing else claims. */
function wallSlices({ turns, tools, waits, t0, tEnd }) {
  const within = (intervals) => clip(unionOf(intervals), t0, tEnd);
  const modelOf = (kinds) =>
    within(
      turns.filter((turn) => kinds.includes(turn.kind)).map((turn) => [turn.start, turn.endAt]),
    );
  const model = modelOf(["accepted", "failed", "cancelled", "open"]);
  const pauses = subtract(within(waits.map((wait) => [wait.start, wait.end])), model);
  const toolSet = subtract(
    within(tools.map((tool) => [tool.start, tool.end])),
    unionOf([...model, ...pauses]),
  );
  const gapCandidates = turns.flatMap((turn, index) =>
    turn.ended && turns[index + 1] !== undefined ? [[turn.endAt, turns[index + 1].start]] : [],
  );
  const gaps = subtract(within(gapCandidates), unionOf([...model, ...pauses, ...toolSet]));
  const byKind = Object.fromEntries(
    ["accepted", "failed", "cancelled", "open"].map((kind) => [kind, lengthOf(modelOf([kind]))]),
  );
  return { model, pauses, tools: toolSet, gaps, byKind };
}

function toolsProducedBy(turn, next, tools) {
  if (!turn.ended) return [];
  const from = turn.endAt - TOOL_ATTRIBUTION_SLACK_S;
  const until = next?.start ?? Infinity;
  return tools.filter((tool) => from <= tool.start && tool.start <= until);
}

/** The "then" cell: the tools the turn produced, the operator wait and the gap until the next turn. */
function followUpCell(turn, next, tools, slices, isSettled) {
  if (!turn.ended) return isSettled ? "(open at settlement)" : "(in flight)";
  const produced = toolsProducedBy(turn, next, tools);
  const names = produced.map((tool) => `${tool.name} ${tool.durationS.toFixed(1)}s`).join(", ");
  const parts = [
    names === "" && turn.retries.length > 0 ? `retries ${turn.retries.join(",")}` : names,
  ];
  const until = next?.start ?? Infinity;
  const waited = lengthOf(clip(slices.pauses, turn.endAt, until));
  if (waited > 0) parts.push(`wait ${waited.toFixed(1)}s`);
  if (next !== undefined)
    parts.push(`gap ${lengthOf(clip(slices.gaps, turn.endAt, until)).toFixed(1)}s`);
  return parts.filter((part) => part !== "").join("  ");
}

function waitSummary(waits, slices, { t0, tEnd }) {
  const totals = new Map();
  for (const wait of waits) {
    const counted = lengthOf(
      subtract(clip(unionOf([[wait.start, wait.end]]), t0, tEnd), slices.model),
    );
    const total = totals.get(wait.label) ?? { label: wait.label, count: 0, seconds: 0 };
    totals.set(wait.label, { ...total, count: total.count + 1, seconds: total.seconds + counted });
  }
  return [...totals.values()];
}

function repositoryInstructions(rows) {
  const row = rows.findLast((candidate) => candidate.op === INSTRUCTIONS_CONTEXT);
  if (row === undefined) return undefined;
  const { state, byteCount, totalByteCount, estimatedTokens, reason } = row;
  return { state, byteCount, totalByteCount, estimatedTokens, reason };
}

/** Pure projection of a run's events (oldest first) into turns, tools, waits and the wall-clock slices. */
export function profileRun(events, suffix) {
  if (events.length === 0) throw new RangeError("profileRun needs at least one event");
  const rows = events.map((event) => ({ ...flatten(event), op: event.op ?? "" }));
  const t0 = seconds(rows[0]);
  const settled = rows.find((row) => row.op === RUN_SETTLED);
  const tEnd = settled === undefined ? seconds(rows.at(-1)) : seconds(settled);
  // Everything after the run settled (a cancelled request that ends later) is not part of its wall.
  const bounded = rows.filter((row) => seconds(row) <= tEnd);
  const tools = collectTools(bounded);
  const waits = collectWaits(bounded, tEnd);
  const bases = collectRequests(bounded).map((request) => describeTurn(request, { t0, tEnd }));
  const slices = wallSlices({ turns: bases, tools, waits, t0, tEnd });
  const wall = tEnd - t0;
  const model = lengthOf(slices.model);
  const [pauses, toolTime, gaps] = [slices.pauses, slices.tools, slices.gaps].map(lengthOf);
  return {
    runId:
      rows
        .map((row) => row.correlationId)
        .find((id) => id?.startsWith("run-") && id.endsWith(suffix)) ?? `run-${suffix}`,
    firstTs: bounded[0].ts,
    lastTs: bounded.at(-1).ts,
    wall,
    isSettled: settled !== undefined,
    turns: bases.map((turn, index) => ({
      ...turn,
      then: followUpCell(turn, bases[index + 1], tools, slices, settled !== undefined),
    })),
    tools,
    instructions: repositoryInstructions(bounded),
    waits: waitSummary(waits, slices, { t0, tEnd }),
    seconds: {
      model,
      byKind: slices.byKind,
      pauses,
      tools: toolTime,
      gaps,
      other: wall - model - pauses - toolTime - gaps,
    },
  };
}

// ---- output ----------------------------------------------------------------------------------

const pad = (value, width) => String(value).padStart(width);
const fixed = (value) => (value === undefined ? "-" : value.toFixed(1));

const TURN_COLUMNS = [
  ["turn", 4, (_turn, index) => index + 1],
  ["at", 6, (turn) => turn.offset.toFixed(0)],
  ["msgs", 4, (turn) => turn.messages ?? "-"],
  ["prompt", 6, (turn) => turn.prompt ?? "-"],
  ["hdr s", 6, (turn) => fixed(turn.headersS)],
  ["ttft s", 6, (turn) => fixed(turn.firstS)],
  ["gen s", 6, (turn) => fixed(turn.genS)],
  ["compl", 6, (turn) => turn.completion ?? "-"],
  ["tok/s", 6, (turn) => fixed(turn.tokensPerSecond)],
  ["reas", 5, (turn) => turn.reasoningTokens ?? "-"],
  ["rbyte", 6, (turn) => turn.reasoningBytes ?? "-"],
  ["finish", 12, (turn) => turn.finish],
];

function tableHeader() {
  return `${TURN_COLUMNS.map(([label, width]) => pad(label, width)).join(" ")}  then`;
}

function turnRow(turn, index) {
  const cells = TURN_COLUMNS.map(([, width, cell]) => pad(cell(turn, index), width));
  return `${cells.join(" ")}  ${turn.then}`;
}

function share(part, wall) {
  return wall > 0 ? Math.round((100 * part) / wall) : 0;
}

function whole(value) {
  return `${value.toFixed(0)}s`;
}

function sliceText(value, wall) {
  return `${whole(value)} (${String(share(value, wall))}%)`;
}

function modelDetail(byKind) {
  const shown = Object.entries(byKind).filter(([kind, value]) => kind === "accepted" || value > 0);
  return shown.map(([kind, value]) => `${kind} ${whole(value)}`).join(", ");
}

function pauseDetail(waits) {
  if (waits.length === 0) return "none";
  return waits
    .map((wait) => `${wait.label} x${String(wait.count)} ${whole(wait.seconds)}`)
    .join(", ");
}

function instructionsLine(instructions) {
  if (instructions === undefined) return [];
  const { state, byteCount, totalByteCount, estimatedTokens, reason } = instructions;
  const parts = [state];
  if (reason !== undefined) parts.push(`reason ${reason}`);
  if (byteCount !== undefined) {
    const partial = totalByteCount !== undefined && totalByteCount !== byteCount;
    parts.push(
      partial
        ? `${String(byteCount)} of ${String(totalByteCount)} bytes`
        : `${String(byteCount)} bytes`,
    );
  }
  if (estimatedTokens !== undefined) {
    parts.push(`about ${String(estimatedTokens)} tokens re-sent with every turn`);
  }
  return [`repository instructions (AGENTS.md): ${parts.join(", ")}`];
}

function breakdownLine({ wall, seconds: slice, waits }) {
  return [
    `breakdown: model ${sliceText(slice.model, wall)} [${modelDetail(slice.byKind)}]`,
    `tools ${sliceText(slice.tools, wall)}`,
    `operator pauses ${sliceText(slice.pauses, wall)} [${pauseDetail(waits)}]`,
    `sidecar/bff gaps ${sliceText(slice.gaps, wall)}`,
    `other ${sliceText(slice.other, wall)}`,
  ].join("  ");
}

export function formatProfile(profile) {
  const { wall, turns, tools } = profile;
  const slowest = tools
    .toSorted((left, right) => right.durationS - left.durationS)
    .slice(0, 3)
    .map((tool) => `${tool.name} ${tool.durationS.toFixed(1)}s`);
  return [
    `${profile.runId}: ${profile.firstTs.slice(11, 19)}Z -> ${profile.lastTs.slice(11, 19)}Z  wall=${wall.toFixed(0)}s  turns=${String(turns.length)}  tools=${String(tools.length)}  ${profile.isSettled ? "settled" : "in flight"}`,
    ...instructionsLine(profile.instructions),
    tableHeader(),
    ...turns.map((turn, index) => turnRow(turn, index)),
    breakdownLine(profile),
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
  assertOperationContract("turn-profile", PROFILE_CONTRACT, PROFILE_OPERATION_PREFIXES);
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
