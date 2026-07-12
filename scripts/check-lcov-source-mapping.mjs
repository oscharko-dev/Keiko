#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { parseChangedFiles } from "./check-mutation-scope.mjs";

const defaultReports = [
  "coverage/packages/lcov.info",
  "packages/keiko-ui/coverage/lcov.info",
  // Written by test:coverage:scripts into its own reports directory (not the ambiguous default
  // ./coverage, which any unscoped `vitest --coverage` invocation using the root config could
  // write to or clean).
  "coverage/scripts/lcov.info",
];
const coveredScriptSources = new Set([
  "scripts/banking-quality-gate-core.mjs",
  "scripts/banking-quality-gate-worker.mjs",
  "scripts/check-lcov-source-mapping.mjs",
  "scripts/check-mutation-quality.mjs",
  "scripts/check-mutation-scope.mjs",
  "scripts/check-sonar-pr-quality-gate.mjs",
]);

export function parseLcovSources(contents, root) {
  return new Set(
    contents
      .flatMap((content) => content.split(/\r?\n/u))
      .filter((line) => line.startsWith("SF:"))
      .map((line) => line.slice(3))
      .map((path) => normalizeRepoPath(path, root)),
  );
}

function normalizeRepoPath(path, root) {
  const absolute = path.startsWith("/") ? path : resolve(root, path);
  return relative(root, absolute).replaceAll("\\", "/");
}

export function isExecutableSource(path) {
  return (
    /\.(?:[cm]?js|jsx|mjs|ts|tsx)$/u.test(path) &&
    (path.startsWith("packages/") || coveredScriptSources.has(path)) &&
    (coveredScriptSources.has(path) || path.includes("/src/")) &&
    !/\.(?:test|spec)\.[^.]+$/u.test(path) &&
    !path.endsWith(".d.ts") &&
    !path.includes("/__tests__/") &&
    !path.includes("/fixtures/") &&
    !/\.(?:config|generated)\.[^.]+$/u.test(path)
  );
}

export function missingCoverageMappings(changedPaths, mappedSources) {
  return changedPaths.filter((path) => isExecutableSource(path) && !mappedSources.has(path));
}

export function runLcovSourceMapping(input) {
  const execute = input.execute ?? execFileSync;
  const read = input.read ?? readFileSync;
  const root = input.root ?? process.cwd();
  const changed = parseChangedFiles(
    execute(
      "/usr/bin/git",
      ["diff", "--name-status", "--diff-filter=ACMR", `${input.base}...${input.head}`],
      { encoding: "utf8", cwd: root },
    ),
  );
  const reports = (input.reports ?? defaultReports).map((path) =>
    read(resolve(root, path), "utf8"),
  );
  const missing = missingCoverageMappings(changed, parseLcovSources(reports, root));
  if (missing.length > 0) throw new Error(`LCOV mapping missing for: ${missing.join(", ")}`);
  (input.log ?? console.log)(
    `lcov-source-mapping: PASS - ${String(changed.length)} changed files.`,
  );
  return { changed, missing };
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}

export function runLcovSourceMappingCli(input = {}) {
  try {
    const argv = input.argv ?? process.argv;
    const base = option(argv, "--base");
    const head = option(argv, "--head") ?? "HEAD";
    if (base === undefined) throw new Error("--base is required.");
    (input.run ?? runLcovSourceMapping)({ base, head });
  } catch (error) {
    (input.error ?? console.error)(
      `lcov-source-mapping: FAIL - ${error instanceof Error ? error.message : String(error)}`,
    );
    (input.setExitCode ?? ((value) => (process.exitCode = value)))(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) runLcovSourceMappingCli();
