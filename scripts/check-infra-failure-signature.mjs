#!/usr/bin/env node
// Classifies a completed, failed GitHub Actions run as infrastructure weather or as a genuine red,
// and - only for a run that is infrastructure weather by construction - asks GitHub to re-run its
// failed jobs exactly once.
//
// ADR-0139 D6 already wraps external-service CALLS in bounded retry with backoff, but that loop
// lives inside a step: it cannot reach a job that died before any step executed. That is exactly
// what the 2026-07-25 GitHub Actions incident produced - failed jobs with an empty step list and a
// runner internal-error annotation, costing three manual re-runs to restore green. This observer is
// the same pattern one layer out, at workflow granularity.
//
// The guarantee it must not weaken is ADR-0139's Consequences clause: a red required check implies a
// real defect, never runner weather. That is preserved by construction, not by intent:
//   * the load-bearing evidence is STRUCTURAL - a failed job that executed zero steps produced no
//     verdict about the tree, so re-running it cannot overwrite one;
//   * the pinned annotation signature only NARROWS that structural set further, in the ADR-0139 D6
//     idiom (an allowlist of transient signatures; anything unrecognised stays fatal);
//   * `rerun-failed-jobs` is run-granular, so ONE failed job that did execute a step makes the whole
//     run genuine - a real defect can never be re-executed behind an infrastructure excuse
//     (ADR-0156: "a real defect may never hide behind a slow measurement");
//   * every unknown, malformed, incomplete or unmatched shape classifies genuine, the allowlist is
//     keyed on workflow file path, and only `--mode enforce` acts at all - so drift, a rename and a
//     misconfiguration all degrade to today's manual re-run rather than to over-retrying.
//
// See docs/adr/ADR-0161-bounded-re-run-for-infrastructure-signature-failures.md.

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveHostExecutable } from "./lib/host-executable.mjs";
import { optionValue } from "./sonar-analysis-scope.mjs";

const INFRA = "infra";
const GENUINE = "genuine";
const EXCLUDED_LANE = "excluded-lane";
const SELF_EVENT = "self-event";
const ALREADY_ATTEMPTED = "already-attempted";
const RERUN = "rerun";
const NO_ACTION = "no-action";
const DRY_RUN = "dry-run";
const ENFORCE = "enforce";

/** The closed classification vocabulary. Only `infra` ever produces a re-run. */
export const CLASSIFICATION = Object.freeze({
  infra: INFRA,
  genuine: GENUINE,
  excludedLane: EXCLUDED_LANE,
  selfEvent: SELF_EVENT,
  alreadyAttempted: ALREADY_ATTEMPTED,
});

export const OBSERVER_WORKFLOW_PATH = ".github/workflows/infra-failure-retry.yml";

// Keyed on workflow FILE PATH, never on display name: a rename changes the name but keeps the path,
// and a brand-new workflow arrives outside this set, so both directions of drift fail toward no
// re-run. Membership is limited to event-driven lanes that are deterministic for a given tree
// (ADR-0139 D1), so a second execution asserts exactly what the first one would have.
//
// Issue #2707 named ci.yml and "the PR lane of osv-scanner.yml". ADR-0159 phase 3 moved that PR lane
// into workflow-hygiene.yml, which is the successor listed here; what remains in osv-scanner.yml is a
// nightly SCHEDULE re-reading a live vulnerability database, which is not deterministic for a given
// tree and is therefore deliberately absent. Wall-clock lanes (nightly-perf-evidence.yml,
// mutation-security.yml) are absent for the same reason - ADR-0156 rejects retrying a measurement.
export const RERUN_ELIGIBLE_WORKFLOW_PATHS = new Set([
  ".github/workflows/ci.yml",
  ".github/workflows/workflow-hygiene.yml",
]);

// Seeded from the 2026-07-25 incident payloads committed under
// scripts/__tests__/fixtures/infra-failure-signature/. Matching is case-insensitive and tolerates a
// missing trailing period; everything else must be the wording verbatim. GitHub may reword these -
// an unrecognised message classifies genuine, so drift degrades to manual re-runs, never to
// over-retrying.
export const INFRA_ANNOTATION_SIGNATURES = Object.freeze([
  Object.freeze({
    id: "runner-internal-error",
    pattern: /^github actions has encountered an internal error when running your job\.?$/u,
  }),
]);

