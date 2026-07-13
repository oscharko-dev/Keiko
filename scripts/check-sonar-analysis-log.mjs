#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function warningLines(contents) {
  return contents
    .split(/\r?\n/u)
    .filter((line) => /(?:^|\s)WARN(?:ING)?(?:\s|:|-)/iu.test(line) || /\[WARN\]/u.test(line));
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
  const warnings = warningLines(contents).map((line) => `scanner warning: ${line.trim()}`);
  const forbidden = lines
    .filter((line) => forbiddenDiagnostics.some((pattern) => pattern.test(line)))
    .map((line) => `forbidden scanner diagnostic: ${line.trim()}`);
  return [...new Set([...warnings, ...forbidden])];
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
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
    (input.run ?? runSonarLogCheck)({ path: option(argv, "--log") });
  } catch (error) {
    (input.error ?? console.error)(
      `sonar-analysis-log: FAIL - ${error instanceof Error ? error.message : String(error)}`,
    );
    (input.setExitCode ?? ((value) => (process.exitCode = value)))(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) executeSonarLogCli();
