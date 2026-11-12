// Grading of the natural-language catalog selection lane (#4327). Pure, so it is testable without
// a laboratory. The model's answer text is never evidence; only the tool transcript and native
// Jira truth are.

/** The closed statuses of one selection attempt. */
export const SELECTION_STATUSES = Object.freeze([
  "selected",
  "alternative",
  "wrong-result",
  "wrong-arguments",
  "wrong-tool",
  "no-tool",
  "invalid",
]);

const DISCOVERY_ALIASES = new Set(["jira_discover", "jira_describe"]);
export const toolAlias = (name) => String(name ?? "").replaceAll(/[.-]/gu, "_");

/** How the model reached its tools: through the catalog search or only through visible tools. */
export function selectionPath(exchanges) {
  return exchanges.some((exchange) => DISCOVERY_ALIASES.has(toolAlias(exchange.call?.name)))
    ? "discovery"
    : "direct";
}

/** Native operations the model actually called, without the local catalog lookups. */
function operationCalls(exchanges) {
  return exchanges.filter((exchange) => !DISCOVERY_ALIASES.has(toolAlias(exchange.call?.name)));
}

function succeeded(exchange) {
  return exchange.result?.status === "completed" && exchange.result?.data?.outcome === "succeeded";
}

const LEAVES_MAX = 50_000;

/** Every string or number value and every object key in the result data, bounded. */
function resultLeaves(value, leaves = new Set()) {
  if (leaves.size >= LEAVES_MAX) return leaves;
  if (typeof value === "string" || typeof value === "number") leaves.add(String(value));
  else if (Array.isArray(value)) for (const item of value) resultLeaves(item, leaves);
  else if (value !== null && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      leaves.add(key);
      resultLeaves(item, leaves);
    }
  return leaves;
}

/**
 * Every bounded native token is a whole value (or key) in the target's result data. A token that
 * only occurs inside a longer value ("High" in "Highest") does not count.
 */
export function carriesTruth(exchange, tokens) {
  const leaves = resultLeaves(exchange.result?.data ?? {});
  const missing = tokens.filter((token) => !leaves.has(token));
  return { complete: tokens.length > 0 && missing.length === 0, missing: missing.length };
}

// Truth tokens are synthetic lab names, so the private report may name the missing ones.
const missingTokens = (exchange, tokens) => {
  const leaves = resultLeaves(exchange.result?.data ?? {});
  return tokens.filter((token) => !leaves.has(token));
};

function readVerdict(target, tokens) {
  if (!succeeded(target)) return { status: "wrong-result", detail: "target call did not succeed" };
  const missing = missingTokens(target, tokens);
  return tokens.length > 0 && missing.length === 0
    ? { status: "selected", detail: `${tokens.length} native tokens present` }
    : {
        status: "wrong-result",
        detail: `${missing.length}/${tokens.length} native tokens missing`,
        missingTokens: missing,
      };
}

/**
 * Consulted only when the target was never called: a failed target call followed by a successful
 * alternative stays a wrong result of the target.
 *
 * A reviewed equivalent operation that answers the request just as well: it is on the case's
 * `alternatives` list and its successful result carries every native token. Any other operation
 * is a wrong tool, because a result can carry a single token by coincidence (a username as a
 * reporter). It is reported apart from an exact selection, never folded into it.
 */
function alternativeRead(calls, tokens, alternatives) {
  const allowed = new Set(alternatives.map(toolAlias));
  const answering = calls.find(
    (call) =>
      allowed.has(toolAlias(call.call?.name)) &&
      succeeded(call) &&
      carriesTruth(call, tokens).complete,
  );
  if (answering === undefined)
    return { status: "wrong-tool", detail: `${calls.length} other operation calls` };
  return {
    status: "alternative",
    detail: `${toolAlias(answering.call?.name)} carried every native token`,
  };
}

/**
 * A write without a target call is a selection failure (another operation, or none), even when it
 * also wrote something, unless another operation produced exactly the requested effect and nothing
 * else; only a called target is judged by its native effect and stray writes.
 */
function missingTarget(effect, otherCalls) {
  const stray = effect.stray ?? 0;
  if (otherCalls === 0 && effect.effects === 0 && stray === 0)
    return { status: "no-tool", detail: "no operation call" };
  if (otherCalls > 0 && effect.effects === 1 && effect.wrongValue !== true && stray === 0)
    return { status: "alternative", detail: "another operation produced exactly the effect" };
  const detail = `${otherCalls} other operation calls, ${effect.effects} native effects`;
  return { status: "wrong-tool", detail };
}

function writeVerdict(target, effect, otherCalls) {
  if (target === undefined) return missingTarget(effect, otherCalls);
  if ((effect.stray ?? 0) > 0)
    return { status: "wrong-result", detail: `${effect.stray} writes the request did not ask for` };
  if (!succeeded(target))
    return { status: "wrong-result", detail: "the target call did not succeed" };
  if (effect.effects !== 1 || effect.wrongValue === true) {
    const detail = `${effect.effects} native effects${effect.wrongValue ? ", wrong value" : ""}`;
    return { status: "wrong-result", detail };
  }
  return { status: "selected", detail: "exactly one verified native effect" };
}

/**
 * A model call that failed after exhausting its retries or at an open circuit with a provider
 * failure. A circuit that opened and recovered without failing a call is reported, but proves no
 * outage, so it never hides a product or model verdict.
 */