// A job in one of these states did not fail. Everything else - `failure`, `cancelled`, `timed_out`,
// `action_required`, `stale`, a missing conclusion - counts as failed, which is the fail-closed
// direction: it can only ENLARGE the set of jobs that must each carry the infrastructure signature.
const NON_FAILING_JOB_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

const REPOSITORY_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;
const RUN_ID = /^[1-9]\d{0,18}$/u;
const CHECK_RUN_URL = /\/check-runs\/(\d+)$/u;
const GH_API_MAX_BUFFER = 32 * 1024 * 1024;

const EMPTY_DECISION = Object.freeze({
  runId: null,
  runAttempt: null,
  workflowPath: null,
  // `null`, not 0: a decision that short-circuits on the lane, the attempt or a malformed payload
  // never counts the jobs, and a record that says "0 failed jobs" would assert something it did not
  // look at. Only classifyJobs replaces these with a number it actually measured.
  failedJobCount: null,
  infraJobCount: null,
  signatures: null,
});

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function decisionFor(classification, reason, context = {}) {
  return {
    ...EMPTY_DECISION,
    ...context,
    decision: classification === INFRA ? RERUN : NO_ACTION,
    classification,
    reason,
  };
}

/** The number of steps that reached a terminal state. A step with no conclusion never ran. */
function executedStepCount(job) {
  if (!Array.isArray(job.steps)) return undefined;
  return job.steps.filter(
    (step) => isRecord(step) && step.conclusion !== null && step.conclusion !== undefined,
  ).length;
}

export function isFailedJob(job) {
  if (!isRecord(job)) return true;
  return typeof job.conclusion !== "string" || !NON_FAILING_JOB_CONCLUSIONS.has(job.conclusion);
}

export function matchedInfraSignature(annotations) {
  if (!Array.isArray(annotations)) return undefined;
  for (const annotation of annotations) {
    if (!isRecord(annotation) || annotation.annotation_level !== "failure") continue;
    const message =
      typeof annotation.message === "string" ? annotation.message.trim().toLowerCase() : "";
    const signature = INFRA_ANNOTATION_SIGNATURES.find((entry) => entry.pattern.test(message));
    if (signature !== undefined) return signature.id;
  }
  return undefined;
}

export function classifyJob(job, annotations) {
  if (!isRecord(job)) return { classification: GENUINE, reason: "job payload is malformed" };
  const executed = executedStepCount(job);
  if (executed === undefined) {
    return { classification: GENUINE, reason: "job payload carries no step list" };
  }
  if (executed > 0) {
    return { classification: GENUINE, reason: `${String(executed)} step(s) executed` };
  }
  const signature = matchedInfraSignature(annotations);
  if (signature === undefined) {
    return { classification: GENUINE, reason: "no pinned runner-failure signature" };
  }
  return { classification: INFRA, reason: "zero steps executed", signature };
}

function normalizedRun(observation) {
  if (!isRecord(observation) || !isRecord(observation.run)) return undefined;
  const { id, run_attempt: attempt, path } = observation.run;
  if (!Number.isSafeInteger(id) || id <= 0) return undefined;
  if (!Number.isSafeInteger(attempt) || attempt < 1) return undefined;
  if (typeof path !== "string" || path === "") return undefined;
  return { runId: id, runAttempt: attempt, workflowPath: path };
}

function laneRejection({ workflowPath, runAttempt }) {
  if (workflowPath === OBSERVER_WORKFLOW_PATH) {
    return { classification: SELF_EVENT, reason: "the observer never acts on its own run" };
  }
  if (!RERUN_ELIGIBLE_WORKFLOW_PATHS.has(workflowPath)) {
    return { classification: EXCLUDED_LANE, reason: "workflow file path is not on the allowlist" };
  }
  if (runAttempt >= 2) {
    return {
      classification: ALREADY_ATTEMPTED,
      reason: "the run already carries a second attempt",
    };
  }
  return undefined;
}

