#!/usr/bin/env node
// Unstable-test report (quality-gate hardening plan 2026-11-21, P3):
//
//   node scripts/report-unstable-tests.mjs vitest --shard 1/8 [--repeats 3] [-- <file filter>...]
//   node scripts/report-unstable-tests.mjs playwright <report.json>
//
// A test whose verdict changes between runs of the same tree is non-deterministic: it fails pull
// requests that did not touch it and passes ones that broke it. The `vitest` mode runs one shard of
// the unit suites several times, each with a different shuffle seed, and compares every test's
// verdicts; the `playwright` mode reads one JSON report of a `--repeat-each` run. Both print the
// unstable tests and the consistently failing ones, append the table to the job summary in CI, and
// exit 1 when either list is not empty, or 2 when no verdict could be read or no test executed.

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./lib/is-main-module.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VITEST_BIN = join(ROOT, "node_modules", "vitest", "vitest.mjs");
const DECIDED = new Set(["passed", "failed"]);

/** One verdict per test of a vitest JSON report, keyed by file and full name. */
export function vitestVerdicts(report, root = ROOT) {
  const verdicts = new Map();
  for (const file of report.testResults ?? []) {
    const path = relative(root, file.name);
    if (file.status === "failed" || (file.assertionResults ?? []).length === 0) {
      // A file that failed to load has no test results; its own status is its only verdict. A
      // file-level failure, such as a failed hook, is a verdict even when every test passed.
      verdicts.set(`${path} (file)`, file.status === "failed" ? "failed" : "passed");
    }
    for (const test of file.assertionResults ?? []) {
      verdicts.set(`${path} > ${test.fullName}`, test.status);
    }
  }
  return verdicts;
}

const PLAYWRIGHT_STATUS = Object.freeze({
  expected: "passed",
  unexpected: "failed",
  flaky: "flaky",
  skipped: "skipped",
});

function collectSpecs(suite, titles, samples) {
  const path = suite.title ? [...titles, suite.title] : titles;
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      const id = `${spec.file} > ${[...path, spec.title].join(" > ")} [${test.projectName}]`;
      const status = PLAYWRIGHT_STATUS[test.status] ?? "failed";
      samples.set(id, [...(samples.get(id) ?? []), status]);
    }
  }
  for (const child of suite.suites ?? []) collectSpecs(child, path, samples);
}

/**
 * Every verdict per test of a Playwright JSON report: a `--repeat-each` run reports one test entry
 * per repetition. The file-level suite title is the file name, so it is left out of the id.
 */
export function playwrightSamples(report) {
  const samples = new Map();
  for (const fileSuite of report.suites ?? []) {
    collectSpecs({ ...fileSuite, title: "" }, [], samples);
  }
  return samples;
}

/** Folds the verdict maps of several runs into every test's list of verdicts. */
export function mergeVerdicts(runs) {
  const samples = new Map();
  for (const verdicts of runs) {
    for (const [id, status] of verdicts) samples.set(id, [...(samples.get(id) ?? []), status]);
  }
  return samples;
}

/**
 * Unstable: a test that both passed and failed, that Playwright itself reported flaky, or that was
 * missing from some runs. Consistently failing: it failed every time it ran. Skipped or pending
 * verdicts decide nothing.
 */
export function classify(samples, runCount) {
  const unstable = [];
  const failing = [];
  for (const [id, statuses] of [...samples].sort(([a], [b]) => a.localeCompare(b))) {
    const decided = statuses.filter((status) => DECIDED.has(status) || status === "flaky");
    if (decided.length === 0) continue;
    const kinds = new Set(decided);
    if (kinds.has("flaky") || kinds.size > 1 || statuses.length < runCount) {
      unstable.push({ id, statuses });
    } else if (kinds.has("failed")) {
      failing.push({ id, statuses });
    }
  }
  return { unstable, failing };
}

/** How many tests reached a decided verdict at least once: skipped-only reports test nothing. */
export function executedTestCount(samples) {
  let executed = 0;
  for (const statuses of samples.values()) {
    if (statuses.some((status) => DECIDED.has(status) || status === "flaky")) executed += 1;
  }
  return executed;
}

