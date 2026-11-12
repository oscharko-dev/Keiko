// Cause classification for every qualification row that is not graded. The disposition itself is
// never reinterpreted: an unknown row stays unknown and the ledger keeps refusing it. The cause only
// says WHY, so a product defect, a lab or fixture fault, a cascade and an infrastructure fault are
// no longer indistinguishable. Everything persisted is a closed word, a status code, a count or a
// source line, never a value.
import { AssertionError } from "node:assert";

/** `product`: Keiko refused locally or failed/misprojected while Jira answered 2xx. `lab`: fixture,
 * preparation, oracle or argument-builder fault. `cascade`: a root cause elsewhere (`blockedBy`).
 * `infrastructure`: transport, timeout, 5xx, rate limit. `not-attempted`: never reached.
 * `undetermined`: genuinely ambiguous, e.g. Jira refused Keiko's request or an oracle disagreed. */
export const QUALIFICATION_CAUSES = Object.freeze([
  "product",
  "lab",
  "cascade",
  "infrastructure",
  "not-attempted",
  "undetermined",
]);

const SUCCESS_OUTCOMES = new Set(["succeeded", "succeeded-unconfirmed"]);
export const succeededOutcome = (outcome) => SUCCESS_OUTCOMES.has(outcome);

/** A closed category for the statuses Jira answered; never raw Jira text. */
export function jiraClass(statuses) {
  if (statuses.length === 0) return "none";
  const classes = new Set(statuses.map(statusClass));
  return classes.size === 1 ? [...classes][0] : "mixed";
}
function statusClass(status) {
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status === 408 || status === 425 || status === 429) return "retryable";
  if (status >= 500) return "5xx";
  return CLIENT_CLASSES.get(status) ?? "4xx-other";
}
const CLIENT_CLASSES = new Map([
  [400, "4xx-validation"],
  [422, "4xx-validation"],
  [401, "4xx-auth"],
  [403, "4xx-auth"],
  [404, "404"],
  [405, "405"],
  [409, "409"],
]);
export function jiraSummary(snapshot) {
  const statuses = (snapshot?.responses ?? []).map((response) => response.status);
  return { statuses, class: jiraClass(statuses) };
}

const PRODUCT_FRAME = /\/packages\/keiko-[\w-]+\/dist\/[\w./-]*?([\w-]+\.js:\d+)/u;
const RECIPE_FRAME = /(api-qualification[\w-]*\.mjs:\d+)/u;
const NODE_FRAME = /\(?node:|\/node_modules\//u;
const INFRASTRUCTURE_CODES =
  /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|UND_ERR_[A-Z_]+)$/u;
const lines = (error) => String(error?.stack ?? "").split("\n");
/** The error and its `cause` chain (bounded), so a wrapped product failure keeps its frames. */
const chain = (error) => {
  const errors = [];
  for (let current = error; current instanceof Error && errors.length < 4; current = current.cause)
    errors.push(current);
  return errors;
};
const unique = (values) => [...new Set(values)].slice(0, 3);
/** Which side threw: any product-build frame (also in a cause) wins, else the first lab frame. */
function throwingSide(frames) {
  if (frames.some((line) => PRODUCT_FRAME.test(line))) return "product";
  for (const line of frames) {
    if (NODE_FRAME.test(line) || /api-qualification-assert\.mjs/u.test(line)) continue;
    if (PRODUCT_FRAME.test(line)) return "product";
    if (RECIPE_FRAME.test(line)) return "lab";
  }
  return "unknown";
}
const failureMessage = (error, values) =>
  error instanceof AssertionError && (!error.generatedMessage || values)
    ? String(error.message).slice(0, values ? 700 : 160)
    : undefined;
const failureCode = (error) => {
  const code = typeof error?.cause?.code === "string" ? error.cause.code : error?.code;
  return typeof code === "string" && INFRASTRUCTURE_CODES.test(code) ? code : undefined;
};
/** Names the recipe and product lines that failed, never a value: a message only when written by hand. */
export function describeFailure(error, detailMode = process.env.KEIKO_AC7_DETAIL) {
  const frames = chain(error).flatMap(lines);
  const sites = unique(frames.map((line) => RECIPE_FRAME.exec(line)?.[1]).filter(Boolean));
  const productSites = unique(frames.map((line) => PRODUCT_FRAME.exec(line)?.[1]).filter(Boolean));
  const message = failureMessage(error, detailMode === "values");
  const code = failureCode(error);
  return {
    ...(sites.length > 0 ? { sites } : {}),
    ...(productSites.length > 0 ? { productSites } : {}),
    ...(message === undefined ? {} : { message }),
    errorType: error instanceof Error ? error.name : "unknown",
    origin: throwingSide(frames),
    ...(code === undefined ? {} : { infrastructureCode: code }),
    ...(Number.isSafeInteger(error?.nativeStatus) ? { nativeStatus: error.nativeStatus } : {}),
  };
}
/** Only a real transport signal makes a failure infrastructure; a timeout alone does not. */
const infrastructureDetail = (detail) => detail?.infrastructureCode !== undefined;

const SAFE_WORD = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const safeWord = (value) =>
  typeof value === "string" && SAFE_WORD.test(value) ? value : "unspecified";
/** The product's own refusal word and outcome; both are closed vocabularies of the product. */
export function productRefusalDetail(data) {
  return { outcome: safeWord(data?.outcome), reason: safeWord(data?.reason) };
}
/**
 * The product answered locally with a non-success outcome before any native request left the
 * process: a refusal that proves nothing about Jira. A request that reached Jira is never one.
 */