/** Every job of the run, or undefined when the list is absent or provably truncated. */
function completeJobList(observation) {
  const { jobs, jobsTotal: total } = observation;
  if (!Array.isArray(jobs)) return undefined;
  if (total !== undefined && (!Number.isSafeInteger(total) || total !== jobs.length)) {
    return undefined;
  }
  return jobs;
}

function annotationsOf(observation, job) {
  const map = isRecord(observation.annotations) ? observation.annotations : {};
  return isRecord(job) ? map[String(job.id)] : undefined;
}

function classifyJobs(run, observation) {
  const jobs = completeJobList(observation);
  if (jobs === undefined) return decisionFor(GENUINE, "job list is missing or incomplete", run);
  const failed = jobs.filter(isFailedJob);
  const infra = failed
    .map((job) => classifyJob(job, annotationsOf(observation, job)))
    .filter((verdict) => verdict.classification === INFRA);
  const context = {
    ...run,
    failedJobCount: failed.length,
    infraJobCount: infra.length,
    signatures: [...new Set(infra.map((verdict) => verdict.signature))],
  };
  if (failed.length === 0) return decisionFor(GENUINE, "the run reports no failed job", context);
  if (infra.length !== failed.length) {
    return decisionFor(GENUINE, "a failed job is not infrastructure-signature", context);
  }
  return decisionFor(INFRA, "every failed job carries the infrastructure signature", context);
}

/**
 * The single classification entry point. Evaluation order is fixed so the reported classification is
 * deterministic when several rejections apply: malformed, then self-event, then excluded lane, then
 * an already-retried run, and only then the jobs themselves.
 */
export function classifyRun(observation) {
  const run = normalizedRun(observation);
  if (run === undefined) return decisionFor(GENUINE, "run payload is missing or malformed");
  const rejection = laneRejection(run);
  if (rejection !== undefined) return decisionFor(rejection.classification, rejection.reason, run);
  return classifyJobs(run, observation);
}

export function requireRepositorySlug(value) {
  if (typeof value !== "string" || !REPOSITORY_SLUG.test(value)) {
    throw new Error("a repository slug of the form owner/name is required");
  }
  return value;
}

export function requireRunId(value) {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !RUN_ID.test(text)) {
    throw new Error("a positive integer run id is required");
  }
  return text;
}

export function ghApi(path, io = {}) {
  const execute = io.execute ?? spawnSync;
  const executable = io.ghExecutable ?? resolveHostExecutable("gh");
  const args = io.method === undefined ? ["api", path] : ["api", "--method", io.method, path];
  const result = execute(executable, args, { encoding: "utf8", maxBuffer: GH_API_MAX_BUFFER });
  if (result.error !== undefined && result.error !== null) throw result.error;
  if (result.status !== 0) {
    throw new Error(`gh api ${path} exited with status ${String(result.status)}`);
  }
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  return stdout === "" ? undefined : JSON.parse(stdout);
}

function requestFor(io) {
  return io.request ?? ((path, method) => ghApi(path, { ...io, method }));
}

// Annotations live on the Checks API, and a workflow job and its check run are different entities
// even where their ids currently coincide. Follow GitHub's own pointer - the `check_run_url` the jobs
// payload carries - instead of assuming the two ids are interchangeable. A job whose pointer is
// present but unusable yields no annotations at all, which classifies genuine: fail closed.
function checkRunIdOf(job) {
  if (typeof job.check_run_url === "string") return CHECK_RUN_URL.exec(job.check_run_url)?.[1];
  return String(job.id);
}

export function collectObservation(runId, io = {}) {
  const repository = requireRepositorySlug(io.repository ?? process.env.GITHUB_REPOSITORY);
  const id = requireRunId(runId);
  const request = requestFor(io);
  const run = request(`repos/${repository}/actions/runs/${id}`);
  const page = request(`repos/${repository}/actions/runs/${id}/jobs?per_page=100`);
  const jobs = isRecord(page) && Array.isArray(page.jobs) ? page.jobs : [];
  const annotations = {};
  for (const job of jobs.filter(isFailedJob)) {
    if (!isRecord(job) || !Number.isSafeInteger(job.id)) continue;
    const checkRunId = checkRunIdOf(job);
    if (checkRunId === undefined) continue;
    const path = `repos/${repository}/check-runs/${checkRunId}/annotations?per_page=100`;
    annotations[String(job.id)] = request(path);
  }
  return { run, jobs, jobsTotal: isRecord(page) ? page.total_count : undefined, annotations };
}