const TABLE_SEPARATOR = String.raw`\|`;

export function formatReport(label, testCount, runCount, { unstable, failing }) {
  const rows = (entries) =>
    entries.length === 0
      ? ["| none | |"]
      : entries.map(({ id, statuses }) => {
          const cell = id.replaceAll("|", TABLE_SEPARATOR);
          return `| ${cell} | ${statuses.join(", ")} |`;
        });
  return [
    `### Unstable tests: ${label}`,
    "",
    `${String(testCount)} tests, ${String(runCount)} runs each.`,
    "",
    "| Unstable test | Verdicts |",
    "| --- | --- |",
    ...rows(unstable),
    "",
    "| Consistently failing test | Verdicts |",
    "| --- | --- |",
    ...rows(failing),
    "",
  ].join("\n");
}

function option(argv, name, fallback) {
  const end = argv.indexOf("--");
  const index = (end === -1 ? argv : argv.slice(0, end)).indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
}

/**
 * `--shard i/n`, `--repeats r` (default 3, at least 2: one run compares nothing), and vitest file
 * filters after `--`, which reproduce one suspect locally.
 */
export function vitestPlan(argv) {
  const shard = option(argv, "--shard", "1/1");
  const match = /^(\d+)\/(\d+)$/u.exec(shard);
  if (match === null || Number(match[1]) < 1 || Number(match[1]) > Number(match[2])) {
    throw new TypeError(`--shard must be i/n with 1 <= i <= n, got ${String(shard)}`);
  }
  const repeats = Number(option(argv, "--repeats", "3"));
  if (!Number.isInteger(repeats) || repeats < 2) {
    throw new TypeError("--repeats must be an integer of at least 2");
  }
  // One seed per repetition, distinct across shards so the nightly matrix covers more orders.
  const seeds = Array.from({ length: repeats }, (_, run) => Number(match[1]) * 1000 + run + 1);
  const end = argv.indexOf("--");
  return { shard, seeds, filters: end === -1 ? [] : argv.slice(end + 1) };
}

function runVitest({ shard, filters }, seed, directory) {
  const output = join(directory, `run-${String(seed)}.json`);
  spawnSync(
    process.execPath,
    [
      VITEST_BIN,
      "run",
      `--shard=${shard}`,
      "--sequence.shuffle",
      `--sequence.seed=${String(seed)}`,
      "--reporter=dot",
      "--reporter=json",
      `--outputFile.json=${output}`,
      ...filters,
    ],
    { cwd: ROOT, stdio: "inherit" },
  );
  return vitestVerdicts(JSON.parse(readFileSync(output, "utf8")));
}

function measureVitest(argv) {
  const plan = vitestPlan(argv);
  const { shard, seeds } = plan;
  const directory = mkdtempSync(join(tmpdir(), "keiko-unstable-"));
  try {
    const runs = seeds.map((seed) => runVitest(plan, seed, directory));
    return {
      label: `unit suites, shard ${shard}`,
      samples: mergeVerdicts(runs),
      runCount: seeds.length,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function measurePlaywright(argv) {
  const [path] = argv;
  if (path === undefined) throw new TypeError("playwright mode needs the JSON report path");
  const report = JSON.parse(readFileSync(path, "utf8"));
  const samples = playwrightSamples(report);
  const runCount = Number(report.config?.projects?.[0]?.repeatEach ?? 1);
  return { label: "smoke journeys", samples, runCount };
}

function main(argv) {
  const [mode, ...rest] = argv;
  const measures = { vitest: measureVitest, playwright: measurePlaywright };
  if (!(mode in measures)) throw new TypeError("mode must be vitest or playwright");
  const { label, samples, runCount } = measures[mode](rest);
  if (samples.size === 0) throw new Error("no test verdict was reported");
  // A report in which every test was skipped proves nothing about stability.
  if (executedTestCount(samples) === 0) throw new Error("no test executed: every verdict skipped");
  const result = classify(samples, runCount);
  const report = formatReport(label, samples.size, runCount, result);
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  return result.unstable.length === 0 && result.failing.length === 0 ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`report-unstable-tests: could not measure — ${error.message}`);
    process.exitCode = 2;
  }
}
