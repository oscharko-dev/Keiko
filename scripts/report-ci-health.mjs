#!/usr/bin/env node
// Gate health report (quality-gate hardening plan 2026-11-21, P6):
//
//   node scripts/report-ci-health.mjs [--days 7] [--json]
//
// Reproduces the measured baseline of the plan's section 1 from the GitHub API, without manual
// steps: pull-request run outcomes, head commits measured more than once, hours spent on runs that
// were then cancelled, verdict times, and the jobs that failed most. It prints a Markdown report,
// appends it to the job summary in CI, and exits non-zero when a ceiling below is crossed, so a
// trend is visible, and fails, weeks before it breaks a pull request. It reads only run metadata:
// no log, no artifact, no code.
//
// Token: GH_TOKEN or GITHUB_TOKEN. Repository: GITHUB_REPOSITORY, default oscharko-dev/Keiko.

import { appendFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { isMainModule } from "./lib/is-main-module.mjs";

const API_ROOT = "https://api.github.com";
const PAGE_SIZE = 100;
const FAILED_RUNS_INSPECTED = 40;
const MAX_PAGES = 10;

/**
 * No-regression ceilings at the baseline this script measured on 2026-11-21 over the same 300 runs
 * as the plan's section 1: 37 of 71 decided runs failed, and a successful verdict took a median of
 * 82 minutes (the hand measurement's 71 came from a smaller sample and is superseded). The target
 * state of section 2 is stricter; these only stop the gates from getting worse unseen. Heads run
 * more than once are reported but hold no ceiling: since ADR-0178 D6 a title or body edit runs a
 * second, evidence-reusing run on the same head on purpose, and run metadata cannot tell it from
 * a second full matrix.
 */
export const CEILINGS = Object.freeze({
  /** Failed share of decided (failed or successful) pull-request runs. */
  failedShareOfDecided: 0.53,
  /** Median minutes from creation to verdict of a successful pull-request run. */
  successVerdictMedianMinutes: 85,
});

function minutesBetween(start, end) {
  return (Date.parse(end) - Date.parse(start)) / 60_000;
}

/** Nearest-rank percentile of a list of numbers; `null` for an empty list. */
export function percentile(values, share) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(share * sorted.length));
  return sorted[rank - 1];
}

function count(values, predicate) {
  return values.filter(predicate).length;
}

/**
 * Health measures of completed pull-request runs. Pure, so each measure is provable from fixtures.
 * @param {Array<{ event: string, status: string, conclusion: string | null, head_sha: string,
 *   created_at: string, updated_at: string, run_started_at?: string }>} runs
 */
export function computeHealth(runs) {
  const pull = runs.filter((run) => run.event === "pull_request" && run.status === "completed");
  const cancelled = pull.filter((run) => run.conclusion === "cancelled");
  const failed = pull.filter((run) => run.conclusion === "failure");
  const succeeded = pull.filter((run) => run.conclusion === "success");
  const perHead = new Map();
  for (const run of pull) perHead.set(run.head_sha, (perHead.get(run.head_sha) ?? 0) + 1);
  const verdict = (list) => list.map((run) => minutesBetween(run.created_at, run.updated_at));
  const cancelledHours =
    cancelled.reduce(
      (sum, run) => sum + minutesBetween(run.run_started_at ?? run.created_at, run.updated_at),
      0,
    ) / 60;
  return {
    completed: pull.length,
    cancelled: cancelled.length,
    failed: failed.length,
    succeeded: succeeded.length,
    heads: perHead.size,
    repeatedHeads: count([...perHead.values()], (runsOnHead) => runsOnHead > 1),
    cancelledHours: Math.round(cancelledHours * 10) / 10,
    successVerdictMinutes: {
      median: percentile(verdict(succeeded), 0.5),
      p90: percentile(verdict(succeeded), 0.9),
    },
    failureVerdictMinutes: {
      median: percentile(verdict(failed), 0.5),
      p90: percentile(verdict(failed), 0.9),
    },
  };
}

/** Failing job names of the inspected failed runs, most frequent first. */
export function topFailingJobs(jobsByRun, limit = 10) {
  const tally = new Map();
  for (const jobs of jobsByRun) {
    const names = new Set(
      jobs.filter((job) => job.conclusion === "failure").map((job) => job.name),
    );
    for (const name of names) tally.set(name, (tally.get(name) ?? 0) + 1);
  }
  return [...tally.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([name, runs]) => ({ name, runs }));
}

/** Every ceiling the measures cross, as a sentence naming the measure, its value and its ceiling. */
export function ceilingViolations(health, ceilings = CEILINGS) {
  const violations = [];
  const decided = health.failed + health.succeeded;
  if (decided > 0 && health.failed / decided > ceilings.failedShareOfDecided) {
    violations.push(
      `failed share of decided runs ${health.failed}/${decided} is above ${ceilings.failedShareOfDecided}`,
    );
  }
  const median = health.successVerdictMinutes.median;
  if (median !== null && median > ceilings.successVerdictMedianMinutes) {
    violations.push(
      `median successful verdict ${Math.round(median)} min is above ${ceilings.successVerdictMedianMinutes} min`,
    );
  }
  return violations;
}