export function requestRerun(runId, io = {}) {
  const repository = requireRepositorySlug(io.repository ?? process.env.GITHUB_REPOSITORY);
  const path = `repos/${repository}/actions/runs/${requireRunId(runId)}/rerun-failed-jobs`;
  return requestFor(io)(path, "POST");
}

const NOT_EVALUATED = "not evaluated";

function signatureList(decision) {
  return decision.signatures.length > 0 ? decision.signatures.join(", ") : "none";
}

/**
 * Redaction contract: counts, the run id, the workflow FILE PATH, the matched signature IDs and a
 * fixed reason phrase. No annotation text, no log body, no branch, commit, actor or title ever
 * reaches this summary (AGENTS.md §7).
 */
export function renderDecisionSummary(decision, mode, acted) {
  const measured = (value) => (value === null ? NOT_EVALUATED : String(value));
  const signatures = decision.signatures === null ? NOT_EVALUATED : signatureList(decision);
  return [
    "### Infrastructure-signature re-run observer",
    "",
    `- run id: ${String(decision.runId ?? "unknown")}`,
    `- workflow path: ${decision.workflowPath ?? "unknown"}`,
    `- run attempt: ${String(decision.runAttempt ?? "unknown")}`,
    `- failed jobs: ${measured(decision.failedJobCount)}`,
    `- infrastructure-signature jobs: ${measured(decision.infraJobCount)}`,
    `- matched signatures: ${signatures}`,
    `- classification: ${decision.classification}`,
    `- mode: ${mode}`,
    `- action: ${acted ? "re-run requested for the failed jobs" : "no action"}`,
    `- reason: ${decision.reason}`,
  ].join("\n");
}

function renderOutputs(decision, acted) {
  return [
    `classification=${decision.classification}`,
    `decision=${decision.decision}`,
    `rerun_requested=${String(acted)}`,
    `run_id=${String(decision.runId ?? "")}`,
  ].join("\n");
}

export function parseObserverOptions(argv) {
  const mode = optionValue(argv, "--mode") ?? DRY_RUN;
  if (mode !== DRY_RUN && mode !== ENFORCE) {
    throw new Error(`--mode must be ${DRY_RUN} or ${ENFORCE}`);
  }
  return {
    mode,
    runId: optionValue(argv, "--run-id"),
    input: optionValue(argv, "--input"),
    summary: optionValue(argv, "--summary"),
    output: optionValue(argv, "--github-output"),
  };
}

export function runObserver(options, io = {}) {
  const observation =
    options.input === undefined
      ? (io.collect ?? collectObservation)(options.runId, io)
      : JSON.parse((io.read ?? readFileSync)(resolve(options.input), "utf8"));
  const decision = classifyRun(observation);
  const acted = decision.decision === RERUN && options.mode === ENFORCE;
  if (acted) (io.rerun ?? requestRerun)(decision.runId, io);
  return { decision, acted };
}

function appendTo(path, contents, io) {
  if (path === undefined) return;
  (io.append ?? appendFileSync)(resolve(path), `${contents}\n`, "utf8");
}

export function executeInfraFailureCli(io = {}) {
  const log = io.log ?? console.log;
  try {
    const options = parseObserverOptions(io.argv ?? process.argv.slice(2));
    const { decision, acted } = (io.run ?? runObserver)(options, io);
    const summary = renderDecisionSummary(decision, options.mode, acted);
    log(`infra-failure-signature: ${decision.classification} / ${decision.decision}`);
    log(summary);
    appendTo(options.summary, summary, io);
    appendTo(options.output, renderOutputs(decision, acted), io);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    (io.error ?? console.error)(`infra-failure-signature: FAIL - ${message}`);
    (io.setExitCode ?? ((value) => (process.exitCode = value)))(1);
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  executeInfraFailureCli();
}
