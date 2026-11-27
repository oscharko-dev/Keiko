#!/usr/bin/env node
// Repository lint, one ESLint process per workspace package plus one for everything else.
//
// The type-aware lint keeps a TypeScript program per tsconfig in memory for the whole run. Linted
// as one `eslint .`, the monorepo outgrew the 12 GiB heap that fits a 16 GiB ubuntu-latest runner
// (#4182, 2026-11-02: Core quality died with "JavaScript heap out of memory" at 11.9 GiB; a local
// run peaked at 13.0 GB resident). Each process here starts from an empty heap, so the peak is
// bounded by the largest partition instead of growing with every package added. keiko-server
// alone reached 11.6-12.0 GiB on macOS (2026-11-27, earlier 8.7 GB), so it is split by directory
// (SPLIT_PACKAGE_DIRECTORIES). The partitions run one after another so two heaps never share the runner.
//
// Every partition receives this process's own Node flags (the heap ceiling the lint script sets) and
// `--max-warnings=0`. The root partition lints `.` minus the partitioned package directories, so
// together the partitions cover exactly what `eslint .` covers. A package the root config ignores
// as a whole (packages/keiko-ui, which lints itself) gets no partition.
//
// Every partition's peak resident memory is measured and held to a budget of three quarters of the
// 16 GiB hosted runner, while it runs: the preloaded reporter's watchdog thread stops a partition
// the moment it grows past the budget, and the partition then fails here with its name and the size
// it reached, while the runner still has room to report, instead of a later run dying of memory
// with no reason given (quality-gate hardening plan 2026-11-21, P1). The peaks also go to the job
// summary in CI, so the trend is visible before the budget is reached.

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

/**
 * Packages whose type-aware lint outgrew one partition's headroom: each listed directory is linted
 * in a process of its own and the rest of the package in another. Measured 2026-11-27 on macOS, the
 * whole of keiko-server peaked at 11.6-12.0 GiB, and one run failed the 12 GiB budget. The split
 * never changes what is linted: the remainder ignores exactly the directories carved out of it, and
 * the typed-lint program still resolves through each file's nearest tsconfig (`projectService`).
 */
export const SPLIT_PACKAGE_DIRECTORIES = Object.freeze({
  "packages/keiko-server": ["src/coding-runtime", "src/atlassian"],
});

function packagePartitions(dir) {
  const carved = (SPLIT_PACKAGE_DIRECTORIES[dir] ?? []).map((sub) => `${dir}/${sub}`);
  if (carved.length === 0) return [{ label: dir, args: [dir] }];
  return [
    ...carved.map((path) => ({ label: path, args: [path] })),
    {
      label: `${dir} (remainder)`,
      args: [dir, ...carved.flatMap((path) => ["--ignore-pattern", `${path}/**`])],
    },
  ];
}

export function lintPartitions(packageNames, ignores) {
  const packages = [...packageNames]
    .sort((left, right) => (left < right ? -1 : Number(left > right)))
    .map((name) => `packages/${name}`)
    .filter((dir) => !ignores.includes(`${dir}/**`));
  return [
    ...packages.flatMap((dir) => packagePartitions(dir)),
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

export function runPartitions(partitions, run, log = console.log) {
  const failed = partitions.filter((partition) => {
    log(`lint-repository: ${partition.label}`);
    return run(partition.args) !== 0;
  });
  return failed.map((partition) => partition.label);
}

export function lintPartition(root, args, peakFile) {
  const result = spawnSync(
    process.execPath,
    [...process.execArgv, "--import", PEAK_REPORTER, ESLINT_BIN, "--max-warnings=0", ...args],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        KEIKO_PEAK_RSS_FILE: peakFile,
        KEIKO_PEAK_RSS_BUDGET_BYTES: String(PEAK_RSS_BUDGET_BYTES),
      },
    },
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

/**
 * Lints every partition and returns the exit code: 1 when a partition failed or its peak is not
 * shown to fit the budget. `root`, `argv`, `env`, `lint`, `log` and `error` are seams for the
 * in-process tests; the command line uses the working directory, its arguments, the process
 * environment, `lintPartition` and the console.
 */
export async function main(deps = {}) {
  const { root, argv, env, lint, log, error } = {
    root: process.cwd(),
    argv: process.argv.slice(2),
    env: process.env,
    lint: lintPartition,
    log: console.log,
    error: console.error,
    ...deps,
  };
  const extra = forwardedArgs(argv);
  const { default: config } = await import(pathToFileURL(join(root, "eslint.config.js")).href);
  const partitions = lintPartitions(workspacePackages(root), globalIgnores(config));
  const peakDirectory = mkdtempSync(join(tmpdir(), "keiko-lint-peak-"));
  const peaks = [];
  const failed = runPartitions(
    partitions,
    (args) => {
      const peakFile = join(peakDirectory, `${peaks.length}.txt`);
      const status = lint(root, [...args, ...extra], peakFile);
      const label = partitions[peaks.length].label;
      peaks.push({ label, peakBytes: readPeak(peakFile) });
      log(`lint-repository: ${label} peak ${gib(peaks.at(-1).peakBytes)} GiB`);
      return status;
    },
    log,
  );
  rmSync(peakDirectory, { recursive: true, force: true });
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, peakSummary(peaks));
  const overBudget = peakBudgetFailures(peaks);
  for (const problem of overBudget) error(`lint-repository: FAIL — ${problem}`);
  if (failed.length > 0) error(`lint-repository: FAIL — ${failed.join(", ")}`);
  if (failed.length > 0 || overBudget.length > 0) return 1;
  log(`lint-repository: PASS — ${partitions.length} partitions`);
  return 0;
}

if (isMainModule(import.meta.url)) process.exitCode = await main();