const gatewayFailed = (gateway = {}) => gateway.unrecovered > 0;

/** The called tools in order with their closed result, never their arguments or data. */
export function callTrace(exchanges) {
  return exchanges.map((exchange) =>
    [
      toolAlias(exchange.call?.name),
      String(exchange.result?.status ?? "none"),
      String(exchange.result?.data?.outcome ?? "none"),
    ].join(":"),
  );
}

/**
 * One attempt: `turn` is { failure, exchanges, gateway: { unrecovered, circuit } }, `tokens` the
 * native read truth, `effect` the native write verification. A gateway outage, an unavailable
 * native truth, or a turn that failed before it returned a transcript is invalid, never a product
 * or model verdict: without a transcript the selection is unknowable.
 */
export function gradeSelection(entry, turn, { tokens = [], effect, truthUnavailable } = {}) {
  const verdict = gradeTurn(entry, turn, { tokens, effect, truthUnavailable });
  return { ...verdict, calls: callTrace(turn.exchanges ?? []) };
}

function invalidReason(turn, exchanges, truthUnavailable) {
  if (gatewayFailed(turn.gateway)) return "the model gateway failed during the turn";
  if (truthUnavailable === true) return "the native truth read failed";
  if (turn.failure !== undefined && exchanges.length === 0)
    return "the turn failed before it returned a transcript";
  return undefined;
}

/**
 * The target call that decides: for a read the successful call that carries every native token
 * (a corrected second read supplies the truth), else a successful one, else the first one.
 */
function targetCall(calls, tool, tokens = []) {
  const targets = calls.filter((exchange) => toolAlias(exchange.call?.name) === toolAlias(tool));
  const complete = (exchange) => succeeded(exchange) && carriesTruth(exchange, tokens).complete;
  return targets.find(complete) ?? targets.find(succeeded) ?? targets[0];
}

/** The gateway's argument refusals of the target, keyed by its canonical id (`keiko.jira.…`). */
function refusedTarget(gateway, tool) {
  const wanted = toolAlias(tool);
  return Object.entries(gateway?.rejected ?? {})
    .filter(([id]) => toolAlias(id.replace(/^keiko\./u, "")) === wanted)
    .reduce((sum, [, count]) => sum + count, 0);
}

function untargetedVerdict(entry, calls, { tokens, effect }) {
  if (entry.effect === "write") return missingTarget(effect, calls.length);
  if (calls.length > 0) return alternativeRead(calls, tokens, entry.alternatives ?? []);
  return { status: "no-tool", detail: "no operation call" };
}

/**
 * A target the gateway refused for its arguments never reaches the transcript; the model did
 * select it, so this is an argument failure, not a selection failure. An exact alternative wins,
 * and a write that also wrote something else, or a wrong value, keeps that verdict.
 */
function refusedVerdict(entry, turn, verdict, effect) {
  const refused = refusedTarget(turn.gateway, entry.tool);
  const clean = (effect?.stray ?? 0) === 0 && effect?.wrongValue !== true;
  if (refused === 0 || !clean || verdict.status === "alternative") return verdict;
  return {
    status: "wrong-arguments",
    detail: `the target was called; ${refused} calls refused for their arguments`,
  };
}

function gradeTurn(entry, turn, { tokens, effect, truthUnavailable }) {
  const exchanges = turn.exchanges ?? [];
  const path = selectionPath(exchanges);
  const invalid = invalidReason(turn, exchanges, truthUnavailable);
  if (invalid !== undefined) return { status: "invalid", path, detail: invalid };
  const calls = operationCalls(exchanges);
  const target = targetCall(calls, entry.tool, entry.effect === "write" ? [] : tokens);
  if (target !== undefined)
    return entry.effect === "write"
      ? { ...writeVerdict(target, effect, calls.length), path }
      : { ...readVerdict(target, tokens), path };
  const verdict = untargetedVerdict(entry, calls, { tokens, effect });
  return { ...refusedVerdict(entry, turn, verdict, effect), path };
}

const countOf = (runs, status) => runs.filter((value) => value === status).length;

/**
 * Pass rate over valid attempts per case and overall; invalid attempts are counted, not graded.
 * An equivalent alternative is counted apart from an exact selection.
 */
export function summarizeSelection(attempts) {
  const byCase = new Map();
  for (const attempt of attempts) {
    const row = byCase.get(attempt.id) ?? { id: attempt.id, catalog: attempt.catalog, runs: [] };
    row.runs.push(attempt.status);
    byCase.set(attempt.id, row);
  }
  const rows = [...byCase.values()].map((row) => {
    const invalid = countOf(row.runs, "invalid");
    const valid = row.runs.length - invalid;
    const selected = countOf(row.runs, "selected");
    const alternative = countOf(row.runs, "alternative");
    const wrongArguments = countOf(row.runs, "wrong-arguments");
    return { ...row, valid, selected, alternative, wrongArguments, invalid };
  });
  const total = (key) => rows.reduce((sum, row) => sum + row[key], 0);
  const valid = total("valid");
  // Like the scorecard's repeat rule: a run that lost most of its attempts to outages measures
  // nothing, so it is reported as insufficient instead of as a low (or perfect) rate.
  const sufficient = attempts.length > 0 && valid >= Math.ceil(attempts.length / 2);
  return {
    rows,
    valid,
    selected: total("selected"),
    alternative: total("alternative"),
    wrongArguments: total("wrongArguments"),
    invalid: total("invalid"),
    sufficient,
  };
}
