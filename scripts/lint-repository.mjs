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

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { isMainModule } from "./lib/is-main-module.mjs";

const ESLINT_BIN = join("node_modules", "eslint", "bin", "eslint.js");

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

// The ESLint arguments one partition runs with. Zero warnings is the repository's lint policy, so
// every partition carries `--max-warnings=0` ahead of its own paths.
export function eslintArguments(partitionArgs) {
  return ["--max-warnings=0", ...partitionArgs];
}

export function runPartitions(partitions, run) {
  const failed = partitions.filter((partition) => {
    console.log(`lint-repository: ${partition.label}`);
    return run(eslintArguments(partition.args)) !== 0;
  });
  return failed.map((partition) => partition.label);
}

async function main() {
  const root = process.cwd();
  const { default: config } = await import(pathToFileURL(join(root, "eslint.config.js")).href);
  const partitions = lintPartitions(workspacePackages(root), globalIgnores(config));
  const failed = runPartitions(partitions, (args) => {
    const result = spawnSync(process.execPath, [...process.execArgv, ESLINT_BIN, ...args], {
      cwd: root,
      stdio: "inherit",
    });
    return result.status ?? 1;
  });
  if (failed.length > 0) {
    console.error(`lint-repository: FAIL — ${failed.join(", ")}`);
    process.exit(1);
  }
  console.log(`lint-repository: PASS — ${partitions.length} partitions`);
}

if (isMainModule(import.meta.url)) await main();
