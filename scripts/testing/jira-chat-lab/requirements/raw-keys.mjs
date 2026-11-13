// A report answer must not show the product's raw result keys (#4355): the person asked for figures,
// not for `byStatus` or `typeName`. The keys are read from what the turn's own `jira.report` calls
// returned (every camelCase property name of the stored result), so the oracle follows the product's
// shape instead of a list of its own; the answer is searched for them as whole words.
import { completedToolExchange } from "./tool-exchanges.mjs";

const CAMEL_CASE = /^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/u;

/** Every camelCase property name found anywhere in the stored `jira.report` results of the turn. */
export function reportResultKeys(exchanges) {
  const keys = new Set();
  const walk = (value) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === "object" && value !== null)
      for (const [key, inner] of Object.entries(value)) {
        if (CAMEL_CASE.test(key)) keys.add(key);
        walk(inner);
      }
  };
  for (const exchange of Array.isArray(exchanges) ? exchanges : [])
    if (completedToolExchange(exchange, "jira.report")) walk(exchange.result.data);
  return keys;
}

/** The kinds of uncertainty element that mark an answer as partly unsupported or unjudged. */
export const FLAG_KINDS = Object.freeze(["unsupported-claim", "entailment-unavailable"]);

/** The flags a stored assistant message carries: `groundedAnswer.uncertainty[]` elements of those kinds. */
export const storedFlags = (message) =>
  (Array.isArray(message?.groundedAnswer?.uncertainty) ? message.groundedAnswer.uncertainty : [])
    .map((element) => element?.kind)
    .filter((kind) => FLAG_KINDS.includes(kind));

/** Why the step cannot be judged (it did not run, or its evidence cannot be read), or undefined. */
function unproven({ text, keys, stored, turn }) {
  if (turn?.failure !== undefined || text.trim() === "")
    return "the turn did not run to an answer; nothing is proven";
  if (keys.size === 0)
    return "no stored jira.report result in the turn; the raw keys cannot be told";
  return stored === undefined ? "the stored assistant message could not be read" : undefined;
}

/**
 * The part `answer-clean` of a report answer (#4355): (a) the answer shows none of the raw member
 * names of THIS turn's stored `jira.report` result (counted) and (b) the stored assistant message
 * carries no `unsupported-claim` or `entailment-unavailable` element. The step must have run — a
 * turn that answered, with a stored report result and a readable stored message — else it is
 * unverified, never green. (b) holds by construction on a Jira-Pod-only chat, which never runs the
 * entailment stage; the check proves it on the stored state rather than assuming it.
 */
export function gradeAnswerClean({ answer, exchanges, stored, turn }) {
  const keys = reportResultKeys(exchanges);
  const text = String(answer ?? "");
  const reason = unproven({ text, keys, stored, turn });
  if (reason !== undefined) return { status: "unverified", detail: reason };
  const found = [...keys].filter((key) => new RegExp(String.raw`\b${key}\b`, "u").test(text));
  const flags = storedFlags(stored);
  if (found.length > 0 || flags.length > 0)
    return {
      status: "red",
      detail: `${found.length} raw result keys in the answer${found.length > 0 ? ` (${found.slice(0, 5).join(", ")})` : ""}; ${flags.length} unsupported-claim or entailment flags in the stored message${flags.length > 0 ? ` (${[...new Set(flags)].join(", ")})` : ""}`,
    };
  return {
    status: "green",
    detail: `none of ${keys.size} result keys in the answer; no unsupported-claim or entailment flag in the stored message`,
  };
}
