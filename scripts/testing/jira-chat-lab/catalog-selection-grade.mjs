// Grading of the natural-language catalog selection lane (#4327). Pure, so it is testable without
// a laboratory. The model's answer text is never evidence; only the tool transcript and native
// Jira truth are.

/** The closed statuses of one selection attempt. */
export const SELECTION_STATUSES = Object.freeze([
  "selected",
  "wrong-result",
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

function readVerdict(target, tokens) {
  if (!succeeded(target)) return { status: "wrong-result", detail: "target call did not succeed" };
  const truth = carriesTruth(target, tokens);
  return truth.complete
    ? { status: "selected", detail: `${tokens.length} native tokens present` }
    : { status: "wrong-result", detail: `${truth.missing}/${tokens.length} native tokens missing` };
}

function writeVerdict(target, effect) {
  if ((effect.stray ?? 0) > 0)
    return { status: "wrong-result", detail: `${effect.stray} writes the request did not ask for` };
  if (effect.effects !== 1 || effect.wrongValue === true) {
    const detail = `${effect.effects} native effects${effect.wrongValue ? ", wrong value" : ""}`;
    return { status: target === undefined ? "no-tool" : "wrong-result", detail };
  }
  if (target === undefined)
    return { status: "wrong-tool", detail: "the effect came from another operation" };
  return succeeded(target)
    ? { status: "selected", detail: "exactly one verified native effect" }
    : { status: "wrong-result", detail: "the target call did not succeed" };
}

/**
 * A model call that failed after exhausting its retries or at an open circuit, or a transport
 * failure of the turn itself. A circuit that opened and recovered without failing a call is
 * reported, but proves no outage, so it never hides a product or model verdict.
 */
const gatewayFailed = (gateway = {}) => gateway.unrecovered > 0;

/**
 * One attempt: `turn` is { failure, exchanges, gateway: { unrecovered, circuit } }, `tokens` the
 * native read truth, `effect` the native write verification. A gateway outage is invalid, never a
 * product or model verdict.
 */
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

export function gradeSelection(entry, turn, { tokens = [], effect } = {}) {
  const verdict = gradeTurn(entry, turn, { tokens, effect });
  return { ...verdict, calls: callTrace(turn.exchanges ?? []) };
}

function gradeTurn(entry, turn, { tokens, effect }) {
  const exchanges = turn.exchanges ?? [];
  const path = selectionPath(exchanges);
  if (gatewayFailed(turn.gateway))
    return { status: "invalid", path, detail: "the model gateway failed during the turn" };
  const calls = operationCalls(exchanges);
  const target = calls.find((exchange) => toolAlias(exchange.call?.name) === toolAlias(entry.tool));
  if (entry.effect === "write") return { ...writeVerdict(target, effect), path };
  if (target !== undefined) return { ...readVerdict(target, tokens), path };
  if (calls.length > 0)
    return { status: "wrong-tool", path, detail: `${calls.length} other operation calls` };
  return { status: "no-tool", path, detail: turn.failure ? "turn failed" : "no operation call" };
}

/** Pass rate over valid attempts per case and overall; invalid attempts are counted, not graded. */
export function summarizeSelection(attempts) {
  const byCase = new Map();
  for (const attempt of attempts) {
    const row = byCase.get(attempt.id) ?? { id: attempt.id, catalog: attempt.catalog, runs: [] };
    row.runs.push(attempt.status);
    byCase.set(attempt.id, row);
  }
  const rows = [...byCase.values()].map((row) => {
    const valid = row.runs.filter((status) => status !== "invalid");
    const selected = valid.filter((status) => status === "selected").length;
    return { ...row, valid: valid.length, selected, invalid: row.runs.length - valid.length };
  });
  const total = (key) => rows.reduce((sum, row) => sum + row[key], 0);
  const valid = total("valid");
  const invalid = total("invalid");
  // Like the scorecard's repeat rule: a run that lost most of its attempts to outages measures
  // nothing, so it is reported as insufficient instead of as a low (or perfect) rate.
  const sufficient = attempts.length > 0 && valid >= Math.ceil(attempts.length / 2);
  return { rows, valid, selected: total("selected"), invalid, sufficient };
}
