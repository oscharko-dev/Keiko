// Validity of a laboratory check (epic #4173): a check the laboratory cannot trust is `invalid`,
// never `red`. A dead model server must not be graded as a product failure, and a lab exception
// is not evidence about the product. Pure except for the Activity Log read, so it is testable
// without a laboratory.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** The closed Activity Log operations that prove the model gateway failed. */
export const GATEWAY_FAILURE_OPS = Object.freeze({
  "gateway.chat.failed": "failed",
  "gateway.stream.failed": "failed",
  "gateway.circuit.opened": "circuit",
  "gateway.circuit.rejected": "circuit",
});

/** The closed reasons a check is invalid. */
export const INVALID_REASONS = Object.freeze([
  "lab-error",
  "model-unavailable",
  "gateway-failure",
  "gateway-circuit-open",
]);

// A failed turn whose message names the transport or the gateway, not the product's answer.
const GATEWAY_TURN_FAILURE =
  /\b(GATEWAY_[A-Z_]+|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR_[A-Z_]+)\b|fetch failed|socket hang up/;

// Log lines are flushed after the journey ends; the grace keeps the late tail inside its window.
const WINDOW_GRACE_MS = 2_000;

function logFiles(root, fromMs) {
  if (!existsSync(root)) return [];
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const path = stack.pop();
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      const stat = statSync(child);
      if (stat.isDirectory()) stack.push(child);
      // A segment last written before the window cannot hold a line of it.
      else if (name.endsWith(".jsonl") && stat.mtimeMs >= fromMs) files.push(child);
    }
  }
  return files;
}

function gatewayLine(line) {
  if (!line.includes('"op":"gateway.')) return undefined;
  try {
    return { entry: JSON.parse(line) };
  } catch {
    return { unparsed: true };
  }
}

function inWindow(entry, { fromMs, toMs, pid }) {
  if (pid !== undefined && entry.pid !== pid) return false;
  const at = Date.parse(entry.ts);
  return Number.isFinite(at) && at >= fromMs && at <= toMs + WINDOW_GRACE_MS;
}

/**
 * The gateway failures the Activity Log recorded for this process inside [fromMs, toMs]: failed
 * model calls and circuit transitions or rejections. Another lane's process writes the same
 * directory, so `pid` restricts the count to the lab server of this run.
 */
export function readGatewayFailures(root, window) {
  const counts = { failed: 0, circuit: 0, unparsed: 0 };
  for (const file of logFiles(root, window.fromMs)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const parsed = gatewayLine(line);
      if (parsed === undefined) continue;
      if (parsed.unparsed) counts.unparsed += 1;
      else if (inWindow(parsed.entry, window)) {
        const kind = GATEWAY_FAILURE_OPS[parsed.entry.op];
        if (kind !== undefined) counts[kind] += 1;
      }
    }
  }
  return counts;
}

/** A check the laboratory cannot trust: it credits no obligation and names its closed reason. */
export function invalidCheck(reason, detail, base = {}) {
  if (!INVALID_REASONS.includes(reason)) throw new TypeError(`Unknown invalid reason ${reason}`);
  return { ...base, status: "invalid", reason, covers: [], detail };
}

/** A lab exception is a lab error, never evidence about the product. */
export function labError(error, base = {}) {
  return invalidCheck("lab-error", `lab error: ${error.message}`, base);
}

/**
 * Re-grades a finished journey check against the gateway evidence of its window.
 *  - A green check stays green: an independent Jira or truth oracle proved the outcome, so a
 *    retried gateway failure did not change it.
 *  - Any other check during which the circuit opened or the gateway failed a model call, or whose
 *    turn failed on a gateway or transport error, cannot be trusted and is invalid.
 * `failures` is the result of `readGatewayFailures` for the journey's window.
 */
export function classifyJourney(check, failures) {
  if (check.status === "green" || check.status === "invalid") return check;
  const counts = `${failures.failed} failed model calls, ${failures.circuit} circuit events`;
  if (failures.circuit > 0)
    return invalidCheck("gateway-circuit-open", `${check.detail}; ${counts}`, check);
  const turnFailure = check.turnFailure ?? check.failure;
  const turnGateway = typeof turnFailure === "string" && GATEWAY_TURN_FAILURE.test(turnFailure);
  if (failures.failed > 0 || turnGateway) {
    return invalidCheck("gateway-failure", `${check.detail ?? ""}; ${counts}`, check);
  }
  return check;
}