function minutes(value) {
  return value === null ? "n/a" : `${Math.round(value)} min`;
}

export function formatReport(health, failingJobs, violations, since) {
  const lines = [
    `### CI gate health (pull-request runs of ci.yml since ${since})`,
    "",
    "| Measure | Value |",
    "| --- | --- |",
    `| Completed runs | ${health.completed} |`,
    `| Cancelled / failed / succeeded | ${health.cancelled} / ${health.failed} / ${health.succeeded} |`,
    `| Heads run more than once | ${health.repeatedHeads} of ${health.heads} |`,
    `| Hours on runs that were then cancelled | ${health.cancelledHours} |`,
    `| Successful verdict, median / p90 | ${minutes(health.successVerdictMinutes.median)} / ${minutes(health.successVerdictMinutes.p90)} |`,
    `| Failed verdict, median / p90 | ${minutes(health.failureVerdictMinutes.median)} / ${minutes(health.failureVerdictMinutes.p90)} |`,
    "",
    "| Most frequent failing job | Failed runs |",
    "| --- | --- |",
    ...(failingJobs.length === 0
      ? ["| none | 0 |"]
      : failingJobs.map((job) => `| ${job.name} | ${job.runs} |`)),
    "",
    violations.length === 0
      ? "All ceilings hold."
      : ["Ceilings crossed:", ...violations.map((violation) => `- ${violation}`)].join("\n"),
    "",
  ];
  return lines.join("\n");
}

/**
 * One GitHub API read. A 5xx answer is retried up to `attempts` times with a growing pause, since
 * the jobs endpoint answers an occasional 502 under load; any other failure is final.
 */
export async function api(
  path,
  token,
  { fetch = globalThis.fetch, attempts = 3, pause, attempt = 1 } = {},
) {
  const response = await fetch(`${API_ROOT}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (response.ok) return response.json();
  if (response.status < 500 || attempt >= attempts) {
    throw new Error(`GitHub API ${response.status} for ${path}`);
  }
  // A retry follows its pause, so it is a tail call rather than an await inside a loop.
  await (pause ?? sleep)(attempt * 2000);
  return api(path, token, { fetch, attempts, pause, attempt: attempt + 1 });
}

async function fetchRuns(repo, token, since, page = 1, runs = []) {
  const body = await api(
    `/repos/${repo}/actions/workflows/ci.yml/runs?event=pull_request&created=%3E%3D${since}&per_page=${PAGE_SIZE}&page=${page}`,
    token,
  );
  const batch = Array.isArray(body.workflow_runs) ? body.workflow_runs : [];
  runs.push(...batch);
  // The next page exists only when this one was full, so pages are read one after another.
  if (batch.length < PAGE_SIZE || page >= MAX_PAGES) return runs;
  return fetchRuns(repo, token, since, page + 1, runs);
}

/** The `--days <n>` window (default 7) as the ISO date it starts on. */
export function windowStart(argv, now = new Date()) {
  const index = argv.indexOf("--days");
  const days = index === -1 ? 7 : Number(argv[index + 1]);
  if (!Number.isInteger(days) || days < 1) throw new TypeError("--days must be a positive integer");
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

async function failedRunJobs(repo, token, runs) {
  const failedRuns = runs
    .filter((run) => run.event === "pull_request" && run.conclusion === "failure")
    .slice(0, FAILED_RUNS_INSPECTED);
  // At most FAILED_RUNS_INSPECTED independent reads, well inside the API's concurrency limits.
  return Promise.all(
    failedRuns.map(async (run) => {
      const body = await api(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`, token);
      return Array.isArray(body.jobs) ? body.jobs : [];
    }),
  );
}

function publish(argv, result) {
  if (argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const report = formatReport(result.health, result.failingJobs, result.violations, result.since);
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
}

async function main(argv) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GH_TOKEN or GITHUB_TOKEN is required");
  const repo = process.env.GITHUB_REPOSITORY || "oscharko-dev/Keiko";
  const since = windowStart(argv);
  const runs = await fetchRuns(repo, token, since);
  const health = computeHealth(runs);
  const failingJobs = topFailingJobs(await failedRunJobs(repo, token, runs));
  const violations = ceilingViolations(health);
  publish(argv, { since, health, failingJobs, violations });
  return violations.length === 0 ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  // Exit 1 is a crossed ceiling; exit 2 is a report that could not be produced at all (token,
  // network, API), so a broken run never reads as a measured regression.
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`report-ci-health: could not measure — ${error.message}`);
    process.exitCode = 2;
  }
}
