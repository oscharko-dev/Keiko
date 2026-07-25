#!/usr/bin/env node
// Answers SonarCloud's `new_coverage` condition locally, before the push (Issue #2699).
//
// Run it after any coverage run that wrote an LCOV report:
//   npm run test:coverage:scripts && npm run check:coverage:new-code
//
// It reads the same threshold the required gate uses (KEIKO_REPOSITORY_GATE_CONTRACT), the same
// main-scope rules (`isCoverableProductSource`), and the same LCOV artefacts SonarCloud ingests, then
// names the exact uncovered lines. The point is that the required gate confirms a known answer
// instead of discovering it.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveHostExecutable } from "./lib/host-executable.mjs";
import {
  coverageVerdict,
  newCodeCoverage,
  parseDiffAddedLines,
  parseLcov,
} from "./lib/new-code-coverage.mjs";
import { isCoverableProductSource } from "./sonar-analysis-scope.mjs";
import { KEIKO_REPOSITORY_GATE_CONTRACT } from "./sonar-quality-gate-contract.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LCOV_CANDIDATES = [
  "coverage/lcov.info",
  "coverage/scripts/lcov.info",
  "coverage/packages/lcov.info",
  "coverage/ui/lcov.info",
];

function git(args) {
  return execFileSync(resolveHostExecutable("git"), args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
}

export function resolveBaseRef(argv, env) {
  const explicit = argv.find((entry) => entry.startsWith("--base="));
  if (explicit !== undefined) return explicit.slice("--base=".length);
  return env.KEIKO_NEW_CODE_BASE_REF ?? "origin/dev";
}

function mergeBase(baseRef) {
  return git(["merge-base", baseRef, "HEAD"]).trim();
}

/** LCOV paths may be absolute or relative to a workspace; normalise to repo-relative. */
export function normaliseLcovPaths(lcov, root = repoRoot) {
  const normalised = new Map();
  for (const [path, entry] of lcov) {
    const key = path.startsWith("/") ? relative(root, path) : path;
    normalised.set(key.split("\\").join("/"), entry);
  }
  return normalised;
}

function readReports(paths) {
  const present = paths.filter((path) => existsSync(join(repoRoot, path)));
  if (present.length === 0) return undefined;
  return {
    lcov: normaliseLcovPaths(
      parseLcov(present.map((path) => readFileSync(join(repoRoot, path), "utf8")).join("\n")),
    ),
    sources: present,
  };
}

function main(argv = process.argv.slice(2), env = process.env) {
  const reports = readReports(LCOV_CANDIDATES);
  if (reports === undefined) {
    console.error(
      "new-code-coverage: FAIL - no LCOV report found. Run a coverage suite first, e.g. " +
        "`npm run test:coverage:scripts`.",
    );
    process.exit(1);
  }
  const base = mergeBase(resolveBaseRef(argv, env));
  const added = parseDiffAddedLines(git(["diff", "-U0", `${base}..HEAD`, "--"]));
  const result = newCodeCoverage({
    addedLinesByFile: added,
    inScope: (path) => isCoverableProductSource(path),
    lcov: reports.lcov,
  });
  const { failures, summary } = coverageVerdict(
    result,
    KEIKO_REPOSITORY_GATE_CONTRACT.newCodeCoverageMinimum,
  );
  console.log(`new-code-coverage: ${summary} [reports: ${reports.sources.join(", ")}]`);
  if (failures.length === 0) return;
  for (const failure of failures) console.error(`new-code-coverage: FAIL - ${failure}`);
  process.exit(1);
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) main();
