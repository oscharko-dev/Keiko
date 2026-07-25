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
// ADR-0158: every LCOV report SonarCloud ingests, and only those. The list must stay identical to
// `sonar.javascript.lcov.reportPaths` in sonar-project.properties, or this mirror answers a
// different question than the gate it exists to predict. It listed `coverage/ui/lcov.info` — a path
// no vitest configuration writes — and omitted the real keiko-ui report, so it silently measured
// zero keiko-ui new code while still reporting a verdict.
const LCOV_CANDIDATES = [
  "coverage/lcov.info",
  "coverage/scripts/lcov.info",
  "coverage/packages/lcov.info",
  "packages/keiko-ui/coverage/lcov.info",
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

// A fresh clone or the gate container may have no `origin/dev`. The decision is returned rather than
// thrown so the operator gets the one-line fix instead of a git stack trace, and so every branch of
// it is reachable from a test without spawning git.
export function resolveMergeBase(baseRef, run) {
  try {
    return { base: run(["merge-base", baseRef, "HEAD"]).trim() };
  } catch {
    return {
      error:
        `new-code-coverage: FAIL - cannot resolve "${baseRef}" against HEAD. Fetch the base ` +
        "(`git fetch origin dev`) or name another one with `--base=<ref>`.",
    };
  }
}

/** LCOV paths may be absolute or relative to a workspace; normalise to repo-relative. */
export function normaliseLcovPaths(lcov, root = repoRoot) {
  const normalised = new Map();
  for (const [path, entry] of lcov) {
    const key = path.startsWith("/") ? relative(root, path) : path;
    normalised.set(key.replaceAll("\\", "/"), entry);
  }
  return normalised;
}

export function readReports(
  paths,
  exists = (path) => existsSync(join(repoRoot, path)),
  read = (path) => readFileSync(join(repoRoot, path), "utf8"),
) {
  const present = paths.filter((path) => exists(path));
  if (present.length === 0) return undefined;
  return {
    lcov: normaliseLcovPaths(parseLcov(present.map((path) => read(path)).join("\n"))),
    sources: present,
  };
}

/**
 * The whole verdict as data: which reports were read, what the ratio is, and what to print. Exported
 * so every failure path — no report, unresolvable base, under the bar — is testable without git, the
 * filesystem, or `process.exit`.
 */
export function evaluate({ argv = [], env = {}, run, exists, read, paths = LCOV_CANDIDATES }) {
  const reports = readReports(paths, exists, read);
  if (reports === undefined) {
    return {
      failures: [
        "new-code-coverage: FAIL - no LCOV report found. Run a coverage suite first, e.g. " +
          "`npm run test:coverage:scripts`.",
      ],
      ok: false,
    };
  }
  const resolved = resolveMergeBase(resolveBaseRef(argv, env), run);
  if (resolved.error !== undefined) return { failures: [resolved.error], ok: false };
  const result = newCodeCoverage({
    addedLinesByFile: parseDiffAddedLines(run(["diff", "-U0", `${resolved.base}..HEAD`, "--"])),
    inScope: (path) => isCoverableProductSource(path),
    lcov: reports.lcov,
  });
  const { failures, summary } = coverageVerdict(
    result,
    KEIKO_REPOSITORY_GATE_CONTRACT.newCodeCoverageMinimum,
  );
  return {
    failures: failures.map((failure) => `new-code-coverage: FAIL - ${failure}`),
    ok: failures.length === 0,
    summary: `new-code-coverage: ${summary} [reports: ${reports.sources.join(", ")}]`,
  };
}

/** Exported, with injectable collaborators, so every branch is reachable from a test (#2699). */
export function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const verdict = evaluate({ argv, env, run: git, ...deps });
  if (verdict.summary !== undefined) console.log(verdict.summary);
  for (const failure of verdict.failures) console.error(failure);
  if (!verdict.ok) process.exit(1);
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) main();
