#!/usr/bin/env node
// Repository lint, one ESLint process per workspace package plus one for everything else.
//
// The type-aware lint keeps a TypeScript program per tsconfig in memory for the whole run. Linted
// as one `eslint .`, the monorepo outgrew the 12 GiB heap that fits a 16 GiB ubuntu-latest runner
// (#4182, 2026-11-02: Core quality died with "JavaScript heap out of memory" at 11.9 GiB; a local
// run peaked at 13.0 GB resident). Each process here starts from an empty heap, so the peak is
// bounded by the largest package (keiko-server: 8.7 GB resident) instead of growing with every
// package added. The partitions run one after another so two heaps never share the runner.
//
// Every partition receives this process's own Node flags (the heap ceiling the lint script sets) and
// `--max-warnings=0`. The root partition lints `.` minus the partitioned package directories, so
// together the partitions cover exactly what `eslint .` covers. A package the root config ignores
// as a whole (packages/keiko-ui, which lints itself) gets no partition.
//
// Every partition's peak resident memory is measured and held to a budget of three quarters of the
// 16 GiB hosted runner. A partition that grows past it fails here with its name and its peak, while
// the runner still has room to report, instead of a later run dying of memory with no reason given
// (quality-gate hardening plan 2026-11-21, P1). The peaks also go to the job summary in CI, so the
// trend is visible before the budget is reached.

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isMainModule } from "./lib/is-main-module.mjs";

const ESLINT_BIN = join("node_modules", "eslint", "bin", "eslint.js");
const PEAK_REPORTER = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "lib", "peak-rss-reporter.mjs"),
).href;
const GIB = 1024 ** 3;

/** Three quarters of the 16 GiB ubuntu-latest runner. */
export const PEAK_RSS_BUDGET_BYTES = 12 * GIB;

function gib(bytes) {
  return (bytes / GIB).toFixed(1);
}

/**
 * Names every partition whose measured peak exceeded the budget, and every partition that reported
 * no peak at all: an unmeasured partition cannot be shown to fit.
 */
export function peakBudgetFailures(peaks, budgetBytes = PEAK_RSS_BUDGET_BYTES) {
  return peaks.flatMap(({ label, peakBytes }) => {
    if (!Number.isFinite(peakBytes) || peakBytes <= 0) return [`${label}: no peak was measured`];
    return peakBytes > budgetBytes
      ? [`${label}: peaked at ${gib(peakBytes)} GiB, above the ${gib(budgetBytes)} GiB budget`]
      : [];
  });
}

export function peakSummary(peaks, budgetBytes = PEAK_RSS_BUDGET_BYTES) {
  const rows = peaks.map(
    ({ label, peakBytes }) =>
      `| ${label} | ${Number.isFinite(peakBytes) ? gib(peakBytes) : "unmeasured"} |`,
  );
  return [
    `### Lint peak resident memory (budget ${gib(budgetBytes)} GiB)`,
    "",
    "| Partition | Peak GiB |",
    "| --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

function readPeak(file) {
  return existsSync(file) ? Number(readFileSync(file, "utf8").trim()) : Number.NaN;
}

// The `ignores` of the config objects that hold nothing else: ESLint's global ignores.
export function globalIgnores(config) {
  return config
    .filter((entry) => Object.keys(entry).every((key) => key === "ignores" || key === "name"))
    .flatMap((entry) => entry.ignores ?? []);
}

export function lintPartitions(packageNames, ignores) {
  const packages = [...packageNames]
    .sort((left, right) => (left < right ? -1 : Number(left > right)))
    .map((name) => `packages/${name}`)
    .filter((dir) => !ignores.includes(`${dir}/**`));
  return [
    ...packages.map((dir) => ({ label: dir, args: [dir] })),
    {
      label: "repository root",
      args: [".", ...packages.flatMap((dir) => ["--ignore-pattern", `${dir}/**`])],
    },
  ];
}

export function workspacePackages(root) {
  return readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && existsSync(join(root, "packages", entry.name, "package.json")),
    )
    .map((entry) => entry.name);
}

export function runPartitions(partitions, run) {
  const failed = partitions.filter((partition) => {
    console.log(`lint-repository: ${partition.label}`);
    return run(partition.args) !== 0;
  });
  return failed.map((partition) => partition.label);
}

export function lintPartition(root, args, peakFile) {
  const result = spawnSync(
    process.execPath,
    [...process.execArgv, "--import", PEAK_REPORTER, ESLINT_BIN, "--max-warnings=0", ...args],
    { cwd: root, stdio: "inherit", env: { ...process.env, KEIKO_PEAK_RSS_FILE: peakFile } },
  );
  return result.status ?? 1;
}

/**
 * The flags this script hands to every partition. Only pruning is accepted: the test-determinism
 * register (eslint-suppressions.json) may shrink through this command, never grow, so a flag that
 * adds suppressions is refused rather than forwarded.
 */
export function forwardedArgs(argv) {
  for (const arg of argv) {
    if (arg !== "--prune-suppressions") {
      throw new TypeError(`lint-repository: unsupported argument ${arg}`);
    }
  }
  return [...new Set(argv)];
}

async function main() {
  const root = process.cwd();
  const extra = forwardedArgs(process.argv.slice(2));
  const { default: config } = await import(pathToFileURL(join(root, "eslint.config.js")).href);
  const partitions = lintPartitions(workspacePackages(root), globalIgnores(config));
  const peakDirectory = mkdtempSync(join(tmpdir(), "keiko-lint-peak-"));
  const peaks = [];
  const failed = runPartitions(partitions, (args) => {
    const peakFile = join(peakDirectory, `${peaks.length}.txt`);
    const status = lintPartition(root, [...args, ...extra], peakFile);
    const label = partitions[peaks.length].label;
    peaks.push({ label, peakBytes: readPeak(peakFile) });
    console.log(`lint-repository: ${label} peak ${gib(peaks.at(-1).peakBytes)} GiB`);
    return status;
  });
  rmSync(peakDirectory, { recursive: true, force: true });
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, peakSummary(peaks));
  const overBudget = peakBudgetFailures(peaks);
  for (const problem of overBudget) console.error(`lint-repository: FAIL — ${problem}`);
  if (failed.length > 0) console.error(`lint-repository: FAIL — ${failed.join(", ")}`);
  if (failed.length > 0 || overBudget.length > 0) process.exit(1);
  console.log(`lint-repository: PASS — ${partitions.length} partitions`);
}

if (isMainModule(import.meta.url)) await main();
