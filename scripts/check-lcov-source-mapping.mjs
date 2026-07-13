#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { parseChangedFiles } from "./check-mutation-scope.mjs";
import {
  isCoverableProductSource,
  runAnalysisScopeCheck,
  systemGitExecutable,
} from "./sonar-analysis-scope.mjs";

const defaultReports = [
  "coverage/packages/lcov.info",
  "packages/keiko-ui/coverage/lcov.info",
  // Written by test:coverage:scripts into its own reports directory (not the ambiguous default
  // ./coverage, which any unscoped `vitest --coverage` invocation using the root config could
  // write to or clean).
  "coverage/scripts/lcov.info",
];
export function parseLcovSources(contents, root) {
  return new Set(
    contents
      .flatMap((content) => content.split(/\r?\n/u))
      .filter((line) => line.startsWith("SF:"))
      .map((line) => line.slice(3))
      .map((path) => normalizedLcovPath(path, root)),
  );
}

function normalizedLcovPath(path, root) {
  const normalized = normalizeRepoPath(path, root);
  if (path.startsWith("/") || path.includes("\\") || path !== normalized) {
    throw new Error(`LCOV source path is not normalized repository-relative: ${path}`);
  }
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`LCOV source path escapes the repository: ${path}`);
  }
  return normalized;
}

function normalizeRepoPath(path, root) {
  const absolute = path.startsWith("/") ? path : resolve(root, path);
  return relative(root, absolute).replaceAll("\\", "/");
}

export function isExecutableSource(path) {
  return isCoverableProductSource(path);
}

export function missingCoverageMappings(changedPaths, mappedSources) {
  return changedPaths.filter((path) => isExecutableSource(path) && !mappedSources.has(path));
}

export function runLcovSourceMapping(input) {
  const execute = input.execute ?? execFileSync;
  const read = input.read ?? readFileSync;
  const root = input.root ?? process.cwd();
  const scope = (input.verifyScope ?? runAnalysisScopeCheck)({ log: () => undefined, root });
  const changed = parseChangedFiles(
    execute(
      systemGitExecutable(),
      ["diff", "--name-status", "--diff-filter=ACMR", `${input.base}...${input.head}`],
      { encoding: "utf8", cwd: root },
    ),
  );
  const reports = (input.reports ?? defaultReports).map((path) =>
    read(resolve(root, path), "utf8"),
  );
  const mapped = parseLcovSources(reports, root);
  const trackedProduction = scope.files.filter(isExecutableSource);
  const missing = missingCoverageMappings(trackedProduction, mapped);
  if (missing.length > 0) throw new Error(`LCOV mapping missing for: ${missing.join(", ")}`);
  const changedMissing = missingCoverageMappings(changed, mapped);
  if (changedMissing.length > 0) {
    throw new Error(`Changed LCOV mapping missing for: ${changedMissing.join(", ")}`);
  }
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
