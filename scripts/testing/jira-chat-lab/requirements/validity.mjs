// Validity of a laboratory check (epic #4173): a check the laboratory cannot trust is `invalid`,
// never `red`. A dead model server must not be graded as a product failure, and a lab exception
// is not evidence about the product. Pure except for the Activity Log read, so it is testable
// without a laboratory.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** The closed reasons a check is invalid, or red because the product route failed. */
export const INVALID_REASONS = Object.freeze([
  "lab-error",
  "model-unavailable",
  "gateway-failure",
  "insufficient-valid-runs",
]);
export const RED_REASONS = Object.freeze(["product-route-failed"]);

const FAILURE_OPS = new Set(["gateway.chat.failed", "gateway.stream.failed"]);
const CIRCUIT_REJECTION_OPS = new Set(["gateway.circuit.opened", "gateway.circuit.rejected"]);

// Only transport signatures: a gateway limit (context overflow, attempt admission) is a product
// outcome, not an outage.
const TRANSPORT_FAILURE =
  /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR_[A-Z_]+)\b|fetch failed|socket hang up/;

/** Whether a failure message names the transport to the model server, not the product. */
export const isTransportFailure = (message) =>
  typeof message === "string" && TRANSPORT_FAILURE.test(message);

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

function collectLine(entry, groups, counts) {
  if (CIRCUIT_REJECTION_OPS.has(entry.op)) counts.circuit += 1;
  if (typeof entry.correlationId !== "string") return;
  const ops = groups.get(entry.correlationId) ?? new Set();
  ops.add(entry.op);
  groups.set(entry.correlationId, ops);
}

/**
 * An infrastructure failure is a correlation that ends in a failed model call AND went through a
 * retry exhaustion or a circuit event. A failure with neither (a context overflow, a refused
 * attempt, a provider rejection) is a product or limit outcome and proves no outage.
 */
function classifyCorrelations(groups, counts) {
  for (const ops of groups.values()) {
    if (![...ops].some((op) => FAILURE_OPS.has(op))) continue;
    const retried =
      ops.has("gateway.retry.exhausted") ||
      [...ops].some((op) => op.startsWith("gateway.circuit."));
    if (retried) counts.outages += 1;
    else counts.productFailures += 1;
  }
}

/**
 * The gateway evidence the Activity Log holds for this process inside [fromMs, toMs]: `outages`
 * (failed model calls that exhausted their retries or met an open circuit), `circuit` (circuit
 * opened or rejected events) and `productFailures` (failed calls with neither). Another lane's
 * process writes the same directory, so `pid` restricts the count to the lab server of this run.
 */
export function readGatewayFailures(root, window) {
  const counts = { outages: 0, circuit: 0, productFailures: 0, unparsed: 0 };
  const groups = new Map();
  for (const file of logFiles(root, window.fromMs)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const parsed = gatewayLine(line);
      if (parsed === undefined) continue;
      if (parsed.unparsed) counts.unparsed += 1;
      else if (inWindow(parsed.entry, window)) collectLine(parsed.entry, groups, counts);
    }
  }
  classifyCorrelations(groups, counts);
  return counts;
}

/**
 * Whether the evidence of a window shows the model infrastructure down: a failed model call that
 * went through retry exhaustion or a circuit event. A circuit event alone (a recovered
 * open, half-open, closed cycle) is reported but proves no failed call, so it is no outage.
 */
export const showsOutage = (failures) => failures.outages > 0;

/** Whether an error is the abort of a deadline signal (`AbortSignal.timeout`), by name only. */
export const isDeadlineAbort = (error) =>
  error?.name === "TimeoutError" || error?.name === "AbortError";

/** A check the laboratory cannot trust: it credits no obligation and names its closed reason. */
export function invalidCheck(reason, detail, base = {}) {
  if (!INVALID_REASONS.includes(reason)) throw new TypeError(`Unknown invalid reason ${reason}`);
  return { ...base, status: "invalid", reason, covers: [], detail };
}

/** A product failure the laboratory did observe: red, with its closed reason, crediting nothing. */
export function redCheck(reason, detail, base = {}) {
  if (!RED_REASONS.includes(reason)) throw new TypeError(`Unknown red reason ${reason}`);
  return { ...base, status: "red", reason, covers: [], detail };
}

// The lab's own stage helper throws this for a non-2xx answer of Keiko's routes.
const ROUTE_FAILURE_MESSAGE = "Live Chat HTTP stage failed";

/**
 * Grades an exception of a probe or journey. A failed Keiko route is a product failure and stays
 * red; every other exception (native Jira, fixture, license, transport) is a lab error and
 * invalid, because it is no evidence about the product.
 */
export function gradeException(error, base = {}) {
  if (error?.message === ROUTE_FAILURE_MESSAGE) {
    return redCheck("product-route-failed", `Keiko route failed: ${error.message}`, base);
  }
  return invalidCheck("lab-error", `lab error: ${error?.message ?? String(error)}`, base);
}

/**
 * Re-grades a finished journey check against the gateway evidence of its window.
 *  - A green check stays green: an independent Jira or truth oracle proved the outcome.
 *  - Any other check during which a model call failed after exhausting its
 *    retries (see `readGatewayFailures`), or whose turn failed on a transport error, is invalid.
 *  - A failed call that was not retried (a limit such as context overflow) stays as graded.
 */
export function classifyJourney(check, failures) {
  if (check.status === "green" || check.status === "invalid") return check;
  const counts = `${failures.outages} infrastructure failures, ${failures.circuit} circuit events`;
  if (showsOutage(failures) || isTransportFailure(check.turnFailure ?? check.failure)) {
    return invalidCheck("gateway-failure", `${check.detail ?? ""}; ${counts}`, check);
  }
  return check;
}
