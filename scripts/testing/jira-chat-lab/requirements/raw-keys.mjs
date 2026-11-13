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

/**
 * The raw result keys the answer shows. Without a stored report result there are no keys to look
 * for, so the part is unverified, never green.
 */
export function gradeRawKeys(answer, exchanges) {
  const keys = reportResultKeys(exchanges);
  if (keys.size === 0)
    return {
      status: "unverified",
      detail: "no stored jira.report result in the turn; the raw keys cannot be told",
    };
  const text = String(answer ?? "");
  const found = [...keys].filter((key) => new RegExp(String.raw`\b${key}\b`, "u").test(text));
  return found.length === 0
    ? { status: "green", detail: `none of ${keys.size} result keys appears in the answer` }
    : {
        status: "red",
        detail: `${found.length} raw result keys appear in the answer: ${found.slice(0, 5).join(", ")}`,
      };
}
