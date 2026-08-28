#!/usr/bin/env node
// Secret-scanning queue gate (#2296, epic #2291).
//
// Epic #2291's definition of done includes "GitHub reports no open generic secret alerts". #2292
// verified that once, by hand, and the queue refilled eight days later without anyone noticing:
// alert #17 was created on 2026-07-20 and was still undispositioned five weeks on. A one-time
// verification of a queue that keeps filling is not a control, and `SECURITY.md`'s triage procedure
// was prose that no script ever executed.
//
// This is that procedure, executable. It reads the open queue and cross-references it against the
// dispositions recorded in the #2296 closeout document. A NEW alert nobody has triaged fails. A
// documented one does not — a known synthetic fixture is a reviewed decision, not an incident.
//
// THE TRAP THIS EXISTS FOR: GitHub's default alert listing omits generic (`password`-type)
// findings, and so does an unfiltered `hide_secret=true` listing. Only an explicit
// `secret_type=password` filter returns them. Every "the generic queue is empty" claim produced
// without that filter is unsupported — the response it was based on could not have contained the
// finding. So this gate always issues BOTH requests and merges them, which is the single reason it
// exists rather than a one-line `gh api` in a workflow.
//
// Body-free: alert numbers, types, states and counts only. `hide_secret=true` is always sent, so no
// literal secret value is ever requested, logged, or written to evidence.
//
// Requires a token with `security-events: read`. It is therefore NOT part of the offline gate loop;
// it is wired into a scheduled lane. A missing token fails closed — an unauthenticated run must
// never be mistaken for an empty queue.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHostExecutable } from "./lib/host-executable.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const CLOSEOUT_DOCUMENT = join("docs", "release", "2296-dependency-security-closeout.md");
export const API_VERSION = "2026-03-10";
const DEFAULT_REPOSITORY = "oscharko-dev/Keiko";
const GH_TIMEOUT_MS = 30_000;

// The two listings that together are the whole queue. `secret_type=password` is not redundant with
// the unfiltered call: the unfiltered call does not return generic findings at all.
export function alertQueries(repository) {
  const base = `repos/${repository}/secret-scanning/alerts?state=open&hide_secret=true&per_page=100`;
  return [base, `${base}&secret_type=password`];
}

function runGh(query) {
  const result = spawnSync(
    // Resolved through the repository's hardened resolver rather than a bare PATH lookup: a
    // writable directory earlier in PATH must not be able to substitute the binary that reads
    // this repository's security findings.
    resolveHostExecutable("gh"),
    ["api", "-H", `X-GitHub-Api-Version: ${API_VERSION}`, query],
    {
      encoding: "utf8",
      timeout: GH_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(`GitHub API request failed (exit ${String(result.status)})`);
  }
  return JSON.parse(result.stdout);
}

// Merged by alert number: the two listings overlap by design, and an alert must be counted once.
export function mergeAlerts(responses) {
  const byNumber = new Map();
  for (const response of responses) {
    for (const alert of response) {
      byNumber.set(alert.number, { number: alert.number, secretType: alert.secret_type });
    }
  }
  return [...byNumber.values()].sort((left, right) => left.number - right.number);
}

// Disposition rows in the closeout document start with an alert reference cell (`#17`).
export function parseDocumentedAlerts(markdown) {
  const documented = new Set();
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const first = trimmed.split("|")[1]?.trim() ?? "";
    const match = /^#(\d+)$/u.exec(first);
    if (match !== null) documented.add(Number(match[1]));
  }
  return documented;
}

export function queueFailures(openAlerts, documented) {
  const failures = [];
  for (const alert of openAlerts) {
    if (!documented.has(alert.number)) {
      failures.push(
        `alert #${String(alert.number)} (${alert.secretType}) is open and has no recorded ` +
          `disposition in ${CLOSEOUT_DOCUMENT}`,
      );
    }
  }
  // A disposition for an alert that is no longer open is a stale sentence, and stale evidence is
  // the failure mode this whole closeout exists to stop. Removing it is part of closing the alert.
  const openNumbers = new Set(openAlerts.map((alert) => alert.number));
  for (const number of documented) {
    if (!openNumbers.has(number)) {
      failures.push(
        `alert #${String(number)} is dispositioned in ${CLOSEOUT_DOCUMENT} but is no longer open; ` +
          "remove the row",
      );
    }
  }
  return failures;
}

function defaultSeams() {
  const repository = process.env.GITHUB_REPOSITORY ?? DEFAULT_REPOSITORY;
  return {
    fetchAlerts: () => alertQueries(repository).map((query) => runGh(query)),
    readDocument: () => readFileSync(join(repoRoot, CLOSEOUT_DOCUMENT), "utf8"),
  };
}

export function evaluate(seams) {
  const openAlerts = mergeAlerts(seams.fetchAlerts());
  const documented = parseDocumentedAlerts(seams.readDocument());
  return { openAlerts, failures: queueFailures(openAlerts, documented) };
}

export function main(seams = defaultSeams()) {
  let result;
  try {
    result = evaluate(seams);
  } catch (error) {
    // Fail closed. An unauthenticated or failed request must never read as an empty queue.
    process.stderr.write(`secret-scanning-queue: FAIL — ${String(error.message ?? error)}\n`);
    return 1;
  }
  if (result.failures.length > 0) {
    process.stderr.write("secret-scanning-queue: FAIL\n");
    for (const failure of result.failures) process.stderr.write(`  - ${failure}\n`);
    return 1;
  }
  process.stdout.write(
    `secret-scanning-queue: PASS — ${String(result.openAlerts.length)} open alert(s), ` +
      "each with a recorded disposition.\n",
  );
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
