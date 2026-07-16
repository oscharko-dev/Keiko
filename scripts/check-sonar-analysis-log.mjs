#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { optionValue } from "./sonar-analysis-scope.mjs";

function warningLines(contents) {
  return contents
    .split(/\r?\n/u)
    .filter((line) => /(?:^|\s)WARN(?:ING)?(?:\s|:|-)/iu.test(line) || /\[WARN\]/u.test(line));
}

// SonarCloud emits this SCM-metadata WARN when git blame attributes zero changed lines to a file
// that is still in the changed-file set. This is common and benign for pull-request analysis of the
// GitHub merge ref: it carries no rule, coverage, or rating signal, and the SonarCloud quality gate
// continues to enforce all of those. Exempt only this exact wording so every other WARN/ERROR the
// scanner emits still fails the gate. See docs/adr/ADR-0139-agent-first-deterministic-quality-gates.md.
const benignScmMetadataWarning =
  /File '[^']*' was detected as changed but without having changed lines/u;

function isBenignScmMetadataWarning(line) {
  return benignScmMetadataWarning.test(line);
}

const forbiddenDiagnostics = [
  /CFamily analysis configuration mode:\s*AutoConfig/iu,
  /C# files which cannot be analyzed/iu,
  /Could not determine common base path/iu,
  /(?:LCOV|coverage report).*(?:could not|cannot|does not exist|not found|unresolved)/iu,
  /SCM.*(?:disabled|failed|missing|not available|no revision)/iu,
];

export function sonarLogFailures(contents) {
  const lines = contents.split(/\r?\n/u);
  const warnings = warningLines(contents)
    .filter((line) => !isBenignScmMetadataWarning(line))
    .map((line) => `scanner warning: ${line.trim()}`);
  const forbidden = lines
    .filter((line) => forbiddenDiagnostics.some((pattern) => pattern.test(line)))
    .map((line) => `forbidden scanner diagnostic: ${line.trim()}`);
  return [...new Set([...warnings, ...forbidden])];
}

export function runSonarLogCheck(input = {}) {
  const path = input.path;
  if (path === undefined) throw new Error("--log is required");
  const contents = (input.read ?? readFileSync)(resolve(path), "utf8");
  const failures = sonarLogFailures(contents);
  if (failures.length > 0) throw new Error(failures.join("\n"));
  (input.log ?? console.log)("sonar-analysis-log: PASS - no scanner warnings.");
  return failures;
}

export function executeSonarLogCli(input = {}) {
  try {
    const argv = input.argv ?? process.argv.slice(2);
    (input.run ?? runSonarLogCheck)({ path: optionValue(argv, "--log") });
  } catch (error) {
    (input.error ?? console.error)(
      `sonar-analysis-log: FAIL - ${error instanceof Error ? error.message : String(error)}`,
    );
    (input.setExitCode ?? ((value) => (process.exitCode = value)))(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) executeSonarLogCli();