export function localRefusal(dispatch, snapshot) {
  if (dispatch?.kind !== "settled" || (snapshot?.responses ?? []).length > 0) return undefined;
  const data = dispatch.result?.data;
  return succeededOutcome(data?.outcome) ? undefined : productRefusalDetail(data);
}

/**
 * Closed refusal codes of the dispatch that describe the lab's own configuration (a held
 * capability, a missing approval, a license, a credential), never a product defect. Matched on the
 * code only, never on message text.
 */
const LAB_CONFIGURATION_REFUSALS = new Set([
  "capability-held",
  "approval-required",
  "license-required",
  "license-invalid",
  "license-expired",
  "auth-failed",
  "effect-denied",
]);
const refusalCause = (row) =>
  LAB_CONFIGURATION_REFUSALS.has(row.product?.reason) ? "lab" : "product";
/** A write the product reported as done and Jira answered 2xx: a failing oracle may be a wrong target. */
const writeSucceeded = (row, jira) =>
  row.mutation === true &&
  jira.class === "2xx" &&
  succeededOutcome(row.dispatch?.result?.data?.outcome);
const preparedCause = (row) => {
  if (row.detail?.origin === "product") return "product";
  return infrastructureDetail(row.detail) ? "infrastructure" : "lab";
};
const oracleCause = (row, jira) => {
  if (infrastructureDetail(row.detail)) return "infrastructure";
  return writeSucceeded(row, jira) ? "undetermined" : "lab";
};
function byJira(row, jira, labHealthFailed) {
  if (jira.class === "retryable") return "infrastructure";
  // A 5xx may answer a request Keiko built badly; only a failing lab health read blames the host.
  if (jira.class === "5xx") return labHealthFailed ? "infrastructure" : "undetermined";
  const outcome = row.dispatch?.result?.data?.outcome;
  // Jira answered 2xx: a product that then failed misprojected; one that succeeded met a
  // disagreeing oracle, which cannot be told apart from an oracle fault.
  if (jira.class === "2xx" && outcome !== undefined && !succeededOutcome(outcome)) return "product";
  return "undetermined";
}
/** Lab only when a recipe frame threw; an unknown origin without a transport signal is ambiguous. */
function dispatchCause(row, jira) {
  if (row.detail?.origin === "product") return "product";
  if (infrastructureDetail(row.detail) || jira.class === "retryable") return "infrastructure";
  return row.detail?.origin === "lab" ? "lab" : "undetermined";
}
/** Failures decided by the failure word alone; the rest fall through to what Jira answered. */
const FAILURE_CAUSES = new Map([
  ["not-attempted", () => "not-attempted"],
  ["prepare-precondition", preparedCause],
  ["prepare-failed", preparedCause],
  ["oracle-read-refused", oracleCause],
  ["readback-failed", dispatchCause],
  ["product-refused", refusalCause],
  ["dispatch-failed", dispatchCause],
]);
const byFailure = (row, jira, health) =>
  (FAILURE_CAUSES.get(row.failure) ?? byJira)(row, jira, health);
/**
 * Undetermined rows that still point at the product: it succeeded after a native 2xx but the oracle
 * disagreed or could not find the object, or Jira rejected the request Keiko built as invalid.
 */
const suspectProduct = (row, jira) =>
  (jira.class === "2xx" &&
    (row.failure === "readback-mismatch" || row.failure === "oracle-read-refused") &&
    succeededOutcome(row.dispatch?.result?.data?.outcome)) ||
  (jira.class === "4xx-validation" && row.failure !== "dispatch-failed");
/**
 * A cascade needs a visible root: the blocking row must itself be non-executable with its own cause
 * in the run (`blockedBy.rootCause`). A root that left no such trace is no explanation.
 */
const cascadeCause = (blockedBy) =>
  blockedBy.rootCause === undefined ? "undetermined" : "cascade";
/**
 * Adds `cause` (and `blockedBy`, `jira`, never a changed disposition) to a row that is not graded.
 * `blockedBy` names the auxiliary fixture or earlier case whose failure caused this one.
 */
export function annotateCause(row, { blockedBy, snapshot, labHealthFailed } = {}) {
  if (row.runtimeAvailability !== "unknown") return row;
  const jira = jiraSummary(snapshot ?? row.witness);
  const cause =
    blockedBy === undefined ? byFailure(row, jira, labHealthFailed) : cascadeCause(blockedBy);
  return {
    ...row,
    cause,
    ...(blockedBy === undefined ? {} : { blockedBy }),
    ...(cause === "undetermined" && suspectProduct(row, jira) ? { suspect: "product" } : {}),
    ...(jira.statuses.length > 0 ? { jira } : {}),
  };
}
/** Counts of every cause among the rows that are not graded; the vocabulary is always complete. */
export function causeSummary(operations) {
  const counts = Object.fromEntries(QUALIFICATION_CAUSES.map((cause) => [cause, 0]));
  for (const operation of operations) {
    if (operation.runtimeAvailability !== "unknown") continue;
    const cause = operation.cause ?? "undetermined";
    if (!Object.hasOwn(counts, cause)) throw new TypeError("Unknown qualification cause");
    counts[cause] += 1;
  }
  return counts;
}
/** Undetermined rows whose evidence points at the product without proving it. */
export function suspectSummary(operations) {
  return {
    product: operations.filter(
      (operation) => operation.runtimeAvailability === "unknown" && operation.suspect === "product",
    ).length,
  };
}
/** Rows the run never reached keep their unknown disposition and say so. */
export function markNotAttempted(operations) {
  for (const operation of operations)
    if (operation.runtimeAvailability === "unknown" && operation.cause === undefined)
      Object.assign(operation, { cause: "not-attempted", failure: "not-attempted" });
}
